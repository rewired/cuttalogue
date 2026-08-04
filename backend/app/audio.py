# Uploads the mix/vocal track itself into the project folder. Separate from
# assets.py because there are exactly two well-known slots (mix, vocal), not
# an open pool - this is what export (frames.py math against real audio
# bytes) reads from, not something the user tags or assigns.
import shutil
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from .projects import project_dir

router = APIRouter()

VALID_TRACKS = ("mix", "vocal")


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
