# web viewer — status (2026-11-05, afternoon)

Project: `~/ct3-web` (vanilla HTML/CSS/JS, no build step). Run `python3 serve.py` → http://127.0.0.1:8765/
Memory note for Claude: `project_ct3_web_replica` (plus `project_pirelli_telemetry_tool` for the corner database).

## Origin
The desktop application (Windows, v3.2.120.1762) is not available on Mac. The installer
the Windows installer was unpacked (WiX Burn → MSI → MSZIP cabs; use an offset-sliced cab reader).
Everything visual comes from the app's own resources: icons, placeholder video, the 633-entry string table, light/dark
theme palettes, ribbon/dock layout from the compiled XAML, About artwork. The bundled Circuit Database gave
`data/circuits.json` (873 circuits with start/finish gates, 8970 named corners) and the Brands Hatch Indy centreline for
the demo session.

## What works
- Main window: ribbon, laps grid (Show/Lap/Time/Delta/VMax/Ref/S1..Sn, Ideal row, summary footer), 2–4 video panes,
  stacked graph (Position/Distance/Time axis, zoom, cursor), satellite track map (Esri tiles) with lap traces, S/F gate,
  corner labels, cursor markers. Light + dark theme (exact app colours). Keyboard shortcuts like the real app.
- Windows: Settings (8 sections incl. Coach AI key + Channel Mapping), Maths Channels, Reports, Measure, Insights
  (per-corner braking / turn-in grip, combo-G map, G-ball, notes, Claude "AI" suggest), Track Report (heat map, tiles,
  laps table, WhatsApp share), About, Open VBOX file (browses real folders via serve.py).
- Real `.vbo` files: parser (`js/vbo.js`), 10/25 Hz, 70+ CAN channels, lat/long minutes (West-positive → negated),
  `[laptiming]` gate (point + direction → 25 m gate), fallback to Circuit Database layouts, Track combo lists layouts
  within 8 km, custom S/F by clicking the map, longitude flip. Auto channel mapping (ecu_aps, log_pbrake_f, RPM,
  log_asteer, sclu_acc_y/x, sclu_yaw_rate, ecu_gear) with sign checks. Multiple sessions as tabs, Sessions mode,
  CSV export. Tested: Zandvoort Porsche #513 (19 laps), Hungaroring 991.2 (6), Nürburgring GP (7), NLS3 Nordschleife (6).
- Video: the desktop application naming (`<AVI prefix>0001.mp4`, per-lap `avifileindex` + `avitime`). Auto-link from the VBO's
  folder (when opened via the server/Open dialog) or by name search (Spotlight → bounded walk incl. /Volumes). Range
  streaming for multi-GB files. Video = master clock during playback (no seeks); follower panes steered by playback
  rate; throttled scrubbing; per-pane sound button (one audible at a time). Drop folder / files / deep link `?path=`.
- Performance: chart static layer cached offscreen; map markers moved not rebuilt; DOM updates throttled.
- Maths Channels (`js/maths.js`): real expression engine (parser + per-lap evaluator with stateful d/dt, ∫, smooth, prev,
  cummax/cummin, if/and/or/not, comparisons, `[Name With Spaces]`, `$Param`). Standard Maths Library = 9 expression
  templates with editable parameters (Bogging, Brake/Throttle/Steering Velocity, Coasting, Cumulative Lateral Accel,
  Gradient, Pedal Overlap, Understeer/Oversteer). "My Maths Channels" are saved in localStorage `ct3.maths`, can
  reference sample fields, any CAN column and other maths channels by name, show live validation + min/max on the ref lap,
  and appear under Channels → Maths Channels. Apply / OK / Delete / Add New / key-pad insertion all work.
- Sector modes: `app.sectorModel()` gives `{n, fr}` boundary fractions for the ref lap. Equal Distance; Max Speed (split at
  the N-1 most prominent speed peaks, cyclic prominence); Max Accel/Decel (peaks + apexes); Custom Sectors (one per
  corner, boundary at corner exit). "Number of Sectors…" prompt in the Track … menu. Laps grid, sector bar (proportional
  widths), graph/map highlighting, Reports and Track Report all use the model.
- User sector splits: Track … → "Add Sector Split (click on map)", click the driven line once per split (Esc when done),
  Undo Last Split / Clear Saved Splits. Stored as [lat, lon] per track key (circuit name, else rounded S/F) in
  localStorage `ct3.sectors` and re-applied automatically whenever that track is loaded (takes priority over the
  corner-exit fallback in Custom Sectors mode). Blue numbered markers on the map. Dev aid `?splits=lat,lon;lat,lon`.
- Separate finish (point-to-point): Track … → Set Separate Finish, click the map. Also honours a `Finish` line in
  `[laptiming]`. Runs go start-crossing → next finish-crossing; transit back to the start is ignored. Yellow/black FINISH
  gate on the map. Clear Separate Finish / Reset Start/Finish remove it.

## Open points / not done
- Smoothness with two large H.264 streams not verified on screen (headless only). If still choppy → 720p proxy
  transcode script (ffmpeg not installed; app's own `Miscellaneous/ffmpeg.exe` is Windows).
- Pit lane marks visual only; Save PDF = browser print. Maths: no units conversion inside expressions (speed is km/h,
  accel in g), no per-channel colour/scale settings. Custom Sectors = corner exits only (no click-to-place splits).
- Custom splits live in this browser's localStorage only (no export/import yet).
- Separate finish has only been tested on the Hungaroring sample via `?finish=lat,lon` (7 runs S/F → T4).
- Insights heuristics are my approximation of CT3's (braking window = 6 s before corner entry to apex).
- The 33 unextracted Circuit Database files and the demo-only Brands Hatch GP layout are cosmetic gaps.

## Direction
Master brief + phased roadmap for the 3D replay engine: `docs/MASTER_BRIEF.md`, `docs/ROADMAP.md` (awaiting approval;
recommended next milestone = Phase 0 hygiene + Phase 1 3D pane with procedural track).

## Useful dev aids
`?theme=dark|light`, `?open=settings|insights|report|maths|reports|measure|about|open|file|track|channels`,
`?load=samples/<file>.vbo`, `?path=<absolute .vbo path>` (server, auto-links video), `?video=<url>|<pretend name>`.
`?channels=speed,m_usos,u:<id>`, `?sectormode=Equal|MaxSpeed|AccelDecel|UserDefined&sectorhl=1`, `?finish=lat,lon`,
`?selftest=1` (dumps sector models, maths ranges, lap splitting as JSON into a hidden `<pre id="selftest">`; read it with
Chrome `--headless=new --dump-dom`).
Screenshots during development were taken headlessly with Chrome (`--headless=new --screenshot`).
