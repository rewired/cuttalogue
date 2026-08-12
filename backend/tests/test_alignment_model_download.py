# Regression coverage for the alignment model's download-progress support
# (backend/app/alignment.py's ALIGNMENT_MODEL_FILENAME/_model_cache_path/
# is_model_downloaded/_download_model_with_progress). The actual network
# download itself is deliberately not exercised here - no mocked HTTP
# server, no real ~1.2GB transfer - consistent with how expand.py's real
# OpenRouter call also has no test coverage; only the surrounding pure
# path/existence logic is tested, plus that the download function takes
# its "already cached, nothing to do" fast path without ever reaching the
# point where it would attempt a real request.
#
# Run with:
#   backend/.venv/Scripts/python.exe backend/tests/test_alignment_model_download.py
import asyncio
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import alignment  # noqa: E402
from app import jobs  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


TMP_DIR = Path(tempfile.mkdtemp(prefix="cuttalogue-alignment-model-download-test-"))

try:
    # --- ALIGNMENT_MODEL_FILENAME: specific, not the generic torch.hub default
    check(bool(alignment.ALIGNMENT_MODEL_FILENAME), "ALIGNMENT_MODEL_FILENAME is a non-empty string")
    check(
        alignment.ALIGNMENT_MODEL_FILENAME != "model.pt",
        f"ALIGNMENT_MODEL_FILENAME is specific, not torch.hub's generic URL-basename default ({alignment.ALIGNMENT_MODEL_FILENAME!r})",
    )

    # --- _model_cache_path()/is_model_downloaded(): monkeypatch torch.hub's
    # cache dir to an isolated temp directory so this never touches the
    # real, possibly multi-GB shared ~/.cache/torch/hub/checkpoints/.
    import torch

    fake_hub_dir = TMP_DIR / "hub"
    original_get_dir = torch.hub.get_dir
    torch.hub.get_dir = lambda: str(fake_hub_dir)
    try:
        cache_path = alignment._model_cache_path()
        check(
            cache_path == fake_hub_dir / "checkpoints" / alignment.ALIGNMENT_MODEL_FILENAME,
            f"_model_cache_path() resolves under torch.hub.get_dir()/checkpoints ({cache_path})",
        )

        check(alignment.is_model_downloaded() is False, "is_model_downloaded() is False against an empty/nonexistent cache dir")

        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(b"fake checkpoint bytes")
        check(alignment.is_model_downloaded() is True, "is_model_downloaded() is True once the expected file exists")

        # --- _download_model_with_progress(): takes the "already cached"
        # fast path and returns without ever importing httpx / attempting a
        # request - proven by it completing instantly against a fake job
        # whose queue nothing is ever pushed into (a real download attempt
        # would hang or error against a fake job/no real network target).
        job = jobs.create_job()
        asyncio.run(alignment._download_model_with_progress(job))
        check(job.status == "queued", "_download_model_with_progress() returns immediately for an already-downloaded model (no progress events emitted)")
    finally:
        torch.hub.get_dir = original_get_dir

finally:
    shutil.rmtree(TMP_DIR, ignore_errors=True)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nAll alignment-model-download checks passed.")
