"""Real offline synthetic training plus protocol checks, using the existing venv."""
import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
METRICS = {"beforeLoss", "afterLoss", "heldOutBefore", "heldOutAfter", "parameterDelta",
           "trainableParameters", "totalParameters", "steps", "weightEffect", "reloadVerified", "validationGroups"}


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not args.run_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in args.run_id):
        parser.error("run-id must use letters, numbers, hyphens or underscores")
    if Path.cwd().resolve() != ROOT:
        parser.error("execute from the project root")
    os.umask(0o077)
    directory = ROOT / ".local/fixture/intelligence-parallel/B" / args.run_id
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "tmp").mkdir()
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ}
    env.update({"HOME": str(directory), "TMPDIR": str(directory / "tmp"),
                "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
                "HF_HOME": str(directory / "cache"), "XDG_CACHE_HOME": str(directory / "cache")})
    commands = []

    def execute(label, command, expected=0, stdin=None):
        start = time.monotonic()
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, input=stdin, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired as error:
            decode = lambda value: value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""
            result = SimpleNamespace(returncode=124, stdout=decode(error.stdout), stderr=decode(error.stderr))
        (directory / f"{label}.stdout.log").write_text(result.stdout, encoding="utf-8")
        (directory / f"{label}.stderr.log").write_text(result.stderr, encoding="utf-8")
        commands.append({"label": label, "command": command, "stdin": stdin, "exitCode": result.returncode,
                         "expectedExitCode": expected, "elapsedSeconds": round(time.monotonic() - start, 3)})
        save(directory / "commands.json", commands)
        if result.returncode != expected:
            raise RuntimeError(f"Unexpected exit code for {label}; inspect its private logs")
        return result

    request = json.loads((ROOT / "training/examples/smoke-request.json").read_text(encoding="utf-8"))
    save(directory / "request.json", request)
    provenance = {"synthetic": True, "python": sys.version, "executable": sys.executable,
                  "sourceSha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in
                                   ("training/worker.py", "training/requirements.txt", "training/examples/run_smoke.py",
                                    "training/examples/smoke-request.json")},
                  "packages": {name: importlib.metadata.version(name) for name in
                               ("numpy", "torch", "transformers", "peft", "tokenizers", "safetensors")},
                  "offlineEnvironment": {name: env[name] for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE",
                                         "HF_HUB_DISABLE_TELEMETRY", "TOKENIZERS_PARALLELISM", "OMP_NUM_THREADS", "MKL_NUM_THREADS")}}
    revision = execute("vendor-revision", ["git", "-C", "training/vendor/transformers", "rev-parse", "HEAD"])
    provenance["transformersCommit"] = revision.stdout.strip()
    save(directory / "environment.json", provenance)
    worker = [sys.executable, "-B", "training/worker.py"]
    try:
        result = execute("train", [*worker, "train", str(directory)])
        metrics = json.loads((directory / "metrics.json").read_text(encoding="utf-8"))
        verification = json.loads((directory / "verification.json").read_text(encoding="utf-8"))
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        assert set(metrics) == METRICS and json.loads(result.stdout) == metrics
        assert all(math.isfinite(v) for v in metrics.values() if isinstance(v, (int, float)))
        assert metrics["parameterDelta"] > 0 and metrics["weightEffect"] > 0 and metrics["reloadVerified"] is True
        assert 0 < metrics["trainableParameters"] < metrics["totalParameters"] and metrics["steps"] == request["settings"]["steps"]
        assert manifest["mode"] == "smoke" and manifest["synthetic"] is True
        assert set(manifest["trainingGroups"]).isdisjoint(manifest["validationGroups"])
        assert len(manifest["validationGroups"]) == metrics["validationGroups"] > 0
        assert verification["reloadSamples"] == 16 and verification["tokenizerReloadVerified"] is True
        assert verification["weightProbe"]["batchSize"] == 1 and verification["weightProbe"]["zeroWeightLoss"] == 0
        assert len(verification["weightedStepLosses"]) == metrics["steps"]
        assert (directory / "base/model.safetensors").is_file()
        assert (directory / "adapter/adapter_model.safetensors").is_file()
        assert (directory / "tokenizer/tokenizer.json").is_file()
        denied = execute("infer-smoke-denied", [*worker, "infer", str(directory)], expected=1,
                         stdin=json.dumps({"text": "Synthetic inference prohibition check."}))
        assert denied.stdout == "" and json.loads(denied.stderr)["error"]["code"] == "SMOKE_INFERENCE_FORBIDDEN"
        repeated = execute("retrain-denied", [*worker, "train", str(directory)], expected=1)
        assert repeated.stdout == "" and json.loads(repeated.stderr)["error"]["code"] == "RUN_ALREADY_STARTED"
        assert json.loads((directory / "metrics.json").read_text(encoding="utf-8")) == metrics
        assert all(hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest for name, digest in provenance["sourceSha256"].items())
        save(directory / "result.json", {"synthetic": True, "exitCode": 0, "status": "implemented_fixture",
                                         "metrics": metrics, "smokeInferenceDenied": True, "retrainDenied": True,
                                         "sourceUnchangedDuringSmoke": True})
        print(json.dumps({"artifacts": str(directory), "metrics": metrics, "exitCode": 0}, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        save(directory / "result.json", {"synthetic": True, "exitCode": 1, "errorType": type(error).__name__})
        print(f"Synthetic verification failed; inspect {directory}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
