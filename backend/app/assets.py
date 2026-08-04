# Asset import: copies uploaded files into the project's assets/ folder,
# probes them, and generates thumbnails. Deliberately does NOT touch
# project.json itself - the frontend merges the returned descriptors into its
# own state and the existing "save project" job (see projects.py) is what
# makes them durable, same as prompt/notes/tags/assignments already work.
import shutil
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile

from . import media
from .projects import project_dir

router = APIRouter()


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

        asset_type = media.guess_asset_type(upload.filename)
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

        created.append(
            {
                "id": asset_id,
                "type": asset_type,
                "fileName": upload.filename,
                "relativePath": f"assets/{asset_id}/{upload.filename}",
                "thumbnailPath": thumbnail_path,
                "tags": [],
                "description": "",
                "metadata": metadata,
            }
        )

    return {"assets": created}
