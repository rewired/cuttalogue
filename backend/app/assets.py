# Asset import: copies uploaded files into the project's assets/ folder,
# probes them, and generates thumbnails. Deliberately does NOT touch
# project.json itself - the frontend merges the returned descriptors into its
# own state and the existing "save project" job (see projects.py) is what
# makes them durable, same as prompt/notes/tags/assignments already work.
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from . import media
from .projects import project_dir

router = APIRouter()


async def _describe_asset_file(asset_dir: Path, asset_id: str, dest: Path, filename: str) -> dict:
    # Probes+thumbnails a file already sitting at its final `dest` path and
    # builds the descriptor the frontend merges into state.assets.
    asset_type = media.guess_asset_type(filename)
    try:
        probe_data = await media.probe(dest)
        metadata = media.extract_metadata(probe_data)
    except Exception:
        metadata = dict(media.EMPTY_METADATA)

    thumbnail_path = None
    if asset_type in ("image", "video"):
        thumb_dest = asset_dir / "thumbnail.jpg"
        ok = await media.generate_thumbnail(dest, thumb_dest, asset_type, metadata.get("durationSeconds"))
        if ok:
            thumbnail_path = f"assets/{asset_id}/thumbnail.jpg"

    return {
        "id": asset_id,
        "type": asset_type,
        "fileName": filename,
        "relativePath": f"assets/{asset_id}/{filename}",
        "thumbnailPath": thumbnail_path,
        "metadata": metadata,
    }


async def _ingest_file(directory: Path, asset_id: str, src: Path, filename: str) -> dict:
    # Shared by every path that turns a file already on disk (an upload, a
    # promoted take) into an asset descriptor: copy into assets/<id>/, then
    # probe/thumbnail. `src` may already be inside `directory` (e.g. a take's
    # output.mp4) - copying instead of referencing in place keeps the asset
    # alive if the take/shot it came from is later deleted.
    asset_dir = directory / "assets" / asset_id
    asset_dir.mkdir(parents=True, exist_ok=True)
    dest = asset_dir / filename
    with src.open("rb") as in_fh, dest.open("wb") as out_fh:
        shutil.copyfileobj(in_fh, out_fh)
    return await _describe_asset_file(asset_dir, asset_id, dest, filename)


@router.post("/api/projects/{project_id}/assets")
async def import_assets(project_id: str, files: list[UploadFile] = File(...)):
    directory = project_dir(project_id)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="project not found")

    created = []
    for upload in files:
        asset_id = uuid.uuid4().hex[:8]
        asset_dir = directory / "assets" / asset_id
        asset_dir.mkdir(parents=True, exist_ok=True)
        dest = asset_dir / upload.filename
        with dest.open("wb") as out:
            shutil.copyfileobj(upload.file, out)

        descriptor = await _describe_asset_file(asset_dir, asset_id, dest, upload.filename)
        created.append({**descriptor, "tags": [], "description": "", "kind": None})

    return {"assets": created}


# Copies a finished generation take into the asset pool so it can be assigned
# to shots and picked as a reference/extend source like any imported file -
# the take itself (and its shot) can later be deleted without taking the
# asset with it. Descriptor shape matches import_assets so the frontend can
# feed it straight into assets.addAssets().
@router.post("/api/projects/{project_id}/shots/{shot_id}/takes/{take_id}/promote-to-asset")
async def promote_take_to_asset(project_id: str, shot_id: int, take_id: str):
    directory = project_dir(project_id)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="project not found")

    take_dir = directory / "shots" / str(shot_id) / "takes" / take_id
    src = take_dir / "output.mp4"
    if not src.exists():
        raise HTTPException(status_code=404, detail="take output not found")

    asset_id = uuid.uuid4().hex[:8]
    filename = f"take-{shot_id}-{take_id}.mp4"
    descriptor = await _ingest_file(directory, asset_id, src, filename)
    return {**descriptor, "tags": [], "description": "", "kind": None}


# Swaps the underlying file for an existing asset while keeping its id (and
# therefore every shot assignment, tag, description that already references
# it) - only the file-derived fields (type/fileName/relativePath/thumbnail/
# metadata) get replaced. The old file and thumbnail are deleted so the
# project folder doesn't accumulate orphaned uploads.
@router.post("/api/projects/{project_id}/assets/{asset_id}/replace")
async def replace_asset(project_id: str, asset_id: str, file: UploadFile = File(...)):
    directory = project_dir(project_id)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="project not found")

    asset_dir = directory / "assets" / asset_id
    if not asset_dir.exists():
        raise HTTPException(status_code=404, detail="asset not found")

    for existing in asset_dir.iterdir():
        if existing.is_file():
            existing.unlink()

    dest = asset_dir / file.filename
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    return await _describe_asset_file(asset_dir, asset_id, dest, file.filename)
