# H3 Shot Direction — Implementation Roadmap

Builds on [deep-research-report-h3-prompting.md](deep-research-report-h3-prompting.md). That report's core architectural decision drives this whole feature:

> The timeline stays as fine-grained as the user wants, but the compiled H3 prompt is not emitted at the same granularity. A compiler turns fine sub-clips into a handful of large semantic beats.

v1 scope (per discussion): camera + per-subject action tracks only. Props/object-ownership state machines, the LLM-based compiler variant, and the automated evaluation harness (face-tracking, VLM judge, multi-generation sampling) are explicitly deferred — YAGNI until the deterministic path is proven useful.

The existing `prompt` field on a shot is not replaced. The compiler writes into it as a starting point, exactly like `[Describe image]` already does for asset descriptions - one explicit action, always overwritable, never automatic.

---

## Phase A — Data model

Add, without touching any existing assignment/export logic:

- `shot.assetRoles: { [assetId]: role }` - a role map alongside the existing `shot.assetIds`, only ever keyed by IDs already present there. `role` is optional (an asset can be assigned to a shot without being a "Subject" in the prompt sense - e.g. a mood reference). Roles: `primary_character`, `supporting_character`, `environment`.
- `shot.direction`:
  ```js
  {
    camera: [{ startSeconds, endSeconds, movement, framing, speed }],
    subjects: { [assetId]: [{ startSeconds, endSeconds, action }] }
  }
  ```
  Times are shot-relative seconds (0 = shot start) - independent of the musical grid, since these are H3 direction beats, not beats of the song. `movement` is one of the official vocabulary: `zoom_in`, `zoom_out`, `push_in`, `pull_out`, `pan`, `truck`, `tracking_shot`, `arc_shot`, `static_shot`.

Both fields round-trip through save/load (`project.js`) and default in for older project files, same pattern as `prompt`/`notes`/`assetIds` already do.

**Acceptance:** a shot's `assetRoles` and `direction` survive a full save → reload cycle; older projects without these fields load without error, defaulting to empty.

---

## Phase B — Direction modal UI

A modal (same pattern as the Setup dialog and the planned Assets detail modal - infrequently touched, wants real room when it is), opened via a button from the Shot tab:

- **Asset roles**: for each asset currently assigned to the shot, a role picker (`none` / primary character / supporting character / environment).
- **Camera track**: a list of segments (start, end, movement dropdown from the fixed vocabulary, framing, speed), add/remove.
- **Per-subject action tracks**: one section per roled asset, each a list of `{ start, end, action text }` entries, add/remove.

No timeline-widget/waveform-style dragging required for v1 - plain list-based add/edit/remove rows is enough; the fine-grained authoring the report describes doesn't need pixel-perfect drag interaction to be useful.

**Acceptance:** camera and subject segments can be added, edited, and removed through the modal; changes persist through the same save/reload cycle as Phase A.

---

## Phase C — Deterministic compiler + trigger

A pure JS function `compileH3Prompt(shot, project)`:

1. Normalize roled assets to a stable `Subject N` order (primary character first, then supporting, then environment).
2. Union all start/end times across the camera track and every subject track into beat boundaries. No automatic merging of short segments in v1 - the UI encouraging coarse segments in the first place stands in for that, per the open point raised during planning.
3. Per beat: translate the active camera segment into the official natural-language phrasing pattern (movement + speed + framing), append active subject actions.
4. Build `subject_definitions` and `retention_analysis` (`fully_preserved` per roled subject) blocks.
5. Build `detailed_description` from the beats, with a continuity note when the shot is a single, uncut take.
6. Derive a short, targeted `limits` list without needing props: no identity/role swap between character subjects, no additional people, no cut (when continuity applies).
7. `overall_soundscape` / `non_diegetic_music` fixed to `N/A` for v1 - CUTTAlogue doesn't model shot-level sound design yet.
8. Serialize to the official six-field text block and write it into the shot's existing `prompt` field.

A **"Compile prompt"** button (in the Shot tab or the Direction modal) triggers this explicitly - never on save, never automatically.

**Acceptance:** compiling a shot with 2+ roled assets and a few camera/action segments produces well-formed text with correctly ordered Subject labels, one paragraph per beat, and a short limits block; running it twice with unchanged input produces identical output (deterministic, no LLM involved yet).

---

## Deferred (not scheduled)

- LLM-based compiler variant (low-temperature OpenRouter call) as a second, selectable "access" alongside the deterministic one.
- Props/objects with ownership-transition state machines.
- Automated evaluation harness (shot-boundary detection, face-tracking against references, object-state VLM checks, multi-generation sampling, acceptance-matrix scoring).
- Smarter automatic beat-merging inside the compiler itself.
