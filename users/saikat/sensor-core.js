/* sensor-core.js — phone position, camera look direction, tilt and ground footprint.
 *
 * Distilled from the sensor core of CropView v3.6 (somdeepkundu/cropview-v3, index.html),
 * which FloodView 1.1 (somdeepkundu/floodview) copies unchanged. Field-tested on Android
 * Chrome and iOS Safari. The bug that each rule fixed is noted next to it.
 *
 * Works in the browser (window.FieldSensors) and in Node (require / import) for unit tests.
 * No dependencies.
 *
 * Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FieldSensors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const D2R = Math.PI / 180;
  const R_EARTH = 6371008.8;          // same mean radius turf.js uses

  const isNum = v => typeof v === 'number' && !isNaN(v);
  const norm360 = a => ((a % 360) + 360) % 360;
  function angDiff(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function lerpAngle(a, b, t) { const d = ((b - a + 540) % 360) - 180; return ((a + d * t) % 360 + 360) % 360; }

  /* ── Geodesy (spherical; matches turf 6.5 to floating-point precision) ── */
  function geoDist(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function geoBearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  function geoDest(lat, lon, distM, brgDeg) {            // → [lat, lon]
    const d = distM / R_EARTH, t = brgDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 / D2R, l2 / D2R];
  }

  /* ── Camera heading ──────────────────────────────────────────────────
     Heading of the REAR CAMERA axis (device −z), clockwise from north, from the
     full W3C rotation R = Rz(alpha)·Rx(beta)·Ry(gamma), world = East, North, Up.
     Why not (360 − alpha + screenAngle)? That is only right with the phone near
     flat. Held upright (beta ≈ 90°, the normal way to shoot a field) the ZXY
     Euler angles hit gimbal lock: Chrome can report alpha and gamma jumping
     together by ~180°, which leaves the physical rotation unchanged but flips a
     heading built from alpha alone. The matrix is continuous through that, and
     it describes the camera axis directly, so no screen-rotation correction is
     needed in portrait or landscape. Within ~10° of nadir/zenith the camera's
     horizontal direction is undefined, so fall back to the phone-top direction. */
  function cameraHeading(alpha, beta, gamma) {
    const cA = Math.cos(alpha * D2R), sA = Math.sin(alpha * D2R);
    const cB = Math.cos(beta * D2R), sB = Math.sin(beta * D2R);
    const cG = Math.cos(gamma * D2R), sG = Math.sin(gamma * D2R);
    const east = -(cA * sG + cG * sA * sB);
    const north = cA * cG * sB - sA * sG;
    if (Math.hypot(east, north) < 0.17) return ((Math.atan2(-cB * sA, cA * cB) / D2R) + 360) % 360; // phone-top direction
    return ((Math.atan2(east, north) / D2R) + 360) % 360;
  }

  /* ── Tilt from nadir ─────────────────────────────────────────────────
     0° = camera straight down, 90° = horizon, > 90° = above the horizon.
     The device z-axis has world-vertical component cos(beta)·cos(gamma), so the
     rear camera sits acos(cos β · cos γ) off nadir. CropView v3.0 used
     Math.abs(e.beta || 45): it ignored gamma (landscape read as flat), made sky
     and crop indistinguishable, and turned a genuine beta === 0 into 45°.
     Returns null on missing data — the caller must hold the last good value. */
  function tiltFrom(beta, gamma) {
    if (!isNum(beta) || !isNum(gamma)) return null;
    const c = Math.min(1, Math.max(-1, Math.cos(beta * D2R) * Math.cos(gamma * D2R)));
    return Math.round(Math.acos(c) / D2R);
  }
  const tiltFromEvent = e => tiltFrom(e && e.beta, e && e.gamma);

  /* ── GPS smoothing ───────────────────────────────────────────────────
     Keep the last `max` fixes; once there are 3+, drop the worst; average the
     rest weighted by 1/acc². Accuracy 0 (some external-GNSS and mock-location
     apps report it) would give an infinite weight and a NaN position, so clamp
     anything under 0.5 m to 0.5 m (FloodView 1.0.0 fix). */
  function createGpsSmoother(max = 6) {
    const buf = [];
    function current() {
      if (!buf.length) return null;
      const sorted = [...buf].sort((a, b) => a.acc - b.acc);
      const use = sorted.length >= 3 ? sorted.slice(0, -1) : sorted;
      let tw = 0, wlat = 0, wlon = 0, walt = 0, hasAlt = false;
      use.forEach(r => {
        const a = Math.max(isFinite(r.acc) ? r.acc : 50, 0.5), w = 1 / (a * a);
        tw += w; wlat += r.lat * w; wlon += r.lon * w;
        if (r.alt !== null && r.alt !== undefined) { walt += r.alt * w; hasAlt = true; }
      });
      return { lat: wlat / tw, lon: wlon / tw, alt: hasAlt ? walt / tw : null,
               acc: use[0].acc, altAcc: use[0].altAcc ?? null, samples: use.length };
    }
    function push(coords) {
      buf.push({ lat: coords.latitude, lon: coords.longitude, alt: coords.altitude ?? null,
                 acc: coords.accuracy, altAcc: coords.altitudeAccuracy ?? null });
      if (buf.length > max) buf.shift();
      return current();
    }
    return { push, current, get size() { return buf.length; }, max };
  }

  /* ── Travel bearing: METADATA ONLY ───────────────────────────────────
     CropView v2–v3.1 let the GPS travel bearing override the compass after ≥3 m
     of movement, and "auto-calibrated" a compass offset from it. Both assumed
     the camera faces the direction of travel. From a vehicle, or walking and
     shooting sideways, that is false: every capture got the car's direction and
     the learned offset kept pulling the compass toward the road. Keep it only
     as travel_bearing_deg / look_side in the export. */
  function createTravelBearing({ minMove = 3, maxAcc = 25, freshMs = 6000, now = () => Date.now() } = {}) {
    let prev = null, bearing = null, at = 0;
    return {
      update(fix) {
        if (!fix) return;
        if (!prev) { prev = { lat: fix.lat, lon: fix.lon }; return; }
        const moved = geoDist(prev.lat, prev.lon, fix.lat, fix.lon);
        if (moved >= Math.max(minMove, fix.acc) && fix.acc < maxAcc) {
          bearing = geoBearing(prev.lat, prev.lon, fix.lat, fix.lon); at = now();
          prev = { lat: fix.lat, lon: fix.lon };
        }
      },
      get() { return (bearing !== null && now() - at < freshMs) ? bearing : null; }
    };
  }
  function lookSide(rel) {             // camera direction relative to travel
    if (rel === null || rel === undefined) return null;
    const a = Math.abs(rel);
    if (a <= 30) return 'AHEAD';
    if (a >= 150) return 'BEHIND';
    return rel < 0 ? 'LEFT' : 'RIGHT';
  }
  function lookRelTravel(heading, travel) {
    return (heading === null || travel === null) ? null : Math.round(((heading - travel + 540) % 360) - 180);
  }

  /* ── Ground footprint ────────────────────────────────────────────────
     camH is the camera height ABOVE GROUND / WATER (≈1.5 m standing), never GPS
     altitude: CropView v3.0 used altitude above sea level and every footprint
     came out ~430× too large at 650 m elevation. Tilt from nadir:
       ground range r(t) = H·tan(t); half-width at r = √(H² + r²)·tan(hfov/2).
     Vertical FOV from the horizontal one through the tangent (16:9 sensor).
     Dropped only when the frame's NEAR edge is at/above the cap; otherwise the
     far edge is clipped at tiltMax (farCapped). */
  function footprint({ camH, tilt, hfov = 65, aspect = 9 / 16, tiltMax = 85 }) {
    if (!isNum(tilt) || !isNum(camH)) return null;
    const H = camH, tr = tilt * D2R, hr = hfov * D2R;
    const vr = 2 * Math.atan(Math.tan(hr / 2) * aspect);
    const cap = tiltMax * D2R;
    const tNear = Math.max(tr - vr / 2, 0);
    if (tNear >= cap) return null;
    const tFar = Math.min(tr + vr / 2, cap);
    const near = H * Math.tan(tNear), far = H * Math.tan(tFar), gd = H * Math.tan(Math.min(tr, cap));
    const halfW = r => Math.sqrt(H * H + r * r) * Math.tan(hr / 2);
    return { near, far, gd, wNear: halfW(near) * 2, wFar: halfW(far) * 2, w: halfW(gd) * 2,
             d: far - near, farCapped: (tr + vr / 2) > cap };
  }
  function footprintRing(lat, lon, heading, fp) {     // → GeoJSON ring [[lon,lat],…] (closed)
    if (!fp || !isNum(heading)) return null;
    const b = norm360(heading);
    const at = (r, off) => {
      const c = geoDest(lat, lon, r, b);
      const p = off === 0 ? c : geoDest(c[0], c[1], Math.abs(off), b + (off > 0 ? 90 : -90));
      return [p[1], p[0]];
    };
    const nL = at(fp.near, -fp.wNear / 2), nR = at(fp.near, fp.wNear / 2);
    const fL = at(fp.far, -fp.wFar / 2), fR = at(fp.far, fp.wFar / 2);
    return [nL, fL, fR, nR, nL];
  }

  /* ── Crosshair aim point (FloodView) ─────────────────────────────────
     Where the centre of the frame meets the ground: distance = H·tan(tilt) along
     the heading. `unc` is a geometry-only ± in metres for a 2° tilt error
     (radial, H·sec²t·Δt) and a 10° heading error (sideways, dist·tan 10°).
     Add GPS accuracy on top for the full error. */
  function aimPoint(lat, lon, heading, { camH, tilt, tiltMax = 85, tiltErrDeg = 2, headingErrDeg = 10 }) {
    if (!isNum(lat) || !isNum(lon) || !isNum(heading) || !isNum(tilt) || tilt >= tiltMax) return null;
    const tr = tilt * D2R, dist = camH * Math.tan(tr);
    const radial = camH / (Math.cos(tr) ** 2) * (tiltErrDeg * D2R), side = dist * Math.tan(headingErrDeg * D2R);
    const p = geoDest(lat, lon, dist, heading);
    return { lat: p[0], lon: p[1], dist, unc: Math.hypot(radial, side) };
  }

  /* ── Compass engine ──────────────────────────────────────────────────
     (a) getting a heading at all — platform wiring;
     (b) knowing when it has gone stale, invalid or stuck — watchdog + resync.
     Every valid reading goes through one funnel (applyHeading); anything that
     does not validate never reaches it.

     start() MUST be called synchronously inside the user's tap, before any
     await: iOS (and Chrome 151+ on Android) only show the motion-permission
     prompt from a user gesture. */
  function createCompass(opts = {}) {
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const now = opts.now || (() => Date.now());
    const T = Object.assign({ staleMs: 2500, lostMs: 8000, stuckMs: 6000, resyncCooldown: 5000,
                              noDataWarnMs: 5000, lowConfAcc: 40 }, opts.timing || {});
    const onChange = opts.onChange || (() => {});
    const onWarn = opts.onWarn || (() => {});

    const S = {
      heading: null, tilt: null,           // null until the first valid reading — never invented
      src: '—', signal: 'LOST', lowConfidence: false,
      platform: 'unknown', perm: 'unknown',
      gotAbsolute: false, absCount: 0, oriCount: 0, resyncs: 0,
      lastValid: null, lastAny: null, lastMotion: null,
      lastAlphaSeen: null, lastAlphaChange: null, lastResync: 0,
      started: 0, warned: false, running: false
    };
    let timer = null;

    function classify() {
      const age = S.lastValid ? now() - S.lastValid : Infinity;
      if (age < T.staleMs) { S.src = S.lowConfidence ? 'COMPASS·LOW-CONF' : 'COMPASS'; S.signal = S.lowConfidence ? 'STALE' : 'OK'; }
      else if (age < T.lostMs) { S.src = 'STALE·HOLD'; S.signal = 'STALE'; }
      else { S.src = S.perm === 'denied' ? 'SENSORS BLOCKED' : (!S.lastAny ? 'NO SENSOR DATA' : 'SIGNAL LOST'); S.signal = 'LOST'; }
    }
    function trackAlpha(raw) {
      const t = now();
      if (S.lastAlphaSeen === null) { S.lastAlphaSeen = raw; S.lastAlphaChange = t; return; }
      if (angDiff(raw, S.lastAlphaSeen) > 0.15) S.lastAlphaChange = t;
      S.lastAlphaSeen = raw;
    }
    function applyTilt(e) { const t = tiltFromEvent(e); if (t !== null) S.tilt = t; }   // null ⇒ hold last good tilt
    function applyHeading(deg) { S.heading = norm360(deg); S.lastValid = now(); classify(); onChange(S); }

    function onOriAbs(e) {
      S.lastAny = now(); S.absCount++;
      if (S.platform === 'unknown') S.platform = 'android';
      if (!isNum(e.alpha)) return;                          // invalid — never treat as 0 / north
      if (!isNum(e.beta) || !isNum(e.gamma)) return;
      // Latch only below the validation: v3.0 latched on the bare event, so one
      // alpha === null absolute event killed the fallback for good.
      S.gotAbsolute = true;
      trackAlpha(e.alpha); applyTilt(e);
      applyHeading(cameraHeading(e.alpha, e.beta, e.gamma));
    }
    function onOri(e) {
      S.lastAny = now(); S.oriCount++;
      applyTilt(e);                                         // beta/gamma are gravity-referenced everywhere
      const h = e.webkitCompassHeading;
      if (isNum(h)) {                                       // iOS: already a compass heading, clockwise from north
        S.platform = 'ios';
        trackAlpha(h);
        const acc = e.webkitCompassAccuracy;                // degrees; −1 or large = don't trust
        S.lowConfidence = isNum(acc) && (acc < 0 || acc > T.lowConfAcc);
        applyHeading(h);
        return;
      }
      if (S.platform === 'unknown' && isNum(e.beta)) S.platform = 'android';
      if (S.gotAbsolute) return;                            // a live absolute stream wins
      if (e.absolute !== true) { onChange(S); return; }      // relative alpha: arbitrary zero, NEVER a compass
      if (!isNum(e.alpha) || !isNum(e.beta) || !isNum(e.gamma)) return;
      trackAlpha(e.alpha);
      applyHeading(cameraHeading(e.alpha, e.beta, e.gamma));
    }
    function onMotion() { S.lastMotion = now(); }          // heartbeat: the sensor stack is alive

    function attach() { win.addEventListener('deviceorientationabsolute', onOriAbs, true); win.addEventListener('deviceorientation', onOri, true); }
    function detach() { win.removeEventListener('deviceorientationabsolute', onOriAbs, true); win.removeEventListener('deviceorientation', onOri, true); }
    function resync(force) {
      const t = now();
      if (!force && t - S.lastResync < T.resyncCooldown) return false;
      S.lastResync = t; S.gotAbsolute = false; S.lastAlphaChange = t; S.resyncs++;
      detach(); attach();
      return true;
    }
    function onVisibility() { if (doc.visibilityState === 'visible') resync(false); }  // backgrounding often freezes Android streams

    /* Detect the platform from the EVENTS, not from the API. Until v3.2.0 the app
       took "requestPermission exists" to mean iPhone; Chrome 151 (July 2026)
       shipped the same API on Android, so every updated Android phone took the
       iOS branch, waited for webkitCompassHeading forever and dropped every
       reading. Ask wherever the API exists; always attach every listener. */
    function requestPermission() {
      const asks = [];
      const DOE = win.DeviceOrientationEvent, DME = win.DeviceMotionEvent;
      if (DOE && typeof DOE.requestPermission === 'function') asks.push(DOE.requestPermission().catch(() => 'error'));
      if (DME && typeof DME.requestPermission === 'function') asks.push(DME.requestPermission().catch(() => 'error'));
      if (!asks.length) { S.perm = 'n/a'; return Promise.resolve('n/a'); }
      return Promise.all(asks).then(r => {
        S.perm = r.includes('denied') ? 'denied' : (r.includes('granted') ? 'granted' : 'unknown');
        if (S.perm === 'denied') onWarn('denied');
        classify(); onChange(S);
        return S.perm;
      });
    }

    /* Watchdog: every second, whether or not any event fired. A dead or stuck
       stream is detected within a couple of seconds, shown in the SRC badge,
       and silently resubscribed — instead of a frozen, confident, wrong cone. */
    function tick() {
      const t = now();
      const sinceValid = S.lastValid ? t - S.lastValid : Infinity;
      const sinceAny = S.lastAny ? t - S.lastAny : Infinity;
      const sinceMotion = S.lastMotion ? t - S.lastMotion : Infinity;
      const stuck = S.lastAlphaChange && (t - S.lastAlphaChange) > T.stuckMs && sinceAny < 3000;
      const deadStream = sinceValid > T.staleMs && sinceMotion < 3000;
      if (stuck || deadStream) resync(false);
      if (!S.lastAny && !S.warned && S.started && t - S.started > T.noDataWarnMs) { S.warned = true; onWarn(S.perm === 'denied' ? 'denied' : 'nodata'); }
      classify(); onChange(S);
    }

    function start() {
      if (S.running) return Promise.resolve(S.perm);
      S.running = true; S.started = now();
      const p = requestPermission();                        // synchronous call inside the tap
      attach();
      win.addEventListener('devicemotion', onMotion, true);
      if (doc) doc.addEventListener('visibilitychange', onVisibility);
      timer = setInterval(tick, 1000);
      classify();
      return p;
    }
    function stop() {
      if (!S.running) return;
      S.running = false; detach();
      win.removeEventListener('devicemotion', onMotion, true);
      if (doc) doc.removeEventListener('visibilitychange', onVisibility);
      clearInterval(timer); timer = null;
    }
    /* Tap-the-compass recalibration: re-ask (inside the tap), force a resync,
       and tell the user to draw a figure-8. */
    function recalibrate() { const p = requestPermission(); resync(true); return p; }

    return { start, stop, recalibrate, resync, tick, state: S,
             _handlers: { onOriAbs, onOri, onMotion } };
  }

  /* CSV cell: quote when needed, and neutralise text a spreadsheet would run as
     a formula (=, +, -, @, tab, CR) with a leading apostrophe (FloodView 1.1.1). */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  return {
    VERSION: '1.0.0',
    D2R, R_EARTH, angDiff, lerpAngle, norm360,
    geoDist, geoBearing, geoDest,
    cameraHeading, tiltFrom, tiltFromEvent,
    createGpsSmoother, createTravelBearing, lookSide, lookRelTravel,
    footprint, footprintRing, aimPoint,
    createCompass, csvCell, esc
  };
});
