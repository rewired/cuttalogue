# Real-model smoke test for Phase 3a lyrics-to-vocal alignment
# (app/alignment.py). Unlike test_alignment.py (fast, fake aligner, no
# download), this exercises the actual torch/torchaudio MMS_FA pipeline
# end-to-end: real ffmpeg audio prep, the real ~1GB model (downloaded once
# into torch's hub cache on first run), and the real CTC forced aligner.
#
# NOT part of the fast regression suite - it can take anywhere from a few
# seconds (model already cached, CPU) to several minutes (first run,
# downloading the model on a slow connection). Run it manually after
# touching alignment.py's actual model-facing code:
#
#   backend/.venv/Scripts/python.exe backend/tests/test_alignment_smoke.py
#
# Generates its own test audio via Windows's built-in SAPI text-to-speech
# (this repo's dev tooling is already Windows-first - see start.ps1) rather
# than requiring a checked-in audio fixture: real, intelligible speech with
# a known transcript, which is exactly what a forced aligner needs to prove
# the pipeline actually works, without pretending it's a substitute for
# testing against real singing (see the module docstring in alignment.py -
# singing is harder and accuracy there isn't what this test claims to show).
import asyncio
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import alignment  # noqa: E402

failures = 0


def check(condition: bool, label: str) -> None:
    global failures
    if condition:
        print(f"ok - {label}")
    else:
        failures += 1
        print(f"FAIL: {label}")


LYRICS = "I know you're getting too close"
TMP_DIR = Path(tempfile.mkdtemp(prefix="cuttalogue-alignment-smoke-"))

try:
    speech_wav = TMP_DIR / "speech.wav"
    ps_script = (
        "Add-Type -AssemblyName System.Speech; "
        "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        f"$synth.SetOutputToWaveFile('{speech_wav}'); "
        f"$synth.Speak(\"{LYRICS}\"); "
        "$synth.Dispose()"
    )
    proc = subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], capture_output=True, text=True)
    check(proc.returncode == 0 and speech_wav.exists(), f"Setup: generated a real speech sample via Windows SAPI TTS ({speech_wav})")
    if proc.returncode != 0:
        print(proc.stderr)
        sys.exit(1)

    print("Running real alignment (first run may download the ~1GB model)...")
    workdir = TMP_DIR / "work"
    workdir.mkdir(parents=True, exist_ok=True)
    words = asyncio.run(alignment.align_lyrics(speech_wav, LYRICS, workdir))

    check(len(words) == len(LYRICS.split()), f"Job completes and returns one result per lyric word ({len(words)} of {len(LYRICS.split())})")

    aligned = [w for w in words if w["startSeconds"] is not None]
    check(len(aligned) > 0, f"At least one word was actually aligned ({len(aligned)} of {len(words)})")

    times = [(w["startSeconds"], w["endSeconds"]) for w in aligned]
    monotonic = all(times[i][0] <= times[i][1] for i in range(len(times))) and all(
        times[i][1] <= times[i + 1][0] + 1e-6 for i in range(len(times) - 1)
    )
    check(monotonic, f"Timestamps are monotonic across the aligned words: {times}")

    texts = [w["text"] for w in words]
    check(texts == LYRICS.split(), f"Original lyric words are preserved verbatim and in order: {texts}")

    for w in words:
        print(f"  {w['text']!r:12} start={w['startSeconds']} end={w['endSeconds']} confidence={w['confidence']}")

finally:
    shutil.rmtree(TMP_DIR, ignore_errors=True)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nReal alignment smoke test passed.")
