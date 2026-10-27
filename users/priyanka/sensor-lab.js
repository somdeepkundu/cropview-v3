/* sensor-lab.js — experimental phone-sensor techniques for field apps, on top of phone-field-sensors.
 * Pure functions and small state machines, browser (window.SensorLab) and Node. Nothing here touches the
 * DOM, so every rule is tested in Node (scripts/test_sensor_lab.mjs) before it reaches a phone.
 *
 *   gravity tilt + sign check · stillness gate · magnetic-disturbance watch (gyro vs compass) ·
 *   field-strength check · step detection + pedestrian dead reckoning · sound level (dBFS) ·
 *   green cover and sky fraction from a camera frame · NMEA parser for external GNSS (RTK) ·
 *   Bluetooth environmental-sensing decoders · barometric height · AR height · capability probe
 *
 * Status: EXPERIMENTAL. Tested with synthetic data; not yet proven in the field like phone-field-sensors.
 * Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SensorLab = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '0.1.0';
  const D2R = Math.PI / 180, G = 9.80665;
  const isNum = v => typeof v === 'number' && isFinite(v);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const norm360 = a => ((a % 360) + 360) % 360;
  const signedDiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return d === -180 ? 180 : d; };   // a − b in (−180, 180]

  /* ── 1. Gravity tilt ──────────────────────────────────────────────
     devicemotion.accelerationIncludingGravity measures the reaction to gravity: lying face-up, z ≈ +9.81.
     The rear camera looks along −z, so tilt from straight down = acos(az / |a|). This is a second,
     independent tilt (raw accelerometer) to cross-check the fused DeviceOrientation tilt.
     Returns null when |a| is far from g (shaking, free fall, a bump): then gravity is not "down". */
  function gravityTilt(ax, ay, az, { sign = 1, tolerance = 0.35 } = {}) {
    if (!isNum(ax) || !isNum(ay) || !isNum(az)) return null;
    const n = Math.hypot(ax, ay, az);
    if (Math.abs(n - G) > tolerance * G) return null;
    return Math.acos(clamp(sign * az / n, -1, 1)) / D2R;
  }
  /* Some browsers have reported this vector with the opposite sign. Don't guess: compare with the
     orientation tilt while the phone is still. If gravity tilt ≈ 180° − orientation tilt, flip.
     pairs: [{grav, ori}] in degrees, sign-1 gravity tilt. Returns +1, −1, or null (not sure yet). */
  function gravitySign(pairs, { minPairs = 10, margin = 10 } = {}) {
    const ok = pairs.filter(p => isNum(p.grav) && isNum(p.ori) && Math.abs(p.ori - 90) > 20);   // near 90° both agree: no information
    if (ok.length < minPairs) return null;
    const same = ok.reduce((s, p) => s + Math.abs(p.grav - p.ori), 0) / ok.length;
    const flip = ok.reduce((s, p) => s + Math.abs(180 - p.grav - p.ori), 0) / ok.length;
    if (same + margin < flip) return 1;
    if (flip + margin < same) return -1;
    return null;
  }
  const upVector = (aig, sign = 1) => {                  // unit "up" in device coordinates
    if (!aig || !isNum(aig.x) || !isNum(aig.y) || !isNum(aig.z)) return null;
    const n = Math.hypot(aig.x, aig.y, aig.z); if (n < 1) return null;
    return [sign * aig.x / n, sign * aig.y / n, sign * aig.z / n];
  };

  /* ── 2. Stillness gate ────────────────────────────────────────────
     A capture taken mid-pan has a heading from one moment and a photo from another. Still = the size of
     the acceleration barely varies AND the gyroscope says the phone is not turning, over a short window. */
  function createStillness({ windowMs = 600, accStd = 0.15, gyroMax = 5 } = {}) {
    let buf = [];
    function push(t, aMag, gyroMag) {
      if (!isNum(aMag)) return;
      buf.push({ t, a: aMag, g: isNum(gyroMag) ? gyroMag : 0 });
      while (buf.length && t - buf[0].t > windowMs) buf.shift();
    }
    function state() {
      if (buf.length < 4 || buf[buf.length - 1].t - buf[0].t < windowMs * 0.7) return { still: null, accStd: null, gyroMax: null };
      const m = buf.reduce((s, b) => s + b.a, 0) / buf.length;
      const sd = Math.sqrt(buf.reduce((s, b) => s + (b.a - m) ** 2, 0) / buf.length);
      const gm = Math.max(...buf.map(b => b.g));
      return { still: sd <= accStd && gm <= gyroMax, accStd: sd, gyroMax: gm };
    }
    return { push, state, reset: () => { buf = []; } };
  }
  const gyroMagnitude = rr => rr && isNum(rr.alpha) && isNum(rr.beta) && isNum(rr.gamma) ? Math.hypot(rr.alpha, rr.beta, rr.gamma) : null;

  /* ── 3. Magnetic-disturbance watch ────────────────────────────────
     The compass is magnetic; the gyroscope is not. Over a short window, the change in compass heading
     must match the turn the gyroscope measured about the vertical. In a metro carriage, beside a car or
     over rebar, the compass moves while the phone does not (or turns by a different amount): DISTURBED.
     rotationRate (deg/s): alpha about device z, beta about x, gamma about y. The turn about "up" is
     ω·up (counter-clockwise seen from above), and compass heading changes by −ω·up. */
  function yawRate(rr, up) {
    if (!rr || !up || !isNum(rr.alpha) || !isNum(rr.beta) || !isNum(rr.gamma)) return null;
    return rr.beta * up[0] + rr.gamma * up[1] + rr.alpha * up[2];
  }
  function createMagWatch({ windowMs = 2000, tolDeg = 8, holdMs = 3000, minSpanFrac = 0.6 } = {}) {
    let gyro = [], comp = [], gAcc = 0, lastT = null, bad = -Infinity, sign = 1;
    const trim = t => {
      while (gyro.length && t - gyro[0].t > windowMs * 2) gyro.shift();
      while (comp.length && t - comp[0].t > windowMs * 2) comp.shift();
    };
    function feedMotion(t, rr, aig, intervalMs) {
      const w = yawRate(rr, upVector(aig, sign));
      if (w === null) return;
      let dt = isNum(intervalMs) && intervalMs > 0 ? intervalMs / 1000 : (lastT === null ? 0 : (t - lastT) / 1000);
      dt = clamp(dt, 0, 0.2); lastT = t;
      gAcc += -w * dt;                                     // heading change from the gyroscope, degrees
      gyro.push({ t, g: gAcc }); trim(t);
    }
    function feedHeading(t, h) { if (isNum(h)) { comp.push({ t, h }); trim(t); } }
    const at = (list, t) => { let best = null; for (const s of list) if (s.t <= t) best = s; return best; };
    function evaluate(t) {
      const cw = comp.filter(s => t - s.t <= windowMs), gw = gyro.filter(s => t - s.t <= windowMs);
      if (cw.length < 3 || gw.length < 3 || cw[cw.length - 1].t - cw[0].t < windowMs * minSpanFrac)
        return { status: 'UNKNOWN', mismatch: null, compassDelta: null, gyroDelta: null };
      let cd = 0; for (let i = 1; i < cw.length; i++) cd += signedDiff(cw[i].h, cw[i - 1].h);   // unwrapped
      const g0 = at(gyro, cw[0].t) || gw[0], g1 = at(gyro, cw[cw.length - 1].t) || gw[gw.length - 1];
      const gd = g1.g - g0.g, mismatch = Math.abs(cd - gd);
      if (mismatch > tolDeg) bad = t;
      return { status: t - bad < holdMs ? 'DISTURBED' : 'CLEAN', mismatch, compassDelta: cd, gyroDelta: gd };
    }
    return { feedMotion, feedHeading, evaluate, setSign: s => { sign = s === -1 ? -1 : 1; },
             reset: () => { gyro = []; comp = []; gAcc = 0; lastT = null; bad = -Infinity; } };
  }
  /* Field strength, where a Magnetometer is exposed (Chrome: behind #enable-generic-sensor-extra-classes).
     Earth's field is about 25–65 µT; outside that, something nearby is magnetic. */
  function fieldCheck(x, y, z, { min = 25, max = 65 } = {}) {
    if (!isNum(x) || !isNum(y) || !isNum(z)) return null;
    const m = Math.hypot(x, y, z);
    return { magnitude: m, ok: m >= min && m <= max };
  }

  /* ── 4. Steps and pedestrian dead reckoning ───────────────────────
     A step is a peak in the smoothed size of the acceleration, at least 0.3 s after the last.
     Step length (Weinberg): K·(aMax − aMin)^¼; calibrate K by walking a known 20 m.
     Dead reckoning keeps a track when GPS drops (trees, lanes); a good GPS fix pulls it back. */
  function stepLength(aMax, aMin, K = 0.48) { return K * Math.pow(Math.max(0, aMax - aMin), 0.25); }
  function createStepDetector({ threshold = 1.0, minIntervalMs = 300, smooth = 0.25, baseRate = 0.02, K = 0.48 } = {}) {
    let lp = null, base = null, prev = null, rising = false, lastStep = -Infinity, hi = -Infinity, lo = Infinity, count = 0;
    function feed(t, aMag) {
      if (!isNum(aMag)) return null;
      if (lp === null) { lp = aMag; base = aMag; prev = aMag; return null; }
      lp += smooth * (aMag - lp); base += baseRate * (aMag - base);
      hi = Math.max(hi, aMag); lo = Math.min(lo, aMag);
      let step = null;
      if (lp < prev && rising && prev - base > threshold && t - lastStep >= minIntervalMs) {
        step = { t, len: stepLength(hi, lo, K), n: ++count };
        lastStep = t; hi = -Infinity; lo = Infinity;
      }
      rising = lp > prev; prev = lp;
      return step;
    }
    return { feed, get count() { return count; } };
  }
  function geoDest(lat, lon, d, brg) {
    const R = 6371008, b = brg * D2R, p1 = lat * D2R, l1 = lon * D2R, a = d / R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(a) * Math.cos(p1), Math.cos(a) - Math.sin(p1) * Math.sin(p2));
    return [p2 / D2R, l2 / D2R];
  }
  function createPDR({ gpsPull = 0.3, gpsGoodM = 10 } = {}) {
    let pos = null; const track = [];
    return {
      start(lat, lon) { pos = [lat, lon]; track.length = 0; track.push(pos.slice()); },
      step(len, heading) {
        if (!pos || !isNum(len) || !isNum(heading)) return null;
        pos = geoDest(pos[0], pos[1], len, heading); track.push(pos.slice()); return pos;
      },
      gps(fix) {                                           // a good fix nudges the track, it does not jump it
        if (!fix || !isNum(fix.lat) || !isNum(fix.lon)) return;
        if (!pos) { this.start(fix.lat, fix.lon); return; }
        if (isNum(fix.acc) && fix.acc <= gpsGoodM) { pos = [pos[0] + gpsPull * (fix.lat - pos[0]), pos[1] + gpsPull * (fix.lon - pos[1])]; track.push(pos.slice()); }
      },
      get pos() { return pos; }, get track() { return track; },
      geojson: () => ({ type: 'Feature', properties: { method: 'pedestrian dead reckoning' }, geometry: { type: 'LineString', coordinates: track.map(p => [p[1], p[0]]) } })
    };
  }

  /* ── 5. Sound level ───────────────────────────────────────────────
     dBFS (0 = loudest the phone can record). Relative, not calibrated sound pressure: compare readings
     from the same phone, or calibrate an offset against a sound-level meter. Turn the browser's voice
     processing OFF, or automatic gain makes every place sound equally loud. */
  const AUDIO_CONSTRAINTS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  function dbfs(samples) {
    if (!samples || !samples.length) return null;
    let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    const rms = Math.sqrt(s / samples.length);
    return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
  }

  /* ── 6. Camera frame indices ──────────────────────────────────────
     Green cover: Excess Green ExG = 2g − r − b on chromatic coordinates (r+g+b = 1), threshold by Otsu,
     never below `minExg` (a uniformly grey frame must not come out "50 % green").
     Sky fraction (phone pointing up under a canopy): bright pixels by Otsu on brightness → gap fraction.
     Auto-exposure changes brightness between frames; these are shares of one frame, so they survive it. */
  function otsu(hist) {
    const total = hist.reduce((a, b) => a + b, 0); if (!total) return 0;
    let sum = 0; for (let i = 0; i < hist.length; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 0;
    for (let i = 0; i < hist.length; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }
  function greenCover(rgba, w, h, { step = 2, minExg = 0.05 } = {}) {
    const BINS = 256, hist = new Array(BINS).fill(0), vals = [];
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], s = r + g + b;
      const e = s ? (2 * g - r - b) / s : 0;              // −1 … 2
      const k = clamp(Math.round((e + 1) / 3 * (BINS - 1)), 0, BINS - 1);
      hist[k]++; vals.push(e);
    }
    const t = Math.max(otsu(hist) / (BINS - 1) * 3 - 1, minExg);
    const green = vals.filter(e => e > t).length;
    return { fraction: vals.length ? green / vals.length : null, threshold: t, n: vals.length };
  }
  function skyFraction(rgba, w, h, { step = 2, minLevel = 90 } = {}) {
    const hist = new Array(256).fill(0), vals = [];
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4, v = Math.round(0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]);
      const lum = Math.max(v, rgba[i + 2]);                // blue sky is bright in blue even when luminance is modest
      hist[clamp(lum, 0, 255)]++; vals.push(lum);
    }
    const t = Math.max(otsu(hist), minLevel);
    return { fraction: vals.length ? vals.filter(v => v > t).length / vals.length : null, threshold: t, n: vals.length };
  }

  /* ── 7. External GNSS over NMEA (USB / Bluetooth serial, e.g. an RTK receiver) ──
     GGA: fix quality (4 = RTK fixed, 5 = RTK float), satellites, HDOP, altitude. RMC: speed, course.
     GST: 1-σ latitude/longitude error in metres — the only honest accuracy figure; without GST,
     accuracy stays null (HDOP is not metres). Every sentence is checksum-checked. */
  const FIX = { 0: 'no fix', 1: 'GPS', 2: 'DGPS', 3: 'PPS', 4: 'RTK fixed', 5: 'RTK float', 6: 'dead reckoning', 7: 'manual', 8: 'simulation' };
  function nmeaChecksumOk(line) {
    const m = /^\$([^*]+)\*([0-9A-Fa-f]{2})\s*$/.exec(line); if (!m) return false;
    let c = 0; for (let i = 0; i < m[1].length; i++) c ^= m[1].charCodeAt(i);
    return c === parseInt(m[2], 16);
  }
  const dm = (v, hemi) => {                               // ddmm.mmmm / dddmm.mmmm → degrees
    if (!v) return null; const f = parseFloat(v); if (!isFinite(f)) return null;
    const d = Math.floor(f / 100), deg = d + (f - d * 100) / 60;
    return hemi === 'S' || hemi === 'W' ? -deg : deg;
  };
  const num = v => (v === '' || v === undefined) ? null : (isFinite(+v) ? +v : null);
  function parseNMEA(line) {
    line = String(line).trim();
    if (!nmeaChecksumOk(line)) return null;
    const f = line.slice(1, line.indexOf('*')).split(','), type = f[0].slice(2);
    if (type === 'GGA') {
      const q = num(f[6]);
      return { type, time: f[1], lat: dm(f[2], f[3]), lon: dm(f[4], f[5]), fix: q, fixLabel: FIX[q] ?? 'unknown',
               sats: num(f[7]), hdop: num(f[8]), alt: num(f[9]) };
    }
    if (type === 'RMC') return { type, time: f[1], valid: f[2] === 'A', lat: dm(f[3], f[4]), lon: dm(f[5], f[6]),
                                 speedMs: num(f[7]) === null ? null : num(f[7]) * 0.514444, courseDeg: num(f[8]) };
    if (type === 'GST') return { type, time: f[1], latErr: num(f[6]), lonErr: num(f[7]), altErr: num(f[8]) };
    if (type === 'GSA') return { type, pdop: num(f[15]), hdop: num(f[16]), vdop: num(f[17]) };
    return { type };
  }
  function createNmeaReader() {
    let buf = ''; const fix = { lat: null, lon: null, alt: null, fix: null, fixLabel: null, sats: null, hdop: null, acc: null, speedMs: null, courseDeg: null, time: null, bad: 0 };
    function push(text) {
      buf += text; const lines = buf.split(/\r?\n/); buf = lines.pop(); const got = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        const s = parseNMEA(l); if (!s) { fix.bad++; continue; }
        if (s.type === 'GGA') Object.assign(fix, { lat: s.lat, lon: s.lon, alt: s.alt, fix: s.fix, fixLabel: s.fixLabel, sats: s.sats, hdop: s.hdop, time: s.time });
        if (s.type === 'RMC') Object.assign(fix, { speedMs: s.speedMs, courseDeg: s.courseDeg });
        if (s.type === 'GST' && isNum(s.latErr) && isNum(s.lonErr)) fix.acc = Math.hypot(s.latErr, s.lonErr);
        got.push(s);
      }
      return got;
    }
    return { push, fix };
  }

  /* ── 8. Bluetooth environmental sensing (GATT 0x181A) ─────────────
     Standard characteristics, little-endian: temperature sint16 × 0.01 °C, humidity uint16 × 0.01 %,
     pressure uint32 × 0.1 Pa. Many cheap sensors use these; others need their own decoder. */
  const ESS = { service: 0x181a, temperature: 0x2a6e, humidity: 0x2a6f, pressure: 0x2a6d };
  const decodeTemperature = dv => dv.getInt16(0, true) * 0.01;
  const decodeHumidity = dv => dv.getUint16(0, true) * 0.01;
  const decodePressure = dv => dv.getUint32(0, true) * 0.1;   // Pa

  /* ── 9. Barometric height ─────────────────────────────────────────
     Absolute altitude from pressure needs the day's sea-level pressure; height DIFFERENCES between two
     readings minutes apart do not: about 8.3 m per hPa near sea level. Use it for floors, embankments,
     flood marks relative to a reference reading — never as GPS-style altitude. */
  function pressureAltitude(pPa, p0 = 101325) { return isNum(pPa) && pPa > 0 ? 44330 * (1 - Math.pow(pPa / p0, 1 / 5.255)) : null; }
  function heightAbove(pPa, refPa) { return isNum(pPa) && isNum(refPa) ? pressureAltitude(pPa, refPa) : null; }

  /* ── 10. Camera height from AR (WebXR hit test) ───────────────────
     In a 'local' reference space y points up. Aim at the ground: height = viewer y − hit y.
     Only where navigator.xr supports 'immersive-ar' with 'hit-test' (Chrome on ARCore phones). */
  function arHeight(viewerY, hitY, { min = 0.1, max = 30 } = {}) {
    if (!isNum(viewerY) || !isNum(hitY)) return null;
    const h = viewerY - hitY;
    return h >= min && h <= max ? h : null;
  }

  /* ── 11. What this phone and browser can do ───────────────────────
     Probe features, never user agents. "flag" = exists in Chromium only behind chrome://flags. */
  function capabilities(w) {
    w = w || (typeof window !== 'undefined' ? window : {});
    const n = w.navigator || {}, has = k => typeof w[k] !== 'undefined';
    return [
      { key: 'orientation', label: 'Orientation (compass, tilt)', ok: has('DeviceOrientationEvent') },
      { key: 'motion', label: 'Motion (accelerometer, gyroscope)', ok: has('DeviceMotionEvent') },
      { key: 'permission', label: 'Motion permission prompt', ok: !!(w.DeviceOrientationEvent && typeof w.DeviceOrientationEvent.requestPermission === 'function'), note: 'iOS, Chrome 151+' },
      { key: 'gravity', label: 'GravitySensor', ok: has('GravitySensor') },
      { key: 'magnetometer', label: 'Magnetometer (µT)', ok: has('Magnetometer'), note: 'Chrome: behind a flag' },
      { key: 'light', label: 'Ambient light (lux)', ok: has('AmbientLightSensor'), note: 'Chrome: behind a flag' },
      { key: 'geolocation', label: 'GPS', ok: !!n.geolocation },
      { key: 'media', label: 'Camera and microphone', ok: !!(n.mediaDevices && n.mediaDevices.getUserMedia) },
      { key: 'xr', label: 'AR (WebXR)', ok: !!n.xr, note: 'ARCore phones, Chrome' },
      { key: 'bluetooth', label: 'Bluetooth sensors', ok: !!n.bluetooth, note: 'Chrome; not iOS' },
      { key: 'serial', label: 'Serial (external GNSS)', ok: !!n.serial, note: 'Chrome desktop; Android 137+ over Bluetooth' },
      { key: 'nfc', label: 'NFC tags', ok: has('NDEFReader'), note: 'Chrome on Android' },
      { key: 'vibrate', label: 'Vibration', ok: typeof n.vibrate === 'function', note: 'not iOS' },
      { key: 'wakelock', label: 'Screen wake lock', ok: !!n.wakeLock }
    ];
  }

  return { VERSION, G, D2R, norm360, signedDiff,
           gravityTilt, gravitySign, upVector, createStillness, gyroMagnitude,
           yawRate, createMagWatch, fieldCheck,
           stepLength, createStepDetector, geoDest, createPDR,
           AUDIO_CONSTRAINTS, dbfs, otsu, greenCover, skyFraction,
           FIX, nmeaChecksumOk, parseNMEA, createNmeaReader,
           ESS, decodeTemperature, decodeHumidity, decodePressure,
           pressureAltitude, heightAbove, arHeight, capabilities };
});
