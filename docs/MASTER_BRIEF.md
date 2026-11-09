# Master Brief — CT3 Web → 3D Telemetry Replay

Status: draft for approval (2026-11-05). Companion: `ROADMAP.md` (phases + next milestone), `../STATUS.md` (day-to-day state), `../README.md` (how to run).

## 1. Product vision (as briefed)

A professional motorsport telemetry tool in the the desktop application / MoTeC class whose differentiator is an **interactive 3D replay**:
import telemetry → pick circuit, car and livery → watch the *actual* lap reconstructed in a simulator-style 3D scene, with two-car
ghost comparison, chase / cockpit / overhead / trackside / free cameras, graphs synchronised to playback, and virtual coaching
cameras. Assets (circuits, cars, liveries) are built **once** and recombined at runtime; normal playback uses **zero generative
AI calls**; the app must work offline on locally stored telemetry and eventually ship as a downloadable desktop app.

## 2. What exists today (inspected 2026-11-05)

`~/ct3-web` — vanilla HTML/CSS/JS, no build step, no framework, no package.json, **not a Git repository**. Served by `serve.py`
(Python stdlib HTTP server with folder browsing, Spotlight file search and HTTP-Range streaming). Third-party code: Leaflet 1.9.4
from a CDN. ~3.3k lines of JS.

| File | Role | Reusable for 3D? |
|---|---|---|
| `js/vbo.js` | the manufacturer `.vbo` parser, lon/lat decoding, local-metre projection (`proj`), gate crossings, gate-from-point | **Yes, as is** — projection + crossings are exactly what a 3D scene needs |
| `js/app.js` (~2.9k lines) | Session/lap model, channel definitions, laps grid, video panes, playback clock, menus, all tool windows, selftest | **Yes** — the lap sample model and the playback clock are the sync backbone |
| `js/charts.js` | Stacked graph (Distance/Time/Position axis, zoom, cursor, sector bands) | Yes — already cursor-driven |
| `js/map.js` | Leaflet satellite map, traces, S/F, finish, corners, user sector splits | Yes — becomes the "overhead 2D" view; the 3D pane sits beside it |
| `js/maths.js` | Expression engine + Standard Maths Library | Yes — unaffected |
| `js/data.js` | Demo session synthesiser, sector times, `sampleAt` interpolation | Yes |
| `data/circuits.json` | 873 circuits: S/F gate, 8970 named corners (lat/lon) | **Yes — the seed for procedural 3D tracks** |
| `data/brands_hatch_indy.json` | Real centreline (from Circuit Database `.CIR`) | Yes — first procedural-track test case |
| `assets/` | Real CT3 icons, placeholder clip, theme tokens | Unaffected |
| `serve.py` | Static + local file API | Extend (asset manifest, caching); later replaced by a Tauri/Rust shell |

### Lap data model (the contract the 3D engine will consume)
Each lap = `{ samples[], time, lengthM, vmax, kind, session }`; each sample =
`{ i, t, dist, speed (m/s), lat, lon, heading (rad, math convention), latG, longG, throttle, brake, rpm, steer, gear, avitime, avifile }`.
Raw columns stay in `session.vbo.data[col]` (Float64Array) and include `height` (GPS altitude, m), `vert-vel`, `sats`,
`solution_type`. Sample rate 10–25 Hz (field `rateHz`). `CTData.sampleAt(lap, dist)` interpolates by distance; `app.indexBy(lap,
'avitime'|'t', v)` looks up by time.

### Playback clock (already the sync point for everything)
`app.tick()` advances `cursorX` each animation frame. When the reference lap has a real video, **the video element is the master
clock** and data follows the frame; otherwise a dt-based clock with `playbackSpeed` (0.25–8×). Everything renders from
`app.cursorDist()` / `app.sampleAtCursor(lap)`: charts, map marker, video HUD, sector bar, map context box. A 3D pane only has to
read the same cursor to be in sync with graphs and video.

### Working features (see `STATUS.md` for detail)
Ribbon/laps grid/video/graph/map replica, light+dark themes, real `.vbo` import (10/25 Hz, 70+ CAN channels), circuit recognition,
custom S/F, separate finish (point-to-point), four sector modes incl. user-placed splits saved per track, maths channels with a
real expression engine, Insights (per-corner analysis, Claude note suggestions), Track Report, Reports, Measure, multi-session
tabs, CSV export, video auto-link + range streaming + video-as-master-clock, keyboard shortcuts.

### Incomplete / limitations relevant to the vision
- No 3D at all; no asset system; no car/livery concept; no camera system.
- Vehicle attitude is not computed: only position (lat/lon), GPS heading, speed. No yaw-rate fusion, no pitch/roll, no slip.
- GPS height is read but unused for geometry; GPS altitude noise (±1–3 m, drifts) is unsuitable for direct 3D placement.
- Demo session is synthetic (Brands Hatch Indy centreline + generated channels).
- Single-threaded; all per-lap arrays are plain JS objects (fine for 25 Hz × 10 min, not for 100 Hz × 2 h).
- No persistence beyond `localStorage` (settings, maths, sector splits); no project files.
- No tests other than the `?selftest=1` dev aid; not under version control.
- Smoothness of two simultaneous large H.264 streams not verified on screen.

## 3. Gap analysis against the vision

| Vision item | Today | Gap |
|---|---|---|
| 1 Telemetry-driven movement | Position/heading/speed per sample exist | Attitude (pitch/roll/yaw) estimation, smoothing, measured-vs-estimated flag |
| 2 Realistic 3D circuits | 2D satellite map + centrelines/corners | Track asset format, calibration, procedural fallback, elevation |
| 3 Cars + liveries | — | Car asset format (GLB), livery texture swap, manifest |
| 4–7 Cameras | — | Camera rig system (chase, cockpit, overhead, trackside, free) |
| 8 Ghost comparison | Two laps already selected/coloured in graphs | Second vehicle instance, transparency material |
| 9 Time / distance sync | Distance-based cursor; time axis exists | Explicit sync-mode switch for the second car |
| 10–11 Graphs synced, channels | **Done** | Nothing — reuse |
| 12 Playback, slow-mo, scrub, corner select | **Done** (0.25–8×, scrubbing, corner list in Insights) | Jump-to-corner from 3D scene |
| 13 Virtual coaching cameras | Sector splits saved per track show the pattern | Same pattern for camera positions (per-track storage → asset file) |
| 14 Offline / local | **Done** (local server, local files) | Desktop packaging later (Tauri) |

## 4. Architecture proposal

### 4.1 Keep the stack, add one rendering module
No framework migration. The current vanilla-JS + no-build setup is a strength for a desktop-packaged tool (instant load, easy
Tauri wrap). Add **Three.js (r16x, CDN like Leaflet, pinned)** in a new file `js/replay3d.js` exposing `CTReplay3D.Pane(el, app)`
with the same lifecycle as `CTMap.TrackMap` (`drawTraces()`, `updateCursor()`, `invalidate()`). It becomes a fourth dock pane
("3D" toggle in View, next to Map), maximisable like the others. React/TypeScript/Rust are **not** justified by the 3D feature
itself; revisit TypeScript only if the team grows. Python stays for offline asset tooling (Blender scripts).

### 4.2 Reusable asset system (the key decision)
```
assets/
  manifest.json                 # lists tracks, cars, liveries (id, name, version, files, licence)
  tracks/<track-id>/
    track.json                  # calibration: origin lat/lon/alt, yaw, scale, elevation offset, S/F, centreline source,
                                #   named cameras[], pit lane, licence/attribution, accuracy class
    track.glb                   # optional: licensed/own 3D mesh (Draco/meshopt compressed), Y-up, metres, origin = track.json origin
    centreline.json             # optional: dense centreline + width + banking (also what the procedural builder consumes)
  cars/<car-id>/
    car.json                    # wheelbase, track, dims, cockpit camera offset, chase offsets, wheel node names, livery UV template
    car.glb                     # body + separate wheel nodes, one "livery" material slot
  liveries/<car-id>/<livery-id>.png|ktx2
```
Runtime = `track × car × livery × telemetry`, combined by the engine; nothing is pre-rendered per combination. Assets are
versioned and cached by the browser / shipped with the desktop app. **No AI inference anywhere in playback.**

### 4.3 Circuit geometry — three accuracy tiers, always labelled
1. **Procedural (day one, all 873 circuits)**: build a track ribbon mesh from the reference lap's own GPS trace (or the Circuit
   Database centreline when available): width from `track.json` default (12 m) or from the spread of all laps' traces, kerbs at
   corner entries/exits from `circuits.json`, elevation from a smoothed GPS height profile (median of all laps, low-pass, pinned to
   0 at S/F). Label: *approximate geometry*.
2. **Calibrated mesh**: licensed/own GLB aligned to WGS-84 via `track.json` (origin + yaw + scale + elevation offset). Calibration UI
   in-app: pick 2–3 control points (S/F, two corner apexes) on the mesh and on the GPS trace → least-squares similarity transform →
   stored in `track.json`. Car Y is then **snapped to the mesh surface** (raycast) instead of GPS altitude. Label: *calibrated*.
3. **Surveyed**: same as 2 but from LiDAR/photogrammetry/official CAD. Label: *surveyed*.

**Assetto Corsa**: Kunos-made content and most mod tracks cannot be redistributed; `.kn5` is a proprietary format. Treat AC only as
a *private, local, user-supplied* source (the user converts their own licensed files with the Blender kn5 importer and the app
imports the resulting GLB). Ship nothing derived from AC. For distributable content use own Blender builds, OpenStreetMap +
public DEMs (Copernicus 30 m / national LiDAR), or commercially licensed scans. Record `licence` in every `track.json`.

### 4.4 Blender pipeline (offline, Python, `tools/blender/`)
`import_any.py` (FBX/OBJ/glTF/kn5-via-addon) → `prepare_track.py` (set units to metres, Y-up on export, move origin to S/F, decimate
to budget, bake AO, split road/kerb/grass/wall materials, name camera empties `cam_*`) → `export_glb.py` (Draco or meshopt).
`prepare_car.py` enforces the car convention (origin at ground under rear axle centre, +Z forward in Blender → −Z in three.js,
wheel empties `wheel_fl/fr/rl/rr`, single `livery` material with the UV template exported as PNG for painters).

### 4.5 Vehicle motion from telemetry (measured vs estimated)
Per frame, for each displayed lap at the current clock:
- **Position**: `proj(lat, lon)` → local metres (existing `CTVbo.proj`), Catmull-Rom between samples (not linear) to avoid 10 Hz
  stepping; height from the tier rule above. Source flag: *measured* (GPS fix with `sats ≥ 6`, `solution_type` OK) else *estimated*.
- **Yaw**: GPS course (`heading`) low-passed, fused with `yaw` rate channel when present (complementary filter); fallback: tangent of
  the smoothed position path. Flag *estimated* when derived from the path.
- **Pitch/roll**: from the track surface normal (tier 2/3) plus a small body-roll term from `latG` (visual only, parameterised in
  `car.json`); never presented as measured.
- **Wheels/steer**: wheel spin from speed and tyre radius; front steer from `steer` / steering ratio (same parameters already
  used by the Understeer maths channel).
- **Speed/distance-only files** (no GPS): place along the track's reference centreline by `dist`; whole car badge *estimated*.
- Data-quality panel: sats, fix type, dropouts, heading jumps > 30°/sample, dist vs. lap-length mismatch, time gaps.

### 4.6 Sync and ghost
Primary car = reference lap, driven by the existing cursor/clock (video stays master when present). Ghost = any other selected
lap: **time-sync** places it at the same elapsed `t`; **distance-sync** at the same `dist` (so it sits exactly beside the primary
and the visible gap is the delta-T). Ghost material: same livery, 35 % opacity, depth-write off. Switch in the 3D pane toolbar,
also as a Settings key.

### 4.7 Cameras
A small rig abstraction `{ update(dt, carState, scene) }`: chase (spring-damped follow behind yaw, speed-dependent distance/FOV),
cockpit (offset from `car.json`, head-yaw toward apex optional), overhead (orthographic, follows or fixed), trackside (auto-select
nearest `cam_*` in `track.json` or user-placed), free (OrbitControls). **Virtual coaching cameras**: click in overhead/free view to
place, saved per track like sector splits (`localStorage` first, exported into `track.json` by the asset tool).

### 4.8 Performance budget
60 fps at 1080p on integrated GPUs: track ≤ 300k triangles, car ≤ 80k, textures ≤ 2k, one directional shadow (CSM later), Draco or
meshopt compression, frustum culling by track segment. Telemetry arrays → typed arrays (`Float32Array` per channel) in the 3D
module; the existing sample objects stay for the 2D UI.

### 4.9 Desktop packaging (later)
Tauri shell with a Rust side replacing `serve.py` (file dialogs, range streaming, asset cache). Nothing in the current code is
browser-API dependent beyond `fetch` to the local server, so this is additive.

## 5. What is reused vs new

Reused unchanged: VBO parser, projection, lap splitting, sample model, playback clock, charts, map, maths, sectors, windows,
themes, server. New: `js/replay3d.js` (scene, assets, motion, cameras, ghost), `assets/manifest.json` + folders, `tools/blender/*`,
`tools/build_track.py` (procedural track + elevation bake from telemetry), calibration window, data-quality window, Settings → 3D
section. Modified lightly: `index.html` (pane + CDN script), `app.js` (pane toggle, cursor hooks, Settings keys), `css/app.css`.

## 6. Risks
Licensing of track geometry (mitigated by tiers + procedural default); GPS altitude noise (mitigated by mesh snapping and
smoothed profile); 10 Hz data stepping (interpolation + heading fusion); scope creep in cars/liveries (start with one neutral GT
car and a UV template); WebGL perf on Intel Macs (budget above, ghost shares geometry).
