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

## Saving & exporting a project

- **"Save project"**: writes tempo, video and shot settings plus all shot boundaries to the project folder on disk via the backend. The audio files themselves are **not** saved - when reloading the project, the mix and vocal may need to be reselected.
- Loading happens automatically: the browser remembers which project it last opened and reloads it from the backend on the next page visit.
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

- **Single shot** - the **Shot** tab has an **"Export lip-sync"** button once a shot is selected. It renders `lip_sync.flac` for that one shot - FLAC, 32 kHz, mono, covering the H3 **render** duration (cut duration plus frame-rule overhang, not the raw cut length) - with a live progress bar driven by ffmpeg's own `-progress` output, and a link to the result once it's done. Output goes to a scratch folder, mainly useful for spot-checking one shot.
- **Whole project** - the footer has an **"Export project"** button (plus an **"Include mix snippet"** checkbox). It builds the full per-shot export package from the product doc: `export/shot-XXX/` folders, each with `lip_sync.flac`, `shot.json` (the render manifest - frame counts, frame rule, assigned asset paths), `prompt.txt`, `notes.md`, copied assigned assets, and optionally `mix.flac`. A floating task panel (bottom-right) tracks aggregate progress ("Shot 12 of 37") with a **Cancel** button; cancelling stops between shots (and mid-encode on the current one) without leaving a corrupted or partially-written shot folder behind.

Both need a vocal track already loaded (see above), and the mix track too if "Include mix snippet" is checked; the project must have been saved at least once since.

---

## Backend

A minimal FastAPI backend (`backend/`) replaces the old "download a JSON file" save/load with a real project folder on disk:

- `POST /api/projects` creates a new project folder + `project.json`.
- `GET /api/projects/{id}` / `PUT /api/projects/{id}` read/write it.
- `PUT` runs as a job (`GET /api/jobs/{jobId}` + `/events` for SSE progress) - the same job/SSE shape export and AI description reuse.
- `POST /api/projects/{id}/assets` imports one or more files into that project's `assets/` folder and returns their metadata/thumbnail descriptors (no project.json write - that's still "Save project").
- `POST /api/projects/{id}/audio/{track}` (`track` = `mix` or `vocal`) uploads the raw audio file itself to `audio/<track>.<ext>`.
- `POST /api/projects/{id}/export` runs the whole-project export as a job with aggregate SSE progress; `POST /api/jobs/{jobId}/cancel` requests cancellation, checked between shots and mid-`ffmpeg`-encode.
- `POST /api/projects/{id}/shots/{shotId}/export/lip-sync` runs `ffmpeg -progress pipe:1` as a real job (live SSE progress, not just start/done) and writes `exports/scratch/shot-<id>-lip_sync.flac`. The render duration is computed server-side (a Python port of the frontend's H3 frame math), not trusted from the client.

Projects are stored under `backend/data/projects/<id>/` (gitignored) - `project.json`, `audio/`, `assets/<assetId>/`, `exports/scratch/` (single-shot export), and `export/` (whole-project export, rebuilt fresh on every run). Files are served straight off disk at `/project-files/<projectId>/<relativePath>`. The frontend keeps its current project id in the browser's `localStorage`; there's no project picker UI yet, just the one project a browser last opened.

Requires `ffprobe`/`ffmpeg` on `PATH` for asset metadata, thumbnails, and export.

---

## What the editor deliberately doesn't do

- No automatic shot or cut detection - all boundaries are set manually.
- No audio mixing (no gain, solo, mute, fades).
- No video preview, no rendering - the editor only plans the cut points.

Full details and roadmap: [docs/musical-shot-editor.md](docs/musical-shot-editor.md).
