"""Offline Transformer/LoRA training worker. Never downloads models or calls APIs."""
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import random
import sys

# Enforce offline behavior even when invoked without the TypeScript runner.
for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[name] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["OMP_NUM_THREADS"] = "2"
os.environ["MKL_NUM_THREADS"] = "2"
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
VENDOR = Path(__file__).resolve().parent / "vendor" / "transformers" / "src"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import torch
from peft import LoraConfig, PeftModel, get_peft_model
from tokenizers import Tokenizer, models, pre_tokenizers, trainers, decoders
from transformers import AutoModelForCausalLM, AutoTokenizer, GPT2Config, GPT2LMHeadModel, PreTrainedTokenizerFast

torch.set_num_threads(2)
PROMPT = "Extract proposed knowledge as JSON. Preserve exact source quotes and UTF-16 offsets. Never confirm knowledge.\n"
MAX_TOKENS = 1024
METRIC_FIELDS = {"beforeLoss", "afterLoss", "heldOutBefore", "heldOutAfter", "parameterDelta",
                 "trainableParameters", "totalParameters", "steps", "weightEffect", "reloadVerified", "validationGroups"}


class WorkerError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def error_record(error):
    if isinstance(error, WorkerError):
        return {"code": error.code, "message": str(error)}
    return {"code": "WORKER_FAILED", "message": "Local training/model operation failed; no model was activated"}


def parse_json(text):
    def reject_constant(_):
        raise WorkerError("INVALID_JSON", "JSON must not contain non-finite numbers")

    def unique_fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise WorkerError("INVALID_JSON", "JSON must not contain duplicate fields")
            value[key] = item
        return value

    def finite_float(text):
        value = float(text)
        if not math.isfinite(value):
            reject_constant(text)
        return value

    try:
        return json.loads(text, parse_constant=reject_constant, parse_float=finite_float, object_pairs_hook=unique_fields)
    except WorkerError:
        raise
    except (ValueError, UnicodeError, RecursionError) as error:
        raise WorkerError("INVALID_JSON", "Invalid JSON document") from error


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 20_000_000:
        raise WorkerError("INVALID_FILE", "Missing, linked or oversized JSON document")
    try:
        return parse_json(path.read_text(encoding="utf-8"))
    except UnicodeError as error:
        raise WorkerError("INVALID_JSON", "JSON document must use valid UTF-8") from error


def candidate_value(text, code):
    try:
        value = parse_json(text)
    except WorkerError as error:
        raise WorkerError(code, "Expected a candidates JSON object") from error
    if (not isinstance(value, dict) or set(value) != {"candidates"} or not isinstance(value["candidates"], list)
            or any(not isinstance(item, dict) for item in value["candidates"])):
        raise WorkerError(code, "Expected a candidates JSON object")
    # The authoritative candidate fields, source spans and approvals remain in TypeScript.
    return value


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def validate_samples(samples):
    if not isinstance(samples, list) or not 1 <= len(samples) <= 1000:
        raise WorkerError("INVALID_DATASET", "Dataset must contain 1 to 1000 samples")
    active, seen, excluded = [], set(), 0
    for sample in samples:
        if not isinstance(sample, dict) or any(not isinstance(sample.get(k), str) or not sample[k].strip()
                                               for k in ("id", "groupId", "input", "target")):
            raise WorkerError("INVALID_SAMPLE", "Sample id, groupId, input and target must be nonempty strings")
        if sample["id"] in seen:
            raise WorkerError("INVALID_SAMPLE", "Sample ids must be unique")
        seen.add(sample["id"])
        weight = sample.get("weight")
        if not finite_number(weight) or not 0 <= weight <= 10:
            raise WorkerError("INVALID_WEIGHT", "Sample weight must be a finite number from 0 to 10")
        if weight == 0:
            excluded += 1
        else:
            candidate_value(sample["target"], "INVALID_SAMPLE")
            active.append(sample)
    if not active:
        raise WorkerError("INVALID_DATASET", "No positive-weight samples remain")
    return active, excluded


def validate_request(request):
    if not isinstance(request, dict) or request.get("mode") not in ("smoke", "lora"):
        raise WorkerError("INVALID_REQUEST", "Training mode must be smoke or lora")
    settings = request.get("settings")
    if not isinstance(settings, dict) or type(settings.get("steps")) is not int or not 5 <= settings["steps"] <= 200:
        raise WorkerError("INVALID_REQUEST", "Training steps must be an integer from 5 to 200")
    if not finite_number(settings.get("learningRate")) or not 0.000001 <= settings["learningRate"] <= 0.005:
        raise WorkerError("INVALID_REQUEST", "Learning rate must be finite and between 0.000001 and 0.005")
    if request["mode"] == "smoke" and request.get("samples") != []:
        raise WorkerError("INVALID_REQUEST", "Smoke accepts only built-in synthetic samples; pass samples: []")
    # Real weights are already computed by the shared TypeScript contract.
    samples, excluded = validate_samples(synthetic_samples() if request["mode"] == "smoke" else request.get("samples"))
    return request["mode"], settings, samples, excluded


def resolve_directory(path):
    candidate = Path(path)
    if not candidate.is_absolute() or Path.cwd().resolve() != ROOT:
        raise WorkerError("INVALID_DIRECTORY", "Use an absolute run directory and execute from the project root")
    storage = ROOT / ".local"
    if ".." in candidate.parts or candidate == storage or not candidate.is_relative_to(storage):
        raise WorkerError("INVALID_DIRECTORY", "Training output must stay inside private project storage")
    for part in (candidate, *candidate.parents):
        if part == ROOT:
            break
        if part.is_symlink():
            raise WorkerError("INVALID_DIRECTORY", "Run directory components must not be symbolic links")
    try:
        directory = candidate.resolve(strict=True)
    except OSError as error:
        raise WorkerError("INVALID_DIRECTORY", "Run directory must already exist") from error
    if not directory.is_dir() or directory == storage or not directory.is_relative_to(storage):
        raise WorkerError("INVALID_DIRECTORY", "Training output must stay inside private project storage")
    return directory


def local_base_path(path):
    if not isinstance(path, str) or not path or not Path(path).is_absolute():
        raise WorkerError("INVALID_MODEL", "Base model must be an absolute, prepared local directory")
    try:
        directory = Path(path).resolve(strict=True)
    except OSError as error:
        raise WorkerError("INVALID_MODEL", "Prepared local base model is missing") from error
    if not directory.is_dir() or not (directory / "config.json").is_file() or (directory / "adapter_config.json").exists():
        raise WorkerError("INVALID_MODEL", "Expected a local base model config, not an adapter repository")
    if not (directory / "model.safetensors").is_file():
        index = directory / "model.safetensors.index.json"
        if not index.is_file():
            raise WorkerError("INVALID_MODEL", "Local base model requires safetensors weights")
        metadata = read_json(index)
        files = metadata.get("weight_map") if isinstance(metadata, dict) else None
        if not isinstance(files, dict) or not files:
            raise WorkerError("INVALID_MODEL", "Invalid safetensors shard index")
        for name in files.values():
            if (not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts
                    or not name.endswith(".safetensors") or not (directory / name).is_file()):
                raise WorkerError("INVALID_MODEL", "Missing or invalid local safetensors shard")
    return str(directory)


def load_base(path):
    path = local_base_path(path)
    try:
        return AutoModelForCausalLM.from_pretrained(path, local_files_only=True, trust_remote_code=False,
                                                  use_safetensors=True, torch_dtype=torch.float32)
    except (OSError, ValueError, RuntimeError, TypeError) as error:
        raise WorkerError("INVALID_MODEL", "Local safetensors base model could not be loaded") from error


def load_tokenizer(path, allow_padding=False):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.is_dir():
        raise WorkerError("INVALID_TOKENIZER", "Expected a prepared local tokenizer directory")
    try:
        tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=False)
        eos = tokenizer.eos_token_id
        if type(eos) is not int or not 0 <= eos < len(tokenizer):
            raise WorkerError("INVALID_TOKENIZER", "Tokenizer must define a valid EOS token")
        if tokenizer.pad_token_id is None and allow_padding:
            tokenizer.pad_token = tokenizer.eos_token
        pad = tokenizer.pad_token_id
        if type(pad) is not int or not 0 <= pad < len(tokenizer):
            raise WorkerError("INVALID_TOKENIZER", "Tokenizer must define a valid padding token")
        return tokenizer
    except WorkerError:
        raise
    except (OSError, ValueError, RuntimeError, TypeError) as error:
        raise WorkerError("INVALID_TOKENIZER", "Local tokenizer files could not be loaded without remote code") from error


def sequence_limit(model, tokenizer):
    limits = [MAX_TOKENS]
    for value in (getattr(model.config, "max_position_embeddings", None),
                  getattr(model.config, "n_positions", None), tokenizer.model_max_length):
        if type(value) is int and value > 0:
            limits.append(value)
    return min(limits)


def weighted_loss(logits, labels, weights, normalizer):
    if (logits.ndim != 3 or labels.shape != logits.shape[:2] or labels.shape[1] < 2
            or weights.shape != (labels.shape[0],) or labels.shape[0] == 0):
        raise WorkerError("INVALID_LOSS", "Invalid loss tensor dimensions")
    if (not finite_number(normalizer) or normalizer <= 0 or weights.dtype == torch.bool
            or not torch.isfinite(weights).all() or (weights < 0).any() or (weights > 10).any()):
        raise WorkerError("INVALID_WEIGHT", "Loss weights and normalizer must be finite and nonnegative; normalizer must be positive")
    shifted = labels[:, 1:]
    counts = (shifted != -100).sum(1)
    if (counts == 0).any():
        raise WorkerError("INVALID_LOSS", "Every sample requires at least one shifted target token")
    losses = torch.nn.functional.cross_entropy(
        logits[:, :-1].reshape(-1, logits.shape[-1]), shifted.reshape(-1), reduction="none", ignore_index=-100,
    ).reshape(shifted.shape)
    per_example = losses.sum(1) / counts
    # Dataset-wide normalization, never batch sum(weights): batch size 1 retains its weight.
    return (per_example * weights).mean() / normalizer


def synthetic_samples():
    result = []
    for index, subject in enumerate(["cache", "backup", "tests", "privacy", "versions", "sources", "timeouts", "consent"]):
        text = f"Verify {subject} before reuse. Conditions may change."
        target = {"candidates": [{"title": f"Check {subject}", "question": f"When can {subject} be reused?", "claim": text,
                  "kind": "principle", "whyKeep": "Preserve a reusable condition", "uncertainties": [],
                  "spans": [{"segmentId": f"s{index}", "start": 0, "end": len(text), "quote": text}]}]}
        for variant in range(2):
            result.append({"id": f"synthetic-{index}-{variant}", "groupId": f"synthetic-{index}",
                           "input": json.dumps({"untrustedTask": {"question": f"Review {subject} {variant}"},
                                                "untrustedSegments": [{"id": f"s{index}", "role": "assistant", "text": text}]}),
                           "target": json.dumps(target), "weight": 1.0 + index / 4})
    return result


def partition(samples):
    groups = sorted({s["groupId"] for s in samples}, key=lambda s: hashlib.sha256(s.encode()).hexdigest())
    if len(groups) < 2:
        raise WorkerError("INSUFFICIENT_GROUPS", "At least two independent conversation groups are required")
    held_out = set(groups[:max(1, len(groups) // 5)])
    return [s for s in samples if s["groupId"] not in held_out], [s for s in samples if s["groupId"] in held_out], len(held_out)


def build_tokenizer(samples):
    backend = Tokenizer(models.BPE(unk_token="[UNK]"))
    backend.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    backend.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(vocab_size=512, special_tokens=["[PAD]", "[UNK]", "[EOS]"],
                                 initial_alphabet=pre_tokenizers.ByteLevel.alphabet(), show_progress=False)
    backend.train_from_iterator([PROMPT + s["input"] + s["target"] for s in samples], trainer)
    return PreTrainedTokenizerFast(tokenizer_object=backend, pad_token="[PAD]", unk_token="[UNK]", eos_token="[EOS]")


def encoded(sample, tokenizer, max_length=MAX_TOKENS):
    if tokenizer.eos_token_id is None:
        raise WorkerError("INVALID_TOKENIZER", "Tokenizer must define an EOS token")
    prefix = tokenizer.encode(PROMPT + sample["input"] + "\nKnowledge JSON:\n", add_special_tokens=False, truncation=False)
    target = tokenizer.encode(sample["target"], add_special_tokens=False, truncation=False) + [tokenizer.eos_token_id]
    if len(target) < 2:
        raise WorkerError("INVALID_SAMPLE", "Sample target must contain tokens before EOS")
    if len(prefix) + len(target) > max_length:
        raise WorkerError("SAMPLE_TOO_LONG", f"Sample exceeds {max_length} tokens; reduce its authorized scope without silently truncating")
    return prefix + target, [-100] * len(prefix) + target


def batch(samples, tokenizer, max_length=MAX_TOKENS):
    if not samples or tokenizer.pad_token_id is None:
        raise WorkerError("INVALID_BATCH", "Batch must be nonempty and tokenizer must define padding")
    pairs = [encoded(s, tokenizer, max_length) for s in samples]
    length = max(len(p[0]) for p in pairs)
    ids = torch.tensor([p[0] + [tokenizer.pad_token_id] * (length - len(p[0])) for p in pairs])
    labels = torch.tensor([p[1] + [-100] * (length - len(p[1])) for p in pairs])
    mask = torch.tensor([[1] * len(p[0]) + [0] * (length - len(p[0])) for p in pairs])
    return ids, labels, mask, torch.tensor([s["weight"] for s in samples], dtype=torch.float32)


def evaluate(model, samples, tokenizer, max_length=MAX_TOKENS):
    if not samples:
        raise WorkerError("INVALID_DATASET", "Evaluation requires nonempty samples")
    model.eval()
    values = []
    with torch.no_grad():
        for sample in samples:
            ids, labels, mask, _ = batch([sample], tokenizer, max_length)
            value = float(weighted_loss(model(ids, attention_mask=mask).logits, labels, torch.ones(1), 1.0))
            if not math.isfinite(value):
                raise WorkerError("NONFINITE_LOSS", "Non-finite evaluation loss")
            values.append(value)
    return sum(values) / len(values)


def verify_reload(model, restored, tokenizer, restored_tokenizer, samples, max_length):
    if (tokenizer.get_vocab() != restored_tokenizer.get_vocab()
            or any(getattr(tokenizer, name) != getattr(restored_tokenizer, name)
                   for name in ("pad_token_id", "eos_token_id", "bos_token_id", "unk_token_id"))):
        raise WorkerError("RELOAD_MISMATCH", "Saved tokenizer vocabulary or special tokens changed")
    model.eval()
    restored.eval()
    max_difference = 0.0
    with torch.no_grad():
        for sample in samples:
            original_batch = batch([sample], tokenizer, max_length)
            restored_batch = batch([sample], restored_tokenizer, max_length)
            if any(not torch.equal(a, b) for a, b in zip(original_batch, restored_batch)):
                raise WorkerError("RELOAD_MISMATCH", "Saved tokenizer did not reproduce the encoded samples")
            ids, _, mask, _ = original_batch
            logits = model(ids, attention_mask=mask).logits
            restored_logits = restored(ids, attention_mask=mask).logits
            if (logits.shape != restored_logits.shape or not torch.isfinite(restored_logits).all()
                    or not torch.allclose(logits, restored_logits, atol=0.0001, rtol=0.0001)):
                raise WorkerError("RELOAD_MISMATCH", "Saved base, tokenizer and adapter did not reproduce logits")
            max_difference = max(max_difference, float((logits - restored_logits).abs().max()))
    return max_difference


def validate_success(metrics):
    if not isinstance(metrics, dict) or set(metrics) != METRIC_FIELDS or metrics.get("reloadVerified") is not True:
        raise WorkerError("INCOMPLETE_RUN", "Complete verified metrics are required")
    for name in METRIC_FIELDS - {"reloadVerified"}:
        if not finite_number(metrics[name]) or metrics[name] < 0:
            raise WorkerError("INCOMPLETE_RUN", "Verified metrics must be finite and nonnegative")
    for name in ("steps", "validationGroups", "trainableParameters", "totalParameters"):
        if type(metrics[name]) is not int or metrics[name] < 1:
            raise WorkerError("INCOMPLETE_RUN", "Verified metric counts must be positive integers")
    if (metrics["steps"] > 200 or metrics["trainableParameters"] > metrics["totalParameters"]
            or metrics["parameterDelta"] <= 0 or metrics["weightEffect"] <= 0):
        raise WorkerError("INCOMPLETE_RUN", "Metrics do not demonstrate a completed verified training run")


def validate_groups(manifest, metrics):
    groups = [manifest.get("trainingGroups"), manifest.get("validationGroups")]
    if any(not isinstance(values, list) or not values
           or any(not isinstance(value, str) or not value.strip() for value in values)
           or len(set(values)) != len(values) for values in groups):
        raise WorkerError("INCOMPLETE_RUN", "Manifest requires independent training and validation groups")
    if set(groups[0]) & set(groups[1]) or len(groups[1]) != metrics["validationGroups"]:
        raise WorkerError("INCOMPLETE_RUN", "Manifest groups conflict with verified validation metrics")


def train(directory):
    directory = resolve_directory(directory)
    artifacts = ("attempt.json", "metrics.json", "manifest.json", "error.json", "verification.json", "adapter", "tokenizer", "base")
    if any((directory / name).exists() or (directory / name).is_symlink()
           for name in (*artifacts, *(name + ".tmp" for name in artifacts))):
        raise WorkerError("RUN_ALREADY_STARTED", "Run directory already contains an attempt or result; do not automatically retry")
    # This exclusive marker also prevents two worker processes from sharing one run.
    try:
        with (directory / "attempt.json").open("x", encoding="utf-8") as stream:
            json.dump({"state": "started"}, stream)
    except FileExistsError as error:
        raise WorkerError("RUN_ALREADY_STARTED", "Run directory already contains an attempt") from error
    try:
        return train_once(directory)
    except Exception as error:
        with contextlib.suppress(OSError):
            write_json(directory / "error.json", error_record(error))
        raise


def train_once(directory):
    request = read_json(directory / "request.json")
    mode, settings, samples, excluded = validate_request(request)
    training, validation, groups = partition(samples)
    random.seed(42)
    torch.manual_seed(42)
    if mode == "smoke":
        tokenizer = build_tokenizer(training)
        base = GPT2LMHeadModel(GPT2Config(vocab_size=len(tokenizer), n_positions=1024, n_ctx=1024, n_embd=48,
                                        n_layer=2, n_head=2, bos_token_id=tokenizer.eos_token_id, eos_token_id=tokenizer.eos_token_id,
                                        pad_token_id=tokenizer.pad_token_id, attn_pdrop=0, resid_pdrop=0, embd_pdrop=0))
        base.save_pretrained(directory / "base", safe_serialization=True)
        base_path = str(directory / "base")
        targets = ["c_attn", "c_proj"]
    else:
        base_path = local_base_path(request.get("baseModel"))
        tokenizer = load_tokenizer(base_path, allow_padding=True)
        base = load_base(base_path)
        targets = "all-linear"
    max_length = sequence_limit(base, tokenizer)
    for sample in samples:
        encoded(sample, tokenizer, max_length)
    tokenizer.save_pretrained(directory / "tokenizer")
    base.config.use_cache = False
    model = get_peft_model(base, LoraConfig(r=4, lora_alpha=8, target_modules=targets, lora_dropout=0, task_type="CAUSAL_LM"))
    parameters = [p for p in model.parameters() if p.requires_grad]
    if not parameters:
        raise WorkerError("NO_TRAINABLE_PARAMETERS", "No trainable adapter parameters")
    original = [p.detach().clone() for p in parameters]
    before = evaluate(model, training, tokenizer, max_length)
    held_before = evaluate(model, validation, tokenizer, max_length)
    optimizer = torch.optim.AdamW(parameters, lr=settings["learningRate"])
    normalizer = sum(s["weight"] for s in training) / len(training)
    step_losses = []
    model.train()
    for step in range(settings["steps"]):
        chosen = [training[(step * 2 + offset) % len(training)] for offset in range(2)]
        ids, labels, mask, weights = batch(chosen, tokenizer, max_length)
        optimizer.zero_grad(set_to_none=True)
        loss = weighted_loss(model(ids, attention_mask=mask).logits, labels, weights, normalizer)
        if not torch.isfinite(loss):
            raise WorkerError("NONFINITE_LOSS", "Non-finite training loss")
        loss.backward()
        if any(p.grad is not None and not torch.isfinite(p.grad).all() for p in parameters):
            raise WorkerError("NONFINITE_GRADIENT", "Non-finite adapter gradient")
        torch.nn.utils.clip_grad_norm_(parameters, 1.0, error_if_nonfinite=True)
        optimizer.step()
        step_losses.append(float(loss.detach()))
    delta = sum(float((p.detach() - old).abs().sum()) for p, old in zip(parameters, original))
    if not math.isfinite(delta) or delta <= 0:
        raise WorkerError("NO_PARAMETER_UPDATE", "No finite nonzero adapter parameter update")
    after = evaluate(model, training, tokenizer, max_length)
    held_after = evaluate(model, validation, tokenizer, max_length)
    model.save_pretrained(directory / "adapter", safe_serialization=True)
    restored_tokenizer = load_tokenizer(directory / "tokenizer")
    restored_base = load_base(base_path)
    restored_base.config.use_cache = False
    restored = load_adapter(restored_base, directory)
    max_logit_difference = verify_reload(model, restored, tokenizer, restored_tokenizer, training + validation, max_length)
    with torch.no_grad():
        ids, labels, mask, weights = batch(training[:1], tokenizer, max_length)
        logits = model(ids, attention_mask=mask).logits
        weighted_probe = float(weighted_loss(logits, labels, weights, normalizer))
        zero_probe = float(weighted_loss(logits, labels, torch.zeros_like(weights), normalizer))
        weight_effect = abs(weighted_probe - zero_probe)
    if not math.isfinite(weight_effect) or weight_effect <= 0:
        raise WorkerError("NO_WEIGHT_EFFECT", "Weights had no finite effect on the single-sample loss")
    metrics = {"beforeLoss": before, "afterLoss": after, "heldOutBefore": held_before, "heldOutAfter": held_after,
               "parameterDelta": delta, "trainableParameters": sum(p.numel() for p in parameters),
               "totalParameters": sum(p.numel() for p in model.parameters()), "steps": settings["steps"],
               "weightEffect": weight_effect, "reloadVerified": True, "validationGroups": groups}
    validate_success(metrics)
    write_json(directory / "verification.json", {"synthetic": mode == "smoke", "seed": 42, "maxSequenceTokens": max_length,
               "trainingSamples": len(training), "validationSamples": len(validation), "excludedZeroWeightSamples": excluded,
               "weightNormalizer": normalizer, "weightedStepLosses": step_losses,
               "weightProbe": {"batchSize": 1, "weight": float(weights[0]), "weightedLoss": weighted_probe,
                               "zeroWeightLoss": zero_probe, "normalizerHeldFixed": True},
               "reloadSamples": len(samples), "tokenizerReloadVerified": True, "reloadMaxLogitDifference": max_logit_difference})
    write_json(directory / "manifest.json", {"mode": mode, "baseModel": base_path, "trainingGroups": sorted({s["groupId"] for s in training}),
               "validationGroups": sorted({s["groupId"] for s in validation}), "synthetic": mode == "smoke"})
    # The runner reads this last-written success marker; partial runs never publish metrics.
    write_json(directory / "metrics.json", metrics)
    return metrics


def load_adapter(base, directory):
    adapter = directory / "adapter"
    if (adapter.is_symlink() or (adapter / "adapter_model.safetensors").is_symlink()
            or (adapter / "adapter_config.json").is_symlink() or not (adapter / "adapter_model.safetensors").is_file()):
        raise WorkerError("INVALID_MODEL", "Adapter requires local safetensors weights; pickle fallback is disabled")
    try:
        return PeftModel.from_pretrained(base, adapter, local_files_only=True, is_trainable=False)
    except (OSError, ValueError, RuntimeError, TypeError) as error:
        raise WorkerError("INVALID_MODEL", "Local safetensors adapter could not be loaded") from error


def infer(directory):
    directory = resolve_directory(directory)
    manifest = read_json(directory / "manifest.json")
    if not isinstance(manifest, dict) or manifest.get("mode") != "lora" or manifest.get("synthetic") is not False:
        raise WorkerError("SMOKE_INFERENCE_FORBIDDEN", "Synthetic random-initialization model cannot serve production extraction")
    metrics = read_json(directory / "metrics.json")
    validate_success(metrics)
    validate_groups(manifest, metrics)
    if (directory / "error.json").exists() or (directory / "error.json").is_symlink():
        raise WorkerError("INCOMPLETE_RUN", "Only successfully verified runs can infer")
    text = sys.stdin.read(100001)
    if len(text) > 100000:
        raise WorkerError("INVALID_REQUEST", "Inference request exceeds input budget")
    request = parse_json(text)
    if not isinstance(request, dict) or set(request) != {"text"} or not isinstance(request["text"], str) or not request["text"].strip():
        raise WorkerError("INVALID_REQUEST", "Inference requires one nonempty text field")
    tokenizer = load_tokenizer(directory / "tokenizer")
    base = load_base(manifest.get("baseModel"))
    model = load_adapter(base, directory).eval()
    inputs = tokenizer(PROMPT + request["text"] + "\nKnowledge JSON:\n", return_tensors="pt", add_special_tokens=False, truncation=False)
    remaining = sequence_limit(base, tokenizer) - inputs.input_ids.shape[-1]
    if remaining < 1:
        raise WorkerError("SAMPLE_TOO_LONG", "Input exceeds trained scope or leaves no generation space")
    with torch.no_grad():
        output = model.generate(**inputs, max_new_tokens=min(512, remaining), do_sample=False, pad_token_id=tokenizer.pad_token_id)
    text = tokenizer.decode(output[0, inputs.input_ids.shape[-1]:], skip_special_tokens=True)
    return candidate_value(text, "INVALID_MODEL_OUTPUT")


def main(arguments=None):
    os.umask(0o077)
    arguments = sys.argv[1:] if arguments is None else arguments
    try:
        if len(arguments) != 2 or arguments[0] not in ("train", "infer"):
            raise WorkerError("INVALID_COMMAND", "Usage: worker.py train|infer <absolute-run-dir>")
        directory = resolve_directory(arguments[1])
        with contextlib.redirect_stdout(sys.stderr):
            value = train(directory) if arguments[0] == "train" else infer(directory)
        print(json.dumps(value, ensure_ascii=False, allow_nan=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": error_record(error)}, allow_nan=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
