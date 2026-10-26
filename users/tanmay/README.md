# Powai Lake Survey · shoot-spot scouting

A field camera for **Tanmay**, scouting photo and film locations around Powai Lake, Mumbai.

**Open on the phone:** https://somdeepkundu.github.io/cropview-v3/users/tanmay/
(Chrome → ⋮ → *Add to Home screen*, or Safari → Share → *Add to Home Screen*, to install it like an app.)

## What it does
- **Pick a type, then shoot.** Seven types sit above the shutter in two rows, all on screen: Viewpoint, Promenade, Birds & wildlife, Golden hour, People & life, Landmark and Hazard / restricted. The picked type stays lit, so each photo is still one tap.
- Every photo keeps its position, camera direction, tilt, ground footprint and an aim point under the crosshair.
- **Video.** Switch to *Video* and tap the red button. Position, direction, tilt, footprint and aim point are logged **once a second**. Tapping a type while filming marks that moment. Clips stop at 10 minutes.
- **↻ button** (under the compass) restarts the camera if the picture freezes. The app also restarts it by itself if no new frame arrives for 4 seconds. A clip being filmed is saved first.
- A clip is written to the phone every 3 seconds, so if the app is killed mid-take, the clip is recovered the next time the survey is opened.
- **Map tab:** photo spots with view cones, and each video as a dashed path, on OpenStreetMap or Esri imagery. No API key is needed.
- **Data tab:** play a clip with the logged position and direction under it, or export everything as a ZIP.
- Works **offline**. Open it once on Wi-Fi so the app and the map tiles around the lake are kept on the phone.

## The ZIP
- `images/`: photos.
- `videos/`: each clip (`.webm` on Android, `.mp4` on iPhone), plus a `.srt` with the same name. VLC shows the per-second position, heading and tilt as captions.
- `data/*_video_track.geojson`: each clip's path, plus one point per second with its footprint.
- `data/*_video_seconds.csv`: one row per second.
- Photo GeoJSON and CSV as before.

## At the lake
- Name the survey first (e.g. `Powai_Sunrise_Scout`).
- Wait for GPS of ±12 m or better. Captures worse than ±30 m are refused.
- Keep tilt in the green 40–80° band when the aim point matters.
- If the compass shows a warning, tap it and draw a slow figure-8, away from railings, cars and magnetic phone mounts.
- While filming, keep the app on screen. Locking the phone or switching apps stops the clip, and what was filmed is kept.
- Export the ZIP before leaving.
- Check signage near the water, and confirm permission for drones, tripods or commercial filming.

Built on the `phone-field-sensors` skill (geo-dev-skills-bysomdeep). Before the first real shoot, do one outdoor check that the heading matches on Tanmay's own phone.

Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License
