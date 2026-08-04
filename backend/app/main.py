# Serves the existing static frontend (index.html/js/css/vendor) from the
# same process as the API, per the roadmap's "decide once" note for Phase 2 -
# one process, one command, no CORS to configure.
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .jobs import router as jobs_router
from .projects import router as projects_router

REPO_ROOT = Path(__file__).resolve().parents[2]

app = FastAPI(title="CUTTAlogue")

app.include_router(projects_router)
app.include_router(jobs_router)

for static_dir in ("js", "css", "vendor"):
    path = REPO_ROOT / static_dir
    if path.exists():
        app.mount(f"/{static_dir}", StaticFiles(directory=path), name=static_dir)


@app.get("/")
async def index():
    return FileResponse(REPO_ROOT / "index.html")
