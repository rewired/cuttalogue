# Serves the existing static frontend (index.html/js/css/vendor) from the
# same process as the API, per the roadmap's "decide once" note for Phase 2 -
# one process, one command, no CORS to configure.
import asyncio
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .assets import router as assets_router
from .audio import router as audio_router
from .export import router as export_router
from .jobs import router as jobs_router
from .projects import DATA_DIR
from .projects import router as projects_router

# asyncio.create_subprocess_exec (media.py's ffmpeg calls) raises
# NotImplementedError on Windows unless the loop is Proactor - some
# environments (observed with uvicorn --reload) otherwise end up on
# Selector, which supports everything else here except subprocesses. Set
# explicitly rather than relying on whatever the process happened to pick.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

REPO_ROOT = Path(__file__).resolve().parents[2]

app = FastAPI(title="CUTTAlogue")

app.include_router(projects_router)
app.include_router(jobs_router)
app.include_router(assets_router)
app.include_router(audio_router)
app.include_router(export_router)

for static_dir in ("js", "css", "vendor"):
    path = REPO_ROOT / static_dir
    if path.exists():
        app.mount(f"/{static_dir}", StaticFiles(directory=path), name=static_dir)

# Serves original asset files and thumbnails straight off disk for preview -
# no auth/access-control needed for a local single-user tool. URL shape:
# /project-files/<projectId>/<relativePath from the project's asset descriptor>
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/project-files", StaticFiles(directory=DATA_DIR), name="project-files")


@app.get("/")
async def index():
    return FileResponse(REPO_ROOT / "index.html")
