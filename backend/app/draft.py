# Draft autosave: a continuously-updated sibling to project.json
# (project.draft.json) that the frontend polls-and-diffs into on a timer, so
# an interrupted session (crash, accidental reload, closed tab) has
# something to recover on the next load - see loadProjectConsideringDraft()
# in project.js. Deliberately not the job/SSE pattern projects.py uses for
# the real save - these writes are small, frequent, and don't need progress
# reporting. The frontend is the sole clock authority (basedOnSavedAt /
# draftUpdatedAt are both timestamps it generates), so this is pure,
# unopinionated storage - no timestamp logic lives here.
import json

from fastapi import APIRouter, HTTPException

from .projects import project_dir

router = APIRouter()


def draft_file(project_id: str):
    return project_dir(project_id) / "project.draft.json"


@router.get("/api/projects/{project_id}/draft")
async def read_draft(project_id: str):
    file = draft_file(project_id)
    if not file.exists():
        raise HTTPException(status_code=404, detail="no draft")
    return json.loads(file.read_text(encoding="utf-8"))


@router.put("/api/projects/{project_id}/draft")
async def write_draft(project_id: str, payload: dict):
    directory = project_dir(project_id)
    if not directory.exists():
        raise HTTPException(status_code=404, detail="project not found")
    draft_file(project_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"ok": True}


@router.delete("/api/projects/{project_id}/draft")
async def delete_draft(project_id: str):
    file = draft_file(project_id)
    if file.exists():
        file.unlink()
    return {"ok": True}
