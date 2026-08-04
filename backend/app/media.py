# ffprobe metadata extraction and ffmpeg thumbnail generation for imported
# assets. Both shell out synchronously and get offloaded to a thread so they
# don't block the event loop - there's no need for the job/SSE machinery here,
# a single ffprobe/ffmpeg call is over before a progress bar would matter.
import json
import subprocess
from pathlib import Path

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
