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
import time
import traceback
import uuid
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

# Phase 5.1: the single provenance identifiers stamped onto a persisted
# lyricsAlignment record (see project.js's serializeProject) - never
# duplicated as string literals elsewhere.
ALIGNMENT_ENGINE_ID = "torchaudio-mms-fa"
LYRICS_ALIGNMENT_SCHEMA_VERSION = 1

# A specific, collision-safe cache filename for the MMS_FA checkpoint -
# passed to bundle.get_model(dl_kwargs=...) below. Without this,
# torch.hub.load_state_dict_from_url defaults to the URL's basename
# ("model.pt"), which on a real machine collides with the same generic
# filename other unrelated tools' checkpoints already use in the same
# shared ~/.cache/torch/hub/checkpoints/ directory - also what makes
# is_model_downloaded() below a reliable check rather than a guess.
ALIGNMENT_MODEL_FILENAME = "mms_fa_ctc_alignment_mling_uroman.pt"


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


def _model_cache_path() -> Path:
    import torch

    return Path(torch.hub.get_dir()) / "checkpoints" / ALIGNMENT_MODEL_FILENAME


def is_model_downloaded() -> bool:
    """Whether the MMS_FA checkpoint is already present in torch's hub
    cache on disk - distinct from is_model_loaded() below, which is about
    this *process* having it in memory. A model can already be downloaded
    (fast to load) without yet being loaded in this particular backend
    process; see align_lyrics_endpoint's run() for how the two combine into
    an honest download/loading/aligning phase sequence."""
    return _model_cache_path().exists()


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
    # dl_kwargs routes straight through to torch.hub.load_state_dict_from_url
    # - see ALIGNMENT_MODEL_FILENAME's own comment for why a specific
    # filename matters. If _download_model_with_progress already fetched
    # the checkpoint (align_lyrics_endpoint's run()), this finds it already
    # cached and downloads nothing; otherwise it's the (progress-less)
    # fallback download path.
    model = bundle.get_model(dl_kwargs={"file_name": ALIGNMENT_MODEL_FILENAME})
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


# MMS_FA's dictionary only covers lowercase a-z and apostrophe (it's designed
# to work with uroman-romanized text for non-Latin scripts, which this module
# doesn't attempt - see the module docstring/completion report for that as a
# deferred limitation). This ONLY produces the token fed to the model; the
# original word - "clooooose", "you're", any capitalization or punctuation -
# is what's returned as `text` and what the caller displays/stores. A word
# that normalizes to nothing (pure punctuation, or a script this can't
# tokenize) has no target to align against, so it's excluded from the model
# call entirely rather than guessed at.
#
# Disallowed characters are DELETED, never replaced with a space: every
# element of _split_words()/_split_words_with_positions() is already a
# single whitespace-free token (split on \S+), and torchaudio's aligner
# expects each normalized target to stay exactly one word with no internal
# whitespace. A hyphenated/dashed compound written as one token - "in-
# between.", or this project's own "[Pre-Chorus]"-style bracketed section
# markers - used to normalize to "in between"/"pre chorus" (the internal
# punctuation became a space instead of disappearing), silently turning one
# aligner target into a string containing a literal space character, which
# crashes deep inside torchaudio's per-character dictionary lookup
# (KeyError: ' ') since space was never actually in that dictionary. Deleting
# instead of substituting keeps every normalized target a single token.
def _normalize_for_alignment(word: str) -> str:
    text = word.lower().replace("’", "'")
    text = re.sub(r"[^a-z']", "", text)
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


# Streams the MMS_FA checkpoint ourselves rather than letting torch.hub do
# it - torch.hub.download_url_to_file only prints a local tqdm bar to this
# process's own stderr with no hook exposed for external progress reporting
# (confirmed by reading its source), so real byte-level progress needs its
# own download. Writes to a temp file next to the real cache path, then
# renames atomically on success - the same "never leave a broken file at
# the real cache path" behavior torch.hub's own downloader has. Once this
# returns, _load_bundle()'s bundle.get_model() call finds the file already
# cached (same path, via ALIGNMENT_MODEL_FILENAME) and downloads nothing.
async def _download_model_with_progress(job: jobs.Job) -> None:
    if is_model_downloaded():
        return

    import torchaudio

    url = getattr(torchaudio.pipelines.MMS_FA, "_path", None)
    if not url:
        # torchaudio internals changed underneath us - fall back to
        # bundle.get_model()'s own (progress-less) download rather than
        # failing alignment outright.
        logger.warning("Could not determine the MMS_FA checkpoint URL - skipping progress-reported download.")
        return

    import httpx

    dest = _model_cache_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_dest = dest.with_name(dest.name + f".{uuid.uuid4().hex}.partial")

    timeout = httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=30.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                total = int(response.headers.get("content-length") or 0)
                downloaded = 0
                last_emit = 0.0
                with tmp_dest.open("wb") as f:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        f.write(chunk)
                        downloaded += len(chunk)
                        now = time.monotonic()
                        if now - last_emit < 0.5 and downloaded != total:
                            continue
                        last_emit = now
                        mb_downloaded = downloaded / (1024 * 1024)
                        if total:
                            mb_total = total / (1024 * 1024)
                            message = f"Downloading alignment model: {mb_downloaded:.0f}/{mb_total:.0f} MB"
                            fraction = downloaded / total
                        else:
                            # No Content-Length from the server - report what
                            # we know (bytes so far) without a fabricated
                            # percentage; the frontend hides the bar and
                            # shows this text alone in that case.
                            message = f"Downloading alignment model: {mb_downloaded:.0f} MB"
                            fraction = None
                        await jobs.emit(
                            job,
                            {"status": "running", "phase": "downloading_model", "message": message, "progressFraction": fraction},
                        )
        tmp_dest.replace(dest)
    finally:
        if tmp_dest.exists():
            tmp_dest.unlink()


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

            # Its own explicit phase with real byte progress (see
            # _download_model_with_progress) - only when a download is
            # actually needed, never run for an already-downloaded/already-
            # loaded model.
            if not is_model_loaded() and not is_model_downloaded():
                await jobs.emit(
                    job,
                    {
                        "status": "running",
                        "phase": "downloading_model",
                        "message": "Downloading alignment model (first run only, ~1.2GB)…",
                        "progressFraction": 0.0,
                    },
                )
                await _download_model_with_progress(job)

            # Honest phase message rather than a fabricated percentage (see
            # is_model_loaded's docstring) - downloading is already reported
            # separately above, so this only ever covers fast deserialization
            # of an already-downloaded checkpoint into this process.
            loading_message = "Aligning lyrics" if is_model_loaded() else "Loading alignment model…"
            await jobs.emit(job, {"status": "running", "phase": "aligning", "message": loading_message})
            words = await run_alignment(wav_path, lyrics_text)
            if not any(w["startSeconds"] is not None for w in words):
                raise RuntimeError(
                    "Alignment produced no usable word timings - the vocal track and lyrics may not "
                    "correspond, or the supplied lyrics contain no alignable words."
                )
            # One canonical result shape (Phase 5.1) - the frontend uses this
            # directly both as the transient preview (words) and, unchanged,
            # as what gets written into project.json on Save. See
            # audio.track_fingerprint's docstring for why vocal identity is
            # captured here rather than recomputed later.
            job.result = {
                "lyricsAlignment": {
                    "schemaVersion": LYRICS_ALIGNMENT_SCHEMA_VERSION,
                    "engine": ALIGNMENT_ENGINE_ID,
                    "lyricsSnapshot": lyrics_text,
                    "vocalSource": audio.track_fingerprint(data, directory, "vocal"),
                    "words": words,
                }
            }
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
