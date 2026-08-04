# Musical Shot Editor

A lean, local browser editor for planning video shots against a song: listen to the mix and vocal stem in sync, lock shot boundaries to the musical grid, and see the matching H3 render length (`4n+1` / `8n+1`) right away.

No server, no install, no cloud - everything runs locally in the browser.

For background on architecture and design decisions, see [docs/musical-shot-editor.md](docs/musical-shot-editor.md).

---

## Getting started

1. Open `index.html` in your browser (Chrome, Edge, or Firefox recommended - double-clicking it works).
2. Use **"Load mix"** to pick your music mix.
3. Optionally use **"Load vocal"** to add the vocal stem.

Once the mix is loaded, the timeline appears with four synchronized tracks: **Grid**, **Shots**, **Mix**, **Vocal**.

> If your browser blocks loading files by double-clicking (`file://` restrictions), open the project folder through a simple local server instead, e.g. `npx serve .` and then visit `http://localhost:3000`.

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

- **"Save project (JSON)"**: saves tempo, video and shot settings plus all shot boundaries. The audio files themselves are **not** saved - when reloading the project, the mix and vocal may need to be reselected.
- **"Load project (JSON)"**: restores a previously saved state.
- **"Export shots (JSON / CSV)"**: exports just the shot list with calculated frame counts, e.g. for further use in H3 or an editing tool.

---

## What the editor deliberately doesn't do

- No automatic shot or cut detection - all boundaries are set manually.
- No audio mixing (no gain, solo, mute, fades).
- No video preview, no rendering - the editor only plans the cut points.

Full details and roadmap: [docs/musical-shot-editor.md](docs/musical-shot-editor.md).
