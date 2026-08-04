# Project CRUD: a project is a folder on disk containing project.json.
# Reads are plain synchronous file I/O - only the write (PUT, i.e. "save") goes
# through the job/SSE pattern from jobs.py, since save is the operation later
# phases (export, describe) need to mimic while it's still cheap to get right.
import asyncio
import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from . import jobs

router = APIRouter()

DATA_DIR = Path(__file__).resolve().parents[1] / "data" / "projects"


def project_dir(project_id: str) -> Path:
    return DATA_DIR / project_id


def project_file(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


@router.post("/api/projects")
async def create_project(payload: dict):
    project_id = uuid.uuid4().hex[:8]
    directory = project_dir(project_id)
    directory.mkdir(parents=True, exist_ok=False)
    project_file(project_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return {"id": project_id, "project": payload}


@router.get("/api/projects")
async def list_projects():
    if not DATA_DIR.exists():
        return {"projects": []}
    results = []
    for entry in DATA_DIR.iterdir():
        if not entry.is_dir():
            continue
        file = entry / "project.json"
        if not file.exists():
            continue
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        results.append(
            {
                "id": entry.name,
                "name": data.get("name") or "",
                "shotCount": len(data.get("shots") or []),
                "updatedAt": file.stat().st_mtime,
            }
        )
    results.sort(key=lambda p: p["updatedAt"], reverse=True)
    return {"projects": results}


@router.get("/api/projects/{project_id}")
async def read_project(project_id: str):
    file = project_file(project_id)
    if not file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    return json.loads(file.read_text(encoding="utf-8"))


@router.put("/api/projects/{project_id}")
async def save_project(project_id: str, payload: dict):
    if not project_dir(project_id).exists():
        raise HTTPException(status_code=404, detail="project not found")
    job = jobs.create_job()
    asyncio.create_task(jobs.run_save_job(job, project_file(project_id), payload))
    return JSONResponse(status_code=202, content={"jobId": job.id})
