# Phase 4a: lip-sync export for a single shot, proving the -ss/-t math
# against H3 render duration (not cut duration) and the ffmpeg-progress job
# shape on one shot before Phase 4b (export_project, below) runs the same
# building blocks in a per-shot batch loop with folders/manifests/assets.
import asyncio
import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import JSONResponse

from . import frames, jobs, media
from .projects import project_dir

router = APIRouter()

LIP_SYNC_SAMPLE_RATE = "32000"
LIP_SYNC_CHANNELS = "1"


def _load_project(project_id: str) -> tuple[dict, Path]:
    directory = project_dir(project_id)
    project_file = directory / "project.json"
    if not project_file.exists():
        raise HTTPException(status_code=404, detail="project not found")
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return data, directory


def _snippet_cmd(source_path: Path, start_seconds: float, duration_seconds: float, output_path: Path) -> list[str]:
    return [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start_seconds:.6f}",
        "-i",
        str(source_path),
        "-t",
        f"{duration_seconds:.6f}",
        "-ar",
        LIP_SYNC_SAMPLE_RATE,
        "-ac",
        LIP_SYNC_CHANNELS,
        "-c:a",
        "flac",
        str(output_path),
    ]


def _require_track(data: dict, directory: Path, track: str) -> Path:
    rel = ((data.get("audio") or {}).get(track) or {}).get("relativePath")
    if not rel:
        raise HTTPException(status_code=400, detail=f"no {track} track uploaded for this project yet")
    path = directory / rel
    if not path.exists():
        raise HTTPException(status_code=400, detail=f"{track} track file is missing on disk")
    return path


@router.post("/api/projects/{project_id}/shots/{shot_id}/export/lip-sync")
async def export_lip_sync(project_id: str, shot_id: int):
    data, directory = _load_project(project_id)

    shot = next((s for s in data.get("shots", []) if s["id"] == shot_id), None)
    if shot is None:
        raise HTTPException(status_code=404, detail="shot not found")

    vocal_path = _require_track(data, directory, "vocal")

    cut_duration = shot["endSeconds"] - shot["startSeconds"]
    calc = frames.frame_calc(cut_duration, data["video"])
    render_duration = calc["renderFrames"] / frames.fps(data["video"])

    scratch_dir = directory / "exports" / "scratch"
    scratch_dir.mkdir(parents=True, exist_ok=True)
    output_path = scratch_dir / f"shot-{shot_id}-lip_sync.flac"
    output_relative_path = f"exports/scratch/{output_path.name}"

    cmd = _snippet_cmd(vocal_path, shot["startSeconds"], render_duration, output_path)

    job = jobs.create_job()

    async def run():
        try:
            await jobs.emit(
                job,
                {
                    "status": "running",
                    "phase": "encoding",
                    "message": "Encoding lip_sync.flac",
                    "progressFraction": 0.0,
                },
            )

            async def on_progress(fraction: float) -> None:
                await jobs.emit(job, {"status": "running", "phase": "encoding", "progressFraction": fraction})

            await media.run_ffmpeg_with_progress(cmd, render_duration, on_progress)

            job.result = {
                "relativePath": output_relative_path,
                "renderDurationSeconds": render_duration,
                "cutFrames": calc["cutFrames"],
                "renderFrames": calc["renderFrames"],
                "overhangFrames": calc["overhangFrames"],
            }
            await jobs.emit(
                job,
                {"status": "done", "phase": "complete", "message": "Saved", "progressFraction": 1.0, "result": job.result},
            )
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            job.error = str(exc)
            await jobs.emit(job, {"status": "error", "message": str(exc)})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id, "expectedDurationSeconds": render_duration})


# Phase 4b: the whole-project export package - per-shot folders, shot.json
# manifest, copied assets, prompt/notes, optional mix.flac, aggregate
# progress, and cancellation (checked between shots and mid-encode via
# media.py's should_cancel).
@router.post("/api/projects/{project_id}/export")
async def export_project(project_id: str, options: dict = Body(default={})):
    include_mix = bool(options.get("includeMixSnippet"))
    data, directory = _load_project(project_id)

    shots = data.get("shots", [])
    if not shots:
        raise HTTPException(status_code=400, detail="project has no shots to export")

    vocal_path = _require_track(data, directory, "vocal")
    mix_path = _require_track(data, directory, "mix") if include_mix else None

    assets_by_id = {a["id"]: a for a in data.get("assets", [])}
    video = data["video"]
    frame_rule_label = frames.frame_rule_label((video.get("frameRule") or {}).get("stride"))
    fps_value = frames.fps(video)
    shot_count = len(shots)

    export_dir = directory / "export"
    job = jobs.create_job()

    def should_cancel() -> bool:
        return job.cancel_requested

    async def run():
        current_shot_dir: Path | None = None
        try:
            if export_dir.exists():
                shutil.rmtree(export_dir)
            export_dir.mkdir(parents=True)
            (export_dir / "project.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

            for index, shot in enumerate(shots):
                if should_cancel():
                    await jobs.emit(
                        job, {"status": "cancelled", "shot": index, "shotCount": shot_count, "message": "Cancelled"}
                    )
                    return

                shot_id = shot["id"]
                shot_dir = export_dir / f"shot-{shot_id:03d}"
                current_shot_dir = shot_dir
                shot_dir.mkdir(parents=True, exist_ok=True)

                cut_duration = shot["endSeconds"] - shot["startSeconds"]
                calc = frames.frame_calc(cut_duration, video)
                render_duration = calc["renderFrames"] / fps_value
                base_progress = index / shot_count

                async def on_progress(fraction: float) -> None:
                    await jobs.emit(
                        job,
                        {
                            "status": "running",
                            "phase": "audio",
                            "shot": index + 1,
                            "shotCount": shot_count,
                            "message": f"Shot {shot_id}: encoding lip_sync.flac",
                            "itemProgress": fraction,
                            "progressFraction": base_progress + fraction / shot_count,
                        },
                    )

                await media.run_ffmpeg_with_progress(
                    _snippet_cmd(vocal_path, shot["startSeconds"], render_duration, shot_dir / "lip_sync.flac"),
                    render_duration,
                    on_progress,
                    should_cancel=should_cancel,
                )

                if include_mix:

                    async def on_mix_progress(fraction: float) -> None:
                        await jobs.emit(
                            job,
                            {
                                "status": "running",
                                "phase": "audio",
                                "shot": index + 1,
                                "shotCount": shot_count,
                                "message": f"Shot {shot_id}: encoding mix.flac",
                                "itemProgress": fraction,
                                "progressFraction": base_progress + fraction / shot_count,
                            },
                        )

                    await media.run_ffmpeg_with_progress(
                        _snippet_cmd(mix_path, shot["startSeconds"], render_duration, shot_dir / "mix.flac"),
                        render_duration,
                        on_mix_progress,
                        should_cancel=should_cancel,
                    )

                asset_relative_paths: list[str] = []
                asset_ids = shot.get("assetIds") or []
                if asset_ids:
                    await jobs.emit(
                        job,
                        {
                            "status": "running",
                            "phase": "assets",
                            "shot": index + 1,
                            "shotCount": shot_count,
                            "message": f"Shot {shot_id}: copying assets",
                            "itemProgress": 0.0,
                            "progressFraction": base_progress,
                        },
                    )
                    assets_dest = shot_dir / "assets"
                    assets_dest.mkdir(exist_ok=True)
                    for asset_id in asset_ids:
                        asset = assets_by_id.get(asset_id)
                        if not asset:
                            continue
                        src = directory / asset["relativePath"]
                        if not src.exists():
                            continue
                        dest = assets_dest / src.name
                        shutil.copyfile(src, dest)
                        asset_relative_paths.append(f"assets/{src.name}")

                manifest = {
                    "shot": shot_id,
                    "startSeconds": shot["startSeconds"],
                    "endSeconds": shot["endSeconds"],
                    "cutDurationSeconds": cut_duration,
                    "fps": fps_value,
                    "cutFrames": calc["cutFrames"],
                    "frameRule": frame_rule_label,
                    "renderFrames": calc["renderFrames"],
                    "renderDurationSeconds": render_duration,
                    "overhangFrames": calc["overhangFrames"],
                    "assets": asset_relative_paths,
                }
                (shot_dir / "shot.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                (shot_dir / "prompt.txt").write_text(shot.get("prompt") or "", encoding="utf-8")
                (shot_dir / "notes.md").write_text(shot.get("notes") or "", encoding="utf-8")
                current_shot_dir = None

                await jobs.emit(
                    job,
                    {
                        "status": "running",
                        "phase": "manifest",
                        "shot": index + 1,
                        "shotCount": shot_count,
                        "message": f"Shot {shot_id}: done",
                        "itemProgress": 1.0,
                        "progressFraction": (index + 1) / shot_count,
                    },
                )

            job.result = {"exportPath": str(export_dir), "shotCount": shot_count}
            await jobs.emit(
                job,
                {"status": "done", "phase": "complete", "message": "Export complete", "progressFraction": 1.0, "result": job.result},
            )
        except media.FFmpegCancelled:
            if current_shot_dir is not None and current_shot_dir.exists():
                shutil.rmtree(current_shot_dir, ignore_errors=True)
            await jobs.emit(job, {"status": "cancelled", "message": "Cancelled"})
        except Exception as exc:  # noqa: BLE001 - reported to the client as a job error, not raised
            if current_shot_dir is not None and current_shot_dir.exists():
                shutil.rmtree(current_shot_dir, ignore_errors=True)
            job.error = str(exc)
            await jobs.emit(job, {"status": "error", "message": str(exc)})
        finally:
            await jobs.close(job)

    asyncio.create_task(run())
    return JSONResponse(status_code=202, content={"jobId": job.id, "shotCount": shot_count})
