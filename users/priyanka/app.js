/* Shevga — field notebook for the moringa trees of IIT Bombay.
 * Built on phone-field-sensors (sensor-core.js, field-store.js) and phone-sensor-lab (compass trust).
 * Tree first: each photo belongs to a tree; each tree has a tag, a position fixed one of three ways
 * (GPS averaged at the trunk, the crosshair point, or crossing photo directions) and dated visits.
 * Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License */
(function () {
  'use strict';
  // db is unique on the somdeepkundu.github.io origin, so it never meets Saikat's or Tanmay's data.
  const APP = { name: 'Shevga', version: '1.0.0', db: 'shevga-iitb-moringa', idPrefix: 'SH' };
  // What is in the frame. Keys go into the export, so keep them stable.
  const CLASSES = [
    { k: 'whole', label: 'Whole tree', sub: '8–15 m away', col: '#5f8f3e' },
    { k: 'tag', label: 'Tag', sub: 'QR & number', col: '#d1a53a' },
    { k: 'trunk', label: 'Trunk', sub: 'bark, base', col: '#8b5e3c' },
    { k: 'canopy', label: 'Canopy', sub: 'look up', col: '#3d8782' },
    { k: 'leaves', label: 'Leaves', sub: 'close up', col: '#93bd4f' },
    { k: 'flower', label: 'Flowers', sub: '& pods', col: '#d6733a' },
    { k: 'sample', label: 'Sample', sub: 'on paper', col: '#8d78a6' },
    { k: 'other', label: 'Other', sub: 'surroundings', col: '#8b9387' }
  ];
  const LEAF = { flush: 'Flush', not_flush: 'Not flush', mixed: 'Mixed', leafless: 'Bare' };
  const LOC_NAME = { trunk: 'GPS at the trunk', aim: 'Crosshair point', bear: 'Photo directions' };
  // A generous box around the IIT Bombay campus (Powai). Outside it the app only warns.
  const CAMPUS = { s: 19.1170, n: 19.1445, w: 72.8995, e: 72.9255, centre: [19.1318, 72.9148] };
  const GPS_LOCK = 12, GPS_BLOCK = 30;
  const AIM_MIN = 40, AIM_MAX = 80, TILT_MAX = 85, HFOV = 65, CONE_PX = 90;
  const LOCK_MS = 15000, LOCK_MAX = 30;      // trunk lock: up to 15 s or 30 fixes
  const FREEZE_MS = 4000;
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  const F = window.FieldSensors, FS = window.FieldStore, LAB = window.SensorLab;
  const $ = id => document.getElementById(id);
  const esc = F.esc;
  const clsOf = k => CLASSES.find(c => c.k === k) || { k, label: k, col: '#8b9387' };
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('sh-' + k); localStorage.setItem('sh-' + k, v); } catch (e) {} return null; };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const inCampus = (lat, lon) => lat >= CAMPUS.s && lat <= CAMPUS.n && lon >= CAMPUS.w && lon <= CAMPUS.e;

  const S = {
    proj: null, camH: 1.5, fix: null, lastGPS: null, caps: [], dispAz: 0,
    map: null, tile: null, sat: false, mapCentred: false, layers: {}, stream: null,
    cls: CLASSES.some(c => c.k === pref('cls')) ? pref('cls') : 'whole',
    tree: null, lock: null, aiming: false, scanning: null, camRestarts: 0, camFailAt: 0
  };
  const gps = F.createGpsSmoother(6);
  const travel = F.createTravelBearing();
  // Compass trust: the gyroscope is not magnetic, so when the compass turns and the phone doesn't,
  // something nearby (a car, railings, rebar) is bending the field. From phone-sensor-lab.
  const mag = LAB ? LAB.createMagWatch() : null;
  let trust = { status: 'UNKNOWN', mismatch: null };
  const compass = F.createCompass({
    onChange: st => { if (mag && st.heading !== null) mag.feedHeading(performance.now(), st.heading); },
    onWarn: w => toast(w === 'denied'
      ? 'Motion sensors are blocked. Allow them in the browser’s site settings, then tap the compass.'
      : 'No compass data from this phone. Tap the compass to try again.', 'err')
  });
  const C = compass.state;
  const store = FS.openStore(APP.db);
  const wake = FS.keepAwake(() => !!S.proj);
  if (mag) addEventListener('devicemotion', e => mag.feedMotion(performance.now(), e.rotationRate, e.accelerationIncludingGravity, e.interval), true);

  /* ── Start: everything that needs a user gesture happens synchronously here ── */
  $('allow').addEventListener('click', () => {
    compass.start();        // motion permission: inside the tap, before any await
    startGPS();
    show('scr-session');
    renderResume();
  });
  $('start-btn').addEventListener('click', () => startSurvey());
  function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }

  async function renderResume() {
    await store.ready;
    const list = await store.listSessions();
    $('resume-wrap').hidden = !list.length;
    $('resume-list').innerHTML = list.slice(0, 5).map(s => `
      <button class="resume" type="button" data-name="${esc(s.name)}">
        <span><b>${esc(s.name)}</b><small>${(s.trees || []).length} trees · ${Math.max(0, s.count - (s.trees || []).length)} photos · ${esc(new Date(s.updated || s.started).toLocaleDateString())}${s.collector ? ' · ' + esc(s.collector) : ''}</small></span><span aria-hidden="true">→</span>
      </button>`).join('');
    $('resume-list').querySelectorAll('.resume').forEach(b => b.addEventListener('click', () => startSurvey(b.dataset.name)));
    if (list.length) $('start-btn').textContent = 'Start a new field book';
  }

  async function startSurvey(resumeName) {
    await store.ready;
    let p;
    if (resumeName) {
      const s = await store.getSession(resumeName);
      if (!s) { toast('Saved field book not found', 'err'); return; }
      p = { name: s.name, notes: s.notes || '', collector: s.collector || '', started: s.started, camH: s.camH || 1.5, trees: s.trees || [] };
    } else {
      const raw = $('pname').value.trim();
      if (!raw) { toast('Give the field book a name', 'err'); return; }
      const camH = parseFloat($('pcamh').value);
      if (!isFinite(camH) || camH < 0.2 || camH > 60) { toast('Camera height must be 0.2–60 m', 'err'); return; }
      const name = raw.replace(/[^a-zA-Z0-9_\-.]/g, '_');           // safe in file names
      const old = await store.getSession(name);
      p = { name, notes: $('pnotes').value.trim(), collector: $('pcoll').value.trim(), started: old ? old.started : new Date().toISOString(), camH, trees: old ? (old.trees || []) : [] };
      if (old) toast('Continuing ' + name, 'ok');
    }
    S.proj = p; S.camH = p.camH;
    S.tree = p.trees.some(t => t.uid === pref('tree:' + p.name)) ? pref('tree:' + p.name) : null;
    await saveSession();
    $('scr-session').classList.remove('on');
    $('app').hidden = false;
    $('h-proj').textContent = p.name;
    $('camh-edit').value = S.camH;
    $('ver').textContent = APP.version;
    renderTypes(); startCamera(); initMap(); wake();
    S.caps = (await store.capsFor(p.name)).filter(c => c.kind !== 'clip').sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    renderAll();
    if (store.mem) toast('Phone storage unavailable — export a ZIP before closing', 'err');
    requestAnimationFrame(loop);
    if (!pref('toured')) setTimeout(() => tour.start(), 600);
  }
  function saveSession() {
    const p = S.proj;
    return store.putSession({ name: p.name, notes: p.notes, collector: p.collector, camH: S.camH, started: p.started, updated: new Date().toISOString(),
      count: S.caps.length + p.trees.length, trees: p.trees });
  }

  /* ── Sensors ── */
  function startGPS() {
    if (!navigator.geolocation) { toast('This browser has no location access', 'err'); return; }
    navigator.geolocation.watchPosition(p => {
      const g = gps.push(p.coords);
      if (g) { S.fix = g; travel.update(g); }
      S.lastGPS = Date.now();
      if (S.lock) lockPush(p.coords);
    }, e => toast('GPS: ' + e.message, 'err'), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  $('compass').addEventListener('click', () => {
    compass.recalibrate();                      // re-asks permission inside this tap
    if (mag) mag.reset();
    if (C.perm !== 'denied') toast('Recalibrating — draw a slow figure-8 with the phone', 'ok');
  });
  const heading = () => C.heading;               // null until the first valid reading
  const tilt = () => C.tilt;
  const fp = () => F.footprint({ camH: S.camH, tilt: tilt(), hfov: HFOV, tiltMax: TILT_MAX });
  const aim = h => (S.fix && heading() !== null) ? F.aimPoint(S.fix.lat, S.fix.lon, h ?? heading(), { camH: S.camH, tilt: tilt(), tiltMax: TILT_MAX }) : null;
  const disturbed = () => trust.status === 'DISTURBED' && C.signal !== 'LOST';

  /* ── Camera, with a watchdog (Powai Lake Survey 1.1): on long sessions Android Chrome can
       leave the preview frozen, or end the track after the app was in the background. ── */
  const camTrack = () => S.stream && S.stream.getVideoTracks()[0];
  async function startCamera() {
    try {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      S.stream = null;
      const v = $('video'); v.srcObject = null;
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      v.srcObject = S.stream;
      await v.play().catch(() => {});
      S.camFailAt = 0; camDog.reset();
      return true;
    } catch (e) { S.camFailAt = Date.now(); toast('Camera: ' + e.message + ' — tap ↻ again to reload the app', 'err'); return false; }
  }
  let camBusy = false;
  async function restartCamera(auto) {
    if (camBusy) return;
    camBusy = true; $('cam-refresh').classList.add('spin');
    try { const ok = await startCamera(); if (ok) { S.camRestarts++; toast(auto ? 'Camera had frozen — restarted' : 'Camera restarted', 'ok'); } }
    finally { camBusy = false; $('cam-refresh').classList.remove('spin'); camDog.reset(); }
  }
  $('cam-refresh').addEventListener('click', () => {
    if (S.camFailAt && Date.now() - S.camFailAt < 10000) { location.reload(); return; }
    restartCamera(false);
  });
  const camDog = {
    lastT: -1, lastChange: 0, lastAuto: 0,
    reset() { this.lastT = -1; this.lastChange = performance.now(); },
    check(now) {
      if (!S.proj || activeTab !== 'cam' || document.visibilityState !== 'visible' || camBusy || sheetOpen()) return;
      const v = $('video'), tr = camTrack();
      if (v.paused && v.srcObject) v.play().catch(() => {});
      if (v.currentTime !== this.lastT) { this.lastT = v.currentTime; this.lastChange = now; }
      const dead = !tr || tr.readyState === 'ended', frozen = now - this.lastChange > FREEZE_MS;
      if ((dead || frozen) && now - this.lastAuto > 15000) { this.lastAuto = now; restartCamera(true); }
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return;
    camDog.reset();
    const tr = camTrack();
    if (S.proj && (!tr || tr.readyState === 'ended')) restartCamera(true);
  });

  /* ── Render loop: decoupled from sensor events ── */
  let lastSlow = 0;
  function loop(ts) {
    if (heading() !== null) S.dispAz = F.lerpAngle(S.dispAz, heading(), 0.2);
    $('rose').style.transform = `rotate(${-S.dispAz}deg)`;
    $('ring').setAttribute('stroke', disturbed() ? 'var(--badc)' : C.signal === 'OK' ? 'rgba(159,208,127,.75)' : C.signal === 'STALE' ? 'var(--warnc)' : 'var(--badc)');
    if (ts - lastSlow > 120) {
      lastSlow = ts;
      if (mag) trust = mag.evaluate(performance.now());
      updHUD(); updTilt(); camDog.check(ts); updLock(); updScan(ts);
      if (activeTab === 'map') updCone(); if (activeTab === 'data') updData();
    }
    requestAnimationFrame(loop);
  }
  const azLbl = a => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][Math.round(a / 45) % 8];
  const fmtM = m => (m < 10 ? m.toFixed(1) : Math.round(m)) + ' m';
  function setChip(id, text, cls) { const e = $(id); e.textContent = text; e.className = 'chip' + (cls ? ' ' + cls : ''); }
  function updHUD() {
    const g = S.fix, h = heading();
    setChip('h-pos', g ? `${g.lat.toFixed(5)} ${g.lon.toFixed(5)}` : 'LAT —  LON —', g ? '' : 'warn');
    setChip('h-acc', g ? `${g.acc <= GPS_LOCK ? '⊕ ' : ''}± ${g.acc.toFixed(1)} m` : 'GPS…',
      !g ? 'warn' : g.acc <= GPS_LOCK ? 'ok' : g.acc <= GPS_BLOCK ? 'warn' : 'bad');
    const sc = disturbed() ? 'bad' : C.signal === 'OK' ? '' : C.signal === 'STALE' ? 'warn' : 'bad';
    setChip('h-hdg', h === null ? 'HDG —' : `HDG ${Math.round(h)}° ${azLbl(h)}`, sc);
    const live = C.signal !== 'LOST' && h !== null;
    setChip('h-src', 'SRC ' + C.src + (live && trust.status !== 'UNKNOWN' ? ' · ' + trust.status : ''), sc);   // honest about the heading
    $('h-campus').hidden = !g || inCampus(g.lat, g.lon);
    const a = aim(), el = $('aim-tag');
    if (!g) { el.textContent = 'AIM — waiting for GPS'; el.className = 'warn'; }
    else if (h === null) { el.textContent = 'AIM — no compass yet'; el.className = 'warn'; }
    else if (!a) { el.textContent = 'AIM — at or above horizon'; el.className = 'warn'; }
    else { el.textContent = `AIM ${fmtM(a.dist)} ± ${fmtM(a.unc)}`; el.className = a.unc > 5 ? 'warn' : ''; }
  }
  function updTilt() {
    const t = tilt(), H = 130;
    $('tilt-zone').style.top = (AIM_MIN / 90 * H) + 'px';
    $('tilt-zone').style.height = ((AIM_MAX - AIM_MIN) / 90 * H) + 'px';
    const pin = $('tilt-pin'), deg = $('tilt-deg'), lbl = $('tilt-lbl');
    if (t === null) { deg.textContent = '—'; lbl.textContent = 'TILT'; pin.style.top = '0px'; return; }
    pin.style.top = (Math.min(Math.max(t / 90, 0), 1) * (H - 4)) + 'px';
    let txt, cls = '';
    if (!fp()) { txt = 'SKY'; cls = 'warn'; }
    else if (t >= TILT_MAX) { txt = 'HORIZON'; cls = 'warn'; }
    else if (t > AIM_MAX) { txt = 'FAR'; cls = 'warn'; }
    else if (t >= AIM_MIN) { txt = '✓ AIM'; cls = 'ok'; }
    else txt = 'DOWN';
    pin.className = cls; deg.className = cls; deg.textContent = t + '°'; lbl.textContent = txt;
  }

  /* ── Trees ───────────────────────────────────────────────────── */
  const trees = () => S.proj ? S.proj.trees : [];
  const treeBy = uid => trees().find(t => t.uid === uid) || null;
  const curTree = () => treeBy(S.tree);
  const normTag = s => {
    const v = String(s || '').toUpperCase().replace(/[#\s]/g, '').replace(/^([A-Z]{1,2})-?(\d)/, '$1$2');
    return v.replace(/[^A-Z0-9\-]/g, '');
  };
  function treeName(t) {
    if (!t) return '—';
    if (t.tag) return t.tag;
    if (t.paint) return 'No. ' + t.paint;
    return 'Untagged ' + (trees().filter(x => !x.tag && !x.paint).indexOf(t) + 1);
  }
  const photosOf = t => S.caps.filter(c => c.treeId === t.uid);
  const lastVisit = t => (t.visits || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0] || null;

  /* Where the tree stands: the method picked on the card, else the one with the smallest ±. */
  function bestLoc(t) {
    const L = Object.assign({}, t.locs || {});
    const b = bearingFix(t); if (b) L.bear = b; else delete L.bear;
    if (t.use && t.use !== 'auto' && L[t.use]) return Object.assign({ method: t.use }, L[t.use]);
    let best = null;
    for (const k of Object.keys(L)) if (L[k] && (!best || L[k].unc < best.unc)) best = Object.assign({ method: k }, L[k]);
    return best;
  }
  /* Photo directions: lines from where whole-tree photos were taken, along their heading.
     Least-squares crossing point; needs two or more lines at least 25° apart, all pointing at it.
     Lines from a DISTURBED compass, a lost signal or weak GPS are left out. */
  function bearingLines(t) {
    return photosOf(t).filter(c => c.cls === 'whole' && c.heading !== null && c.signal === 'OK' && c.trust !== 'DISTURBED' && c.accuracy <= 20 && (c.tilt === null || c.tilt >= 45));
  }
  function bearingFix(t) {
    const ls = bearingLines(t);
    if (ls.length < 2) return null;
    const lat0 = ls[0].lat, lon0 = ls[0].lon, kx = 111320 * Math.cos(lat0 * F.D2R), ky = 110540;
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    const L = ls.map(c => {
      const x = (c.lon - lon0) * kx, y = (c.lat - lat0) * ky, h = c.heading * F.D2R, dx = Math.sin(h), dy = Math.cos(h);
      const w = 1 / Math.max(c.accuracy, 2) ** 2;
      const m11 = 1 - dx * dx, m12 = -dx * dy, m22 = 1 - dy * dy;
      a11 += w * m11; a12 += w * m12; a22 += w * m22; b1 += w * (m11 * x + m12 * y); b2 += w * (m12 * x + m22 * y);
      return { x, y, dx, dy, acc: c.accuracy, h: c.heading };
    });
    let spread = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) spread = Math.max(spread, F.angDiff(L[i].h, L[j].h));
    if (spread < 25) return null;
    const det = a11 * a22 - a12 * a12; if (Math.abs(det) < 1e-12) return null;
    const px = (a22 * b1 - a12 * b2) / det, py = (a11 * b2 - a12 * b1) / det;
    let r2 = 0, dsum = 0, accsum = 0;
    for (const l of L) {
      const vx = px - l.x, vy = py - l.y, along = vx * l.dx + vy * l.dy;
      if (along < 1 || along > 90) return null;           // behind a camera, or implausibly far
      const perp = vx * l.dy - vy * l.dx; r2 += perp * perp; dsum += along; accsum += l.acc;
    }
    const n = L.length, rms = Math.sqrt(r2 / n), meanD = dsum / n;
    const unc = Math.max(1.5, Math.sqrt(rms * rms + (meanD * Math.tan(7 * F.D2R)) ** 2 / n + (accsum / n) ** 2 / n));
    return { lat: lat0 + py / ky, lon: lon0 + px / kx, unc, n, spread: Math.round(spread), rms: +rms.toFixed(1) };
  }

  /* ── Tree picker (nearest first) ── */
  function openPicker() {
    $('tp-find').value = '';
    renderPicker(); $('tpick').hidden = false;
  }
  function renderPicker() {
    const q = normTag($('tp-find').value), g = S.fix;
    let list = trees().map(t => { const l = bestLoc(t); return { t, d: (g && l) ? F.geoDist(g.lat, g.lon, l.lat, l.lon) : null }; });
    if (q) list = list.filter(x => normTag(x.t.tag).includes(q) || normTag(x.t.paint).includes(q));
    list.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9) || (b.t.updated || '').localeCompare(a.t.updated || ''));
    $('tp-list').innerHTML = list.length ? list.map(({ t, d }) => {
      const v = lastVisit(t), n = photosOf(t).length;
      return `<button type="button" class="tp-item${t.uid === S.tree ? ' cur' : ''}" data-uid="${esc(t.uid)}">
        <span><b>${esc(treeName(t))}</b><small>${t.paint && t.tag ? 'painted ' + esc(t.paint) + ' · ' : ''}${n} photo${n === 1 ? '' : 's'}${v ? ' · ' + esc(LEAF[v.leaf] || 'visited') + ' ' + esc(v.date.slice(5)) : ''}</small></span>
        <span class="d">${d === null ? (bestLoc(t) ? '' : 'no position') : fmtM(d)}</span></button>`;
    }).join('') : `<p class="empty">${trees().length ? 'No tree matches.' : 'No trees in the book yet.'}</p>`;
    $('tp-list').querySelectorAll('.tp-item').forEach(b => b.addEventListener('click', () => { setTree(b.dataset.uid); $('tpick').hidden = true; }));
  }
  $('tp-find').addEventListener('input', renderPicker);
  $('tp-new').addEventListener('click', () => { $('tpick').hidden = true; openTree(null); });
  $('treebar').addEventListener('click', () => trees().length ? openPicker() : openTree(null));
  $('b-tree').addEventListener('click', () => openTree(curTree()));
  function setTree(uid) {
    S.tree = uid; pref('tree:' + S.proj.name, uid || '');
    renderTreebar(); updLast();
    const t = curTree(); if (t) toast('Now photographing ' + treeName(t), 'ok');
  }
  function renderTreebar() {
    const t = curTree(), bar = $('treebar');
    bar.classList.toggle('none', !t);
    if (!t) { $('tb-id').textContent = 'No tree yet'; $('tb-meta').textContent = trees().length ? 'Tap to pick a tree' : 'Tap to start a tree'; return; }
    const l = bestLoc(t), n = photosOf(t).length, v = (t.visits || []).find(x => x.date === today());
    $('tb-id').textContent = treeName(t);
    $('tb-meta').textContent = `${n} photo${n === 1 ? '' : 's'} · ${l ? '± ' + fmtM(l.unc) : 'no position yet'}${v && v.leaf ? ' · ' + LEAF[v.leaf].toLowerCase() : ''}`;
  }

  /* ── Tree card ── */
  let draft = null;                 // the tree being edited (a copy until Save)
  const SEGS = ['stems', 'leaf', 'flowers', 'pods', 'sample'];
  const segGet = f => { const b = document.querySelector(`.seg[data-f="${f}"] button[aria-checked="true"]`); return b ? b.dataset.v : null; };
  const segSet = (f, v) => document.querySelectorAll(`.seg[data-f="${f}"] button`).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v)));
  document.querySelectorAll('.seg').forEach(sg => sg.querySelectorAll('button').forEach(b => {
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
    b.addEventListener('click', () => { const on = b.getAttribute('aria-checked') === 'true'; segSet(sg.dataset.f, on ? null : b.dataset.v); if (sg.dataset.f === 'sample') $('ts-sample').disabled = segGet('sample') !== 'yes'; });
  }));
  function openTree(t) {
    const isNew = !t;
    draft = t ? JSON.parse(JSON.stringify(t)) : { uid: 'TR-' + Date.now(), tag: '', paint: '', qr: null, created: new Date().toISOString(), locs: {}, use: 'auto', visits: [], _new: true };
    draft._new = isNew;
    $('ts-h').textContent = isNew ? 'New tree' : treeName(t);
    $('ts-tag').value = draft.tag || ''; $('ts-paint').value = draft.paint || '';
    $('ts-qr').hidden = !draft.qr; $('ts-qr').textContent = draft.qr ? 'QR: ' + draft.qr : '';
    segSet('stems', draft.stems || null);
    $('ts-gbh').value = draft.gbh ?? ''; $('ts-ht').value = draft.ht ?? '';
    const v = (draft.visits || []).find(x => x.date === today()) || {};
    $('ts-date').textContent = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    segSet('leaf', v.leaf || null); segSet('flowers', v.flowers || null); segSet('pods', v.pods || null); segSet('sample', v.sample || null);
    $('ts-sample').value = v.sampleLabel || ''; $('ts-sample').disabled = v.sample !== 'yes'; $('ts-note').value = v.note || '';
    $('ts-del').hidden = isNew;
    renderLocs(); $('tsheet').hidden = false;
    $('tsheet').querySelector('.bsheet').scrollTop = 0;
  }
  function renderLocs() {
    const t = draft, b = bearingFix(t), best = bestLoc(t), L = t.locs || {};
    const nLines = bearingLines(t).length;
    const row = (k, n, title, val, hint, act, actLbl) => `
      <div class="loc${best && best.method === k ? ' use' : ''}"><span class="n">${n}</span>
        <span><b>${title}</b>${val ? `<small class="v">${val}</small>` : ''}<small>${hint}</small></span>
        ${act ? `<button type="button" data-act="${act}" class="${best && best.method === k && t.use === k ? 'on' : ''}">${actLbl}</button>` : ''}</div>`;
    const v = l => l ? `± ${fmtM(l.unc)} · ${l.lat.toFixed(6)}, ${l.lon.toFixed(6)}` : '';
    $('ts-locs').innerHTML =
      row('trunk', 'i', LOC_NAME.trunk, v(L.trunk) + (L.trunk ? ` · ${L.trunk.n} fixes` : ''), 'Stand touching the trunk; the phone averages GPS for 15 s.', 'lock', L.trunk ? 'Again' : 'Lock') +
      row('aim', 'ii', LOC_NAME.aim, v(L.aim) + (L.aim ? ` · ${fmtM(L.aim.dist)} away` : ''), 'From open ground, put the crosshair on the trunk base.', 'aim', L.aim ? 'Again' : 'Aim') +
      row('bear', 'iii', LOC_NAME.bear, b ? `${v(b)} · ${b.n} photos, ${b.spread}° apart` : '', b ? 'Whole-tree photos from different sides cross here.' :
        nLines ? `${nLines} usable whole-tree photo${nLines === 1 ? '' : 's'}; add one from a side at least 30° round.` : 'Take “Whole tree” photos from two or more sides.', b ? 'bear' : null, 'Use');
    const hint = $('ts-loc-hint');
    if (!best) hint.textContent = 'No position yet. Any one of the three is enough; two lets you cross-check.';
    else {
      const others = Object.entries(Object.assign({}, L, b ? { bear: b } : {})).filter(([k, l]) => l && k !== best.method);
      const far = others.map(([k, l]) => [k, F.geoDist(best.lat, best.lon, l.lat, l.lon)]).filter(([, d]) => d > 8);
      hint.textContent = `Using ${LOC_NAME[best.method].toLowerCase()}${t.use === 'auto' ? ' (smallest ±)' : ''}.` +
        (far.length ? ` ${LOC_NAME[far[0][0]]} is ${fmtM(far[0][1])} away — check it.` : others.length ? ' The others agree within 8 m.' : '') +
        (!inCampus(best.lat, best.lon) ? ' ⚠ This is outside the campus.' : '');
    }
    $('ts-locs').querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
      const a = btn.dataset.act;
      if (a === 'lock') { collectForm(); startLock(); }
      else if (a === 'aim') { collectForm(); startAim(); }
      else if (a === 'bear') { draft.use = draft.use === 'bear' ? 'auto' : 'bear'; renderLocs(); }
    }));
    $('ts-locs').querySelectorAll('.loc').forEach((el, i) => {
      const k = ['trunk', 'aim', 'bear'][i];
      if (k !== 'bear' && L[k]) el.addEventListener('dblclick', () => { draft.use = draft.use === k ? 'auto' : k; renderLocs(); });
    });
  }
  function collectForm() {
    const d = draft;
    d.tag = normTag($('ts-tag').value); d.paint = $('ts-paint').value.trim();
    d.stems = segGet('stems'); const g = parseFloat($('ts-gbh').value), h = parseFloat($('ts-ht').value);
    d.gbh = isFinite(g) ? g : null; d.ht = isFinite(h) ? h : null;
    const v = { date: today(), leaf: segGet('leaf'), flowers: segGet('flowers'), pods: segGet('pods'), sample: segGet('sample'),
      sampleLabel: segGet('sample') === 'yes' ? $('ts-sample').value.trim() : '', note: $('ts-note').value.trim() };
    d.visits = (d.visits || []).filter(x => x.date !== v.date);
    if (v.leaf || v.flowers || v.pods || v.sample || v.note) d.visits.push(Object.assign(v, { collector: S.proj.collector || '', saved: new Date().toISOString() }));
    return d;
  }
  async function commitDraft() {
    const d = collectForm(), isNew = d._new; delete d._new;
    d.updated = new Date().toISOString();
    const i = trees().findIndex(t => t.uid === d.uid);
    if (i >= 0) trees()[i] = d; else trees().push(d);
    // photos keep a copy of the tag, so the export reads well even if the tag is fixed later
    if (!isNew) S.caps.filter(c => c.treeId === d.uid && c.treeTag !== treeName(d)).forEach(c => { c.treeTag = treeName(d); store.putCap(c).catch(() => {}); });
    await saveSession();
    draft = Object.assign(JSON.parse(JSON.stringify(d)), { _new: false });
    return d;
  }
  $('ts-save').addEventListener('click', async () => {
    const tag = normTag($('ts-tag').value);
    const dup = tag && trees().find(t => t.uid !== draft.uid && t.tag === tag);
    if (dup) {
      if (confirm(`${tag} is already in the book. Open that tree instead?`)) { $('tsheet').hidden = true; draft = null; setTree(dup.uid); openTree(dup); }
      return;
    }
    const d = await commitDraft();
    $('tsheet').hidden = true; draft = null;
    if (S.tree !== d.uid) setTree(d.uid); else { renderTreebar(); updLast(); }
    renderAll();
    toast(treeName(d) + ' saved' + (bestLoc(d) ? '' : ' — no position yet'), bestLoc(d) ? 'ok' : '');
  });
  $('ts-del').addEventListener('click', async () => {
    const t = treeBy(draft.uid); if (!t) return;
    const n = photosOf(t).length;
    if (!confirm(`Delete ${treeName(t)}${n ? ' and its ' + n + ' photo' + (n === 1 ? '' : 's') : ''}?`)) return;
    for (const c of photosOf(t)) await store.delCap(c.id);
    S.caps = S.caps.filter(c => c.treeId !== t.uid);
    S.proj.trees = trees().filter(x => x !== t);
    if (S.tree === t.uid) setTree(null);
    await saveSession(); $('tsheet').hidden = true; draft = null; renderAll();
  });
  document.querySelectorAll('.sheet-ov').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o || e.target.closest('[data-close]')) { o.hidden = true; if (o.id === 'tsheet') draft = null; } });
  });
  const sheetOpen = () => [...document.querySelectorAll('.sheet-ov')].some(o => !o.hidden);
  function goTab(k) { document.querySelector(`.tab[data-tab="${k}"]`).click(); }

  /* ── (i) Trunk lock: average raw GPS fixes, weighted 1/acc², while she stands at the tree ── */
  function startLock() {
    $('tsheet').hidden = true; goTab('cam');
    S.lock = { t0: performance.now(), fixes: [] };
    $('lk-title').textContent = 'Hold still at the trunk'; $('lk-stop').textContent = 'Done';
    $('lockbox').hidden = false; updLock();
  }
  function lockPush(c) {
    if (!S.lock || !isFinite(c.latitude) || !isFinite(c.longitude)) return;
    S.lock.fixes.push({ lat: c.latitude, lon: c.longitude, acc: Math.max(0.5, c.accuracy || 99) });
    if (S.lock.fixes.length >= LOCK_MAX) endLock(true);
  }
  function updLock() {
    if (S.aiming) return updAim();
    if (!S.lock) return;
    const el = performance.now() - S.lock.t0, n = S.lock.fixes.length, frac = Math.min(1, el / LOCK_MS);
    $('lk-arc').style.strokeDashoffset = String(119.4 * (1 - frac));
    const accs = S.lock.fixes.map(f => f.acc).sort((a, b) => a - b), med = n ? accs[Math.floor(n / 2)] : null;
    $('lk-info').textContent = `${n} fix${n === 1 ? '' : 'es'}${med ? ' · median ± ' + med.toFixed(1) + ' m' : ''} · ${Math.max(0, Math.ceil((LOCK_MS - el) / 1000))} s`;
    if (el >= LOCK_MS) endLock(true);
  }
  function endLock(keep) {
    const L = S.lock; S.lock = null; $('lockbox').hidden = true;
    if (!L || !keep || !draft) { if (draft) $('tsheet').hidden = false; return; }
    const fx = L.fixes;
    if (fx.length < 3) { toast('Too few GPS fixes — try again in the open, or use the crosshair', 'err'); $('tsheet').hidden = false; return; }
    const accs = fx.map(f => f.acc).sort((a, b) => a - b), med = accs[Math.floor(accs.length / 2)];
    if (med > GPS_BLOCK) { toast(`GPS too weak under this canopy (± ${med.toFixed(0)} m). Use the crosshair from open ground.`, 'err'); $('tsheet').hidden = false; return; }
    let w = 0, la = 0, lo = 0;
    for (const f of fx) { const k = 1 / (f.acc * f.acc); w += k; la += k * f.lat; lo += k * f.lon; }
    // Fixes seconds apart share most of their error, so averaging helps less than √n: claim at most √3.
    const unc = Math.max(accs[0] * 0.8, med / Math.sqrt(Math.min(fx.length, 3)));
    draft.locs = draft.locs || {};
    draft.locs.trunk = { lat: la / w, lon: lo / w, unc: +unc.toFixed(1), n: fx.length, medAcc: +med.toFixed(1), at: new Date().toISOString() };
    commitDraft().then(d => { if (S.tree !== d.uid) setTree(d.uid); renderAll(); renderLocs(); $('tsheet').hidden = false; toast(`Trunk position saved · ± ${fmtM(unc)} from ${fx.length} fixes`, 'ok'); });
  }
  $('lk-stop').addEventListener('click', () => {
    if (S.aiming) { useAim(); return; }
    if (S.lock && S.lock.fixes.length >= 3) endLock(true); else endLock(false);
  });

  /* ── (ii) Crosshair point: from open ground, aim at the trunk base. Also files a whole-tree photo. ── */
  function startAim() {
    $('tsheet').hidden = true; goTab('cam');
    S.aiming = true; pickType('whole');
    $('lk-title').textContent = 'Crosshair on the trunk base'; $('lk-stop').textContent = 'Use';
    $('lk-arc').style.strokeDashoffset = '0';
    $('lockbox').hidden = false; updAim();
  }
  function updAim() {
    const a = aim(), g = S.fix;
    $('lk-info').textContent = !g ? 'waiting for GPS' : heading() === null ? 'waiting for the compass' : !a ? 'tilt down to the base of the trunk' :
      `${fmtM(a.dist)} away · ± ${fmtM(Math.hypot(a.unc, g.acc))}${disturbed() ? ' · compass disturbed' : ''}`;
  }
  async function useAim() {
    const g = S.fix, h = heading(), a = aim(h), t = tilt();
    if (!g || g.acc > GPS_BLOCK) { toast('GPS too weak here — step into the open', 'err'); return; }
    if (h === null || C.signal === 'LOST') { toast('No compass — tap it and draw a figure-8', 'err'); return; }
    if (disturbed()) { toast('Compass disturbed here — move away from cars and railings', 'err'); return; }
    if (!a || t < AIM_MIN || t > AIM_MAX) { toast('Tilt down until the crosshair sits on the trunk base (green band)', 'err'); return; }
    S.aiming = false; $('lockbox').hidden = true;
    draft.locs = draft.locs || {};
    draft.locs.aim = { lat: a.lat, lon: a.lon, unc: +Math.hypot(a.unc, g.acc).toFixed(1), dist: +a.dist.toFixed(2), fromLat: g.lat, fromLon: g.lon, heading: Math.round(h), tilt: t, camH: S.camH, at: new Date().toISOString() };
    const d = await commitDraft();
    if (S.tree !== d.uid) setTree(d.uid);
    await capture('whole', 'aim');                // the evidence: a photo with the crosshair on the trunk
    renderLocs(); $('tsheet').hidden = false;
  }

  /* ── Tag scanner: BarcodeDetector where the phone has it (Android Chrome), jsQR otherwise (iPhone) ── */
  $('ts-scan').addEventListener('click', () => { collectForm(); startScan(); });
  $('scan-close').addEventListener('click', () => stopScan(null));
  let jsqrLoading = null;
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    if (!jsqrLoading) jsqrLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jsqr.min.js'; s.onload = res; s.onerror = () => rej(new Error('scanner not loaded')); document.head.appendChild(s); });
    return jsqrLoading;
  }
  async function startScan() {
    $('tsheet').hidden = true; goTab('cam');
    $('scan').hidden = false; $('scan-msg').textContent = 'Hold the tag’s QR code inside the square';
    S.scanning = { busy: false, last: 0, det: null };
    try {
      if ('BarcodeDetector' in window) {
        const f = await BarcodeDetector.getSupportedFormats().catch(() => []);
        if (f.includes('qr_code')) S.scanning.det = new BarcodeDetector({ formats: ['qr_code'] });
      }
      if (!S.scanning.det) await loadJsQR();
    } catch (e) { if (S.scanning) $('scan-msg').textContent = 'Scanner unavailable — type the number instead'; }
  }
  async function updScan(ts) {
    const sc = S.scanning; if (!sc || sc.busy || ts - sc.last < 220) return;
    const v = $('video'); if (!v.videoWidth) return;
    sc.busy = true; sc.last = ts;
    try {
      let raw = null;
      if (sc.det) { const r = await sc.det.detect(v); if (r && r.length) raw = r[0].rawValue; }
      else if (window.jsQR) {
        const side = Math.min(v.videoWidth, v.videoHeight) * 0.75, sx = (v.videoWidth - side) / 2, sy = (v.videoHeight - side) / 2 - v.videoHeight * 0.08;
        const N = 560, cv = $('snap'); cv.width = N; cv.height = N;
        const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(v, sx, Math.max(0, sy), side, side, 0, 0, N, N);
        const r = window.jsQR(cx.getImageData(0, 0, N, N).data, N, N, { inversionAttempts: 'dontInvert' });
        if (r && r.data) raw = r.data;
      }
      if (raw && S.scanning === sc) stopScan(raw);
    } catch (e) { /* a bad frame; try the next one */ }
    finally { sc.busy = false; }
  }
  function tagFromQR(raw) {
    const s = String(raw);
    const m = s.match(/(?:^|[^A-Z0-9])(L)[-_ ]?(\d{2,6})(?![0-9])/i) || s.match(/(?:^|[^A-Z0-9])([A-Z]{1,2})[-_]?(\d{2,6})(?![0-9])/i);
    return m ? (m[1] + m[2]).toUpperCase() : null;
  }
  function stopScan(raw) {
    S.scanning = null; $('scan').hidden = true;
    if (!draft) return;
    if (raw) {
      draft.qr = String(raw).slice(0, 300);
      const tag = tagFromQR(raw);
      if (tag) draft.tag = tag;
      try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
      toast(tag ? 'Tag read: ' + tag : 'QR read, but no tag number in it — type the number', tag ? 'ok' : 'err');
    }
    const d = draft; openTree(d.uid && treeBy(d.uid) ? Object.assign(treeBy(d.uid), {}) : null);
    // openTree() reset the form from the saved tree; put the unsaved draft back
    draft = d; $('ts-tag').value = d.tag || ''; $('ts-paint').value = d.paint || '';
    $('ts-qr').hidden = !d.qr; $('ts-qr').textContent = d.qr ? 'QR: ' + d.qr : '';
    restoreVisit(d);
  }
  function restoreVisit(d) {
    segSet('stems', d.stems || null); $('ts-gbh').value = d.gbh ?? ''; $('ts-ht').value = d.ht ?? '';
    const v = (d.visits || []).find(x => x.date === today()) || {};
    segSet('leaf', v.leaf || null); segSet('flowers', v.flowers || null); segSet('pods', v.pods || null); segSet('sample', v.sample || null);
    $('ts-sample').value = v.sampleLabel || ''; $('ts-sample').disabled = v.sample !== 'yes'; $('ts-note').value = v.note || '';
    $('ts-h').textContent = d._new ? 'New tree' : treeName(d); $('ts-del').hidden = !!d._new;
    renderLocs();
  }

  /* ── Type picker + shutter ── */
  function renderTypes() {
    $('types').style.setProperty('--cols', Math.min(4, CLASSES.length));
    $('types').innerHTML = CLASSES.map(c => `<button type="button" role="radio" class="tbtn" data-cls="${esc(c.k)}" style="--c:${c.col}" aria-checked="${c.k === S.cls}">${esc(c.label)}<small>${esc(c.sub)}</small></button>`).join('');
    $('types').querySelectorAll('.tbtn').forEach(b => b.addEventListener('click', () => pickType(b.dataset.cls)));
    $('map-legend').innerHTML = '<span><i class="tree-i"></i>tree</span>' + CLASSES.filter(c => ['whole', 'tag', 'canopy', 'leaves', 'flower'].includes(c.k)).map(c => `<span><i style="background:${c.col}"></i>${esc(c.label)}</span>`).join('') + '<span><i style="background:#9aa"></i>other photos</span>';
  }
  function pickType(k) {
    S.cls = k; pref('cls', k);
    $('types').querySelectorAll('.tbtn').forEach(b => b.setAttribute('aria-checked', String(b.dataset.cls === k)));
    updLast();
  }
  $('shutter').addEventListener('click', () => capture(S.cls));
  function updLast() {
    const t = curTree();
    $('last').innerHTML = `<b>${esc(clsOf(S.cls).label)}</b>${t ? '→ ' + esc(treeName(t)) : 'pick a tree first'}`;
  }

  /* ── Photo: read everything synchronously first, so the record matches the instant
       of the tap; only then await the encode and the store ── */
  let busy = false;
  async function capture(cls, role) {
    if (busy || !S.proj) return;
    const tr = curTree();
    if (!tr) { toast('Pick a tree first — every photo belongs to one', 'err'); trees().length ? openPicker() : openTree(null); return; }
    const g = S.fix;
    if (!g) { toast('No GPS fix yet — wait for the position', 'err'); return; }
    if (g.acc > GPS_BLOCK) { toast(`GPS too weak (± ${g.acc.toFixed(0)} m) — step into the open`, 'err'); return; }
    const vid = $('video');
    if (!vid.videoWidth) { toast('Camera not ready — tap ↻ to restart it', 'err'); return; }
    busy = true;
    try {
      const cv = $('snap'); cv.width = vid.videoWidth; cv.height = vid.videoHeight;
      cv.getContext('2d').drawImage(vid, 0, 0);
      const now = new Date(), ms = now.getTime(), h = heading(), t = tilt();
      const f = fp(), ring = (f && h !== null) ? F.footprintRing(g.lat, g.lon, h, f) : null, a = aim(h);
      const tb = travel.get(), rel = F.lookRelTravel(h, tb);
      const id = APP.idPrefix + '-' + ms, name = treeName(tr);
      const ts = now.toISOString().replace(/[-:T]/g, '').split('.')[0];
      const safe = s => String(s).replace(/[^A-Za-z0-9\-]/g, '');
      const cap = {
        id, project: S.proj.name, timestamp: now.toISOString(), visitDate: today(), collector: S.proj.collector || '',
        treeId: tr.uid, treeTag: name, role: role || null,
        imgName: `${S.proj.name}_${safe(name) || 'tree'}_${cls}_${ts}_${g.lat.toFixed(5).replace('.', 'p')}_${g.lon.toFixed(5).replace('.', 'p')}.jpg`,
        lat: g.lat, lon: g.lon, altitude: g.alt, accuracy: g.acc, gpsSamples: g.samples, inCampus: inCampus(g.lat, g.lon),
        heading: h === null ? null : Math.round(h), headingSrc: C.src, signal: C.signal, platform: C.platform,
        trust: C.signal === 'LOST' || h === null ? 'UNKNOWN' : trust.status, trustMismatch: trust.mismatch === null ? null : +trust.mismatch.toFixed(1),
        tilt: t, camH: S.camH, hfov: HFOV,
        travelBrg: tb === null ? null : Math.round(tb), lookRel: rel, lookSide: F.lookSide(rel),
        fp: f ? { w: f.w, d: f.d, farCapped: f.farCapped } : null, ring,
        aim: a ? { lat: a.lat, lon: a.lon, dist: a.dist, unc: a.unc } : null,
        cls, note: '', thumb: null
      };
      const fl = $('flash'); fl.style.background = clsOf(cls).col; fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      cap.thumb = thumbOf(cv);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
      await store.putPhoto(id, blob);
      await store.putCap(cap);
      S.caps.unshift(cap);
      tr.updated = cap.timestamp;
      await saveSession();
      renderAll();
      const warn = h === null || C.signal === 'LOST' ? ' · ⚠ no compass fix' : cap.trust === 'DISTURBED' ? ' · ⚠ compass disturbed — direction not used' : g.acc > GPS_LOCK ? ' · weak GPS' : '';
      let tip = '';
      if (!role && cls === 'tag' && !tr.tag) tip = ' · add the tag number on the tree card';
      else if (!role && cls === 'whole' && !bearingFix(tr) && bearingLines(tr).length === 1) tip = ' · one more from another side fixes the tree';
      toast(`${clsOf(cls).label} → ${name}${warn || tip}`, warn ? '' : 'ok');
    } catch (e) { console.error(e); toast('Capture failed: ' + e.message, 'err'); }
    finally { busy = false; }
  }
  function thumbOf(src) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const W = 320, H = Math.round(sh * W / sw) || 180, c = document.createElement('canvas');
    c.width = W; c.height = H; c.getContext('2d').drawImage(src, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.62);
  }

  /* ── Map ── */
  function initMap() {
    if (S.map) return;
    S.map = L.map('map', { zoomControl: true, attributionControl: true, maxBounds: [[CAMPUS.s - 0.02, CAMPUS.w - 0.02], [CAMPUS.n + 0.02, CAMPUS.e + 0.02]] })
      .fitBounds([[CAMPUS.s, CAMPUS.w], [CAMPUS.n, CAMPUS.e]]);
    S.tile = L.tileLayer(OSM, { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(S.map);
    L.rectangle([[CAMPUS.s, CAMPUS.w], [CAMPUS.n, CAMPUS.e]], { color: '#7a6338', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(S.map);
    S.layers.fp = L.layerGroup().addTo(S.map);
    S.layers.caps = L.layerGroup().addTo(S.map);
    S.layers.trees = L.layerGroup().addTo(S.map);
    S.map.on('move zoom', updCone);
    S.map.on('zoomend', () => labelZoom());
    S.map.on('popupopen', e => { const b = e.popup.getElement().querySelector('[data-open]'); if (b) b.addEventListener('click', () => { S.map.closePopup(); setTree(b.dataset.open); openTree(treeBy(b.dataset.open)); }); });
  }
  $('b-sat').addEventListener('click', () => {
    S.sat = !S.sat; S.map.removeLayer(S.tile);
    S.tile = L.tileLayer(S.sat ? SAT : OSM, { maxZoom: 20, maxNativeZoom: S.sat ? 18 : 19, attribution: S.sat ? 'Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap contributors' }).addTo(S.map);
    $('b-sat').setAttribute('aria-pressed', String(S.sat));
  });
  $('b-centre').addEventListener('click', () => { if (S.fix) S.map.setView([S.fix.lat, S.fix.lon], 18); else toast('Waiting for GPS…', 'err'); });
  $('b-campus').addEventListener('click', () => S.map.fitBounds([[CAMPUS.s, CAMPUS.w], [CAMPUS.n, CAMPUS.e]]));
  function updCone() {
    const g = S.fix; if (!S.map || !g) return;
    if (!S.me) S.me = L.circleMarker([g.lat, g.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#3b7fb0', fillOpacity: 1, interactive: false }).addTo(S.map);
    else S.me.setLatLng([g.lat, g.lon]);
    if (!S.mapCentred) { if (inCampus(g.lat, g.lon)) S.map.setView([g.lat, g.lon], 18); S.mapCentred = true; }
    const col = disturbed() ? '#b8432f' : C.signal === 'OK' ? '#4d7633' : C.signal === 'STALE' ? '#c48a1b' : '#b8432f';
    if (heading() === null) { ['cone', 'ray', 'aim', 'live'].forEach(k => { if (S.layers[k]) { S.map.removeLayer(S.layers[k]); S.layers[k] = null; } }); return; }
    const h = S.dispAz;
    const mpp = 156543.03392 * Math.cos(g.lat * F.D2R) / Math.pow(2, S.map.getZoom());
    const len = Math.max(CONE_PX * mpp, 3), dest = (m, b) => F.geoDest(g.lat, g.lon, m, b);
    const cone = [[g.lat, g.lon]]; for (let i = 0; i <= 10; i++) cone.push(dest(len, h - HFOV / 2 + HFOV * i / 10));
    const set = (k, make, ll, style) => { if (!S.layers[k]) S.layers[k] = make().addTo(S.map); else { S.layers[k].setLatLngs ? S.layers[k].setLatLngs(ll) : S.layers[k].setLatLng(ll); S.layers[k].setStyle(style); } };
    set('cone', () => L.polygon(cone, { color: col, weight: 1, fillColor: col, fillOpacity: .2, interactive: false }), cone, { color: col, fillColor: col });
    const ray = [[g.lat, g.lon], dest(len * 1.15, h)];
    set('ray', () => L.polyline(ray, { color: col, weight: 2, interactive: false }), ray, { color: col });
    const a = aim(h);
    if (a) set('aim', () => L.circleMarker([a.lat, a.lon], { radius: 5, color: '#fff', weight: 2, fillColor: col, fillOpacity: .9, interactive: false }), [a.lat, a.lon], { fillColor: col });
    else if (S.layers.aim) { S.map.removeLayer(S.layers.aim); S.layers.aim = null; }
    const f = fp(), r = f ? F.footprintRing(g.lat, g.lon, h, f) : null;
    if (r) { const ll = r.map(p => [p[1], p[0]]); set('live', () => L.polygon(ll, { color: '#fff', weight: 1.2, dashArray: '3 3', fillColor: col, fillOpacity: .22, interactive: false }), ll, { fillColor: col }); }
    else if (S.layers.live) { S.map.removeLayer(S.layers.live); S.layers.live = null; }
  }
  const treeIcon = (col, cur) => L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<svg width="18" height="18" viewBox="0 0 18 18"><rect x="3.5" y="3.5" width="11" height="11" transform="rotate(45 9 9)" fill="${col}" stroke="${cur ? '#1f2a22' : '#fff'}" stroke-width="${cur ? 2.4 : 1.8}"/></svg>` });
  const LEAF_COL = { flush: '#6faa3f', not_flush: '#3f5f31', mixed: '#b08a3a', leafless: '#a5432a' };
  function drawCaps() {
    if (!S.map) return;
    S.layers.fp.clearLayers(); S.layers.caps.clearLayers(); S.layers.trees.clearLayers();
    const locOf = {}; trees().forEach(t => { locOf[t.uid] = bestLoc(t); });
    [...S.caps].reverse().forEach(c => {
      const col = ['whole', 'tag', 'canopy', 'leaves', 'flower'].includes(c.cls) ? clsOf(c.cls).col : '#99aaaa';
      const tl = locOf[c.treeId];
      if (c.cls === 'whole' && c.heading !== null) {
        // the line each whole-tree photo contributes: to the tree if fixed, else 40 m along the heading
        const end = tl ? [tl.lat, tl.lon] : F.geoDest(c.lat, c.lon, 40, c.heading);
        S.layers.fp.addLayer(L.polyline([[c.lat, c.lon], end], { color: col, weight: 1.4, dashArray: c.trust === 'DISTURBED' ? '1 4' : '5 4', opacity: .9, interactive: false }));
      } else if (c.aim && c.aim.dist > 0.5) {
        S.layers.caps.addLayer(L.polyline([[c.lat, c.lon], [c.aim.lat, c.aim.lon]], { color: col, weight: 1.2, dashArray: '2 3', interactive: false }));
      }
      S.layers.caps.addLayer(L.circleMarker([c.lat, c.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: .95 })
        .bindPopup(() => `<b>${esc(c.treeTag)}</b> · ${esc(clsOf(c.cls).label)}<br>${esc(new Date(c.timestamp).toLocaleString())}<br>HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}°${c.trust === 'DISTURBED' ? ' · compass disturbed' : ''}`));
    });
    trees().forEach(t => {
      const l = locOf[t.uid]; if (!l) return;
      const v = lastVisit(t), col = (v && LEAF_COL[v.leaf]) || '#4d7633';
      if (l.unc > 3) S.layers.trees.addLayer(L.circle([l.lat, l.lon], { radius: l.unc, color: col, weight: 1, fillOpacity: .07, interactive: false }));
      S.layers.trees.addLayer(L.marker([l.lat, l.lon], { icon: treeIcon(col, t.uid === S.tree), zIndexOffset: 500 })
        .bindTooltip(esc(treeName(t)), { permanent: true, direction: 'right', offset: [8, 0], className: 'tree-lbl' })
        .bindPopup(() => `<b>${esc(treeName(t))}</b>${t.paint && t.tag ? ' · painted ' + esc(t.paint) : ''}<br>${esc(LOC_NAME[l.method])} · ± ${fmtM(l.unc)}<br>${photosOf(t).length} photos · ${(t.visits || []).length} visit${(t.visits || []).length === 1 ? '' : 's'}${v ? ' · last ' + esc(v.date) + (v.leaf ? ' (' + esc(LEAF[v.leaf]) + ')' : '') : ''}<br><button type="button" class="ghost" style="margin-top:6px;padding:6px 10px" data-open="${esc(t.uid)}">Open tree</button>`));
    });
    labelZoom();
  }
  function labelZoom() {
    if (!S.map) return;
    const show = S.map.getZoom() >= 17;
    S.layers.trees.eachLayer(l => { if (l.getTooltip && l.getTooltip()) { if (show) l.openTooltip(); else l.closeTooltip(); } });
  }

  /* ── Tabs ── */
  let activeTab = 'cam';
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + activeTab));
    if (activeTab === 'cam') camDog.reset();
    if (activeTab === 'map' && S.map) setTimeout(() => { S.map.invalidateSize(); updCone(); labelZoom(); }, 50);
    if (activeTab === 'data') { updData(); updStore(); }
  }));

  /* ── Trees tab ── */
  function renderAll() { renderTreebar(); updLast(); renderTrees(); renderList(); drawCaps(); }
  function renderTrees() {
    const T = trees(), vToday = T.filter(t => (t.visits || []).some(v => v.date === today())).length;
    $('h-count').textContent = `${T.length} tree${T.length === 1 ? '' : 's'} · ${S.caps.length} photo${S.caps.length === 1 ? '' : 's'}`;
    $('sum').innerHTML = `<div><b>${T.length}</b><small>trees</small></div><div><b>${S.caps.length}</b><small>photos</small></div><div><b>${vToday}</b><small>visited today</small></div>`;
    if (!T.length) { $('tree-list').innerHTML = '<p class="empty">No trees yet. On the Camera tab, tap the bar above the buttons to start one.</p>'; return; }
    const list = T.slice().sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    $('tree-list').innerHTML = list.map(t => {
      const ph = photosOf(t), th = (ph.find(c => c.cls === 'whole') || ph[0] || {}).thumb, l = bestLoc(t), v = lastVisit(t);
      return `<button type="button" class="spec" data-uid="${esc(t.uid)}">
        ${th ? `<img src="${th}" alt="" />` : '<span class="noimg">❦</span>'}
        <span><h6>${esc(treeName(t))}${t.paint && t.tag ? `<small>painted ${esc(t.paint)}</small>` : ''}</h6>
          <p>${l ? `${esc(LOC_NAME[l.method])} · ± ${fmtM(l.unc)}` : '<span class="stamp miss">no position</span>'} · ${ph.length} photo${ph.length === 1 ? '' : 's'}</p>
          <p>${v ? `${v.leaf ? `<span class="stamp ${esc(v.leaf)}">${esc(LEAF[v.leaf])}</span> ` : ''}${esc(v.date)}${v.sample === 'yes' ? ' · sample ' + esc(v.sampleLabel || 'taken') : ''}` : 'no visit recorded'}</p></span>
        <span class="go" aria-hidden="true">›</span></button>`;
    }).join('');
    $('tree-list').querySelectorAll('.spec').forEach(b => b.addEventListener('click', () => { setTree(b.dataset.uid); openTree(treeBy(b.dataset.uid)); }));
  }
  let listAll = false;
  function renderList() {
    if (!S.caps.length) { $('cap-list').innerHTML = '<p class="empty">No photos yet.</p>'; return; }
    const show = listAll ? S.caps : S.caps.slice(0, 20);
    $('cap-list').innerHTML = show.map(c => `
      <div class="cap">
        <img src="${c.thumb || ''}" alt="" />
        <div class="meta">
          <span class="pill" style="--c:${clsOf(c.cls).col}">${esc(clsOf(c.cls).label)}</span> <b>${esc(c.treeTag)}</b> · ${esc(new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}<br>
          <span class="mono">HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}° · ± ${(c.accuracy || 0).toFixed(0)} m</span>${c.trust === 'DISTURBED' ? ' · <span class="stamp miss">compass disturbed</span>' : ''}
        </div>
        <div class="acts"><button type="button" data-del="${esc(c.id)}">Delete</button></div>
      </div>`).join('') + (S.caps.length > show.length ? `<button type="button" class="more" id="b-more">Show all ${S.caps.length}</button>` : '');
    const more = $('b-more'); if (more) more.addEventListener('click', () => { listAll = true; renderList(); });
    $('cap-list').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this photo and its record?')) return;
      S.caps = S.caps.filter(x => x.id !== b.dataset.del);
      await store.delCap(b.dataset.del); await saveSession(); renderAll();
    }));
  }
  function updData() {
    const g = S.fix, h = heading(), a = aim(), v = $('video'), tr = camTrack();
    const rows = [
      ['Position', g ? `${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}${inCampus(g.lat, g.lon) ? '' : ' (outside campus box)'}` : null],
      ['Accuracy', g ? `± ${g.acc.toFixed(1)} m (${g.samples}/${gps.max} fixes, worst dropped)` : null],
      ['Heading', h === null ? null : `${Math.round(h)}° ${azLbl(h)} [${C.src}]`],
      ['Compass trust', trust.mismatch === null ? 'unknown — needs the gyroscope and some movement' : `${trust.status} · compass ${trust.compassDelta.toFixed(1)}° vs gyroscope ${trust.gyroDelta.toFixed(1)}° in 2 s`],
      ['Sensors', `${C.platform} · permission ${C.perm} · abs ${C.absCount} · ori ${C.oriCount} · resyncs ${C.resyncs}`],
      ['Tilt', tilt() === null ? null : `${tilt()}° from straight down`],
      ['Camera height', S.camH.toFixed(2) + ' m above ground'],
      ['Camera', tr ? `${v.videoWidth}×${v.videoHeight} · ${tr.readyState} · restarts ${S.camRestarts}` : null],
      ['Crosshair', a ? `${fmtM(a.dist)} ahead, ± ${fmtM(a.unc)}` : null]
    ];
    $('kv').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd class="${val ? '' : 'na'}">${val ? esc(val) : '—'}</dd>`).join('');
  }
  async function updStore() {
    let t = store.mem ? 'In memory only — export before closing.' : `${trees().length} trees and ${S.caps.length} photos on this phone`;
    const u = await store.usage(); if (u !== null && !store.mem) t += ` · ${(u / 1048576).toFixed(1)} MB`;
    if (store.persisted === false) t += ' · storage not marked persistent';
    $('store-info').textContent = t;
  }
  $('camh-set').addEventListener('click', () => {
    const v = parseFloat($('camh-edit').value);
    if (!isFinite(v) || v < 0.2 || v > 60) { toast('Camera height must be 0.2–60 m', 'err'); return; }
    S.camH = v; saveSession(); toast('Camera height ' + v.toFixed(2) + ' m — applies to new photos', 'ok');
  });

  /* ── Export ── */
  function props(c) {
    return {
      id: c.id, imgName: c.imgName, timestamp: c.timestamp, visit_date: c.visitDate, collector: c.collector || null,
      tree_uid: c.treeId, tree_tag: (treeBy(c.treeId) ? treeName(treeBy(c.treeId)) : c.treeTag), class: c.cls, role: c.role,
      heading_deg: c.heading, heading_source: c.headingSrc, heading_signal: c.signal, heading_trust: (c.trust || 'UNKNOWN').toLowerCase(), trust_mismatch_deg: c.trustMismatch ?? null,
      sensor_platform: c.platform, tilt_deg_from_nadir: c.tilt, camera_height_m: c.camH, hfov_deg: c.hfov,
      gps_accuracy_m: c.accuracy, gps_samples: c.gpsSamples, altitude_m: c.altitude, in_campus: c.inCampus,
      aim_lat: c.aim ? +c.aim.lat.toFixed(8) : null, aim_lon: c.aim ? +c.aim.lon.toFixed(8) : null,
      aim_dist_m: c.aim ? +c.aim.dist.toFixed(2) : null, aim_uncertainty_m: c.aim ? +c.aim.unc.toFixed(2) : null,
      footprint_width_m: c.fp ? +c.fp.w.toFixed(2) : null, footprint_depth_m: c.fp ? +c.fp.d.toFixed(2) : null,
      travel_bearing_deg: c.travelBrg, look_side: c.lookSide
    };
  }
  const chrono = () => [...S.caps].reverse();
  const meta = extra => Object.assign({ app: APP.name, version: APP.version, project: S.proj.name, collector: S.proj.collector, notes: S.proj.notes, session_started: S.proj.started, exported: new Date().toISOString(), trees: trees().length, photos: S.caps.length }, extra || {});
  const r6 = v => v == null ? null : +(+v).toFixed(7);
  function treeProps(t) {
    const l = bestLoc(t), L = t.locs || {}, b = bearingFix(t), v = lastVisit(t), ph = photosOf(t);
    return {
      tree_uid: t.uid, tag: t.tag || null, painted_no: t.paint || null, qr_payload: t.qr || null, name: treeName(t),
      location_method: l ? l.method : null, location_uncertainty_m: l ? l.unc : null, in_campus: l ? inCampus(l.lat, l.lon) : null,
      trunk_lat: L.trunk ? r6(L.trunk.lat) : null, trunk_lon: L.trunk ? r6(L.trunk.lon) : null, trunk_unc_m: L.trunk ? L.trunk.unc : null, trunk_fixes: L.trunk ? L.trunk.n : null,
      aim_lat: L.aim ? r6(L.aim.lat) : null, aim_lon: L.aim ? r6(L.aim.lon) : null, aim_unc_m: L.aim ? L.aim.unc : null, aim_dist_m: L.aim ? L.aim.dist : null,
      bearing_lat: b ? r6(b.lat) : null, bearing_lon: b ? r6(b.lon) : null, bearing_unc_m: b ? +b.unc.toFixed(1) : null, bearing_photos: b ? b.n : bearingLines(t).length, bearing_spread_deg: b ? b.spread : null,
      stems: t.stems || null, girth_cm: t.gbh ?? null, height_m: t.ht ?? null,
      photos: ph.length, visits: (t.visits || []).length, last_visit: v ? v.date : null, last_leaf: v ? v.leaf : null, last_flowers: v ? v.flowers : null, last_pods: v ? v.pods : null,
      created: t.created, updated: t.updated || null
    };
  }
  function treesGJ() {
    return { type: 'FeatureCollection', metadata: meta({ description: 'One point per tree at its chosen position (location_method). Trees without a position have geometry null. All three position estimates are in the properties.' }),
      features: trees().map(t => { const l = bestLoc(t); return { type: 'Feature', geometry: l ? { type: 'Point', coordinates: [r6(l.lon), r6(l.lat)] } : null, properties: treeProps(t) }; }) };
  }
  const TREE_COLS = ['tree_uid', 'tag', 'painted_no', 'name', 'location_method', 'location_uncertainty_m', 'in_campus', 'lat', 'lon', 'trunk_lat', 'trunk_lon', 'trunk_unc_m', 'trunk_fixes', 'aim_lat', 'aim_lon', 'aim_unc_m', 'aim_dist_m', 'bearing_lat', 'bearing_lon', 'bearing_unc_m', 'bearing_photos', 'bearing_spread_deg', 'stems', 'girth_cm', 'height_m', 'photos', 'visits', 'last_visit', 'last_leaf', 'last_flowers', 'last_pods', 'qr_payload', 'created', 'updated'];
  function treesCsv() {
    return [TREE_COLS.join(','), ...trees().map(t => { const p = treeProps(t), l = bestLoc(t); p.lat = l ? r6(l.lat) : null; p.lon = l ? r6(l.lon) : null; return TREE_COLS.map(k => F.csvCell(p[k])).join(','); })].join('\n');
  }
  const VISIT_COLS = ['tree_uid', 'tree', 'date', 'leaf_state', 'flowers', 'pods', 'leaf_sample', 'sample_label', 'note', 'collector', 'photos_that_day', 'saved'];
  function visitsCsv() {
    const out = [VISIT_COLS.join(',')];
    trees().forEach(t => (t.visits || []).slice().sort((a, b) => a.date.localeCompare(b.date)).forEach(v => {
      const p = { tree_uid: t.uid, tree: treeName(t), date: v.date, leaf_state: v.leaf, flowers: v.flowers, pods: v.pods, leaf_sample: v.sample, sample_label: v.sampleLabel, note: v.note, collector: v.collector, photos_that_day: photosOf(t).filter(c => c.visitDate === v.date).length, saved: v.saved };
      out.push(VISIT_COLS.map(k => F.csvCell(p[k])).join(','));
    }));
    return out.join('\n');
  }
  function pointsGJ() {
    return { type: 'FeatureCollection', metadata: meta(), features: chrono().map(c => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: props(c),
      ...(c.ring ? { fov_polygon: { type: 'Polygon', coordinates: [c.ring] } } : {}) })) };   // fov_polygon: CropView-compatible
  }
  function directionsGJ() {
    const fs = chrono().filter(c => c.heading !== null).map(c => {
      const tl = treeBy(c.treeId) ? bestLoc(treeBy(c.treeId)) : null;
      const d = c.aim ? c.aim.dist : tl ? F.geoDist(c.lat, c.lon, tl.lat, tl.lon) : 25;
      const e = F.geoDest(c.lat, c.lon, Math.max(2, Math.min(d, 80)), c.heading);
      return { type: 'Feature', geometry: { type: 'LineString', coordinates: [[c.lon, c.lat], [e[1], e[0]]] }, properties: Object.assign(props(c), { line_length_m: +Math.max(2, Math.min(d, 80)).toFixed(1), used_for_tree_position: c.cls === 'whole' && c.signal === 'OK' && c.trust !== 'DISTURBED' && c.accuracy <= 20 }) };
    });
    return { type: 'FeatureCollection', metadata: meta({ description: 'Look direction of every photo, as a line from where it was taken. Whole-tree lines are the ones crossed for the photo-direction position.' }), features: fs };
  }
  const COLS = ['id', 'imgName', 'timestamp', 'visit_date', 'tree_tag', 'tree_uid', 'class', 'role', 'lat', 'lon', 'gps_accuracy_m', 'in_campus', 'heading_deg', 'heading_source', 'heading_trust', 'tilt_deg_from_nadir', 'camera_height_m', 'aim_lat', 'aim_lon', 'aim_dist_m', 'aim_uncertainty_m', 'altitude_m', 'collector'];
  function csv() {
    return [COLS.join(','), ...chrono().map(c => { const p = props(c); p.lat = c.lat; p.lon = c.lon; return COLS.map(k => F.csvCell(p[k])).join(','); })].join('\n');
  }
  function readme() {
    return [
      `${APP.name} export · ${S.proj.name}${S.proj.collector ? ' · collector ' + S.proj.collector : ''}`, '',
      'images/  photos named {Book}_{Tree}_{class}_{UTC time}_{lat}_{lon}.jpg',
      'data/    *_trees.geojson / *_trees.csv     one record per tree, at its chosen position',
      '         *_visits.csv                     one row per tree per visit day: leaf state, flowers, pods, sample',
      '         *_photos_points.geojson          one point per photo (where it was taken), with fov_polygon',
      '         *_photos.csv                     the photo records as a table',
      '         *_photo_directions.geojson       each photo’s look direction as a line', '',
      'Tree position — three independent estimates, all kept:',
      '  trunk     GPS averaged for ~15 s standing at the trunk (weighted 1/acc²; ± is conservative, fixes are correlated)',
      '  aim       crosshair on the trunk base from open ground: camera_height · tan(tilt) along the heading',
      '  bearing   least-squares crossing of whole-tree photo directions (≥ 2 photos, ≥ 25° apart, compass not disturbed)',
      '  location_method is the one picked on the tree card, otherwise the one with the smallest ±.', '',
      'leaf_state           flush (new soft lime leaves) | not_flush | mixed | leafless',
      'heading_deg          camera look direction, clockwise from true north (null = no compass fix)',
      'heading_trust        clean | disturbed | unknown — compass turn vs gyroscope turn over 2 s;',
      '                     disturbed means something magnetic nearby; those directions are not used for positions.',
      '                     A constant offset cannot be detected this way: check a few against imagery.',
      'tilt_deg_from_nadir  0 = straight down, 90 = horizon',
      'camera_height_m      height of the camera above the ground (not GPS altitude)',
      'in_campus            inside a generous box around IIT Bombay (19.1170–19.1445 N, 72.8995–72.9255 E)', '',
      `${APP.name} ${APP.version} · Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License`
    ].join('\n');
  }
  async function buildZip() {
    const pn = S.proj.name;
    return FS.buildZip({
      store, caps: chrono(), imgNameOf: c => c.imgName,
      zipName: `${pn}_Shevga_${new Date().toISOString().split('T')[0]}.zip`,
      files: [
        { path: `data/${pn}_trees.geojson`, content: JSON.stringify(treesGJ(), null, 2) },
        { path: `data/${pn}_trees.csv`, content: treesCsv() },
        { path: `data/${pn}_visits.csv`, content: visitsCsv() },
        { path: `data/${pn}_photos_points.geojson`, content: JSON.stringify(pointsGJ(), null, 2) },
        { path: `data/${pn}_photos.csv`, content: csv() },
        { path: `data/${pn}_photo_directions.geojson`, content: JSON.stringify(directionsGJ(), null, 2) },
        { path: 'README.txt', content: readme() }
      ]
    });
  }
  $('b-zip').addEventListener('click', async () => {
    if (!S.caps.length && !trees().length) { toast('Nothing to export yet', 'err'); return; }
    toast('Building ZIP…');
    try { const z = await buildZip(); FS.download(z.blob, z.name); toast(z.missing ? z.missing + ' photo(s) missing on this phone — exported without them' : 'ZIP exported ✓', z.missing ? 'err' : 'ok'); }
    catch (e) { toast('Export failed: ' + e.message, 'err'); }
  });
  $('b-csv').addEventListener('click', () => {
    if (!trees().length) { toast('Nothing to export yet', 'err'); return; }
    FS.download(treesCsv(), `${S.proj.name}_trees_${today()}.csv`, 'text/csv');
    setTimeout(() => FS.download(visitsCsv(), `${S.proj.name}_visits_${today()}.csv`, 'text/csv'), 400);
  });
  const sharer = FS.createSharer({
    build: buildZip,
    keyOf: () => S.proj.name + '|' + S.caps.map(c => c.id).join(',') + '|' + trees().map(t => t.uid + t.updated).join(','),
    onLabel: ready => { $('b-share').textContent = ready ? 'Tap to share' : 'Share ZIP'; },
    onToast: toast
  });
  if (sharer.canShareFiles()) $('b-share').hidden = false;
  $('b-share').addEventListener('click', () => {
    if (!S.caps.length && !trees().length) { toast('Nothing to export yet', 'err'); return; }
    sharer.share().catch(e => toast('Share failed: ' + e.message, 'err'));
  });

  /* ── Guide + tutorial: illustrated plates, then a spotlight over the real controls ── */
  $('b-help').addEventListener('click', () => { $('guide').hidden = false; });
  $('b-tour').addEventListener('click', () => { $('guide').hidden = true; goTab('cam'); tour.start(); });
  const ART = {
    tag: `<svg class="art" viewBox="0 0 300 130"><g fill="none" stroke="#1f2a22" stroke-width="1.3" stroke-linecap="round">
      <path d="M96 0c-6 40 4 84-4 130M196 0c6 44-6 86 2 130"/><path d="M110 22c4 3 4 9 0 12M168 70c-5 2-6 8-2 11M120 104c3 2 7 2 9 0" stroke-width=".9"/></g>
      <rect x="118" y="14" width="56" height="44" rx="2" fill="#1f2a22"/><text x="146" y="47" text-anchor="middle" font-family="Fraunces,serif" font-size="26" fill="#f2ecdf">25</text>
      <path d="M92 70c30 4 80 4 112-2" fill="none" stroke="#85897a" stroke-width="1"/>
      <g transform="rotate(-14 160 92)"><rect x="128" y="66" width="70" height="52" rx="2" fill="#faf6ec" stroke="#1f2a22" stroke-width="1.2"/>
      <rect x="134" y="72" width="26" height="26" fill="none" stroke="#1f2a22"/><rect x="137" y="75" width="7" height="7" fill="#1f2a22"/><rect x="150" y="75" width="7" height="7" fill="#1f2a22"/><rect x="137" y="88" width="7" height="7" fill="#1f2a22"/><rect x="149" y="87" width="4" height="4" fill="#1f2a22"/>
      <text x="164" y="84" font-family="IBM Plex Mono,monospace" font-size="8.5" fill="#1f2a22">#L1048</text><rect x="164" y="88" width="28" height="7" fill="#355724"/><text x="166" y="94" font-family="IBM Plex Sans,sans-serif" font-size="5.5" fill="#fff">Shevga</text></g>
      <text x="216" y="40" font-family="Fraunces,serif" font-size="12" fill="#56604f" font-style="italic">painted no.</text><path d="M214 37l-36 0" stroke="#56604f" stroke-width=".8"/>
      <text x="216" y="104" font-family="Fraunces,serif" font-size="12" fill="#56604f" font-style="italic">tag + QR</text><path d="M214 100l-12 0" stroke="#56604f" stroke-width=".8"/></svg>`,
    locate: `<svg class="art" viewBox="0 0 300 130"><g font-family="Fraunces,serif" font-size="12" fill="#56604f">
      <circle cx="150" cy="52" r="30" fill="#a9c48a" fill-opacity=".55" stroke="#1f2a22" stroke-width="1.1"/><circle cx="150" cy="52" r="3.5" fill="#1f2a22"/>
      <g stroke="#1f2a22" stroke-width="1.2" fill="none"><circle cx="150" cy="96" r="4"/><path d="M150 100v12M144 106h12"/></g><text x="161" y="112" font-style="italic">i · at the trunk</text>
      <g stroke="#1f2a22" stroke-width="1.2" fill="none"><circle cx="40" cy="74" r="4"/><path d="M40 78v12M34 84h12"/></g>
      <path d="M46 76L146 54" stroke="#a5432a" stroke-width="1.2" stroke-dasharray="4 3" fill="none"/><text x="18" y="110" font-style="italic">ii · crosshair</text>
      <g stroke="#355724" stroke-width="1.2" fill="none"><path d="M252 18L156 50M262 96L156 56" stroke-dasharray="6 4"/><rect x="250" y="10" width="12" height="9" rx="1.5"/><rect x="260" y="92" width="12" height="9" rx="1.5"/></g>
      <text x="218" y="124" font-style="italic">iii · directions</text></g></svg>`,
    round: `<svg class="art" viewBox="0 0 300 130"><g font-family="IBM Plex Mono,monospace" font-size="9" fill="#56604f">
      <circle cx="150" cy="62" r="34" fill="#a9c48a" fill-opacity=".5" stroke="#1f2a22" stroke-width="1.1"/><path d="M150 62v40" stroke="#1f2a22" stroke-width="2.2"/>
      <circle cx="150" cy="62" r="56" fill="none" stroke="#cdc2aa" stroke-dasharray="2 4"/>
      <g fill="#1f2a22"><circle cx="94" cy="62" r="3"/><circle cx="206" cy="62" r="3"/><circle cx="150" cy="118" r="3"/></g>
      <path d="M100 62h26M200 62h-26M150 112v-8" stroke="#1f2a22" stroke-width="1" marker-end="url(#ah)"/>
      <defs><marker id="ah" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L6 3L0 6z" fill="#1f2a22"/></marker></defs>
      <text x="40" y="58">whole tree</text><text x="216" y="58">from another</text><text x="216" y="70">side, 30°+ round</text>
      <text x="8" y="16">1 whole · 2 tag · 3 trunk</text><text x="8" y="28">4 canopy · 5 leaves · 6 flowers</text></g></svg>`
  };
  const tour = (function () {
    const STEPS = [
      { el: null, art: () => (document.querySelector('.sprig') || {}).outerHTML || '', h: 'Namaste, Priyanka', p: 'A field notebook for the Shevga trees on campus. Nine short pages — about a minute.' },
      { el: null, art: () => ART.tag, h: 'Start with the tag', p: 'Most campus trees carry an IIT Bombay inventory tag (#L…) and a painted number. Scan the QR or type the number — that is the tree’s name in the book.' },
      { el: null, art: () => ART.locate, h: 'Fix where it stands', p: 'Three ways, use any: (i) stand at the trunk and lock GPS, (ii) from open ground put the crosshair on the trunk base, (iii) take whole-tree photos from two sides — their directions cross at the tree.' },
      { el: null, art: () => ART.round, h: 'Same photos every visit', p: 'Whole tree from 8–15 m, then tag, trunk, canopy looking up, leaves, flowers or pods. The same order each time makes the visits comparable.' },
      { el: '#treebar', h: 'The current tree', p: 'Every photo goes to the tree named here. Tap it to switch — the nearest trees come first — or to start a new one.' },
      { el: '#types', h: 'What is in the frame', p: 'Pick before you shoot; it stays lit until you pick another.' },
      { el: '#shutter', h: 'Shutter', p: 'Position, look direction and tilt are saved with every photo.' },
      { el: '#b-tree', h: 'Tree details', p: 'Tag, position, girth, and today’s visit: leaves flush or not, flowers, pods, the sample bag. Save when done.' },
      { el: '#compass', h: 'If the direction looks wrong', p: 'Tap the compass and draw a slow figure-8. If the badge says DISTURBED, step away from cars, poles and railings.' },
      { el: '.tabs', h: 'Map and Trees', p: 'Map shows every tree and photo direction. Trees lists the book and exports a ZIP — do it before you leave the field.' }
    ];
    let i = 0;
    function place() {
      const s = STEPS[i], hole = $('tour-hole'), card = $('tour-card');
      $('tour-step').textContent = `${String(i + 1).padStart(2, '0')} / ${String(STEPS.length).padStart(2, '0')}`;
      $('tour-h').textContent = s.h; $('tour-p').textContent = s.p;
      $('tour-art').innerHTML = s.art ? s.art() : '';
      const sv = $('tour-art').querySelector('svg.sprig'); if (sv) sv.setAttribute('style', 'height:130px;width:auto;margin:-4px auto 6px');
      $('tour-next').textContent = i === STEPS.length - 1 ? 'Begin' : 'Next';
      const el = s.el && document.querySelector(s.el);
      const ch = card.offsetHeight || 260, vh = window.innerHeight;
      if (!el) { hole.className = 'none'; card.style.top = Math.max(16, (vh - ch) / 2) + 'px'; return; }
      const r = el.getBoundingClientRect(), pad = 5;
      hole.className = '';
      Object.assign(hole.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
        borderRadius: el.id === 'shutter' || el.id === 'compass' ? '50%' : '12px' });
      card.style.top = (r.top > vh / 2 ? Math.max(12, r.top - ch - 18) : Math.min(vh - ch - 12, r.bottom + 18)) + 'px';
    }
    function start() { i = 0; $('tour').hidden = false; place(); requestAnimationFrame(place); }
    function end() { $('tour').hidden = true; pref('toured', '1'); }
    $('tour-next').addEventListener('click', () => { if (++i >= STEPS.length) end(); else { place(); requestAnimationFrame(place); } });
    $('tour-skip').addEventListener('click', end);
    window.addEventListener('resize', () => { if (!$('tour').hidden) place(); });
    return { start, end, get step() { return i; } };
  })();

  /* ── Small things ── */
  let tt;
  function toast(m, cls) {
    const e = $('toast'); e.textContent = m;
    // keep clear of what she is using: above the dock on the camera, at the top over an open card
    const top = sheetOpen() && !$('tsheet').hidden;
    e.style.top = top ? 'calc(14px + env(safe-area-inset-top))' : '';
    e.style.bottom = top ? 'auto' : (S.proj && activeTab === 'cam' && $('dock').offsetHeight ? ($('dock').offsetHeight + 10) + 'px' : '');
    e.className = 'show' + (cls ? ' ' + cls : '') + (S.proj && activeTab !== 'cam' && !top ? ' low' : '');
    clearTimeout(tt); tt = setTimeout(() => { e.className = ''; }, 3400);
  }
  (function () { try { const m = navigator.deviceMemory; if (m && m <= 2) document.documentElement.classList.add('g-lite'); } catch (e) {} })();
  (function () {
    const el = $('offline-state');
    if (!('serviceWorker' in navigator)) { el.textContent = 'Offline mode not supported in this browser'; return; }
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (!S.proj) location.reload();
      else toast('App updated — close and reopen it when you have a moment', 'ok');
    });
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { el.textContent = '✓ Ready to work offline'; el.className = 'fine ok'; })
      .catch(() => { el.textContent = 'Offline mode unavailable (needs https or localhost)'; });
  })();

  // for tests and debugging in the console
  window.__field = { S, C, compass, store, capture, buildZip, csv, treesCsv, visitsCsv, treesGJ, pointsGJ, directionsGJ, bearingFix, bestLoc, tagFromQR, normTag, openTree, setTree, tour, APP, get trust() { return trust; }, get draft() { return draft; } };
})();
