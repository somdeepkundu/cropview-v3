# 🌱 CropView v3

**Geo-tagged field crop capture — the compass now heals itself.**

A free, open-source single-file PWA for field researchers and agronomists. Point your phone at a crop; capture its location, heading, and ground field-of-view; match it to satellite data.

**Version 3.0.0** · Layer 1 of 3 · MIT License

---

## What v3 fixes

The FOV cone (and compass rose) used to freeze or drift on some phones, intermittently. v2 already fixed the Android mirroring bug and added GPS-bearing fusion — but the code still trusted every sensor event blindly. Three real DeviceOrientation quirks fell through:

| # | Bug | Symptom | Fix |
|---|-----|---------|-----|
| 1 | `e.alpha \|\| 0` treated a `null` reading as `0` | Cone silently snapped to North | Invalid readings are now rejected outright, never coerced |
| 2 | The Android absolute/relative fallback latched permanently on the first event | If the absolute stream later died, there was no fallback left | The latch only sets on a *validated* reading, and resets on resync |
| 3 | Rendering was 1:1 with sensor events | A stalled or backgrounded stream = a frozen cone, with no signal to the user | A watchdog checks stream health every second and a render loop keeps the UI live independent of event timing |

The app now watches its own compass stream: it validates every reading, detects a dead or stuck stream, and silently resubscribes. If it genuinely can't get a fix, the `SRC` badge says so (`STALE·HOLD` / `SIGNAL LOST`) instead of showing a confident, wrong cone. Tap the compass anytime to force a manual recalibration.

Design informed by three reference projects: [`flutter_compass`](https://github.com/zesage/flutter_compass) (trust the OS-fused heading, corroborate with a second live sensor), [`Camera-Overlay-Android`](https://github.com/kurti-vdb/Camera-Overlay-Android) (redraw continuously, not only on-event), and [`open-sensor-platform`](https://github.com/sensorplatforms/open-sensor-platform) (explicit calibration/confidence state instead of one opaque number).

---

## Heading fusion

```
compass  = platform-corrected, validated deviceorientation(absolute)  (gyro+accel+mag, OS-fused)
gpsBear  = turf.bearing(prevFix, currFix)   when moved ≥ 3 m, accuracy < 25 m

heading  = gpsBear        if a GPS bearing was seen in the last 6 s     [SRC: GPS MOVE]
         = compass + cal  if the compass stream is healthy             [SRC: COMPASS·CAL]
         = compass + cal  if stale/lost — held, but flagged in the UI  [SRC: STALE·HOLD / SIGNAL LOST]

watchdog = runs every 1s: validates the stream, detects a dead or stuck
           sensor, and silently resyncs the listeners when it does
```

The active source and its health are shown live in the HUD (`SRC` badge, colour-coded) and written into every exported feature as `heading_source`.

---

## Quick start

It's a single file — no build step.

```bash
npx serve .
```

Or open the GitHub Pages URL on your phone:
`https://somdeepkundu.github.io/cropview-v3`

**Flow:** Grant permissions → name the project session → capture.

---

## Export

- **Points GeoJSON** — capture locations, with `heading_deg`, `heading_source`, `kc_stage`, footprint dimensions, and the `fov_polygon`.
- **Footprints GeoJSON** — FOV ground polygons (the Layer 2 input for satellite pixel sampling).
- **CSV** — tabular summary.
- **ZIP** — geocoded JPEGs + all data + README.

---

## Files

```
index.html                   ← the capture app (self-contained)
manifest.json                ← PWA manifest
cropview-uploader.html       ← standalone data/image uploader tool
cropview-zip-uploader.html   ← standalone ZIP uploader tool
```

---

## Credits

**Somdeep Kundu** — PhD Research Scholar, RuDRA Lab, C-TARA, IIT Bombay.
Developed for the RGSTC Project, Maharashtra Government.
📧 somdeep@iitb.ac.in · 🌐 [somdeepkundu.github.io](https://somdeepkundu.github.io)

MIT License © 2026 Somdeep Kundu
