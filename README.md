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

1. Open the **☰** menu (top left of the header) and use **"Load mix"** to pick your music mix.
2. Optionally use **"Load vocal"** in the same menu to add the vocal stem.

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
| Set playback position | Click or drag on the grid, mix, or vocal track |

All four tracks (grid, shots, mix, vocal) always stay in sync - same zoom, same scroll range, shared playhead.

---

## Looping a region

Two draggable locators on the **Grid** track's ruler mark a loop region for playback:

- The **⟲** button (next to Play) turns looping on/off. First activation defaults the region to whichever shot the playhead is currently inside (or the next/last shot if it's in a gap or past everything) - not the whole project.
- Drag the region's edges to resize it, or drag its body to move the whole region.
- The **Grid / Events** toggle next to it controls what the locators snap to on release: the musical grid (default), or shot boundaries - the left locator snaps to shot starts, the right locator to shot ends.
- Loop points are saved with the project, same as shot boundaries.

---

## Tempo & grid

Click the **⚙** icon on the Grid track's label to open the Tempo/Video/Shot length flyout.

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
| Select a shot | Click it - highlights the clip and its row in the table below, synced either direction |
| Split a shot | **Ctrl+click** inside an existing shot |
| Move a shot edge | Drag the edge of a shot |
| Merge two touching shots | Double-click their shared boundary |
| Delete a shot | Right-click the shot → "Delete shot" |

While dragging (creating or moving), the boundary only snaps to the selected grid on release - it follows the mouse freely during the drag itself.

Each shot's row in the table below shows: start, end, duration, status (too short / valid / too long), cut frames, H3 render frames, and the frame overhang. Double-click a shot's **#** in the table to rename it inline (Enter to confirm, Esc to cancel).

---

## Saving, naming & switching projects

Save, export, and project-switching controls all live in the **☰** menu (top left of the header).

- The text field in the header is the project's **name** - type into it and hit **"Save project"** to persist it (same as tempo/shots, not saved until you click Save).
- **"Save project"** (or **Ctrl+S** anywhere): writes tempo, video and shot settings plus all shot boundaries to the project folder on disk via the backend, with a brief confirmation toast. The audio files themselves are **not** saved - when reloading the project, the mix and vocal may need to be reselected.
- **"Projects ▾"** opens a list of every project on the backend (name, shot count, last saved) - click one to switch to it, or **"+ New project"** to start a blank one. The browser remembers whichever project it last opened and reloads it automatically on the next page visit.
- **"Export shots (JSON / CSV)"**: exports just the shot list with calculated frame counts, e.g. for further use in H3 or an editing tool. Still a plain client-side download, unrelated to the project save above.

---

## Assets

The top-level **Assets** tab (next to **Shots**, above the timeline) is the project's asset library - a master/detail view, not scoped to any shot:

- **"Add files"** imports images, videos, or audio - each gets copied into the project folder, probed with FFprobe (duration, dimensions, fps, codec, sample rate, channels), and given a thumbnail (images/video only).
- Every asset gets a **kind** right on its card - Location / Character / Prop for images, Full mix / Lip-sync for audio, Motion guide for video - fixed for that asset everywhere in the project (a person can't be a character in one shot and a location in the next). An asset must be classified before it can be assigned to a shot.
- Selecting a card opens the detail panel on the right with its tags (comma-separated; the filter box above the grid matches on tags) and, for images, a description field plus a **"Describe image"** button (see [Setup](#setup) below).
- Tags, kind, and descriptions live in the same project state as prompt/notes, so they only become durable once you hit **"Save project"**; imported files themselves land on disk immediately.

Assigning an asset to a specific shot happens per-shot instead, in that shot's **Cast & Locations** tab (see below) - the library has no concept of "the selected shot".

---

## Cast & Locations, Direction, Prompt, Notes, Generate (per shot)

Selecting a shot (click its row in the table, or the shot itself in the timeline - either stays in sync with the other) exposes five tabs to its right:

- **Cast & Locations** - the shot's assigned assets as chips. Click the trailing **"+"** tile to open the asset picker: a grid of every classified asset where clicking an unassigned tile assigns it and closes the picker immediately (unclassified assets show as unavailable until given a kind in the Assets tab). Click a chip's **×** to unassign it. Character assets also get a per-shot **role** (primary / supporting character) and locations get an environment role - these are per-shot, since the same character can lead one shot and support the next, unlike kind which is fixed for the asset everywhere.
- **Direction** - a small draggable/resizable lane timeline scoped to the shot's own duration - one **Camera** lane plus one lane per cast subject with an acting role. Drag a segment to move it, drag its edges to resize, click it to edit its fields (movement/framing/speed for camera, free-text action for subjects) in the panel below. A beat/time ruler above the lanes and a beat-boundary preview row below them show the musical grid and the semantic beats the compiler will actually merge segments into. The **Snap: on/off** toggle in the toolbar controls whether dragging a segment (or its edges) snaps to that ruler on release, same free-during-drag/snap-on-release behavior as the Shots track. The expand icon moves the same lanes into a large modal for more room - no separate view, just a reparent.
- **Prompt** - free-text prompt for that shot, round-tripped through the project JSON, plus a **Seed** field: the seed to use for the *next* generation in the Generate tab (leave it blank for a random one each time). A completed take keeps a record of whichever seed it actually used, independent of whatever this field holds later.
- **Notes** - free-text notes for that shot, same round-trip.
- **Generate** - triggers video generation for this shot against a configured ComfyUI Pod (see [Setup](#setup) below) and keeps every take rather than overwriting: each entry shows its seed, status, and (once done) an inline video player, with **Set active** / **Delete** actions. Generating always adds a new take, even re-running with the same prompt.

**"Compile prompt"** (in the Direction tab) feeds the Direction data into MiniMax H3's structured reference-generation prompt (see [docs/h3-shot-direction-roadmap.md](docs/h3-shot-direction-roadmap.md)) and writes the result into the **Prompt** tab. Keep segments coarse - a handful of large beats compiles far more reliably than many tiny ones.

---

## Export

- **Whole project** - the **☰** menu has an **"Export project"** button (plus an **"Include mix snippet"** checkbox). It builds the full per-shot export package from the product doc: `export/shot-XXX/` folders, each with `lip_sync.flac`, `shot.json` (the render manifest - frame counts, frame rule, assigned asset paths), `prompt.txt`, `notes.md`, copied assigned assets, and optionally `mix.flac`. A floating task panel (bottom-right) tracks aggregate progress ("Shot 12 of 37") with a **Cancel** button; cancelling stops between shots (and mid-encode on the current one) without leaving a corrupted or partially-written shot folder behind.

Both need a vocal track already loaded (see above), and the mix track too if "Include mix snippet" is checked; the project must have been saved at least once since.

---

## Setup

The **"Setup"** button in the **☰** menu opens an application-wide connection dialog with two independent sections - separate from any project, stored locally on the backend and never written into a project's JSON or export.

**AI Provider** (optional image descriptions / prompt expansion):

- **API base URL** and **API key** for an OpenRouter-compatible chat completions API.
- **Default model**: used whenever a per-image request doesn't override it.
- **Test connection**: a quick round trip (`GET {base URL}/models`, then a tiny real completion if a default model is set) to confirm the key/URL/model work before relying on them.

With nothing configured, the rest of the app behaves exactly as before. Once configured, each **image** asset's card in the Assets tab gets a **Description** field plus a **"Describe image"** button (with an optional per-request model override). Clicking it sends that one image to the configured provider and streams the response straight into the description field as it arrives - one explicit action per image, never automatic or batched. Like export, this needs the project to have been saved at least once since the image was imported (asset import copies the file to disk right away, but it only becomes part of `project.json` - and therefore visible to the backend - once "Save project" runs).

**ComfyUI (Pod)** (per-shot video generation, see the **Generate** tab described above):

- **Pod base URL** - a ComfyUI instance running on a RunPod Pod (e.g. `https://<pod-id>-8188.proxy.runpod.net`). RunPod Serverless isn't supported yet.
- **API key** - stored, but not wired into any request yet. RunPod's HTTP proxy has no authentication of its own; how to secure it (a basic-auth sidecar, an SSH tunnel, or something else) is still an open decision.
- **Test connection**: checks that the Pod responds to `GET {base URL}/system_stats`.

The workflow itself (which ComfyUI nodes receive the prompt / reference images / seed) is a separate, still-in-progress piece on the backend (`backend/app/comfy_workflow_template.py`), independent of this connection setup.

---

## Backend

A minimal FastAPI backend (`backend/`) replaces the old "download a JSON file" save/load with a real project folder on disk:

- `POST /api/projects` creates a new project folder + `project.json`. `GET /api/projects` lists every project (id, name, shot count, last-saved time) for the **Projects** picker.
- `GET /api/projects/{id}` / `PUT /api/projects/{id}` read/write it.
- `PUT` runs as a job (`GET /api/jobs/{jobId}` + `/events` for SSE progress) - the same job/SSE shape export and AI description reuse.
- `POST /api/projects/{id}/assets` imports one or more files into that project's `assets/` folder and returns their metadata/thumbnail descriptors (no project.json write - that's still "Save project").
- `POST /api/projects/{id}/audio/{track}` (`track` = `mix` or `vocal`) uploads the raw audio file itself to `audio/<track>.<ext>`.
- `POST /api/projects/{id}/export` runs the whole-project export as a job with aggregate SSE progress; `POST /api/jobs/{jobId}/cancel` requests cancellation, checked between shots and mid-`ffmpeg`-encode.
- `GET /api/settings` / `PUT /api/settings` read/write the application-level provider connections - `providers.ai` (chat API) and `providers.comfy` (ComfyUI Pod) - in `backend/data/settings.json` (gitignored). API keys are never echoed back in the `GET` response, only whether one is saved.
- `POST /api/settings/test` makes a lightweight request against whichever provider (`ai` or `comfy`) is specified and reports whether it succeeded.
- `POST /api/projects/{id}/assets/{assetId}/describe` streams one image to the configured AI provider's chat completions endpoint (`stream: true`) and re-emits each token as a job event's `delta` field over the same SSE job shape, so the frontend can pour the response into the description field as it arrives.
- `POST /api/projects/{id}/shots/{shotId}/generate` submits a generation job to the configured ComfyUI Pod (upload reference images, submit the workflow, poll for completion, download the result) over the same job/SSE shape; the resulting file lands under `shots/<shotId>/takes/<takeId>/output.mp4` in the project folder. Like the endpoints above, it never writes `project.json` itself - the frontend records the take and persists it via the normal Save.

Projects are stored under `backend/data/projects/<id>/` (gitignored) - `project.json`, `audio/`, `assets/<assetId>/`, `shots/<shotId>/takes/<takeId>/` (generated videos), `exports/scratch/` (single-shot export), and `export/` (whole-project export, rebuilt fresh on every run). Files are served straight off disk at `/project-files/<projectId>/<relativePath>`. The frontend keeps its current project id in the browser's `localStorage` and switches it via the **Projects** picker in the **☰** menu.

Requires `ffprobe`/`ffmpeg` on `PATH` for asset metadata, thumbnails, and export. `ffmpeg` calls all run via a plain synchronous `subprocess.Popen` in a background thread rather than `asyncio.create_subprocess_exec` - the latter needs the Proactor event loop on Windows and raises `NotImplementedError` on Selector, which some `uvicorn --reload` worker processes end up on regardless of the policy set at startup.

---

## What the editor deliberately doesn't do

- No automatic shot or cut detection - all boundaries are set manually.
- No audio mixing (no gain, solo, mute, fades).
- No local rendering - video generation happens via a configured ComfyUI Pod (see [Setup](#setup)), not inside the app itself.

Full details and roadmap: [docs/musical-shot-editor.md](docs/musical-shot-editor.md).
