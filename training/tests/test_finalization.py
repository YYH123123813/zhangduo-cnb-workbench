"""Final-stage synthetic boundary tests; injected metrics are never training evidence."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import test_worker as fixtures

worker = fixtures.worker
torch = fixtures.torch


injected_metrics = fixtures.injected_metrics


class FinalBoundaryTests(unittest.TestCase):
    def setUp(self):
        storage = Path(os.environ["TRAINING_TEST_ROOT"])
        storage.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="synthetic-final-", dir=storage))
        self.write("manifest.json", {"mode": "lora", "synthetic": False, "baseModel": str(self.directory),
                                     "trainingGroups": ["synthetic-train"], "validationGroups": ["synthetic-held"]})
        self.write("metrics.json", injected_metrics())
        (self.directory / "tokenizer").mkdir()
        self.write("tokenizer/tokenizer.json", {"syntheticLoaderSpy": True})

    def write(self, name, value):
        (self.directory / name).write_text(json.dumps(value), encoding="utf-8")

    @contextlib.contextmanager
    def injected_inference(self, output='{"candidates":[]}'):
        tokenizer = MagicMock()
        tokenizer.__len__.return_value = 8
        tokenizer.model_max_length = 1024
        tokenizer.eos_token_id = 2
        tokenizer.pad_token_id = 0
        tokenizer.return_value = fixtures.BatchEncoding({"input_ids": torch.ones((1, 3), dtype=torch.long),
                                                        "attention_mask": torch.ones((1, 3), dtype=torch.long)})
        tokenizer.decode.return_value = output
        model = MagicMock()
        model.eval.return_value = model
        model.generate.return_value = torch.ones((1, 8), dtype=torch.long)
        base = SimpleNamespace(config=SimpleNamespace(max_position_embeddings=1024))
        with patch.object(worker.AutoTokenizer, "from_pretrained", return_value=tokenizer) as loader, patch("worker.load_base", return_value=base), patch("worker.load_adapter", return_value=model), patch("sys.stdin", io.StringIO('{"text":"Synthetic source"}')):
            yield loader, model

    def test_partial_metrics_cannot_authorize_inference(self):
        self.write("metrics.json", {"reloadVerified": True})
        with self.injected_inference() as (loader, _):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.infer(self.directory)
            self.assertEqual(caught.exception.code, "INCOMPLETE_RUN")
            loader.assert_not_called()

    def test_invalid_success_metrics_cannot_authorize_inference(self):
        for field, value in (("parameterDelta", 0), ("weightEffect", 0), ("steps", True), ("steps", 201),
                             ("heldOutBefore", None), ("heldOutAfter", -1), ("trainableParameters", 9),
                             ("totalParameters", 0), ("validationGroups", 0), ("reloadVerified", False)):
            metrics = injected_metrics()
            metrics[field] = value
            self.write("metrics.json", metrics)
            with self.subTest(field=field), self.injected_inference() as (loader, _):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.infer(self.directory)
                self.assertEqual(caught.exception.code, "INCOMPLETE_RUN")
                loader.assert_not_called()

    def test_overlapping_or_missing_manifest_groups_are_rejected(self):
        for training, held in ((["same"], ["same"]), ([], ["held"]), (["train"], []),
                               (["train"], ["held", "held"]), (["train"], ["held", "other"])):
            self.write("manifest.json", {"mode": "lora", "synthetic": False, "baseModel": str(self.directory),
                                         "trainingGroups": training, "validationGroups": held})
            with self.subTest(groups=(training, held)), self.injected_inference() as (loader, _):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.infer(self.directory)
                self.assertEqual(caught.exception.code, "INCOMPLETE_RUN")
                loader.assert_not_called()

    def test_invalid_inference_output_is_rejected(self):
        for text in ("not JSON", "[]", "{}", '{"candidates":null}', '{"candidates":[null]}',
                     '{"candidates":[],"confirmed":true}', '{"candidates":[],"score":NaN}'):
            with self.subTest(output=text), self.injected_inference(text):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.infer(self.directory)
                self.assertEqual(caught.exception.code, "INVALID_MODEL_OUTPUT")

    def test_valid_candidate_envelope_returns_only_model_value(self):
        with self.injected_inference():
            self.assertEqual(worker.infer(self.directory), {"candidates": []})

    def test_missing_metrics_and_failed_run_never_load_models(self):
        (self.directory / "metrics.json").unlink()
        with self.injected_inference() as (loader, _), self.assertRaises(ValueError):
            worker.infer(self.directory)
        loader.assert_not_called()
        self.write("metrics.json", injected_metrics())
        self.write("error.json", {"code": "RELOAD_MISMATCH"})
        with self.injected_inference() as (loader, _), self.assertRaises(ValueError):
            worker.infer(self.directory)
        loader.assert_not_called()

    def test_missing_tokenizer_has_safe_dedicated_error(self):
        with patch.object(worker.AutoTokenizer, "from_pretrained", side_effect=OSError("synthetic-private-detail")):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.load_tokenizer(self.directory / "tokenizer")
        self.assertEqual(caught.exception.code, "INVALID_TOKENIZER")
        self.assertNotIn("synthetic-private-detail", str(caught.exception))

    def test_loaded_tokenizer_must_define_valid_eos(self):
        tokenizer = MagicMock()
        tokenizer.__len__.return_value = 8
        tokenizer.pad_token_id = 0
        for eos in (None, -1, 99, True):
            tokenizer.eos_token_id = eos
            with self.subTest(eos=eos), patch.object(worker.AutoTokenizer, "from_pretrained", return_value=tokenizer):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.load_tokenizer(self.directory / "tokenizer")
                self.assertEqual(caught.exception.code, "INVALID_TOKENIZER")

    def test_missing_tokenizer_files_fail_without_loading_base_weights(self):
        directory = self.directory / "missing-tokenizer"
        directory.mkdir()
        with self.assertRaises(worker.WorkerError) as caught:
            worker.load_tokenizer(directory)
        self.assertEqual(caught.exception.code, "INVALID_TOKENIZER")

    def test_corrupt_adapter_error_is_sanitized(self):
        adapter = self.directory / "adapter"
        adapter.mkdir()
        (adapter / "adapter_model.safetensors").write_bytes(b"synthetic-loader-spy")
        with patch.object(worker.PeftModel, "from_pretrained", side_effect=ValueError("synthetic-private-detail")):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.load_adapter(None, self.directory)
        self.assertEqual(caught.exception.code, "INVALID_MODEL")
        self.assertNotIn("synthetic-private-detail", str(caught.exception))

    def test_base_loader_errors_are_sanitized_and_classified(self):
        self.write("config.json", {"model_type": "gpt2"})
        (self.directory / "model.safetensors").write_bytes(b"synthetic-loader-spy")
        with patch.object(worker.AutoModelForCausalLM, "from_pretrained", side_effect=OSError("synthetic-private-model-detail")):
            with self.assertRaises(worker.WorkerError) as caught:
                worker.load_base(str(self.directory))
        self.assertEqual(caught.exception.code, "INVALID_MODEL")
        self.assertNotIn("synthetic-private-model-detail", str(caught.exception))

    def test_internal_run_symlink_is_rejected_like_runner(self):
        target = self.directory / "target"
        target.mkdir()
        link = self.directory / "alias"
        link.symlink_to(target, target_is_directory=True)
        try:
            with self.assertRaises(worker.WorkerError) as caught:
                worker.resolve_directory(link)
            self.assertEqual(caught.exception.code, "INVALID_DIRECTORY")
        finally:
            link.unlink()

    def test_target_must_be_json_candidate_envelope(self):
        for text in ("not-json", "[]", '{"candidates":null}', '{"candidates":[null]}'):
            item = fixtures.sample()
            item["target"] = text
            with self.subTest(target=text), self.assertRaises(worker.WorkerError) as caught:
                worker.validate_samples([item])
            self.assertEqual(caught.exception.code, "INVALID_SAMPLE")


class ReloadBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.samples = worker.synthetic_samples()[:2]
        cls.tokenizer = worker.build_tokenizer(cls.samples)

    def model(self, delta=0.):
        model = MagicMock()
        model.side_effect = lambda ids, attention_mask=None: SimpleNamespace(
            logits=torch.zeros(ids.shape[0], ids.shape[1], len(self.tokenizer)) + delta)
        return model

    def test_reload_logit_difference_fails_without_relaxing_threshold(self):
        with self.assertRaises(worker.WorkerError) as caught:
            worker.verify_reload(self.model(), self.model(0.1), self.tokenizer, self.tokenizer, self.samples, 1024)
        self.assertEqual(caught.exception.code, "RELOAD_MISMATCH")

    def test_reload_changed_padding_configuration_is_rejected(self):
        restored = copy.deepcopy(self.tokenizer)
        restored.pad_token = restored.eos_token
        with self.assertRaises(worker.WorkerError) as caught:
            worker.verify_reload(self.model(), self.model(), self.tokenizer, restored, self.samples, 1024)
        self.assertEqual(caught.exception.code, "RELOAD_MISMATCH")

    def test_reload_equal_logits_and_tokenizer_pass(self):
        difference = worker.verify_reload(self.model(), self.model(), self.tokenizer, self.tokenizer, self.samples, 1024)
        self.assertEqual(difference, 0.)


class AttemptFailureTests(unittest.TestCase):
    def setUp(self):
        storage = Path(os.environ["TRAINING_TEST_ROOT"])
        storage.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="synthetic-attempt-", dir=storage))

    def test_empty_zero_and_single_source_fail_before_model_loading(self):
        cases = [([], "INVALID_DATASET"), ([fixtures.sample(weight=0)], "INVALID_DATASET"),
                 ([fixtures.sample(), fixtures.sample("other")], "INSUFFICIENT_GROUPS")]
        for index, (samples, code) in enumerate(cases):
            directory = self.directory / str(index)
            directory.mkdir()
            config = fixtures.request()
            config["samples"] = samples
            worker.write_json(directory / "request.json", config)
            with self.subTest(code=code), patch("worker.load_base") as loader:
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.train(directory)
                self.assertEqual(caught.exception.code, code)
                loader.assert_not_called()
                self.assertFalse((directory / "metrics.json").exists())

    def test_invalid_json_request_records_failure_not_metrics(self):
        (self.directory / "request.json").write_text('{"mode":', encoding="utf-8")
        with self.assertRaises(worker.WorkerError) as caught:
            worker.train(self.directory)
        self.assertEqual(caught.exception.code, "INVALID_JSON")
        self.assertEqual(worker.read_json(self.directory / "error.json")["code"], "INVALID_JSON")
        self.assertFalse((self.directory / "metrics.json").exists())

    def test_partial_outputs_and_temp_files_block_retraining(self):
        for name in ("adapter", "tokenizer", "base", "attempt.json", "manifest.json", "metrics.json.tmp"):
            directory = self.directory / name.replace(".", "-")
            directory.mkdir()
            artifact = directory / name
            if name in ("adapter", "tokenizer", "base"):
                artifact.mkdir()
            else:
                artifact.write_text("synthetic-existing-partial", encoding="utf-8")
            with self.subTest(artifact=name), self.assertRaises(worker.WorkerError) as caught:
                worker.train(directory)
            self.assertEqual(caught.exception.code, "RUN_ALREADY_STARTED")
            if artifact.is_file():
                self.assertEqual(artifact.read_text(), "synthetic-existing-partial")

    def test_injected_post_save_reload_failure_never_publishes_success(self):
        def failing_reload(directory):
            adapter = directory / "adapter"
            adapter.mkdir()
            (adapter / "adapter_model.safetensors").write_bytes(b"synthetic-partial-not-a-model")
            raise worker.WorkerError("RELOAD_MISMATCH", "Injected reload failure")

        with patch("worker.train_once", side_effect=failing_reload), self.assertRaises(worker.WorkerError):
            worker.train(self.directory)
        self.assertEqual(worker.read_json(self.directory / "error.json")["code"], "RELOAD_MISMATCH")
        self.assertFalse((self.directory / "metrics.json").exists())
        self.assertFalse((self.directory / "manifest.json").exists())
        with self.assertRaises(worker.WorkerError) as caught:
            worker.train(self.directory)
        self.assertEqual(caught.exception.code, "RUN_ALREADY_STARTED")


if __name__ == "__main__":
    unittest.main()
