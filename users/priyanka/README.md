# Shevga — moringa trees of IIT Bombay

A field notebook for Priyanka's survey of the moringa (Shevga) trees on the IIT Bombay campus.

**Open:** https://somdeepkundu.github.io/cropview-v3/users/priyanka/

## What it records
- **Every photo belongs to a tree.** A tree is named by its IIT Bombay inventory tag (`#L1048`). Scan the tag's QR or type it. The painted trunk number is kept as well.
- **Where the tree stands**, by any of three methods, each kept separately:
  1. GPS averaged for about 15 s while standing at the trunk.
  2. The crosshair on the trunk base, seen from open ground (camera height × tan tilt along the heading).
  3. Photo directions: two or more whole-tree photos from different sides, crossed by least squares.
- **Each photo**: position, look direction, tilt, and compass trust. Compass trust compares the gyroscope with the compass and flags magnetic disturbance near cars, railings and poles.
- **Each visit**: leaves (flush / not flush / mixed / bare), flowers, pods, the leaf-sample bag label, and a note.
- **Export ZIP**: photos; trees GeoJSON + CSV (with all three position estimates); visits CSV; photo points, photo directions, README.

## In the field
- Open it once on Wi-Fi; after that it works offline. On Android Chrome, "Add to Home screen" installs it.
- The first launch shows a short tutorial. **?** (top right) has the field guide and replays the tutorial.
- Take the same photos at every visit: whole tree from 8–15 m, tag, trunk, canopy looking up, leaves, flowers or pods.
- Under a thick canopy, GPS is often ± 15 m or worse. Lock at the trunk anyway, and add whole-tree photos from two open sides.
- Export the ZIP before leaving the field.

Built on the `phone-field-sensors` and `phone-sensor-lab` skills (geo-dev-skills-bysomdeep).

Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License
