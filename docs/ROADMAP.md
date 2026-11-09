# Roadmap — phased implementation

Phases build on `ct3-web` as it is; nothing is rebuilt. Each phase ends with a `?selftest` check and screenshots as now.

## Phase 0 — Hygiene (½ day)  ← prerequisite, not a restart
- `git init`, `.gitignore` (samples symlinks, chrome profiles), first commit of the current state.
- Pin CDN versions already used; add `docs/` links to README/STATUS.
- Typed-array export of a lap (`app.lapArrays(lap)` → `{t, x, y, z, yaw, speed, ...}` Float32Arrays) — the one API the 3D module needs.

## Phase 1 — 3D pane v0, procedural track (1–2 weeks)  ← **recommended next milestone**
- `js/replay3d.js` + Three.js (pinned CDN). Fourth dock pane "3D" with the same toggle/maximise behaviour as Map.
- Procedural track ribbon from the reference lap's GPS trace: width 12 m default (or from trace spread), kerb strips at corner
  entry/exit from `circuits.json`, smoothed GPS elevation profile, S/F line, sector split markers, corner labels (reuse existing data).
- Placeholder car (simple low-poly GT shape or a CC0 GLB) with wheels; position/yaw from telemetry per §4.5; ghost = second selected lap.
- Cameras: chase, overhead, free. Playback is the existing cursor/clock, so Play/scrub/slow-mo/corner-jump already work.
- Badges: *approximate geometry*, *measured* / *estimated* per car. Settings → 3D (sync mode, ghost opacity, quality).
- Exit criteria: Zandvoort and Hungaroring samples replay at 60 fps with two cars; delta visibly matches the Delta-T graph.

## Phase 2 — Asset system + first real car (1–2 weeks)
- `assets/manifest.json`, `cars/<id>/car.json + car.glb`, `liveries/<car>/*.png`; GLTFLoader with Draco/meshopt; livery material
  swap at runtime; car + livery pickers in the 3D toolbar; cockpit camera from `car.json`.
- Blender car convention + `tools/blender/prepare_car.py`; one neutral GT3-style car built in Blender with a UV livery template.

## Phase 3 — Calibrated tracks + Blender track pipeline (2–3 weeks)
- `track.json` schema, calibration window (control points → similarity transform), surface snapping by raycast, `track.glb` loading.
- `tools/blender/prepare_track.py`, `export_glb.py`; first calibrated track from own/licensed geometry (candidate: Zandvoort from
  OSM + AHN LiDAR, which is open data for the Netherlands).
- Accuracy tiers and licence metadata surfaced in the UI.

## Phase 4 — Cameras, coaching, polish (1–2 weeks)
- Trackside cameras from `track.json`, virtual coaching cameras placed in-app and saved per track (then exported), camera
  transitions, picture-in-picture of the second lap's camera, graph ↔ 3D cross-highlighting of corners.

## Phase 5 — Trust & data quality (1 week)
- Data-quality window (sats, fix, gaps, heading jumps, distance consistency), estimated-motion rules for speed-only files,
  yaw-rate fusion, unit tests for geometry/sync run under Node (vbo.js, maths.js, motion solver are DOM-free).

## Phase 6 — Desktop (2 weeks, when needed)
- Tauri shell; Rust replaces `serve.py` (file dialogs, range streaming, asset cache, project files). Offline by construction.

## Recommended next concrete milestone
**Phase 0 + Phase 1**: initialise Git, add the typed-array lap export, then build the 3D pane with a procedural track and a
placeholder car driven by the existing clock, two-car ghost, chase/overhead/free cameras, measured/estimated badges. This gives
the differentiating feature on real data for every circuit in the database within about two weeks, without any asset licensing
dependency, and every later phase (assets, calibration, cameras) slots into that pane rather than replacing it.
