"""Explicit, revision-checked generation controls shared by HTTP-adjacent clients and MCP."""
from typing import Any

from .comfy import start_generation_job
from .h3_preflight import error_message, inspect_generation
from .project_repository import ProjectRepository, RevisionConflictError
from .write_services import ShotNotFoundError, WriteValidationError


ROLE_ORDER = ["primary_character", "supporting_character", "environment", "prop"]


class GenerationService:
    def __init__(self, repository: ProjectRepository):
        self.repository = repository

    async def start_generation(
        self, project_id: str, shot_id: int, expected_revision: str,
        seed: int | None = None,
    ) -> dict[str, Any]:
        record = self.repository.read(project_id)
        if record["revision"] != expected_revision:
            raise RevisionConflictError(expected_revision, record["revision"])
        project = record["project"]
        shot = next((item for item in project.get("shots", []) if item.get("id") == shot_id), None)
        if shot is None:
            raise ShotNotFoundError("shot not found")
        prompt = shot.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise WriteValidationError("shot prompt must be compiled or authored before generation")
        if seed is not None and (isinstance(seed, bool) or not isinstance(seed, int)):
            raise WriteValidationError("seed must be an integer or null")

        asset_ids = shot.get("assetIds") or []
        roles = shot.get("assetRoles") or {}
        if (
            not isinstance(asset_ids, list)
            or not all(isinstance(asset_id, str) for asset_id in asset_ids)
            or not isinstance(roles, dict)
        ):
            raise WriteValidationError("shot asset references are invalid")
        reference_ids = [asset_id for asset_id in asset_ids if roles.get(asset_id) in ROLE_ORDER]
        reference_ids.sort(key=lambda asset_id: ROLE_ORDER.index(roles[asset_id]))

        project_assets = project.get("assets") or []
        if not isinstance(project_assets, list) or not all(isinstance(asset, dict) for asset in project_assets):
            raise WriteValidationError("project assets are invalid")
        assets = {asset.get("id"): asset for asset in project_assets}
        video_refs = shot.get("videoRefs") or {}
        if not isinstance(video_refs, dict):
            raise WriteValidationError("shot video references are invalid")
        extend_id = next((
            asset_id for asset_id in asset_ids
            if (assets.get(asset_id) or {}).get("type") == "video"
            and isinstance(video_refs.get(asset_id), dict)
            and video_refs[asset_id].get("mode") == "extend"
        ), None)
        extend = video_refs.get(extend_id) if extend_id else {}
        body = {
            "prompt": prompt, "seed": seed if seed is not None else shot.get("seed"),
            "referenceAssetIds": reference_ids, "extendAssetId": extend_id,
            "extendStartFrame": (extend or {}).get("startFrame") or 0,
            "extendFrameCount": (extend or {}).get("frameCount"),
        }
        preflight = inspect_generation(project, shot, body)
        if not preflight["ok"]:
            raise WriteValidationError(error_message(preflight))
        directory = self.repository.directory(project_id)
        result = await start_generation_job(project, directory, shot, body)
        return {
            "projectId": project_id, "shotId": shot_id,
            "revision": record["revision"], **result,
        }
