# Changelog

Notable changes to CropView. The capture app (`index.html`, version in `package.json`) and the Data Explorer (`cropview-viewer-v2.html`) are versioned separately.

## CropView 3S (Swarnakhali field edition) 3S.1.0 — 2026-10-26

### Added
- `users/saikat/`: a separate field app for Saikat in Swarnakhali, West Bengal. It uses the CropView look with a green tint.
- Tag chips above the shutter (sticky, custom tags, Bengali labels), and retag or note per photo on the Data tab.
- Bengali (Bangabda, West Bengal Panjika) date on screen and in every export record.
- First-run tutorial.

## Capture app v3.6 + Data Explorer v2.3 — 2026-10-13

### Changed
- New frosted-glass look in both apps: soft aurora background, frosted HUD over the camera, glass map controls, popups, toast and modals, a lit capture button.
- Colour, depth and blur only — no sizes, positions or features changed. Real blur is used only on small floating pieces; low-RAM phones (≤2 GB) and "reduce transparency" get the same look without blur.

### Added
- Glass / Classic switch: About → Look in the camera app, ✨ in the Data Explorer top bar. Shared between both apps on the same device.
- Rollback: tag `v3.4.0-ltr` is the previous design.

## Data Explorer v2.2 — 2026-10-11

### Added
- Photo zoom in the full-screen viewer: pinch, scroll wheel, double-tap or double-click (2.5×), and − / fit / + buttons. Zooms up to 6×.
- Drag to move around a zoomed photo. Movement stops at the photo's edge, so it can't be lost off-screen.
- On phones, swipe left or right to go to the next or previous photo (when not zoomed).
- Keyboard: `+` / `−` to zoom, `0` to fit the photo to the screen.
- A touch-friendly hint bar on phones (pinch, double-tap, drag, swipe).

### Fixed
- Viewer shortcuts no longer fire while typing in the class-code box. Typing `0` or using the arrow keys there now edits the code instead of changing photos.

## Data Explorer v2.1
- Colour legend on the map, arrow-head size slider, overlapping points fanned out per zoom level, viewer navigation direction reversed.

## Capture app v3.4.0 LTR
- Current long-term release. Notes for v3.0 and v3.1 are in `description.md`.
