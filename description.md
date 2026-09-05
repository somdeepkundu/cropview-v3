# 🌱 CropView v3

**Geo-tagged field crop capture — correct ground geometry, self-healing compass.**

A free, open-source single-file PWA for field researchers and agronomists. Point your phone at a crop; capture its location, heading, and ground field-of-view; match it to satellite data.

**Version 3.1.0** · Layer 1 of 3 · MIT License

---

## What v3.1 fixes

v3.0 rebuilt the compass for reliability but shipped a critical error in the ground-footprint geometry, plus one incomplete fix from its own changelog.

| # | Bug | Symptom | Fix |
|---|-----|---------|-----|
| 1 | `calcFP()` used `S.alt` (GPS altitude above **sea level**) as the camera's height above **ground** | At ~650 m elevation every footprint came out ~430x too large — a 2.7 m plot exported as a 1.2 km polygon, making Layer 2 pixel sampling meaningless | Camera height is now `S.camH`, set per session on the start screen (default 1.5 m) and exported as `camera_height_m` |
| 2 | Tilt was `Math.abs(e.beta \|\| 45)` | In landscape a phone aimed 45° down reported FLAT; a phone aimed at the sky was indistinguishable from one aimed at the crop; a genuine `beta === 0` was silently rewritten to 45° | Tilt is derived from `beta` **and** `gamma` as `acos(cos β · cos γ)` — the true rear-camera angle from nadir, orientation-independent and sign-aware |
| 3 | `S.gotAbsolute = true` ran *above* the `alpha === null` check | One malformed `deviceorientationabsolute` event latched the flag forever and permanently blocked the relative-event fallback — the v3.0 changelog claimed this was fixed, but the code still latched on the bare event | The flag now latches only on a reading that has actually validated |
| 4 | Compass rose rotated by `S.az` (compass only) while the map cone and exports used `S.heading` (fused) | Under `GPS MOVE` the rose and the cone pointed in different directions | Both now read the fused heading |
| 5 | Footprint width used ground range instead of slant range; depth was `gd·tan(v)`; vertical FOV was `hFOV × 9/16`; degenerate results fell back to `\|\| 5` / `\|\| 3` | Systematically undersized footprints and fabricated dimensions where the geometry was undefined | Width uses slant range `√(H²+r²)`, depth is the true near-to-far spread `H(tan(t+v/2) − tan(t−v/2))`, vertical FOV is derived through the tangent, and an at-or-above-horizon aim returns `null` and blocks capture instead of inventing numbers |

**Breaking change for downstream consumers:** exports now carry `camera_height_m`, and `tilt_deg` is duplicated as `tilt_deg_from_nadir` to make the convention explicit (0° = straight down, 90° = horizon). Footprint polygons captured with v3.0 are not trustworthy and should be re-collected.

---

## What v3.0 fixed

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
