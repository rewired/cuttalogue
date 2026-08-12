# Regression coverage for Phase 5.1 (persisted lyrics alignment): the
# canonical vocal-source fingerprint helper (app/audio.py's
# track_fingerprint), the read-only fingerprint endpoint it backs, and
# align_lyrics_endpoint's success-path result shape. Same dependency-free
# TestClient + fake-aligner style as test_alignment.py - see that file's own
# header for why (no torch/torchaudio model load, runs in well under a
# second). test_alignment.py itself is untouched: this file only adds the
# Phase 5.1-specific persistence/fingerprint coverage that didn't exist
# before (that file only ever exercised the 400/404 validation paths of the
# endpoint, never a full success run through the job system).
#
# Run with:
#   backend/.venv/Scripts/python.exe backend/tests/test_lyrics_alignment_persistence.py
import json
import shutil
import sys
import tempfile
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import alignment  # noqa: E402
from app import audio  # noqa: E402
from app import projects as projects_module  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


TMP_DIR = Path(tempfile.mkdtemp(prefix="cuttalogue-lyrics-alignment-persistence-test-"))


def make_silent_wav(path: Path, num_samples: int, sample_rate: int = 16000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * num_samples)


# --- Same fake CTC aligner/tokenizer/model as test_alignment.py -------------
class FakeSpan:
    def __init__(self, start: int, end: int, score: float):
        self.start = start
        self.end = end
        self.score = score

    def __len__(self) -> int:
        return self.end - self.start


_next_word_spans: list[list[FakeSpan]] = []


def fake_tokenizer(words):
    return [[1] for _ in words]


def fake_aligner(_emission, tokens):
    assert len(tokens) == len(_next_word_spans), "fake aligner called with unexpected word count"
    return _next_word_spans


def fake_model(waveform):
    import torch

    return torch.zeros(1, 100, 32), None


def install_fake_bundle():
    import torch

    alignment._bundle_cache.clear()
    alignment._bundle_cache.update(
        {
            "bundle": None,
            "model": fake_model,
            "tokenizer": fake_tokenizer,
            "aligner": fake_aligner,
            "device": torch.device("cpu"),
        }
    )


try:
    install_fake_bundle()

    # --- track_fingerprint(): real file vs. missing track ----------------------
    project_dir_for_fingerprint = TMP_DIR / "fingerprint-proj"
    vocal_path = project_dir_for_fingerprint / "audio" / "vocal.wav"
    make_silent_wav(vocal_path, num_samples=1600)
    data_with_vocal = {"audio": {"vocal": {"relativePath": "audio/vocal.wav"}}}

    fp = audio.track_fingerprint(data_with_vocal, project_dir_for_fingerprint, "vocal")
    check(fp is not None, "track_fingerprint: returns a fingerprint for an existing file")
    check(fp["relativePath"] == "audio/vocal.wav", f"track_fingerprint: relativePath is echoed verbatim ({fp})")
    check(fp["sizeBytes"] == vocal_path.stat().st_size, f"track_fingerprint: sizeBytes matches the real file ({fp})")
    check(isinstance(fp["mtimeMs"], float) and fp["mtimeMs"] > 0, f"track_fingerprint: mtimeMs is a real timestamp ({fp})")

    fp_missing = audio.track_fingerprint({"audio": {}}, project_dir_for_fingerprint, "vocal")
    check(fp_missing is None, "track_fingerprint: returns None when the track was never uploaded")

    fp_gone = audio.track_fingerprint(
        {"audio": {"vocal": {"relativePath": "audio/does-not-exist.wav"}}}, project_dir_for_fingerprint, "vocal"
    )
    check(fp_gone is None, "track_fingerprint: returns None when the referenced file is missing on disk")

    # --- GET /api/projects/{id}/audio/vocal/fingerprint + POST /align-lyrics ---
    from fastapi.testclient import TestClient  # noqa: E402

    from app.main import app  # noqa: E402

    original_data_dir = projects_module.DATA_DIR
    try:
        test_data_dir = TMP_DIR / "projects"
        test_data_dir.mkdir(parents=True, exist_ok=True)
        projects_module.DATA_DIR = test_data_dir

        # A single persistent portal (TestClient as a context manager) is
        # required here, not the bare `TestClient(app)` test_alignment.py
        # uses: without `with`, each request spins up its own throwaway
        # event loop, so align_lyrics_endpoint's asyncio.create_task(run())
        # background job never survives past the POST that created it - the
        # subsequent GET /api/jobs/{id} polls would just see it hang at
        # "running" forever. Only needed here because this file is the first
        # to actually wait for a background job to finish.
        client_cm = TestClient(app)
        client = client_cm.__enter__()

        # A project with no vocal track uploaded yet.
        no_vocal_id = "no-vocal-fp-proj"
        no_vocal_dir = test_data_dir / no_vocal_id
        no_vocal_dir.mkdir(parents=True, exist_ok=True)
        (no_vocal_dir / "project.json").write_text(json.dumps({"audio": {}}), encoding="utf-8")

        res_no_vocal = client.get(f"/api/projects/{no_vocal_id}/audio/vocal/fingerprint")
        check(res_no_vocal.status_code == 200, f"fingerprint endpoint: 200 even with no vocal uploaded (got {res_no_vocal.status_code})")
        check(res_no_vocal.json() == {"fingerprint": None}, f"fingerprint endpoint: null fingerprint, not an error ({res_no_vocal.json()})")

        res_bad_track = client.get(f"/api/projects/{no_vocal_id}/audio/bogus/fingerprint")
        check(res_bad_track.status_code == 400, f"fingerprint endpoint: invalid track name is a 400 (got {res_bad_track.status_code})")

        res_missing_project = client.get("/api/projects/does-not-exist/audio/vocal/fingerprint")
        check(res_missing_project.status_code == 404, f"fingerprint endpoint: unknown project is a 404 (got {res_missing_project.status_code})")

        # A project with a real vocal track uploaded, aligned end-to-end
        # through the actual job system (never exercised by test_alignment.py).
        proj_id = "aligned-proj"
        proj_dir = test_data_dir / proj_id
        proj_vocal_path = proj_dir / "audio" / "vocal.wav"
        make_silent_wav(proj_vocal_path, num_samples=16000)
        (proj_dir / "project.json").write_text(
            json.dumps({"audio": {"vocal": {"relativePath": "audio/vocal.wav"}}}), encoding="utf-8"
        )

        res_fp = client.get(f"/api/projects/{proj_id}/audio/vocal/fingerprint")
        check(res_fp.status_code == 200, f"fingerprint endpoint: 200 for a real vocal track (got {res_fp.status_code})")
        real_fp = res_fp.json()["fingerprint"]
        check(real_fp is not None and real_fp["relativePath"] == "audio/vocal.wav", f"fingerprint endpoint: real fingerprint shape ({real_fp})")

        _next_word_spans[:] = [[FakeSpan(0, 10, 0.9)], [FakeSpan(20, 40, 0.5)]]
        lyrics_text = "hello world"
        res_align = client.post(f"/api/projects/{proj_id}/align-lyrics", json={"lyricsText": lyrics_text})
        check(res_align.status_code == 202, f"align-lyrics: 202 accepted (got {res_align.status_code})")
        job_id = res_align.json()["jobId"]

        deadline = time.time() + 5
        job_body = None
        while time.time() < deadline:
            job_body = client.get(f"/api/jobs/{job_id}").json()
            if job_body["status"] in ("done", "error"):
                break
            time.sleep(0.02)

        check(job_body is not None and job_body["status"] == "done", f"align-lyrics job: completes successfully ({job_body})")
        result = (job_body or {}).get("result") or {}
        persisted = result.get("lyricsAlignment")
        check(persisted is not None, f"align-lyrics job: result carries a lyricsAlignment record ({result})")
        if persisted:
            check(
                persisted["schemaVersion"] == alignment.LYRICS_ALIGNMENT_SCHEMA_VERSION,
                f"align-lyrics job: schemaVersion matches the named constant ({persisted.get('schemaVersion')})",
            )
            check(
                persisted["engine"] == alignment.ALIGNMENT_ENGINE_ID,
                f"align-lyrics job: engine matches the named constant ({persisted.get('engine')})",
            )
            check(persisted["lyricsSnapshot"] == lyrics_text, f"align-lyrics job: lyricsSnapshot is the exact submitted text ({persisted.get('lyricsSnapshot')})")
            check(
                persisted["vocalSource"] == real_fp,
                f"align-lyrics job: vocalSource matches the vocal track's own fingerprint ({persisted.get('vocalSource')} vs {real_fp})",
            )
            check(
                [w["text"] for w in persisted["words"]] == ["hello", "world"],
                f"align-lyrics job: words preserve original text/order ({persisted.get('words')})",
            )
    finally:
        client_cm.__exit__(None, None, None)
        projects_module.DATA_DIR = original_data_dir

finally:
    shutil.rmtree(TMP_DIR, ignore_errors=True)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nAll lyrics-alignment-persistence checks passed.")
