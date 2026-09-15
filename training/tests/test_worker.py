"""Synthetic-only regression tests; no pretrained weights or network access."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
import worker
import torch
from transformers import BatchEncoding


def sample(identifier="a", group="conversation-a", weight=1.0):
    return {"id": identifier, "groupId": group, "input": "Synthetic source.",
            "target": '{"candidates": []}', "weight": weight}


def request(mode="lora"):
    return {"mode": mode, "samples": [sample(), sample("b", "conversation-b")],
            "settings": {"steps": 5, "learningRate": 0.001}, "baseModel": ""}


def injected_metrics():
    return {"beforeLoss": 2., "afterLoss": 1., "heldOutBefore": 2., "heldOutAfter": 1.,
            "parameterDelta": 1., "trainableParameters": 4, "totalParameters": 8,
            "steps": 5, "weightEffect": 1., "reloadVerified": True, "validationGroups": 1}


class LossTests(unittest.TestCase):
    def test_single_sample_weight_changes_loss_and_gradient(self):
        logits = torch.tensor([[[0.2, 0.8], [0.7, 0.3], [0.4, 0.6]]], requires_grad=True)
        labels = torch.tensor([[-100, -100, 1]])
        low = worker.weighted_loss(logits, labels, torch.tensor([1.0]), 2.0)
        low_gradient = torch.autograd.grad(low, logits, retain_graph=True)[0]
        high = worker.weighted_loss(logits, labels, torch.tensor([3.0]), 2.0)
        high_gradient = torch.autograd.grad(high, logits)[0]
        self.assertAlmostEqual(high.item(), 3 * low.item(), places=6)
        torch.testing.assert_close(high_gradient, 3 * low_gradient)

    def test_prompt_padding_and_final_logits_do_not_contribute(self):
        logits = torch.randn(1, 6, 3, requires_grad=True)
        labels = torch.tensor([[-100, -100, -100, 1, 2, -100]])
        loss = worker.weighted_loss(logits, labels, torch.ones(1), 1.0)
        expected = torch.nn.functional.cross_entropy(logits[0, 2:4], torch.tensor([1, 2]))
        torch.testing.assert_close(loss, expected)
        gradient = torch.autograd.grad(loss, logits)[0]
        self.assertEqual(gradient[0, [0, 1, 4, 5]].abs().sum().item(), 0)
        self.assertGreater(gradient[0, 2:4].abs().sum().item(), 0)

    def test_mean_is_per_sample_not_per_token(self):
        logits = torch.tensor([[[1., 0.]] * 4, [[0., 2.]] * 4])
        labels = torch.tensor([[-100, 0, -100, -100], [-100, 0, 0, 0]])
        losses = torch.nn.functional.cross_entropy(logits[:, 0], torch.zeros(2, dtype=torch.long), reduction="none")
        actual = worker.weighted_loss(logits, labels, torch.tensor([1., 3.]), 2.)
        torch.testing.assert_close(actual, (losses[0] + 3 * losses[1]) / 4)

    def test_zero_weight_has_zero_gradient(self):
        logits = torch.randn(2, 3, 4, requires_grad=True)
        labels = torch.tensor([[-100, 1, 2], [-100, 2, 3]])
        loss = worker.weighted_loss(logits, labels, torch.tensor([0., 1.]), 1.)
        gradient = torch.autograd.grad(loss, logits)[0]
        self.assertEqual(gradient[0].abs().sum().item(), 0)

    def test_empty_supervision_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "target"):
            worker.weighted_loss(torch.zeros(1, 3, 2), torch.full((1, 3), -100), torch.ones(1), 1.)

    def test_invalid_loss_weights_and_normalizer_are_rejected(self):
        for value in (-1., float("nan"), float("inf")):
            with self.subTest(weight=value), self.assertRaises(ValueError):
                worker.weighted_loss(torch.zeros(1, 2, 2), torch.tensor([[-100, 1]]), torch.tensor([value]), 1.)
        for value in (0., -1., float("nan"), float("inf")):
            with self.subTest(normalizer=value), self.assertRaises(ValueError):
                worker.weighted_loss(torch.zeros(1, 2, 2), torch.tensor([[-100, 1]]), torch.ones(1), value)

    def test_invalid_tensor_shapes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "dimensions"):
            worker.weighted_loss(torch.zeros(2, 3, 2), torch.full((2, 3), 1), torch.ones(1), 1.)


class DatasetTests(unittest.TestCase):
    def test_group_split_is_order_independent_and_disjoint(self):
        samples = worker.synthetic_samples()
        training, validation, count = worker.partition(samples)
        again_train, again_validation, again_count = worker.partition(list(reversed(samples)))
        self.assertFalse({s["groupId"] for s in training} & {s["groupId"] for s in validation})
        self.assertEqual({s["id"] for s in training}, {s["id"] for s in again_train})
        self.assertEqual({s["id"] for s in validation}, {s["id"] for s in again_validation})
        self.assertEqual(count, again_count)
        self.assertEqual(len(training) + len(validation), len(samples))

    def test_all_variants_of_each_conversation_stay_together(self):
        samples = [sample(f"{group}-{i}", str(group)) for group in range(10) for i in range(group + 1)]
        training, validation, count = worker.partition(samples)
        self.assertEqual(count, 2)
        for group in {s["groupId"] for s in samples}:
            expected = {s["id"] for s in samples if s["groupId"] == group}
            self.assertTrue(expected <= {s["id"] for s in training} or expected <= {s["id"] for s in validation})

    def test_zero_weight_is_excluded_before_partition(self):
        samples, excluded = worker.validate_samples([sample(weight=0), sample("b", "b"), sample("c", "c")])
        self.assertEqual(excluded, 1)
        self.assertEqual([s["id"] for s in samples], ["b", "c"])
        training, validation, _ = worker.partition(samples)
        self.assertNotIn("conversation-a", {s["groupId"] for s in training + validation})

    def test_zero_weight_group_cannot_satisfy_holdout(self):
        samples, _ = worker.validate_samples([sample(weight=0), sample("b", "b")])
        with self.assertRaisesRegex(ValueError, "two"):
            worker.partition(samples)

    def test_invalid_weights_are_not_silently_dropped(self):
        for value in (-1, 10.001, float("nan"), float("inf"), True, "2", None, 10 ** 1000):
            with self.subTest(weight=value), self.assertRaises(ValueError):
                worker.validate_samples([sample(weight=value), sample("b", "b")])

    def test_missing_empty_or_duplicate_samples_are_rejected(self):
        for samples in ([], [sample(weight=0)], [sample(), sample()], [sample()] * 1001):
            with self.subTest(samples=len(samples)), self.assertRaises(ValueError):
                worker.validate_samples(samples)
        for field in ("id", "groupId", "input", "target"):
            for value in ("", "   ", None, 123):
                item = sample()
                item[field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    worker.validate_samples([item])

    def test_training_configuration_rejects_non_integer_and_nonfinite(self):
        for field, values in (("steps", (True, 5.5, "5", 4, 201)),
                              ("learningRate", (True, float("nan"), float("inf"), 0, 0.006))):
            for value in values:
                config = request()
                config["settings"][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    worker.validate_request(config)

    def test_smoke_rejects_external_samples_and_uses_fixed_synthetic_weights(self):
        config = request("smoke")
        with self.assertRaisesRegex(ValueError, "synthetic"):
            worker.validate_request(config)
        config["samples"] = []
        config["settings"]["weights"] = {"defaultImportance": 0}
        mode, settings, samples, excluded = worker.validate_request(config)
        self.assertEqual(mode, "smoke")
        self.assertEqual(samples, worker.synthetic_samples())
        self.assertEqual(excluded, 0)

    def test_public_examples_are_synthetic_with_exact_source_spans(self):
        for name in ("smoke-request.json", "lora-request.synthetic.json"):
            config = worker.read_json(ROOT / "training/examples" / name)
            _, _, samples, _ = worker.validate_request(config)
            training, validation, _ = worker.partition(samples)
            self.assertTrue(training and validation)
            for item in samples:
                self.assertTrue(item["id"].startswith("synthetic-"))
                self.assertTrue(item["groupId"].startswith("synthetic-"))
                source = json.loads(item["input"])
                target = json.loads(item["target"])
                segments = {s["id"]: s["text"] for s in source["untrustedSegments"]}
                for candidate in target["candidates"]:
                    for span in candidate["spans"]:
                        utf16 = segments[span["segmentId"]].encode("utf-16-le")
                        self.assertEqual(utf16[span["start"] * 2:span["end"] * 2].decode("utf-16-le"), span["quote"])


class EncodingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tokenizer = worker.build_tokenizer(worker.synthetic_samples()[:2])

    def test_target_only_and_padding(self):
        short = sample()
        long = sample("long", "long")
        long["target"] = long["target"] * 4
        ids, labels, mask, weights = worker.batch([short, long], self.tokenizer)
        prefix = self.tokenizer.encode(worker.PROMPT + short["input"] + "\nKnowledge JSON:\n", add_special_tokens=False)
        self.assertTrue((labels[0, :len(prefix)] == -100).all())
        self.assertEqual(labels[0, len(prefix)], ids[0, len(prefix)])
        self.assertTrue((labels[mask == 0] == -100).all())
        self.assertGreater((mask == 0).sum().item(), 0)
        self.assertEqual(labels[0, mask[0].sum() - 1], self.tokenizer.eos_token_id)

    def test_oversize_is_rejected_without_truncation(self):
        item = sample()
        item["input"] = " x" * 2000
        with self.assertRaisesRegex(ValueError, "exceeds"):
            worker.encoded(item, self.tokenizer)

    def test_actual_model_context_limit_is_enforced(self):
        with self.assertRaisesRegex(ValueError, "exceeds"):
            worker.encoded(sample(), self.tokenizer, max_length=10)

    def test_missing_eos_is_rejected(self):
        tokenizer = copy.deepcopy(self.tokenizer)
        tokenizer.eos_token = None
        with self.assertRaisesRegex(ValueError, "EOS"):
            worker.encoded(sample(), tokenizer)

    def test_zero_weight_samples_and_holdout_do_not_train_tokenizer(self):
        samples, _ = worker.validate_samples(worker.synthetic_samples() + [sample("zero", "zero", 0)])
        training, validation, _ = worker.partition(samples)
        self.assertNotIn("zero", [s["id"] for s in training + validation])
        with patch("worker.Tokenizer") as backend, patch("worker.PreTrainedTokenizerFast"):
            worker.build_tokenizer(training)
        corpus = backend.return_value.train_from_iterator.call_args.args[0]
        self.assertEqual(corpus, [worker.PROMPT + s["input"] + s["target"] for s in training])
        self.assertFalse(set(corpus) & {worker.PROMPT + s["input"] + s["target"] for s in validation})


class FileTests(unittest.TestCase):
    def setUp(self):
        storage = Path(os.environ["TRAINING_TEST_ROOT"])
        storage.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="synthetic-", dir=storage))

    def write(self, name, value):
        (self.directory / name).write_text(json.dumps(value), encoding="utf-8")

    def test_strict_json_rejects_nan_and_duplicate_fields(self):
        for text in ('{"weight": NaN}', '{"weight": 1e999}', '{"mode":"smoke","mode":"lora"}'):
            path = self.directory / "bad.json"
            path.write_text(text, encoding="utf-8")
            with self.assertRaises(ValueError):
                worker.read_json(path)

    def test_invalid_request_has_no_success_artifacts(self):
        config = request()
        config["samples"][0]["weight"] = -1
        self.write("request.json", config)
        with self.assertRaises(ValueError):
            worker.train(self.directory)
        self.assertFalse((self.directory / "metrics.json").exists())
        self.assertFalse((self.directory / "manifest.json").exists())
        self.assertEqual(json.loads((self.directory / "error.json").read_text())["code"], "INVALID_WEIGHT")

    def test_same_directory_is_never_retrained(self):
        self.write("request.json", request("smoke"))
        self.write("metrics.json", {"sentinel": "existing result"})
        with self.assertRaisesRegex(ValueError, "already"):
            worker.train(self.directory)
        self.assertEqual(json.loads((self.directory / "metrics.json").read_text()), {"sentinel": "existing result"})

    def test_partial_failure_records_only_sanitized_diagnostic(self):
        with patch("worker.train_once", side_effect=RuntimeError("synthetic-private-text-do-not-log")):
            with self.assertRaises(RuntimeError):
                worker.train(self.directory)
        text = (self.directory / "error.json").read_text()
        self.assertNotIn("synthetic-private-text", text)
        self.assertEqual(json.loads(text)["code"], "WORKER_FAILED")
        self.assertFalse((self.directory / "metrics.json").exists())
        with self.assertRaisesRegex(ValueError, "already"):
            worker.train(self.directory)

    def test_smoke_cannot_infer(self):
        self.write("manifest.json", {"mode": "smoke", "synthetic": True})
        with patch("sys.stdin", io.StringIO('{"text":"synthetic"}')):
            with self.assertRaisesRegex(ValueError, "production"):
                worker.infer(self.directory)

    def test_model_id_relative_path_and_pickle_only_are_rejected(self):
        for path in ("gpt2", "./training", ""):
            with self.subTest(path=path), self.assertRaises(ValueError):
                worker.local_base_path(path)
        self.write("config.json", {"model_type": "gpt2"})
        (self.directory / "pytorch_model.bin").write_bytes(b"synthetic-not-a-model")
        with self.assertRaisesRegex(ValueError, "safetensors"):
            worker.local_base_path(str(self.directory))

    def test_sharded_model_rejects_missing_files_and_path_escape(self):
        self.write("config.json", {"model_type": "gpt2"})
        for filename in ("../outside.safetensors", "/outside.safetensors", "weights.bin", "missing.safetensors"):
            self.write("model.safetensors.index.json", {"weight_map": {"weight": filename}})
            with self.subTest(filename=filename), self.assertRaisesRegex(ValueError, "safetensors"):
                worker.local_base_path(str(self.directory))

    def test_pretrained_loader_is_offline_float32_no_remote_code(self):
        self.write("config.json", {"model_type": "gpt2"})
        (self.directory / "model.safetensors").write_bytes(b"synthetic-loader-spy")
        with patch.object(worker.AutoModelForCausalLM, "from_pretrained") as loader:
            worker.load_base(str(self.directory))
        loader.assert_called_once_with(str(self.directory), local_files_only=True, trust_remote_code=False,
                                       use_safetensors=True, torch_dtype=torch.float32)
        self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
        self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")

    def test_adapter_pickle_fallback_is_blocked(self):
        (self.directory / "adapter").mkdir()
        (self.directory / "adapter/adapter_model.bin").write_bytes(b"synthetic-not-a-model")
        with patch.object(worker.PeftModel, "from_pretrained") as loader:
            with self.assertRaisesRegex(ValueError, "safetensors"):
                worker.load_adapter(None, self.directory)
            loader.assert_not_called()

    def test_model_loader_failure_publishes_no_metrics(self):
        self.write("request.json", request())
        with self.assertRaisesRegex(ValueError, "absolute"):
            worker.train(self.directory)
        self.assertFalse((self.directory / "metrics.json").exists())
        self.assertEqual(json.loads((self.directory / "error.json").read_text())["code"], "INVALID_MODEL")

    def test_run_path_escape_and_symlink_are_rejected(self):
        with self.assertRaises(ValueError):
            worker.resolve_directory(ROOT)
        link = self.directory / "escape"
        # Never leave a cycle back into the project for shared filesystem watchers.
        link.symlink_to(ROOT / "training/tests", target_is_directory=True)
        try:
            with self.assertRaises(ValueError):
                worker.resolve_directory(link)
        finally:
            link.unlink()

    def test_inference_uses_same_prompt_and_reserves_generation_context(self):
        self.prepare_inference()
        inputs = {"input_ids": torch.ones((1, 900), dtype=torch.long), "attention_mask": torch.ones((1, 900), dtype=torch.long)}
        with patch.object(worker.AutoTokenizer, "from_pretrained") as tokenizer_loader, patch("worker.load_base") as base_loader, patch("worker.load_adapter") as adapter_loader:
            tokenizer = tokenizer_loader.return_value
            tokenizer.return_value = BatchEncoding(inputs)
            tokenizer.model_max_length = 1024
            tokenizer.__len__.return_value = 8
            tokenizer.eos_token_id = 2
            tokenizer.pad_token_id = 0
            tokenizer.decode.return_value = '{"candidates": []}'
            base_loader.return_value.config = SimpleNamespace(max_position_embeddings=1024)
            model = adapter_loader.return_value.eval.return_value
            model.generate.return_value = torch.ones((1, 905), dtype=torch.long)
            with patch("sys.stdin", io.StringIO('{"text":"Synthetic source"}')):
                self.assertEqual(worker.infer(self.directory), {"candidates": []})
            tokenizer.assert_called_once_with(worker.PROMPT + "Synthetic source\nKnowledge JSON:\n", return_tensors="pt", add_special_tokens=False, truncation=False)
            tokenizer_loader.assert_called_once_with(self.directory / "tokenizer", local_files_only=True, trust_remote_code=False)
            self.assertEqual(model.generate.call_args.kwargs["max_new_tokens"], 124)

    def test_invalid_inference_input_is_rejected_before_loading_model(self):
        self.prepare_inference()
        for text in ('{}', '{"text":""}', '{"text":1}', '{"text":"x","extra":true}', "x" * 100001):
            with self.subTest(length=len(text)), patch("sys.stdin", io.StringIO(text)), patch("worker.load_base") as loader:
                with self.assertRaises(ValueError):
                    worker.infer(self.directory)
                loader.assert_not_called()

    def prepare_inference(self):
        self.write("manifest.json", {"mode": "lora", "synthetic": False, "baseModel": str(self.directory),
                                     "trainingGroups": ["synthetic-train"], "validationGroups": ["synthetic-held"]})
        self.write("metrics.json", injected_metrics())
        (self.directory / "tokenizer").mkdir()
        self.write("tokenizer/tokenizer.json", {"syntheticLoaderSpy": True})

    def verify_numeric_failure(self, kind, expected):
        config = request("smoke")
        config["samples"] = []
        self.write("request.json", config)
        tokenizer = worker.build_tokenizer(worker.synthetic_samples())

        class TinyModel(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.values = torch.nn.Parameter(torch.linspace(0, 1, len(tokenizer)))
                self.config = SimpleNamespace(n_positions=1024, use_cache=False)

            def forward(self, ids, attention_mask=None):
                return SimpleNamespace(logits=self.values.expand(ids.shape[0], ids.shape[1], -1))

            def save_pretrained(self, *_args, **_kwargs):
                pass

        model = TinyModel()
        if kind == "loss":
            with torch.no_grad():
                model.values.fill_(float("nan"))
        if kind == "gradient":
            model.values.register_hook(lambda gradient: torch.full_like(gradient, float("inf")))
        with patch("worker.GPT2LMHeadModel", return_value=model), patch("worker.get_peft_model", return_value=model), patch("worker.build_tokenizer", return_value=tokenizer), patch("worker.evaluate", return_value=1.), patch.object(torch.optim.AdamW, "step"):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.train(self.directory)
        self.assertEqual(caught.exception.code, expected)
        self.assertEqual(json.loads((self.directory / "error.json").read_text())["code"], expected)
        self.assertFalse((self.directory / "metrics.json").exists())
        self.assertFalse((self.directory / "manifest.json").exists())

    def test_nonfinite_training_loss_never_publishes_success(self):
        self.verify_numeric_failure("loss", "NONFINITE_LOSS")

    def test_nonfinite_gradient_never_publishes_success(self):
        self.verify_numeric_failure("gradient", "NONFINITE_GRADIENT")

    def test_unchanged_parameters_never_publish_success(self):
        self.verify_numeric_failure("unchanged", "NO_PARAMETER_UPDATE")

    def test_cli_success_stdout_contains_only_json(self):
        def noisy_infer(_):
            print("synthetic library diagnostic")
            return {"candidates": []}
        with patch("worker.infer", side_effect=noisy_infer), contextlib.redirect_stdout(io.StringIO()) as stdout, contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(worker.main(["infer", str(self.directory)]), 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"candidates": []})
        self.assertIn("synthetic library diagnostic", stderr.getvalue())

    def test_cli_relative_directory_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            code = worker.main(["train", str(self.directory.relative_to(ROOT))])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr.getvalue())["error"]["code"], "INVALID_DIRECTORY")


if __name__ == "__main__":
    unittest.main()
