"""Thin FastAPI adapter over revision-guarded write services."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import projects
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository, RevisionConflictError
from .write_services import (
    CameraSegmentNotFoundError, ProjectWriteService, ShotNotFoundError,
    WriteValidationError,
)

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


class AddCameraSegmentRequest(WriteRequest):
    start_seconds: float = Field(alias="startSeconds")
    end_seconds: float = Field(alias="endSeconds")
    movement: str = "zoom_in"
    framing: str = ""
    speed: str = ""
    amplitude: str = ""
    direction: str = ""
    target: str = ""
    focal_length: str = Field(default="", alias="focalLength")
    depth_of_field: str = Field(default="", alias="depthOfField")
    focus_target: str = Field(default="", alias="focusTarget")
    transition_to_next: str = Field(default="", alias="transitionToNext")
    enabled: bool = True


class UpdateCameraSegmentRequest(WriteRequest):
    start_seconds: float | None = Field(default=None, alias="startSeconds")
    end_seconds: float | None = Field(default=None, alias="endSeconds")
    movement: str | None = None
    framing: str | None = None
    speed: str | None = None
    amplitude: str | None = None
    direction: str | None = None
    target: str | None = None
    focal_length: str | None = Field(default=None, alias="focalLength")
    depth_of_field: str | None = Field(default=None, alias="depthOfField")
    focus_target: str | None = Field(default=None, alias="focusTarget")
    transition_to_next: str | None = Field(default=None, alias="transitionToNext")
    enabled: bool | None = None


def camera_fields(payload: AddCameraSegmentRequest | UpdateCameraSegmentRequest) -> dict:
    values = payload.model_dump(by_alias=True, exclude={"expected_revision"}, exclude_none=True)
    values.pop("expectedRevision", None)
    return values


def service() -> ProjectWriteService:
    return ProjectWriteService(ProjectRepository(projects.DATA_DIR))


def translate(error: Exception) -> HTTPException:
    if isinstance(error, (ProjectNotFoundError, ShotNotFoundError, CameraSegmentNotFoundError)):
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


@router.post("/api/projects/{project_id}/shots/{shot_id}/camera")
def add_camera_segment(project_id: str, shot_id: int, payload: AddCameraSegmentRequest):
    try:
        return service().add_camera_segment(
            project_id, shot_id, payload.expected_revision, camera_fields(payload),
        )
    except (ProjectNotFoundError, InvalidProjectError, RevisionConflictError, ShotNotFoundError, WriteValidationError) as error:
        raise translate(error) from error


@router.patch("/api/projects/{project_id}/shots/{shot_id}/camera/{segment_index}")
def update_camera_segment(
    project_id: str, shot_id: int, segment_index: int,
    payload: UpdateCameraSegmentRequest,
):
    try:
        return service().update_camera_segment(
            project_id, shot_id, segment_index, payload.expected_revision,
            camera_fields(payload),
        )
    except (
        ProjectNotFoundError, InvalidProjectError, RevisionConflictError,
        ShotNotFoundError, CameraSegmentNotFoundError, WriteValidationError,
    ) as error:
        raise translate(error) from error


@router.delete("/api/projects/{project_id}/shots/{shot_id}/camera/{segment_index}")
def remove_camera_segment(
    project_id: str, shot_id: int, segment_index: int, payload: WriteRequest,
):
    try:
        return service().remove_camera_segment(
            project_id, shot_id, segment_index, payload.expected_revision,
        )
    except (
        ProjectNotFoundError, InvalidProjectError, RevisionConflictError,
        ShotNotFoundError, CameraSegmentNotFoundError, WriteValidationError,
    ) as error:
        raise translate(error) from error
