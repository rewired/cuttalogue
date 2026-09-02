"""Thin FastAPI adapter over revision-guarded write services."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import projects
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository, RevisionConflictError
from .write_services import ProjectWriteService, ShotNotFoundError, WriteValidationError

router = APIRouter()


class WriteRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    expected_revision: str = Field(alias="expectedRevision")


class CreateShotRequest(WriteRequest):
    start_seconds: float = Field(alias="startSeconds")
    end_seconds: float = Field(alias="endSeconds")
    name: str = ""


class UpdateTimingRequest(WriteRequest):
    start_seconds: float = Field(alias="startSeconds")
    end_seconds: float = Field(alias="endSeconds")


class RenameShotRequest(WriteRequest):
    name: str


def service() -> ProjectWriteService:
    return ProjectWriteService(ProjectRepository(projects.DATA_DIR))


def translate(error: Exception) -> HTTPException:
    if isinstance(error, (ProjectNotFoundError, ShotNotFoundError)):
        return HTTPException(status_code=404, detail=str(error))
    if isinstance(error, RevisionConflictError):
        return HTTPException(status_code=409, detail={
            "code": "revision_conflict", "expectedRevision": error.expected_revision,
            "currentRevision": error.current_revision,
        })
    return HTTPException(status_code=400, detail=str(error))


@router.post("/api/projects/{project_id}/shots")
def create_shot(project_id: str, payload: CreateShotRequest):
    try:
        return service().create_shot(
            project_id, payload.expected_revision, payload.start_seconds,
            payload.end_seconds, payload.name,
        )
    except (ProjectNotFoundError, InvalidProjectError, RevisionConflictError, WriteValidationError) as error:
        raise translate(error) from error


@router.patch("/api/projects/{project_id}/shots/{shot_id}/timing")
def update_shot_timing(project_id: str, shot_id: int, payload: UpdateTimingRequest):
    try:
        return service().update_shot_timing(
            project_id, shot_id, payload.expected_revision,
            payload.start_seconds, payload.end_seconds,
        )
    except (ProjectNotFoundError, InvalidProjectError, RevisionConflictError, ShotNotFoundError, WriteValidationError) as error:
        raise translate(error) from error


@router.patch("/api/projects/{project_id}/shots/{shot_id}/name")
def rename_shot(project_id: str, shot_id: int, payload: RenameShotRequest):
    try:
        return service().rename_shot(project_id, shot_id, payload.expected_revision, payload.name)
    except (ProjectNotFoundError, InvalidProjectError, RevisionConflictError, ShotNotFoundError, WriteValidationError) as error:
        raise translate(error) from error
