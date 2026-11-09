# Lap data viewer (web)

Small browser-based viewer for lap timing and data-logger sessions: track map, speed/pedal/G traces,
lap comparison, sector times, synchronised onboard video and user-defined maths channels.

Plain HTML/CSS/JS, no build step. Development notes live in `STATUS.md`; longer-term direction in `docs/`.

## Run

```bash
python3 serve.py            # http://127.0.0.1:8765/
```

Drop a session file onto the window, or use File → Load. Settings, channel mapping and sector
definitions are kept in the browser's local storage.
