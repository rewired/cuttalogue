# ffprobe metadata extraction and ffmpeg thumbnail generation for imported
# assets. Both shell out synchronously and get offloaded to a thread so they
# don't block the event loop - there's no need for the job/SSE machinery here,
# a single ffprobe/ffmpeg call is over before a progress bar would matter.
#
# run_ffmpeg_with_progress, below, is the one genuinely long-running ffmpeg
# call (export encoding) - it runs as a real asyncio subprocess so its
# -progress pipe:1 output can be parsed and forwarded as job progress while
# it's still running, rather than shelling out and blocking.
import asyncio
import json
import subprocess
from pathlib import Path
from typing import Awaitable, Callable

from fastapi.concurrency import run_in_threadpool

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}

EMPTY_METADATA = {
    "durationSeconds": None,
    "width": None,
    "height": None,
    "fps": None,
    "codec": None,
    "sampleRate": None,
    "channels": None,
}


def guess_asset_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return "other"


def _probe_sync(path: Path) -> dict:
    proc = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


async def probe(path: Path) -> dict:
    return await run_in_threadpool(_probe_sync, path)


def _parse_fps(rate: str | None) -> float | None:
    if not rate or rate == "0/0":
        return None
    num, _, den = rate.partition("/")
    try:
        num_f, den_f = float(num), float(den or 1)
        return round(num_f / den_f, 3) if den_f else None
    except ValueError:
        return None


def extract_metadata(probe_data: dict) -> dict:
    fmt = probe_data.get("format", {})
    streams = probe_data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = fmt.get("duration")
    sample_rate = audio.get("sample_rate") if audio else None
    return {
        "durationSeconds": float(duration) if duration else None,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": _parse_fps(video.get("r_frame_rate")) if video else None,
        "codec": (video or audio or {}).get("codec_name"),
        "sampleRate": int(sample_rate) if sample_rate else None,
        "channels": audio.get("channels") if audio else None,
    }


def _thumbnail_sync(src: Path, dest: Path, asset_type: str, duration: float | None) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if asset_type == "image":
        cmd = ["ffmpeg", "-y", "-i", str(src), "-vf", "scale=320:-1", "-frames:v", "1", str(dest)]
    elif asset_type == "video":
        seek = min(1.0, duration / 2) if duration else 0
        cmd = ["ffmpeg", "-y", "-ss", str(seek), "-i", str(src), "-vf", "scale=320:-1", "-frames:v", "1", str(dest)]
    else:
        return False
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0 and dest.exists()


async def generate_thumbnail(src: Path, dest: Path, asset_type: str, duration: float | None) -> bool:
    return await run_in_threadpool(_thumbnail_sync, src, dest, asset_type, duration)


class FFmpegError(RuntimeError):
    pass


class FFmpegCancelled(Exception):
    pass


async def run_ffmpeg_with_progress(
    cmd: list[str],
    expected_duration_seconds: float,
    on_progress: Callable[[float], Awaitable[None]],
    should_cancel: Callable[[], bool] | None = None,
) -> None:
    # -progress pipe:1 makes ffmpeg emit machine-readable key=value lines
    # (out_time_ms=..., progress=continue|end) on stdout as it works, instead
    # of only human-readable stats on stderr - that's what turns this into a
    # real progress fraction rather than a spinner. should_cancel is polled
    # between lines so a cancelled batch export can kill an in-flight encode
    # instead of waiting for it to finish first.
    full_cmd = [*cmd, "-progress", "pipe:1", "-nostats"]
    proc = await asyncio.create_subprocess_exec(
        *full_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    stderr_chunks: list[bytes] = []

    async def drain_stderr():
        assert proc.stderr is not None
        async for chunk in proc.stderr:
            stderr_chunks.append(chunk)

    stderr_task = asyncio.create_task(drain_stderr())

    assert proc.stdout is not None
    cancelled = False
    async for raw_line in proc.stdout:
        if should_cancel and should_cancel():
            cancelled = True
            proc.terminate()
            break
        line = raw_line.decode(errors="ignore").strip()
        if line.startswith("out_time_ms="):
            try:
                out_time_ms = int(line.split("=", 1)[1])
            except ValueError:
                continue
            if expected_duration_seconds > 0:
                fraction = (out_time_ms / 1_000_000) / expected_duration_seconds
                await on_progress(min(1.0, max(0.0, fraction)))
        elif line == "progress=end":
            break

    await proc.wait()

    if cancelled:
        # A forcefully terminated process's stderr pipe doesn't reliably signal
        # EOF promptly on Windows (ProactorEventLoop) even though the process
        # has already exited - awaiting drain_stderr() here has been observed
        # to stall for the remainder of what would have been the full encode
        # time. Cancelling it instead is safe: stderr's only consumer is the
        # error message below, which a cancellation never needs.
        stderr_task.cancel()
        try:
            await stderr_task
        except asyncio.CancelledError:
            pass
        raise FFmpegCancelled()

    await stderr_task

    if proc.returncode != 0:
        stderr_text = b"".join(stderr_chunks).decode(errors="ignore")
        raise FFmpegError(stderr_text[-2000:])
