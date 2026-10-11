# Changelog

Notable changes to CropView. The capture app (`index.html`, version in `package.json`) and the Data Explorer (`cropview-viewer-v2.html`) are versioned separately.

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
