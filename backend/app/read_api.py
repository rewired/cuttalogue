"""Thin FastAPI adapter over the transport-neutral read services."""
from fastapi import APIRouter, HTTPException

from . import projects
from .project_repository import InvalidProjectError, ProjectNotFoundError, ProjectRepository
from .prompt_service import PromptCompilationError
from .read_services import EntityNotFoundError, ProjectReadService

router = APIRouter()


def service() -> ProjectReadService:
    return ProjectReadService(ProjectRepository(projects.DATA_DIR))


def translate(error: Exception) -> HTTPException:
    if isinstance(error, (ProjectNotFoundError, EntityNotFoundError)):
        return HTTPException(status_code=404, detail=str(error))
    if isinstance(error, PromptCompilationError):
        return HTTPException(status_code=503, detail=str(error))
    return HTTPException(status_code=400, detail=str(error))


@router.get("/api/projects/{project_id}/shots")
def list_shots(project_id: str):
    try:
        return service().list_shots(project_id)
    except (ProjectNotFoundError, InvalidProjectError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/shots/{shot_id}")
def get_shot(project_id: str, shot_id: int):
    try:
        return service().get_shot(project_id, shot_id)
    except (ProjectNotFoundError, InvalidProjectError, EntityNotFoundError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/shots/{shot_id}/direction")
def get_shot_direction(project_id: str, shot_id: int):
    try:
        return service().get_shot_direction(project_id, shot_id)
    except (ProjectNotFoundError, InvalidProjectError, EntityNotFoundError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/shots/{shot_id}/camera")
def get_camera_segments(project_id: str, shot_id: int):
    try:
        return service().get_camera_segments(project_id, shot_id)
    except (ProjectNotFoundError, InvalidProjectError, EntityNotFoundError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/shots/{shot_id}/camera/validation")
def validate_camera_path(project_id: str, shot_id: int):
    try:
        return service().validate_camera_path(project_id, shot_id)
    except (ProjectNotFoundError, InvalidProjectError, EntityNotFoundError, ValueError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/shots/{shot_id}/camera/evaluation")
def evaluate_camera_path(project_id: str, shot_id: int, time_seconds: float):
    try:
        return service().evaluate_camera_path(project_id, shot_id, time_seconds)
    except (ProjectNotFoundError, InvalidProjectError, EntityNotFoundError, ValueError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/shots/{shot_id}/prompt/compiled")
def compile_shot_prompt(project_id: str, shot_id: int):
    try:
        return service().compile_shot_prompt(project_id, shot_id)
    except (ProjectNotFoundError, InvalidProjectError, EntityNotFoundError, PromptCompilationError) as error:
        raise translate(error) from error


@router.get("/api/projects/{project_id}/warnings")
def get_project_warnings(project_id: str):
    try:
        return service().get_project_warnings(project_id)
    except (ProjectNotFoundError, InvalidProjectError) as error:
        raise translate(error) from error
