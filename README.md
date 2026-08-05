# Musical Shot Editor

A lean, local editor for planning video shots against a song: listen to the mix and vocal stem in sync, lock shot boundaries to the musical grid, and see the matching H3 render length (`4n+1` / `8n+1`) right away.

Local first - everything runs on your machine, no cloud.

For background on architecture and design decisions, see [docs/musical-shot-editor.md](docs/musical-shot-editor.md) and the [implementation roadmap](docs/cuttalogue-roadmap.md).

---

## Getting started

A small Python/FastAPI backend now serves the app and persists projects to disk (see [Backend](#backend) below):

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Then open `http://localhost:8000` in your browser.

1. Use **"Load mix"** to pick your music mix.
2. Optionally use **"Load vocal"** to add the vocal stem.

Once the mix is loaded, the timeline appears with four synchronized tracks: **Grid**, **Shots**, **Mix**, **Vocal**.

Loading a mix/vocal file also copies it to the backend project folder in the background (needed for lip-sync export, see below) - but playback itself still needs the local file, so after a page refresh, reselect the mix/vocal files as before; tempo, video, shot-limit settings, and all shots persist automatically.

---

## Using the timeline

| Action | Control |
|---|---|
| Play / pause | Spacebar or the play button |
| Switch A/B (mix ↔ vocal) | Radio buttons in the transport bar |
| Zoom | Zoom slider in the transport bar |
| Scroll horizontally | Mouse wheel / trackpad gesture over the timeline |
| Set playback position | Click or drag on the mix or vocal track |

All four tracks (grid, shots, mix, vocal) always stay in sync - same zoom, same scroll range, shared playhead.

---

## Tempo & grid

In the **Tempo** panel:

- **BPM** and **time signature** (numerator/denominator) are freely adjustable.
- **Grid offset**: use this if the song doesn't start exactly on beat one at second zero. **"Offset = Playhead"** sets the offset directly to the current playback position.
- **Grid**: Off, 1 beat, 1/2 bar, 1 bar, 2 bars, 1 second, or 1 frame. The chosen grid determines both the visible grid lines and what newly created or moved shot boundaries snap to.

In the **Video** panel:

- **FPS** of the target video.
- **Frame rule**: free, `4n+1`, or `8n+1` - determines which frame count H3 rounds up to when rendering.

In the **Shot length** panel:

- **Minimum** / **maximum** in seconds. Shots outside this range are color-coded in the timeline and the table (too short / too long) but nothing is blocked.

---

## Creating and editing shots

The shots track starts empty - no shot is created automatically. Shots don't have to form a continuous chain: a gap can remain between two shots (e.g. an intro that shouldn't appear in the shot list at all).

| Action | Control |
|---|---|
| Create a new shot | Drag on empty space in the shots track |
| Create/move without grid snap | Hold **Alt** while dragging |
| Split a shot | Click inside an existing shot |
| Move a shot edge | Drag the edge of a shot |
| Merge two touching shots | Double-click their shared boundary |
| Delete a shot | Right-click the shot → "Delete shot" |

While dragging (creating or moving), the boundary only snaps to the selected grid on release - it follows the mouse freely during the drag itself.

Each shot's row in the table below shows: start, end, duration, status (too short / valid / too long), cut frames, H3 render frames, and the frame overhang.

---

## Saving, naming & switching projects

- The text field in the header is the project's **name** - type into it and hit **"Save project"** to persist it (same as tempo/shots, not saved until you click Save).
- **"Save project"**: writes tempo, video and shot settings plus all shot boundaries to the project folder on disk via the backend. The audio files themselves are **not** saved - when reloading the project, the mix and vocal may need to be reselected.
- **"Projects ▾"** opens a list of every project on the backend (name, shot count, last saved) - click one to switch to it, or **"+ New project"** to start a blank one. The browser remembers whichever project it last opened and reloads it automatically on the next page visit.
- **"Export shots (JSON / CSV)"**: exports just the shot list with calculated frame counts, e.g. for further use in H3 or an editing tool. Still a plain client-side download, unrelated to the project save above.

---

## Assets

The **Assets** tab (next to **Shot**, in the panel right of the shot list) holds the project's asset pool:

- **"Add files"** imports images, videos, or audio - each gets copied into the project folder, probed with FFprobe (duration, dimensions, fps, codec, sample rate, channels), and given a thumbnail (images/video only).
- Tag each asset with a comma-separated list; the filter box above the grid matches on tags.
- Select a shot first, then use each card's **Assign / Remove** button to attach or detach it from that shot (click-based - no drag-and-drop). Assigned assets also show up as removable chips in the **Shot** tab.
- Tags and assignments live in the same project state as prompt/notes, so they only become durable once you hit **"Save project"**; imported files themselves land on disk immediately.

---

## Export

- **Whole project** - the header menu has an **"Export project"** button (plus an **"Include mix snippet"** checkbox). It builds the full per-shot export package from the product doc: `export/shot-XXX/` folders, each with `lip_sync.flac`, `shot.json` (the render manifest - frame counts, frame rule, assigned asset paths), `prompt.txt`, `notes.md`, copied assigned assets, and optionally `mix.flac`. A floating task panel (bottom-right) tracks aggregate progress ("Shot 12 of 37") with a **Cancel** button; cancelling stops between shots (and mid-encode on the current one) without leaving a corrupted or partially-written shot folder behind.

Both need a vocal track already loaded (see above), and the mix track too if "Include mix snippet" is checked; the project must have been saved at least once since.

---

## Setup & optional AI image descriptions

The **"Setup"** button in the header (top right) opens an application-wide connection dialog - separate from any project, stored locally on the backend and never written into a project's JSON or export:

- **API base URL** and **API key** for an OpenRouter-compatible chat completions API.
- **Default model**: used whenever a per-image request doesn't override it.
- **Test connection**: a quick round trip (`GET {base URL}/models`) to confirm the key/URL work before relying on them.

With nothing configured, the rest of the app behaves exactly as before. Once configured, each **image** asset's card in the Assets tab gets a **Description** field plus a **"Describe image"** button (with an optional per-request model override). Clicking it sends that one image to the configured provider and streams the response straight into the description field as it arrives - one explicit action per image, never automatic or batched. Like export, this needs the project to have been saved at least once since the image was imported (asset import copies the file to disk right away, but it only becomes part of `project.json` - and therefore visible to the backend - once "Save project" runs).

---

## Backend

A minimal FastAPI backend (`backend/`) replaces the old "download a JSON file" save/load with a real project folder on disk:

- `POST /api/projects` creates a new project folder + `project.json`. `GET /api/projects` lists every project (id, name, shot count, last-saved time) for the **Projects** picker.
- `GET /api/projects/{id}` / `PUT /api/projects/{id}` read/write it.
- `PUT` runs as a job (`GET /api/jobs/{jobId}` + `/events` for SSE progress) - the same job/SSE shape export and AI description reuse.
- `POST /api/projects/{id}/assets` imports one or more files into that project's `assets/` folder and returns their metadata/thumbnail descriptors (no project.json write - that's still "Save project").
- `POST /api/projects/{id}/audio/{track}` (`track` = `mix` or `vocal`) uploads the raw audio file itself to `audio/<track>.<ext>`.
- `POST /api/projects/{id}/export` runs the whole-project export as a job with aggregate SSE progress; `POST /api/jobs/{jobId}/cancel` requests cancellation, checked between shots and mid-`ffmpeg`-encode.
- `GET /api/settings` / `PUT /api/settings` read/write the application-level AI provider connection (`backend/data/settings.json`, gitignored) - the API key is never echoed back in the `GET` response, only whether one is saved.
- `POST /api/settings/test` makes a lightweight authenticated request to the configured provider and reports whether it succeeded.
- `POST /api/projects/{id}/assets/{assetId}/describe` streams one image to the configured provider's chat completions endpoint (`stream: true`) and re-emits each token as a job event's `delta` field over the same SSE job shape, so the frontend can pour the response into the description field as it arrives.

Projects are stored under `backend/data/projects/<id>/` (gitignored) - `project.json`, `audio/`, `assets/<assetId>/`, `exports/scratch/` (single-shot export), and `export/` (whole-project export, rebuilt fresh on every run). Files are served straight off disk at `/project-files/<projectId>/<relativePath>`. The frontend keeps its current project id in the browser's `localStorage` and switches it via the **Projects** picker in the header.

Requires `ffprobe`/`ffmpeg` on `PATH` for asset metadata, thumbnails, and export. `ffmpeg` calls all run via a plain synchronous `subprocess.Popen` in a background thread rather than `asyncio.create_subprocess_exec` - the latter needs the Proactor event loop on Windows and raises `NotImplementedError` on Selector, which some `uvicorn --reload` worker processes end up on regardless of the policy set at startup.

---

## What the editor deliberately doesn't do

- No automatic shot or cut detection - all boundaries are set manually.
- No audio mixing (no gain, solo, mute, fades).
- No video preview, no rendering - the editor only plans the cut points.

Full details and roadmap: [docs/musical-shot-editor.md](docs/musical-shot-editor.md).
