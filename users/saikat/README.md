# CropView 3S · Swarnakhali field edition

A field camera for **Saikat**, surveying around Swarnakhali, West Bengal.

**Open on the phone:** https://somdeepkundu.github.io/cropview-v3/users/saikat/
(Chrome → ⋮ → *Add to Home screen* to install it like an app.)

## What it does
- **Tag first, then shoot.** Tags are a row of chips above the shutter. The lit tag stays on until another is picked. *+ Tag* adds a new name (e.g. `Jute · পাট`), and a Bengali part is kept as the Bengali label.
- The starting tags come from the first walk: Banana, Vegetables, Tree grove and Open field (with swatches from those photos), plus Paddy, Mustard, Pond and Fallow.
- Every photo keeps its position, camera direction, tilt, ground footprint, tag, an optional note, and the date in **both calendars** (English and Bangabda).
- **Data tab:** change a photo's tag, add a note, save one photo, or export everything as a ZIP. The ZIP has the same layout as CropView, so the [Data Explorer](https://somdeepkundu.github.io/cropview-v3/cropview-viewer-v2.html) opens it.
- A **first-run tutorial** walks through the real controls. Replay it from ⓘ → *Show tutorial*.
- Works **offline**. Maps are Leaflet with OpenStreetMap or Esri imagery, and no API key is needed. Tiles seen once while online stay on the phone.

## Bengali calendar
`bcal.js` uses the West Bengal (Panjika) Bangabda, not Bangladesh's revised calendar. The month start dates for 1433 were checked against two West Bengal sources and a Surya Siddhanta sankranti calculation with the midnight rule. 1434 comes from the same calculation. The calendar covers **15 Apr 2026 – 13 Apr 2028**. Outside that range only the English date is shown, and `bcal.js` needs a new year added.

## Export fields (added to CropView's)
`tag`, `tag_label`, `tag_label_bn`, `note`, `bengali_date` (e.g. `8 Kartik 1433`), `bengali_date_bn`, `ritu`.

Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License
