"""Run only B's synthetic tests, preserving logs under a fresh evidence directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    if not args.run_id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for c in args.run_id):
        parser.error("run-id must use letters, numbers, hyphens or underscores")
    os.umask(0o077)
    directory = ROOT / ".local/fixture/intelligence-parallel/B" / args.run_id
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "tmp").mkdir()
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT") if key in os.environ}
    env.update({"HOME": str(directory), "TMPDIR": str(directory / "tmp"),
                "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                "TOKENIZERS_PARALLELISM": "false", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2",
                "HF_HOME": str(directory / "cache"), "XDG_CACHE_HOME": str(directory / "cache"),
                "TRAINING_TEST_ROOT": str(directory / "cases")})
    command = [sys.executable, "-B", "-m", "unittest", "discover", "-s", "training/tests", "-p", "test_*.py", "-v"]
    sources = [ROOT / "training/worker.py", ROOT / "training/requirements.txt",
               *sorted((ROOT / "training/tests").glob("*.py")), *sorted((ROOT / "training/examples").glob("*.json"))]
    before = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    start = time.monotonic()
    try:
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired as error:
        # subprocess.run has killed and waited for this exact test process.
        decode = lambda value: value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value or ""
        result = SimpleNamespace(returncode=124, stdout=decode(error.stdout), stderr=decode(error.stderr))
    (directory / "stdout.log").write_text(result.stdout, encoding="utf-8")
    (directory / "stderr.log").write_text(result.stderr, encoding="utf-8")
    after = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    links = [str((Path(parent) / name).relative_to(directory)) for parent, folders, files in os.walk(directory, followlinks=False)
             for name in folders + files if (Path(parent) / name).is_symlink()]
    exit_code = result.returncode if result.returncode or (before == after and not links) else 1
    record = {"synthetic": True, "command": command, "exitCode": exit_code, "testProcessExitCode": result.returncode,
              "elapsedSeconds": round(time.monotonic() - start, 3),
              "sourceUnchangedDuringTests": before == after, "remainingSymlinks": links,
              "sourceSha256": before, "sourceSha256After": after}
    (directory / "result.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(result.stdout, end="")
    print(result.stderr, end="", file=sys.stderr)
    print(json.dumps({**record, "artifacts": str(directory)}, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
