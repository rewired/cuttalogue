# Uploads the mix/vocal track itself into the project folder. Separate from
# assets.py because there are exactly two well-known slots (mix, vocal), not
# an open pool - this is what export (frames.py math against real audio
# bytes) and comfy.py (H3 lip-sync reference audio) both read from, not
# something the user tags or assigns.
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from .projects import project_dir

router = APIRouter()

VALID_TRACKS = ("mix", "vocal")


def require_track(data: dict, directory: Path, track: str) -> Path:
    rel = ((data.get("audio") or {}).get(track) or {}).get("relativePath")
    if not rel:
        raise HTTPException(status_code=400, detail=f"no {track} track uploaded for this project yet")
    path = directory / rel
    if not path.exists():
        raise HTTPException(status_code=400, detail=f"{track} track file is missing on disk")
    return path


def optional_track(data: dict, directory: Path, track: str) -> Path | None:
    rel = ((data.get("audio") or {}).get(track) or {}).get("relativePath")
    if not rel:
        return None
    path = directory / rel
    return path if path.exists() else None


# Phase 5.1: the one place a track's on-disk identity is fingerprinted, so
# both align_lyrics_endpoint (stamping a fresh lyricsAlignment.vocalSource)
# and the read-only endpoint below (checking whether a persisted alignment
# is still valid) agree on the same lightweight, non-cryptographic identity -
# relative path + size + mtime, not a content hash (see the Phase 5.1 spec's
# "reliable practical invalidation, not forensic identity").
def track_fingerprint(data: dict, directory: Path, track: str) -> dict | None:
    path = optional_track(data, directory, track)
    if path is None:
        return None
    rel = ((data.get("audio") or {}).get(track) or {}).get("relativePath")
    stat = path.stat()
    return {"relativePath": rel, "sizeBytes": stat.st_size, "mtimeMs": stat.st_mtime * 1000}


@router.post("/api/projects/{project_id}/audio/{track}")
async def upload_audio(project_id: str, track: str, file: UploadFile = File(...)):
    if track not in VALID_TRACKS:
        raise HTTPException(status_code=400, detail="track must be 'mix' or 'vocal'")
    directory = project_dir(project_id)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="project not found")

    audio_dir = directory / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    # Drop any previous upload for this track (possibly a different
    # extension) before writing the new one, so re-loading a track doesn't
    # leave a stale file another track's export could accidentally pick up.
    for existing in audio_dir.glob(f"{track}.*"):
        existing.unlink()

    ext = Path(file.filename).suffix or ".wav"
    dest = audio_dir / f"{track}{ext}"
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    return {"relativePath": f"audio/{dest.name}", "fileName": file.filename}


# Phase 5.1: lets the frontend learn the *current* on-disk vocal (or mix)
# fingerprint on project load/vocal change without running MMS - a persisted
# lyricsAlignment.vocalSource is only ever compared against this, never
# recomputed by re-running alignment. Read-only, never touches project.json.
@router.get("/api/projects/{project_id}/audio/{track}/fingerprint")
async def get_track_fingerprint(project_id: str, track: str):
    if track not in VALID_TRACKS:
        raise HTTPException(status_code=400, detail="track must be 'mix' or 'vocal'")
    directory = project_dir(project_id)
    file = directory / "project.json"
    if not file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(file.read_text(encoding="utf-8"))
    return {"fingerprint": track_fingerprint(data, directory, track)}
