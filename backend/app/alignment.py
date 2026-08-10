# Phase 3a: local word-level lyrics-to-vocal forced alignment. Given the
# project's own vocal track and lyrics text the user supplies, finds where
# each supplied word occurs in the audio - a forced-alignment problem
# ("where does this known text occur"), not a transcription problem ("what
# was sung"). The user's lyrics are never replaced by whatever an ASR model
# thinks it heard; see _normalize_for_alignment's docstring.
#
# Engine: torchaudio's MMS_FA bundle (a CTC forced-aligner over a
# Wav2Vec2-family acoustic model), the smallest local dependency that does
# genuine forced alignment rather than ASR - two pip packages (torch,
# torchaudio), no espeak/native toolchain (unlike aeneas), no cloud API.
# Runs on CPU by default; picks up CUDA automatically if a GPU-enabled torch
# build happens to be installed, but never requires one. The ~1GB model
# downloads once into torch's own hub cache on first use.
#
# Everything engine-specific lives in this one module - a future Phase 3b
# swapping the engine (or adding phrase/hold detection on top of these same
# word timings) should never need to touch project state, the frontend,
# MSE.vocalCues, or the Direction editor. See align_lyrics()'s return
# contract, which is the only thing callers depend on.
import array
import asyncio
import json
import logging
import re
import shutil
import subprocess
import traceback
import wave
from pathlib import Path
from typing import TypedDict

from fastapi import APIRouter, Body, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import audio, jobs
from .projects import project_dir

logger = logging.getLogger("cuttalogue.alignment")

router = APIRouter()


class WordAlignment(TypedDict):
    text: str
    startSeconds: float | None
    endSeconds: float | None
    confidence: float | None
    # Transient structural metadata (Phase 3b) - which original lyric line
    # this word came from (its position in lyrics_text.split("\n"), blank
    # lines included in the count) and this word's own position in the flat
    # result list. Lets a caller holding the same lyrics_text regroup words
    # back into lines - and therefore derive phrase/hold regions - without a
    # second tokenizer that could drift from the one below. Never copied into
    # persistent vocalCues.
    lineIndex: int
    wordIndex: int


# Populated lazily by _load_bundle() and kept for the lifetime of the
# backend process - loading the model is the expensive part (weight
# download/deserialization), so repeated alignment jobs in the same process
# reuse it instead of paying that cost per request.
_bundle_cache: dict = {}


def _load_bundle():
    if "model" in _bundle_cache:
        return _bundle_cache
    try:
        import torch
        import torchaudio
    except ImportError as exc:
        raise RuntimeError(
            "Local alignment requires torch and torchaudio, which are not installed in this "
            "backend's virtual environment. Run: backend/.venv/Scripts/python.exe -m pip install "
            "-r backend/requirements.txt (this also downloads a ~1GB model on first use)."
        ) from exc

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model()
    # Conservative GPU use (see file header): only used if a CUDA-enabled
    # torch build AND a working device are both already present, never
    # required - CPU is plenty fast for aligning one song's vocal stem
    # (a few hundred words), see the smoke test in test_alignment_smoke.py.
    device = torch.device("cuda") if torch.cuda.is_available() else torch.device("cpu")
    model = model.to(device)
    _bundle_cache.update(
        {
            "bundle": bundle,
            "model": model,
            "tokenizer": bundle.get_tokenizer(),
            "aligner": bundle.get_aligner(),
            "device": device,
        }
    )
    return _bundle_cache


def _split_words_with_positions(lyrics_text: str) -> list[tuple[str, int]]:
    """Returns (word, lineIndex) pairs in original order. lineIndex is the
    word's literal position in lyrics_text.split("\\n") - blank lines count
    towards it even though they contribute no words - so a caller holding
    the same lyrics_text can always recover the exact original line text via
    lyrics_text.split("\\n")[lineIndex]. Word content/order is identical to
    _split_words() below; this only adds position metadata."""
    result = []
    for line_index, line in enumerate(lyrics_text.split("\n")):
        for word in re.findall(r"\S+", line):
            result.append((word, line_index))
    return result


def _split_words(lyrics_text: str) -> list[str]:
    return [word for word, _ in _split_words_with_positions(lyrics_text)]


# MMS_FA's dictionary only covers lowercase a-z, apostrophe, and space (it's
# designed to work with uroman-romanized text for non-Latin scripts, which
# this module doesn't attempt - see the module docstring/completion report
# for that as a deferred limitation). This ONLY produces the token fed to the
# model; the original word - "clooooose", "you're", any capitalization or
# punctuation - is what's returned as `text` and what the caller displays/
# stores. A word that normalizes to nothing (pure punctuation, or a script
# this can't tokenize) has no target to align against, so it's excluded from
# the model call entirely rather than guessed at.
def _normalize_for_alignment(word: str) -> str:
    text = word.lower().replace("’", "'")
    text = re.sub(r"[^a-z' ]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _convert_to_mono16k_sync(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(source), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", str(dest)],
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"audio preparation failed: {result.stderr.decode(errors='ignore')[-500:]}")


# Reads the mono/16-bit/16kHz PCM WAV _convert_to_mono16k_sync produced,
# without going through torchaudio.load() - newer torchaudio versions route
# that through an optional torchcodec dependency this project doesn't need,
# since the exact format is already guaranteed by the ffmpeg step above.
# Returns a [1, num_samples] float32 tensor in [-1, 1], matching what
# torchaudio.load would have given us.
def _read_wav_mono16k(path: Path):
    import torch

    with wave.open(str(path), "rb") as wf:
        if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
            raise RuntimeError("internal error: alignment WAV was not mono 16-bit PCM")
        raw = wf.readframes(wf.getnframes())
    samples = array.array("h")
    samples.frombytes(raw)
    tensor = torch.tensor(samples, dtype=torch.float32) / 32768.0
    return tensor.unsqueeze(0)


def _align_sync(wav_path: Path, lyrics_text: str) -> list[WordAlignment]:
    import torch

    loaded = _load_bundle()
    model, tokenizer, aligner, device = loaded["model"], loaded["tokenizer"], loaded["aligner"], loaded["device"]

    word_positions = _split_words_with_positions(lyrics_text)
    original_words = [w for w, _ in word_positions]
    normalized_words = [_normalize_for_alignment(w) for w in original_words]

    results: list[WordAlignment] = [
        {
            "text": w,
            "startSeconds": None,
            "endSeconds": None,
            "confidence": None,
            "lineIndex": line_index,
            "wordIndex": i,
        }
        for i, (w, line_index) in enumerate(word_positions)
    ]
    alignable_indices = [i for i, w in enumerate(normalized_words) if w]
    if not alignable_indices:
        return results

    waveform = _read_wav_mono16k(wav_path).to(device)
    targets = [normalized_words[i] for i in alignable_indices]

    with torch.inference_mode():
        emission, _ = model(waveform)
        token_spans = aligner(emission[0], tokenizer(targets))

    num_frames = emission.shape[1]
    ratio = waveform.shape[1] / num_frames / 16000

    for local_index, original_index in enumerate(alignable_indices):
        spans = token_spans[local_index]
        if not spans:
            continue
        start = spans[0].start * ratio
        end = spans[-1].end * ratio
        # TokenSpan.score is the model's own per-token log-probability
        # (genuinely produced by the aligner, never invented) - averaged
        # across the word's tokens weighted by each token's frame length,
        # the same scoring convention as torchaudio's own CTC forced-
        # alignment tutorial.
        total_len = sum(len(s) for s in spans)
        confidence = sum(s.score * len(s) for s in spans) / total_len if total_len else None
        # .update(), not a wholesale replace - keeps lineIndex/wordIndex set above.
        results[original_index].update(
            {
                "startSeconds": round(float(start), 3),
                "endSeconds": round(float(end), 3),
                "confidence": round(float(confidence), 4) if confidence is not None else None,
            }
        )

    return results


def is_model_loaded() -> bool:
    """Whether _load_bundle() has already run in this process - lets the job
    endpoint below emit an honest "loading model" vs "aligning" phase message
    instead of a fabricated one."""
    return "model" in _bundle_cache


async def prepare_audio(vocal_path: Path, workdir: Path) -> Path:
    """Renders a temporary mono/16kHz PCM copy of vocal_path into workdir
    (a job-scoped scratch directory the caller owns and cleans up) and
    returns its path. Never touches vocal_path itself."""
    wav_path = workdir / "vocal_16k.wav"
    await run_in_threadpool(_convert_to_mono16k_sync, vocal_path, wav_path)
    return wav_path


async def run_alignment(wav_path: Path, lyrics_text: str) -> list[WordAlignment]:
    """Aligns lyrics_text against the (already mono/16kHz) audio at wav_path.
    Returns one WordAlignment per whitespace-separated token in lyrics_text,
    in original order - startSeconds/endSeconds are None for a word that
    could not be given to the aligner at all (see _normalize_for_alignment);
    callers must not invent a timestamp for those."""
    return await run_in_threadpool(_align_sync, wav_path, lyrics_text)


async def align_lyrics(vocal_path: Path, lyrics_text: str, workdir: Path) -> list[WordAlignment]:
    """Convenience wrapper composing prepare_audio() + run_alignment() - used
    directly by the smoke test and pure-logic tests; the job endpoint below
    calls the two steps separately so it can emit an accurate phase between
    them."""
    wav_path = await prepare_audio(vocal_path, workdir)
    return await run_alignment(wav_path, lyrics_text)


def _error_message(exc: Exception) -> str:
    return str(exc) or repr(exc)


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    return json.loads(project_file.read_text(encoding="utf-8")), directory


# POST /align-lyrics never writes project.json itself (same convention as
# describe.py/comfy.py) - it returns transient word timings; the frontend
# only ever turns them into real vocalCues through MSE.vocalCues.add() and
# the normal Save path, same as a generated take becomes a real shot take.
@router.post("/api/projects/{project_id}/align-lyrics")
async def align_lyrics_endpoint(project_id: str, body: dict = Body(default={})):
    data, directory = _load_project(project_id)

    lyrics_text = body.get("lyricsText") or ""
    if not _split_words(lyrics_text):
        raise HTTPException(status_code=400, detail="Enter lyrics before alignment.")

    # The vocal track, never the full mix - same canonical resolution Phase 1
    # uses for H3 lip-sync reference audio (see audio.require_track), so a
    # missing vocal track fails the same clear way here too.
    try:
        vocal_path = audio.require_track(data, directory, "vocal")
    except HTTPException as exc:
        raise HTTPException(status_code=400, detail="No vocal track is available for this project.") from exc

    job = jobs.create_job()

    # Job-scoped scratch dir for the temporary mono/16kHz conversion (see
    # align_lyrics) - unique per job so concurrent/repeated alignment runs
    # never collide, cleaned up regardless of outcome. Never touches the
    # project's own stored vocal file, same reasoning as comfy.py's
    # generation_dir for lip-sync audio.
    workdir = directory / "alignment" / job.id

    async def run():
        try:
            workdir.mkdir(parents=True, exist_ok=True)
            await jobs.emit(job, {"status": "running", "phase": "audio", "message": "Preparing vocal audio"})
            wav_path = await prepare_audio(vocal_path, workdir)

            # Honest phase message rather than a fabricated percentage (see
            # is_model_loaded's docstring) - the model download/load on a
            # cold process can take a while, so it's worth calling out
            # separately from the (usually much faster) alignment pass itself.
            loading_message = "Aligning lyrics" if is_model_loaded() else "Loading alignment model (first run downloads it, may take a while)"
            await jobs.emit(job, {"status": "running", "phase": "aligning", "message": loading_message})
            words = await run_alignment(wav_path, lyrics_text)
            if not any(w["startSeconds"] is not None for w in words):
                raise RuntimeError(
                    "Alignment produced no usable word timings - the vocal track and lyrics may not "
                    "correspond, or the supplied lyrics contain no alignable words."
                )
            job.result = {"words": words}
            await jobs.emit(job, {"status": "done", "phase": "complete", "message": "Done", "result": job.result})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            logger.error("align-lyrics failed for project %s: %s", project_id, traceback.format_exc())
            job.error = _error_message(exc)
            await jobs.emit(job, {"status": "error", "message": job.error})
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id})
