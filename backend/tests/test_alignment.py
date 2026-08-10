# Regression coverage for Phase 3a lyrics-to-vocal alignment (app/alignment.py).
# Same dependency-free-of-a-test-framework style as test_lip_sync_audio.py:
# a plain script using FastAPI's TestClient (already in requirements.txt) and
# a fake aligner/tokenizer/model swapped into alignment._bundle_cache so
# these run in well under a second and never touch torch/torchaudio's real
# ~1GB MMS_FA model or download anything - see test_alignment_smoke.py for
# the real-model check, documented and run separately.
#
# Run with:
#   backend/.venv/Scripts/python.exe backend/tests/test_alignment.py
import json
import shutil
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import alignment  # noqa: E402
from app import projects as projects_module  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


TMP_DIR = Path(tempfile.mkdtemp(prefix="cuttalogue-alignment-test-"))


def make_silent_wav(path: Path, num_samples: int, sample_rate: int = 16000) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * num_samples)


# --- Fake CTC aligner/tokenizer/model, deterministic and instant ------------
# See file header - installed straight into alignment._bundle_cache so
# _load_bundle()'s early-return path is taken and torch/torchaudio's real
# model is never loaded. Frame math is chosen so ratio = waveform_samples /
# num_frames / sample_rate works out to exactly 0.01s/frame - see the
# per-word frame windows below.


class FakeSpan:
    def __init__(self, start: int, end: int, score: float):
        self.start = start
        self.end = end
        self.score = score

    def __len__(self) -> int:
        return self.end - self.start


# Maps each *alignable* (non-empty-normalized) word, in order, to its frame
# window/score - populated per-test right before calling _align_sync.
_next_word_spans: list[list[FakeSpan]] = []


def fake_tokenizer(words):
    return [[1] for _ in words]


def fake_aligner(_emission, tokens):
    assert len(tokens) == len(_next_word_spans), "fake aligner called with unexpected word count"
    return _next_word_spans


def fake_model(waveform):
    import torch

    # 100 frames over a 16000-sample/16kHz waveform -> ratio 0.01s/frame,
    # so a FakeSpan's frame indices are just the word's timestamp in
    # centiseconds - easy to pick exact expected seconds below.
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
    wav_path = TMP_DIR / "silent_16k.wav"
    make_silent_wav(wav_path, num_samples=16000)

    # --- Case C: result normalization / deterministic chronological order ----
    # "hello" -> frames 0-10 (0.00s-0.10s), "world" -> frames 20-40
    # (0.20s-0.40s); "!!!" normalizes to "" and must never reach the aligner.
    _next_word_spans[:] = [[FakeSpan(0, 10, 0.9)], [FakeSpan(20, 40, 0.5)]]
    lyrics = "hello !!! world"
    import asyncio

    results = asyncio.run(alignment.run_alignment(wav_path, lyrics))

    check(len(results) == 3, f"Case C: one result per input token, got {len(results)}")
    check(
        [r["text"] for r in results] == ["hello", "!!!", "world"],
        "Case C: results keep the original word order (deterministic, chronological)",
    )
    check(results[0]["startSeconds"] == 0.0 and results[0]["endSeconds"] == 0.1, f"Case C: 'hello' timing {results[0]}")
    check(results[2]["startSeconds"] == 0.2 and results[2]["endSeconds"] == 0.4, f"Case C: 'world' timing {results[2]}")
    check(results[0]["confidence"] == 0.9, f"Case C: 'hello' confidence is the fake aligner's own score, not invented ({results[0]['confidence']})")
    check(
        results[0]["startSeconds"] < results[2]["startSeconds"],
        "Case C: aligned words come back in non-decreasing time order",
    )

    # --- Case D: original-text preservation ------------------------------------
    _next_word_spans[:] = [[FakeSpan(0, 5, 0.7)], [FakeSpan(10, 15, 0.7)]]
    lyrics_d = "I know you're getting too clooooose"
    # Only "you're" and "clooooose" are exercised against the fake aligner
    # here (2 spans set above) - the other four words also normalize to
    # non-empty tokens, so make the fake list match the actual alignable
    # count for this input instead.
    normalized = [alignment._normalize_for_alignment(w) for w in alignment._split_words(lyrics_d)]
    alignable_count = sum(1 for w in normalized if w)
    _next_word_spans[:] = [[FakeSpan(i * 10, i * 10 + 5, 0.8)] for i in range(alignable_count)]
    results_d = asyncio.run(alignment.run_alignment(wav_path, lyrics_d))
    texts = [r["text"] for r in results_d]
    check(texts == ["I", "know", "you're", "getting", "too", "clooooose"], f"Case D: original tokens preserved verbatim: {texts}")
    check("you're" in texts, "Case D: contraction \"you're\" is not rewritten")
    check("clooooose" in texts, "Case D: elongated word \"clooooose\" is not rewritten to \"close\"")

    # --- Case G: a genuinely unalignable word never gets a fabricated timestamp
    _next_word_spans[:] = [[FakeSpan(0, 5, 0.6)]]
    results_g = asyncio.run(alignment.run_alignment(wav_path, "word ---"))
    check(results_g[1]["text"] == "---", "Case G: the unalignable token is still present in the result")
    check(
        results_g[1]["startSeconds"] is None and results_g[1]["endSeconds"] is None,
        f"Case G: no timestamp is invented for an unalignable word ({results_g[1]})",
    )

    # --- Case B: backend validation --------------------------------------------
    from fastapi.testclient import TestClient  # noqa: E402

    from app.main import app  # noqa: E402

    original_data_dir = projects_module.DATA_DIR
    try:
        test_data_dir = TMP_DIR / "projects"
        test_data_dir.mkdir(parents=True, exist_ok=True)
        projects_module.DATA_DIR = test_data_dir

        # A project with no vocal track uploaded.
        no_vocal_id = "no-vocal-proj"
        no_vocal_dir = test_data_dir / no_vocal_id
        no_vocal_dir.mkdir(parents=True, exist_ok=True)
        (no_vocal_dir / "project.json").write_text(json.dumps({"audio": {}}), encoding="utf-8")

        client = TestClient(app)

        res_missing_vocal = client.post(f"/api/projects/{no_vocal_id}/align-lyrics", json={"lyricsText": "hello world"})
        check(res_missing_vocal.status_code == 400, f"Case B: missing vocal track returns HTTP 400 (got {res_missing_vocal.status_code})")
        check("vocal" in (res_missing_vocal.json().get("detail") or "").lower(), "Case B: error message mentions the vocal track")

        res_empty_lyrics = client.post(f"/api/projects/{no_vocal_id}/align-lyrics", json={"lyricsText": "   "})
        check(res_empty_lyrics.status_code == 400, f"Case B: empty/whitespace-only lyrics returns HTTP 400 (got {res_empty_lyrics.status_code})")
        check(
            "lyrics" in (res_empty_lyrics.json().get("detail") or "").lower(),
            "Case B: error message mentions lyrics",
        )

        res_missing_project = client.post("/api/projects/does-not-exist/align-lyrics", json={"lyricsText": "hello"})
        check(res_missing_project.status_code == 404, f"Case B: unknown project returns HTTP 404 (got {res_missing_project.status_code})")
    finally:
        projects_module.DATA_DIR = original_data_dir

finally:
    shutil.rmtree(TMP_DIR, ignore_errors=True)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nAll alignment checks passed.")
