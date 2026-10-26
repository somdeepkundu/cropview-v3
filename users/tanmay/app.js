/* Powai Lake Survey — capture app built on sensor-core.js and field-store.js.
 * Photos and videos; every video logs position, heading, tilt and footprint once a second.
 * Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License */
(function () {
  'use strict';
  const APP = { name: 'Powai Lake Survey', version: '1.1.0', db: 'powai-lake-survey', idPrefix: 'PL' };
  // One type per spot. Keys go into the export, so keep them stable.
  const CLASSES = [
    { k: 'viewpoint', label: 'Viewpoint', col: '#4fb3d9' },
    { k: 'promenade', label: 'Promenade', col: '#8fcf72' },
    { k: 'wildlife', label: 'Birds & wildlife', col: '#e9b949' },
    { k: 'golden_hour', label: 'Golden hour', col: '#d9774b' },
    { k: 'people_life', label: 'People & life', col: '#c58be0' },
    { k: 'landmark', label: 'Landmark', col: '#e8e2d0' },
    { k: 'hazard', label: 'Hazard / restricted', col: '#e5534b' }
  ];
  const GPS_LOCK = 12;          // ± m shown as "locked"
  const GPS_BLOCK = 30;         // ± m above which a capture is refused
  const AIM_MIN = 40, AIM_MAX = 80, TILT_MAX = 85, HFOV = 65, CONE_PX = 90;
  const REC_MAX_S = 600;        // a clip stops itself at 10 min (≈ 300–400 MB)
  const PART_MS = 3000;         // video is written to the phone every 3 s while recording
  const FREEZE_MS = 4000;       // no new camera frame for this long → restart the camera
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  const F = window.FieldSensors, FS = window.FieldStore;
  const $ = id => document.getElementById(id);
  const esc = F.esc;
  const clsOf = k => CLASSES.find(c => c.k === k) || { k, label: k, col: '#9ca69e' };
  const isClip = c => c.kind === 'clip';
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('pl-' + k); localStorage.setItem('pl-' + k, v); } catch (e) {} return null; };

  const S = {
    proj: null, camH: 1.5, fix: null, lastGPS: null, caps: [], dispAz: 0,
    map: null, tile: null, sat: false, mapCentred: false, layers: {}, stream: null, platform: 'unknown',
    cls: CLASSES.some(c => c.k === pref('cls')) ? pref('cls') : CLASSES[0].k,
    mode: pref('mode') === 'video' ? 'video' : 'photo',
    rec: null, noMic: false, camRestarts: 0, camFailAt: 0
  };
  const gps = F.createGpsSmoother(6);
  const travel = F.createTravelBearing();
  const compass = F.createCompass({
    onWarn: w => toast(w === 'denied'
      ? 'Motion sensors are blocked. Allow them in the browser’s site settings, then tap the compass.'
      : 'No compass data from this phone. Tap the compass to try again.', 'err')
  });
  const C = compass.state;
  const store = FS.openStore(APP.db);
  const wake = FS.keepAwake(() => !!S.proj);

  /* ── Start: everything that needs a user gesture happens synchronously here ── */
  $('allow').addEventListener('click', () => {
    compass.start();        // motion permission: inside the tap, before any await
    startGPS();
    show('scr-session');
    renderResume();
  });
  $('start-btn').addEventListener('click', () => startSurvey());

  function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }

  const countTxt = list => {
    const p = list.filter(c => !isClip(c)).length, v = list.length - p;
    return `${p} photo${p === 1 ? '' : 's'}` + (v ? ` · ${v} video${v === 1 ? '' : 's'}` : '');
  };
  async function renderResume() {
    await store.ready;
    const list = await store.listSessions();
    $('resume-wrap').hidden = !list.length;
    $('resume-list').innerHTML = list.slice(0, 5).map(s => `
      <button class="resume" type="button" data-name="${esc(s.name)}">
        <span><b>${esc(s.name)}</b><small>${s.count} item${s.count === 1 ? '' : 's'} · ${esc(new Date(s.updated || s.started).toLocaleDateString())} · camera ${(+s.camH || 1.5).toFixed(2)} m</small></span><span aria-hidden="true">→</span>
      </button>`).join('');
    $('resume-list').querySelectorAll('.resume').forEach(b => b.addEventListener('click', () => startSurvey(b.dataset.name)));
  }

  async function startSurvey(resumeName) {
    await store.ready;
    let p;
    if (resumeName) {
      const s = await store.getSession(resumeName);
      if (!s) { toast('Saved survey not found', 'err'); return; }
      p = { name: s.name, notes: s.notes || '', started: s.started, camH: s.camH || 1.5 };
    } else {
      const raw = $('pname').value.trim();
      if (!raw) { toast('Give the survey a name', 'err'); return; }
      const camH = parseFloat($('pcamh').value);
      if (!isFinite(camH) || camH < 0.2 || camH > 60) { toast('Camera height must be 0.2–60 m', 'err'); return; }
      const name = raw.replace(/[^a-zA-Z0-9_\-.]/g, '_');           // safe in file names
      const old = await store.getSession(name);
      p = { name, notes: $('pnotes').value.trim(), started: old ? old.started : new Date().toISOString(), camH };
      if (old) toast('Continuing saved survey ' + name, 'ok');
    }
    S.proj = p; S.camH = p.camH;
    await saveSession();
    $('scr-session').classList.remove('on');
    $('app').hidden = false;
    $('h-proj').textContent = p.name;
    $('camh-edit').value = S.camH;
    $('ver').textContent = APP.version;
    renderTypes(); setMode(S.mode); startCamera(); initMap(); wake();
    S.caps = (await store.capsFor(p.name)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    await recoverClips();
    renderList(); drawCaps();
    if (store.mem) toast('Phone storage unavailable — export a ZIP before closing', 'err');
    requestAnimationFrame(loop);
  }
  function saveSession() {
    const p = S.proj;
    return store.putSession({ name: p.name, notes: p.notes, camH: S.camH, started: p.started, updated: new Date().toISOString(), count: S.caps.length });
  }

  /* ── Sensors ── */
  function startGPS() {
    if (!navigator.geolocation) { toast('This browser has no location access', 'err'); return; }
    navigator.geolocation.watchPosition(p => {
      const g = gps.push(p.coords);
      if (g) { S.fix = g; travel.update(g); }
      S.lastGPS = Date.now();
    }, e => toast('GPS: ' + e.message, 'err'), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  $('compass').addEventListener('click', () => {
    compass.recalibrate();                      // re-asks permission inside this tap
    if (C.perm !== 'denied') toast('Recalibrating — draw a slow figure-8 with the phone', 'ok');
  });

  const heading = () => C.heading;               // null until the first valid reading
  const tilt = () => C.tilt;
  const fp = () => F.footprint({ camH: S.camH, tilt: tilt(), hfov: HFOV, tiltMax: TILT_MAX });
  const aim = h => (S.fix && heading() !== null) ? F.aimPoint(S.fix.lat, S.fix.lon, h ?? heading(), { camH: S.camH, tilt: tilt(), tiltMax: TILT_MAX }) : null;

  /* ── Camera, with a watchdog. On long sessions Android Chrome can leave the preview
       frozen (the track stays "live" but no new frames arrive), or end the track after
       the app was in the background. The ↻ button restarts it; the watchdog does the
       same by itself when frames stop for FREEZE_MS. A recording is saved first. ── */
  const camTrack = () => S.stream && S.stream.getVideoTracks()[0];
  async function startCamera() {
    try {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      S.stream = null;
      const v = $('video'); v.srcObject = null;
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      v.srcObject = S.stream;
      await v.play().catch(() => {});
      S.camFailAt = 0; watch.reset();
      return true;
    } catch (e) { S.camFailAt = Date.now(); toast('Camera: ' + e.message + ' — tap ↻ again to reload the app', 'err'); return false; }
  }
  let camBusy = false;
  async function restartCamera(auto) {
    if (camBusy) return;
    camBusy = true; $('cam-refresh').classList.add('spin');
    try {
      if (S.rec) await stopRec('camera');
      const ok = await startCamera();
      if (ok) { S.camRestarts++; toast(auto ? 'Camera had frozen — restarted' : 'Camera restarted', 'ok'); }
    } finally { camBusy = false; $('cam-refresh').classList.remove('spin'); watch.reset(); }
  }
  $('cam-refresh').addEventListener('click', () => {
    if (S.camFailAt && Date.now() - S.camFailAt < 10000) { location.reload(); return; }   // second tap after a failure
    restartCamera(false);
  });
  const watch = {
    lastT: -1, lastChange: 0, lastAuto: 0,
    reset() { this.lastT = -1; this.lastChange = performance.now(); },
    check(now) {
      if (!S.proj || activeTab !== 'cam' || document.visibilityState !== 'visible' || camBusy) return;
      const v = $('video'), tr = camTrack();
      if (v.paused && v.srcObject) v.play().catch(() => {});
      if (v.currentTime !== this.lastT) { this.lastT = v.currentTime; this.lastChange = now; }
      const dead = !tr || tr.readyState === 'ended';
      const frozen = now - this.lastChange > FREEZE_MS;
      if ((dead || frozen) && now - this.lastAuto > 15000) { this.lastAuto = now; restartCamera(true); }
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (S.rec) stopRec('hidden'); return; }
    watch.reset();
    const tr = camTrack();
    if (S.proj && (!tr || tr.readyState === 'ended')) restartCamera(true);
  });

  /* ── Render loop: decoupled from sensor events, so the rose and cone stay live
       between events and the health colour updates even when nothing fires ── */
  let lastSlow = 0;
  function loop(ts) {
    if (heading() !== null) S.dispAz = F.lerpAngle(S.dispAz, heading(), 0.2);
    $('rose').style.transform = `rotate(${-S.dispAz}deg)`;
    $('ring').setAttribute('stroke', C.signal === 'OK' ? '#3c5a3a' : C.signal === 'STALE' ? 'var(--warn)' : 'var(--bad)');
    if (ts - lastSlow > 120) {
      lastSlow = ts; updHUD(); updTilt(); updRec(); watch.check(ts);
      if (activeTab === 'map') updCone(); if (activeTab === 'data') updData();
    }
    requestAnimationFrame(loop);
  }
  const azLbl = a => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][Math.round(a / 45) % 8];
  const fmtM = m => (m < 10 ? m.toFixed(1) : Math.round(m)) + ' m';
  const fmtDur = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtMB = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
  function setChip(id, text, cls) { const e = $(id); e.textContent = text; e.className = 'chip' + (cls ? ' ' + cls : ''); }
  function updHUD() {
    const g = S.fix, h = heading();
    setChip('h-pos', g ? `LAT ${g.lat.toFixed(5)}  LON ${g.lon.toFixed(5)}` : 'LAT —  LON —', g ? '' : 'warn');
    setChip('h-acc', g ? `${g.acc <= GPS_LOCK ? '⊕ ' : ''}± ${g.acc.toFixed(1)} m${g.samples > 1 ? ' ×' + g.samples : ''}` : 'GPS…',
      !g ? 'warn' : g.acc <= GPS_LOCK ? 'ok' : g.acc <= GPS_BLOCK ? 'warn' : 'bad');
    const sc = C.signal === 'OK' ? '' : C.signal === 'STALE' ? 'warn' : 'bad';
    setChip('h-hdg', h === null ? 'HDG —' : `HDG ${Math.round(h)}° ${azLbl(h)}`, sc);
    setChip('h-src', 'SRC ' + C.src, sc);              // honest: says how far to trust the heading
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
    if (!fp()) { txt = 'SKY ✕'; cls = 'warn'; }
    else if (t >= TILT_MAX) { txt = 'HORIZON'; cls = 'warn'; }
    else if (t > AIM_MAX) { txt = 'FAR'; cls = 'warn'; }
    else if (t >= AIM_MIN) { txt = '✓ AIM'; cls = 'ok'; }
    else txt = 'DOWN';
    pin.className = cls; deg.className = cls; deg.textContent = t + '°'; lbl.textContent = txt;
  }

  /* ── Type picker + mode + shutter. The type stays picked, so each photo is still
       one tap; while filming, tapping a type marks that moment in the log. ── */
  function renderTypes() {
    $('types').innerHTML = CLASSES.map(c => `<button type="button" role="radio" class="tbtn" data-cls="${esc(c.k)}" style="--c:${c.col}" aria-checked="${c.k === S.cls}">${esc(c.label)}</button>`).join('');
    $('types').querySelectorAll('.tbtn').forEach(b => b.addEventListener('click', () => pickType(b.dataset.cls)));
    $('map-legend').innerHTML = CLASSES.map(c => `<span><i style="background:${c.col}"></i>${esc(c.label)}</span>`).join('') + '<span><i style="background:transparent;border-style:dashed"></i>video path</span>';
  }
  function pickType(k) {
    S.cls = k; pref('cls', k);
    $('types').querySelectorAll('.tbtn').forEach(b => b.setAttribute('aria-checked', String(b.dataset.cls === k)));
    if (S.rec) { const t = S.rec.rows.length ? S.rec.rows.length - 1 : 0; S.rec.marks.push({ t, cls: k }); toast(`Marked ${clsOf(k).label} at ${fmtDur(t)}`, 'ok'); }
    updLast();
  }
  function setMode(m) {
    if (S.rec) return;
    S.mode = m; pref('mode', m);
    document.querySelectorAll('.mode button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    const sh = $('shutter'); sh.classList.toggle('video', m === 'video');
    sh.setAttribute('aria-label', m === 'video' ? 'Start video' : 'Take photo');
    updLast();
  }
  document.querySelectorAll('.mode button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('shutter').addEventListener('click', () => {
    if (S.mode === 'photo') capture(S.cls);
    else if (S.rec) stopRec('user');
    else startRec();
  });
  function updLast() {
    const c = clsOf(S.cls);
    $('last').innerHTML = `<b>${esc(c.label)}</b>${S.rec ? 'tap a type to mark' : S.mode === 'video' ? 'video · 1 s log' : 'photo'}`;
  }

  /* ── Photo: read everything synchronously first, so the record matches
       the instant of the tap; only then await the photo encode and the store ── */
  let busy = false;
  async function capture(cls) {
    if (busy || !S.proj) return;
    const g = S.fix;
    if (!g) { toast('No GPS fix yet — wait for LAT/LON', 'err'); return; }
    if (g.acc > GPS_BLOCK) { toast(`GPS too weak (± ${g.acc.toFixed(0)} m) — move to open sky`, 'err'); return; }
    const vid = $('video');
    if (!vid.videoWidth) { toast('Camera not ready — tap ↻ to restart it', 'err'); return; }
    busy = true;
    try {
      const cv = $('snap'); cv.width = vid.videoWidth; cv.height = vid.videoHeight;
      cv.getContext('2d').drawImage(vid, 0, 0);
      const now = new Date(), ms = now.getTime(), h = heading(), t = tilt();
      const f = fp(), ring = (f && h !== null) ? F.footprintRing(g.lat, g.lon, h, f) : null, a = aim(h);
      const tb = travel.get(), rel = F.lookRelTravel(h, tb);
      const id = APP.idPrefix + '-' + ms;
      const ts = now.toISOString().replace(/[-:T]/g, '').split('.')[0];
      const cap = {
        id, project: S.proj.name, timestamp: now.toISOString(),
        imgName: `${S.proj.name}_${id}_${ts}_${g.lat.toFixed(5).replace('.', 'p')}_${g.lon.toFixed(5).replace('.', 'p')}.jpg`,
        lat: g.lat, lon: g.lon, altitude: g.alt, accuracy: g.acc, gpsSamples: g.samples,
        heading: h === null ? null : Math.round(h), headingSrc: C.src, signal: C.signal, platform: C.platform,
        tilt: t, camH: S.camH, hfov: HFOV,
        travelBrg: tb === null ? null : Math.round(tb), lookRel: rel, lookSide: F.lookSide(rel),
        fp: f ? { w: f.w, d: f.d, farCapped: f.farCapped } : null, ring,
        aim: a ? { lat: a.lat, lon: a.lon, dist: a.dist, unc: a.unc } : null,
        cls, note: '', thumb: null
      };
      const fl = $('flash'); fl.style.background = clsOf(cls).col; fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      cap.thumb = thumbOf(cv);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
      await store.putPhoto(id, blob);
      await store.putCap(cap);
      S.caps.unshift(cap);
      await saveSession();
      renderList(); drawCaps();
      const warn = h === null || C.signal === 'LOST' ? ' · ⚠ no compass fix' : !f ? ' · no footprint (above horizon)' : g.acc > GPS_LOCK ? ' · weak GPS' : '';
      toast(clsOf(cls).label + ' saved' + warn, warn ? '' : 'ok');
    } catch (e) { console.error(e); toast('Capture failed: ' + e.message, 'err'); }
    finally { busy = false; }
  }
  function thumbOf(src) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const W = 320, H = Math.round(sh * W / sw) || 180, c = document.createElement('canvas');
    c.width = W; c.height = H; c.getContext('2d').drawImage(src, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.62);
  }

  /* ── Video. MediaRecorder hands over a piece every PART_MS and each piece goes
       straight into IndexedDB, so memory stays flat and a crash keeps what was filmed.
       The 1 s log is self-correcting (each tick aims at t0 + n s), not a drifting
       setInterval; t_s is the nominal second, t_actual_s when it was really read. ── */
  // WebM first: Chrome's MP4 recorder holds the video back for many seconds whatever the
  // timeslice (tested: nothing but a 1 KB header after 8 s), so a crash would lose the take
  // and memory would grow. WebM hands over a piece on time. Safari only does MP4.
  function pickMime() {
    if (!window.MediaRecorder) return null;
    const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
      'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
    return '';
  }
  async function startRec() {
    if (S.rec || busy || !S.proj) return;
    const g = S.fix;
    if (!g) { toast('No GPS fix yet — wait for LAT/LON', 'err'); return; }
    if (g.acc > GPS_BLOCK) { toast(`GPS too weak (± ${g.acc.toFixed(0)} m) — move to open sky`, 'err'); return; }
    const tr = camTrack();
    if (!tr || tr.readyState !== 'live' || !$('video').videoWidth) { toast('Camera not ready — tap ↻ to restart it', 'err'); return; }
    const mime = pickMime();
    if (mime === null) { toast('This browser cannot record video', 'err'); return; }
    busy = true; $('shutter').disabled = true;
    let mic = null;
    try {
      if (!S.noMic) {
        try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } }); }
        catch (e) { S.noMic = true; toast('No microphone access — filming without sound'); }
      }
      const ms = new MediaStream([...S.stream.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])]);
      const opts = { videoBitsPerSecond: 5000000 }; if (mime) opts.mimeType = mime;
      const mr = new MediaRecorder(ms, opts);
      const now = new Date(), id = APP.idPrefix + 'V-' + now.getTime();
      const type = (mr.mimeType || mime || 'video/webm');
      const ext = /mp4/.test(type) ? 'mp4' : 'webm';
      const ts = now.toISOString().replace(/[-:T]/g, '').split('.')[0];
      const R = { id, mr, mic, type, seq: 0, bytes: 0, rows: [], marks: [{ t: 0, cls: S.cls }], t0: 0, timer: null, writes: Promise.resolve(), stopping: false, writeErr: null };
      mr.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        const n = ++R.seq, part = e.data; R.bytes += part.size;
        R.writes = R.writes.then(() => store.putPart(id, n, part)).catch(err => { R.writeErr = err; });
      };
      mr.onerror = e => { toast('Recording error: ' + ((e.error && e.error.message) || 'unknown') + ' — clip saved', 'err'); stopRec('error'); };
      const started = new Promise(r => { mr.onstart = r; });
      mr.start(PART_MS);
      await Promise.race([started, new Promise(r => setTimeout(r, 1500))]);
      if (mr.state !== 'recording') throw new Error('recorder did not start');
      R.t0 = performance.now();
      R.cap = {
        id, kind: 'clip', status: 'recording', project: S.proj.name, timestamp: now.toISOString(),
        vidName: `${S.proj.name}_${id}_${ts}.${ext}`, mime: type, audio: !!mic,
        cls: S.cls, camH: S.camH, hfov: HFOV, platform: C.platform,
        lat: g.lat, lon: g.lon, thumb: thumbOf($('video')), rows: [], marks: R.marks, duration: 0, size: 0, note: ''
      };
      await store.putCap(R.cap);                    // a crash now still leaves a recoverable clip
      S.rec = R;
      tick(R);
      $('shutter').classList.add('rec'); $('shutter').setAttribute('aria-label', 'Stop video');
      document.querySelectorAll('.mode button').forEach(b => { b.disabled = true; });
      $('rec-badge').hidden = false; updLast(); updRec();
    } catch (e) {
      if (mic) mic.getTracks().forEach(t => t.stop());
      S.rec = null; toast('Could not start video: ' + e.message, 'err');
    } finally { busy = false; $('shutter').disabled = false; }
  }
  function tick(R) {
    if (S.rec !== R || R.stopping) return;
    sampleRow(R);
    const n = R.rows.length;
    if (n > REC_MAX_S) { toast('10-minute limit reached — clip saved', 'ok'); stopRec('limit'); return; }
    if (n % 5 === 0) { R.cap.rows = R.rows; R.cap.duration = n - 1; store.putCap(R.cap).catch(() => {}); }
    R.timer = setTimeout(() => tick(R), Math.max(0, R.t0 + n * 1000 - performance.now()));
  }
  function sampleRow(R) {
    const g = S.fix, h = heading(), t = tilt(), f = fp(), a = aim(h);
    R.rows.push({
      t: R.rows.length, ta: +((performance.now() - R.t0) / 1000).toFixed(2), utc: new Date().toISOString(), cls: S.cls,
      lat: g ? +g.lat.toFixed(7) : null, lon: g ? +g.lon.toFixed(7) : null, acc: g ? +g.acc.toFixed(1) : null,
      alt: g && g.alt != null ? +(+g.alt).toFixed(1) : null, gpsAge: S.lastGPS ? +((Date.now() - S.lastGPS) / 1000).toFixed(1) : null,
      hdg: h === null ? null : Math.round(h), src: C.src, sig: C.signal, tilt: t,
      aim: a ? { lat: +a.lat.toFixed(8), lon: +a.lon.toFixed(8), dist: +a.dist.toFixed(2), unc: +a.unc.toFixed(2) } : null,
      fp: f ? { w: +f.w.toFixed(2), d: +f.d.toFixed(2) } : null,
      ring: (f && h !== null && g) ? F.footprintRing(g.lat, g.lon, h, f) : null
    });
  }
  async function stopRec(reason) {
    const R = S.rec; if (!R || R.stopping) return;
    R.stopping = true; clearTimeout(R.timer);
    const dur = (performance.now() - R.t0) / 1000;
    const stopped = new Promise(r => { R.mr.onstop = r; });
    try { if (R.mr.state !== 'inactive') R.mr.stop(); } catch (e) {}
    await Promise.race([stopped, new Promise(r => setTimeout(r, 4000))]);
    await new Promise(r => setTimeout(r, 0));     // let the last dataavailable queue its write
    await R.writes;
    if (R.mic) R.mic.getTracks().forEach(t => t.stop());
    S.rec = null;
    $('shutter').classList.remove('rec'); setMode(S.mode);
    document.querySelectorAll('.mode button').forEach(b => { b.disabled = false; });
    $('rec-badge').hidden = true; updLast();
    try {
      const blob = await store.joinParts(R.id, R.type);
      if (!blob) { await store.delCap(R.id); toast('The clip was empty — nothing saved', 'err'); return; }
      Object.assign(R.cap, { status: 'done', rows: R.rows, marks: R.marks, duration: +dur.toFixed(2), size: blob.size, stopReason: reason });
      await store.putCap(R.cap);
      S.caps.unshift(R.cap);
      await saveSession(); renderList(); drawCaps();
      const why = reason === 'hidden' ? ' (stopped when the app left the screen)' : reason === 'camera' ? ' (stopped to restart the camera)' : '';
      toast(`Video saved · ${fmtDur(dur)} · ${R.rows.length} positions${why}` + (R.writeErr ? ' · ⚠ some seconds not stored' : ''), R.writeErr ? 'err' : 'ok');
    } catch (e) { console.error(e); toast('Saving the video failed: ' + e.message, 'err'); }
  }
  function updRec() {
    const R = S.rec; if (!R) return;
    $('rec-time').textContent = fmtDur((performance.now() - R.t0) / 1000);
    $('rec-info').textContent = `${R.rows.length} pts · ${fmtMB(R.bytes)}`;
  }
  // A clip left "recording" means the app was killed mid-take: glue its pieces back together.
  async function recoverClips() {
    let n = 0;
    for (const c of S.caps.filter(c => isClip(c) && c.status === 'recording')) {
      const blob = await store.joinParts(c.id, c.mime).catch(() => null) || await store.getPhoto(c.id);
      if (!blob) { await store.delCap(c.id); S.caps = S.caps.filter(x => x !== c); continue; }
      Object.assign(c, { status: 'recovered', size: blob.size, duration: Math.max(0, (c.rows || []).length - 1) });
      await store.putCap(c); n++;
    }
    if (n) { await saveSession(); toast(`${n} interrupted video${n === 1 ? '' : 's'} recovered`, 'ok'); }
  }

  /* ── Map: live cone (fixed ~90 px wedge so the direction is always visible),
       the true footprint dashed, the crosshair point, saved photos and video paths ── */
  function initMap() {
    if (S.map) return;
    S.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([19.1265, 72.9050], 15);
    S.tile = L.tileLayer(OSM, { maxZoom: 20, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(S.map);
    S.layers.fp = L.layerGroup().addTo(S.map);
    S.layers.caps = L.layerGroup().addTo(S.map);
    S.map.on('move zoom', updCone);
  }
  $('b-sat').addEventListener('click', () => {
    S.sat = !S.sat; S.map.removeLayer(S.tile);
    S.tile = L.tileLayer(S.sat ? SAT : OSM, { maxZoom: 20, maxNativeZoom: S.sat ? 18 : 19, attribution: S.sat ? 'Esri, Maxar, Earthstar Geographics' : '© OpenStreetMap contributors' }).addTo(S.map);
    $('b-sat').setAttribute('aria-pressed', String(S.sat));
  });
  $('b-centre').addEventListener('click', () => { if (S.fix) S.map.setView([S.fix.lat, S.fix.lon], 18); else toast('Waiting for GPS…', 'err'); });
  function updCone() {
    const g = S.fix; if (!S.map || !g) return;
    if (!S.me) S.me = L.circleMarker([g.lat, g.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#4aa3df', fillOpacity: 1, interactive: false }).addTo(S.map);
    else S.me.setLatLng([g.lat, g.lon]);
    if (!S.mapCentred) { S.map.setView([g.lat, g.lon], 18); S.mapCentred = true; }
    const col = C.signal === 'OK' ? '#8fcf72' : C.signal === 'STALE' ? '#e9b949' : '#e5534b';
    if (heading() === null) { ['cone', 'ray', 'aim', 'live'].forEach(k => { if (S.layers[k]) { S.map.removeLayer(S.layers[k]); S.layers[k] = null; } }); return; }
    const h = S.dispAz;
    const mpp = 156543.03392 * Math.cos(g.lat * F.D2R) / Math.pow(2, S.map.getZoom());
    const len = Math.max(CONE_PX * mpp, 3), dest = (m, b) => F.geoDest(g.lat, g.lon, m, b);
    const cone = [[g.lat, g.lon]]; for (let i = 0; i <= 10; i++) cone.push(dest(len, h - HFOV / 2 + HFOV * i / 10));
    const set = (k, make, ll, style) => { if (!S.layers[k]) S.layers[k] = make().addTo(S.map); else { S.layers[k].setLatLngs ? S.layers[k].setLatLngs(ll) : S.layers[k].setLatLng(ll); S.layers[k].setStyle(style); } };
    set('cone', () => L.polygon(cone, { color: col, weight: 1, fillColor: col, fillOpacity: .22, interactive: false }), cone, { color: col, fillColor: col });
    const ray = [[g.lat, g.lon], dest(len * 1.15, h)];
    set('ray', () => L.polyline(ray, { color: col, weight: 2, interactive: false }), ray, { color: col });
    const a = aim(h);
    if (a) set('aim', () => L.circleMarker([a.lat, a.lon], { radius: 5, color: '#fff', weight: 2, fillColor: col, fillOpacity: .9, interactive: false }), [a.lat, a.lon], { fillColor: col });
    else if (S.layers.aim) { S.map.removeLayer(S.layers.aim); S.layers.aim = null; }
    const f = fp(), r = f ? F.footprintRing(g.lat, g.lon, h, f) : null;
    if (r) { const ll = r.map(p => [p[1], p[0]]); set('live', () => L.polygon(ll, { color: '#fff', weight: 1.4, dashArray: '3 3', fillColor: col, fillOpacity: .3, interactive: false }), ll, { fillColor: col }); }
    else if (S.layers.live) { S.map.removeLayer(S.layers.live); S.layers.live = null; }
  }
  function drawCaps() {
    if (!S.map) return;
    S.layers.fp.clearLayers(); S.layers.caps.clearLayers();
    [...S.caps].reverse().forEach(c => {
      const col = clsOf(c.cls).col;
      if (isClip(c)) {
        const pts = (c.rows || []).filter(r => r.lat !== null).map(r => [r.lat, r.lon]);
        if (!pts.length) pts.push([c.lat, c.lon]);
        if (pts.length > 1) S.layers.caps.addLayer(L.polyline(pts, { color: col, weight: 3, dashArray: '6 5', opacity: .95 }).bindPopup(() => clipPopup(c)));
        S.layers.caps.addLayer(L.circleMarker(pts[0], { radius: 8, color: col, weight: 3, fillColor: '#111', fillOpacity: 1 }).bindPopup(() => clipPopup(c)));
        return;
      }
      if (c.ring) S.layers.fp.addLayer(L.polygon(c.ring.map(p => [p[1], p[0]]), { color: col, weight: 1.2, fillColor: col, fillOpacity: .16, interactive: false }));
      if (c.aim && c.aim.dist > 0.5) {
        S.layers.caps.addLayer(L.polyline([[c.lat, c.lon], [c.aim.lat, c.aim.lon]], { color: col, weight: 1.5, dashArray: '2 3', interactive: false }));
        S.layers.caps.addLayer(L.circleMarker([c.aim.lat, c.aim.lon], { radius: 3.5, color: '#fff', weight: 1, fillColor: col, fillOpacity: 1, interactive: false }));
      }
      S.layers.caps.addLayer(L.circleMarker([c.lat, c.lon], { radius: 7, color: '#fff', weight: 2, fillColor: col, fillOpacity: .95 })
        .bindPopup(() => `<b>${esc(clsOf(c.cls).label)}</b><br>${esc(new Date(c.timestamp).toLocaleString())}<br>HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}°${c.aim ? ' · aim ' + fmtM(c.aim.dist) : ''}`));
    });
  }
  const clipPopup = c => `<b>Video · ${esc(clsOf(c.cls).label)}</b><br>${esc(new Date(c.timestamp).toLocaleString())}<br>${fmtDur(c.duration)} · ${(c.rows || []).length} positions`;

  /* ── Tabs ── */
  let activeTab = 'cam';
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + activeTab));
    if (activeTab === 'cam') watch.reset();
    if (activeTab === 'map' && S.map) setTimeout(() => { S.map.invalidateSize(); updCone(); }, 50);
    if (activeTab === 'data') { updData(); updStore(); }
  }));

  /* ── Data panel ── */
  function updData() {
    const g = S.fix, h = heading(), f = fp(), a = aim(), v = $('video'), tr = camTrack();
    const rows = [
      ['Position', g ? `${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}` : null],
      ['Accuracy', g ? `± ${g.acc.toFixed(1)} m (${g.samples}/${gps.max} fixes, worst dropped)` : null],
      ['Heading', h === null ? null : `${Math.round(h)}° ${azLbl(h)} [${C.src}]`],
      ['Sensors', `${C.platform} · permission ${C.perm} · abs ${C.absCount} · ori ${C.oriCount} · resyncs ${C.resyncs}`],
      ['Tilt', tilt() === null ? null : `${tilt()}° from straight down${tilt() > 90 ? ' (above horizon)' : ''}`],
      ['Camera height', S.camH.toFixed(2) + ' m above ground'],
      ['Camera', tr ? `${v.videoWidth}×${v.videoHeight} · ${tr.readyState}${tr.muted ? ' · no frames' : ''} · restarts ${S.camRestarts}` : null],
      ['Footprint', f ? `${f.w.toFixed(1)} × ${f.d.toFixed(1)} m${f.farCapped ? ' (far edge clipped)' : ''}` : (g ? '— (aimed above horizon)' : null)],
      ['Crosshair', a ? `${fmtM(a.dist)} ahead, ± ${fmtM(a.unc)}` : null],
      ['Travel', travel.get() === null ? null : `${Math.round(travel.get())}° (metadata only)`]
    ];
    $('kv').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd class="${v ? '' : 'na'}">${v ? esc(v) : '—'}</dd>`).join('');
  }
  async function updStore() {
    let t = store.mem ? 'In memory only — export before closing.' : `${countTxt(S.caps)} on this phone`;
    const u = await store.usage(); if (u !== null && !store.mem) t += ` · ${(u / 1048576).toFixed(1)} MB used`;
    if (store.persisted === false) t += ' · storage not marked persistent';
    $('store-info').textContent = t;
  }
  $('camh-set').addEventListener('click', () => {
    const v = parseFloat($('camh-edit').value);
    if (!isFinite(v) || v < 0.2 || v > 60) { toast('Camera height must be 0.2–60 m', 'err'); return; }
    S.camH = v; saveSession(); toast('Camera height ' + v.toFixed(2) + ' m — applies to new photos and videos', 'ok');
  });
  function renderList() {
    $('h-count').textContent = countTxt(S.caps);
    if (!S.caps.length) { $('cap-list').innerHTML = '<p class="empty">Nothing yet. On the Camera tab, pick a type, then tap the shutter.</p>'; return; }
    $('cap-list').innerHTML = S.caps.map(c => isClip(c) ? `
      <div class="cap">
        <img src="${c.thumb || ''}" alt="" />
        <div class="meta">
          <span class="pill" style="background:${clsOf(c.cls).col}">${esc(clsOf(c.cls).label)}</span><span class="kind">VIDEO ${fmtDur(c.duration)}</span> <b>${esc(new Date(c.timestamp).toLocaleTimeString())}</b><br>
          ${(c.rows || []).length} positions, 1 per second · ${fmtMB(c.size || 0)}${c.audio ? '' : ' · no sound'}${c.status === 'recovered' ? ' · recovered' : ''}<br>
          ${(c.marks || []).length > 1 ? (c.marks.length - 1) + ' marked moment' + (c.marks.length > 2 ? 's' : '') : 'start ' + c.lat.toFixed(5) + ', ' + c.lon.toFixed(5)}
        </div>
        <div class="acts"><button type="button" data-play="${esc(c.id)}">Play</button><button type="button" data-del="${esc(c.id)}">Delete</button></div>
      </div>` : `
      <div class="cap">
        <img src="${c.thumb || ''}" alt="" />
        <div class="meta">
          <span class="pill" style="background:${clsOf(c.cls).col}">${esc(clsOf(c.cls).label)}</span> <b>${esc(new Date(c.timestamp).toLocaleTimeString())}</b><br>
          ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)} · ± ${(c.accuracy || 0).toFixed(0)} m<br>
          HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}°${c.aim ? ' · aim ' + fmtM(c.aim.dist) : ''}
        </div>
        <div class="acts"><button type="button" data-del="${esc(c.id)}">Delete</button></div>
      </div>`).join('');
    $('cap-list').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      const c = S.caps.find(x => x.id === b.dataset.del);
      if (!confirm(isClip(c) ? 'Delete this video and its log?' : 'Delete this photo and its record?')) return;
      S.caps = S.caps.filter(x => x.id !== b.dataset.del);
      await store.delCap(b.dataset.del); await saveSession(); renderList(); drawCaps();
    }));
    $('cap-list').querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => play(S.caps.find(x => x.id === b.dataset.play))));
  }

  /* ── Clip player: the line under the video shows that second's log row ── */
  let plURL = null, plClip = null;
  async function play(c) {
    const blob = await store.getPhoto(c.id);
    if (!blob) { toast('Video file missing on this phone', 'err'); return; }
    plClip = c; plURL = URL.createObjectURL(blob);
    const v = $('pl-video'); v.src = plURL; $('player').hidden = false; plRead();
    v.play().catch(() => {});
  }
  function rowText(r, c) {
    if (!r) return '—';
    const pos = r.lat === null ? 'no GPS' : `${Math.abs(r.lat).toFixed(5)}${r.lat >= 0 ? 'N' : 'S'} ${Math.abs(r.lon).toFixed(5)}${r.lon >= 0 ? 'E' : 'W'} ±${Math.round(r.acc)} m`;
    const hd = r.hdg === null ? 'HDG —' : `HDG ${r.hdg}° ${azLbl(r.hdg)}`;
    return `${pos} · ${hd} · tilt ${r.tilt ?? '—'}°${r.aim ? ' · aim ' + fmtM(r.aim.dist) : ''} · ${clsOf(r.cls || c.cls).label}`;
  }
  function plRead() {
    if (!plClip) return;
    const rows = plClip.rows || [], v = $('pl-video');
    const i = Math.min(rows.length - 1, Math.floor(v.currentTime || 0));
    $('pl-read').innerHTML = `<b>${fmtDur(v.currentTime || 0)}</b> · ${esc(rowText(rows[i], plClip))}`;
  }
  $('pl-video').addEventListener('timeupdate', plRead);
  $('pl-close').addEventListener('click', () => {
    const v = $('pl-video'); v.pause(); v.removeAttribute('src'); v.load();
    if (plURL) URL.revokeObjectURL(plURL); plURL = null; plClip = null; $('player').hidden = true;
  });

  /* ── Export ── */
  function props(c) {
    return {
      id: c.id, imgName: c.imgName, timestamp: c.timestamp, project: c.project, class: c.cls, note: c.note || null,
      heading_deg: c.heading, heading_source: c.headingSrc, heading_signal: c.signal, sensor_platform: c.platform,
      tilt_deg_from_nadir: c.tilt, camera_height_m: c.camH, hfov_deg: c.hfov,
      gps_accuracy_m: c.accuracy, gps_samples: c.gpsSamples, altitude_m: c.altitude,
      aim_lat: c.aim ? +c.aim.lat.toFixed(8) : null, aim_lon: c.aim ? +c.aim.lon.toFixed(8) : null,
      aim_dist_m: c.aim ? +c.aim.dist.toFixed(2) : null, aim_uncertainty_m: c.aim ? +c.aim.unc.toFixed(2) : null,
      footprint_width_m: c.fp ? +c.fp.w.toFixed(2) : null, footprint_depth_m: c.fp ? +c.fp.d.toFixed(2) : null, footprint_far_capped: c.fp ? c.fp.farCapped : null,
      travel_bearing_deg: c.travelBrg, look_rel_travel_deg: c.lookRel, look_side: c.lookSide
    };
  }
  const photos = () => [...S.caps].filter(c => !isClip(c)).reverse();
  const clips = () => [...S.caps].filter(isClip).reverse();
  const meta = extra => Object.assign({ app: APP.name, version: APP.version, project: S.proj.name, notes: S.proj.notes, session_started: S.proj.started, exported: new Date().toISOString(), photos: photos().length, videos: clips().length }, extra || {});
  function pointsGJ() {
    return { type: 'FeatureCollection', metadata: meta(), features: photos().map(c => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: props(c),
      ...(c.ring ? { fov_polygon: { type: 'Polygon', coordinates: [c.ring] } } : {}) })) };   // fov_polygon: CropView-compatible
  }
  function footprintsGJ() {
    const fs = photos().filter(c => c.ring).map(c => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [c.ring] }, properties: Object.assign(props(c), { capture_lat: c.lat, capture_lon: c.lon }) }));
    return { type: 'FeatureCollection', metadata: meta({ description: 'Ground footprint of each photo: the camera field of view projected onto the ground. Use it to sample satellite pixels.' }), features: fs };
  }
  const COLS = ['id', 'imgName', 'timestamp', 'project', 'lat', 'lon', 'class', 'note', 'heading_deg', 'heading_source', 'tilt_deg_from_nadir', 'camera_height_m', 'hfov_deg', 'gps_accuracy_m', 'altitude_m', 'aim_lat', 'aim_lon', 'aim_dist_m', 'aim_uncertainty_m', 'footprint_width_m', 'footprint_depth_m', 'travel_bearing_deg', 'look_side'];
  function csv() {
    return [COLS.join(','), ...photos().map(c => { const p = props(c); p.lat = c.lat; p.lon = c.lon; return COLS.map(k => F.csvCell(p[k])).join(','); })].join('\n');
  }
  // Video: one row per second per clip.
  function secProps(c, r) {
    return {
      clip_id: c.id, video: c.vidName, t_s: r.t, t_actual_s: r.ta, utc: r.utc, class: r.cls || c.cls,
      lat: r.lat, lon: r.lon, gps_accuracy_m: r.acc, gps_age_s: r.gpsAge, altitude_m: r.alt,
      heading_deg: r.hdg, heading_source: r.src, heading_signal: r.sig, tilt_deg_from_nadir: r.tilt,
      aim_lat: r.aim ? r.aim.lat : null, aim_lon: r.aim ? r.aim.lon : null, aim_dist_m: r.aim ? r.aim.dist : null, aim_uncertainty_m: r.aim ? r.aim.unc : null,
      footprint_width_m: r.fp ? r.fp.w : null, footprint_depth_m: r.fp ? r.fp.d : null, camera_height_m: c.camH, hfov_deg: c.hfov
    };
  }
  const SEC_COLS = ['clip_id', 'video', 't_s', 't_actual_s', 'utc', 'class', 'lat', 'lon', 'gps_accuracy_m', 'gps_age_s', 'altitude_m', 'heading_deg', 'heading_source', 'heading_signal', 'tilt_deg_from_nadir', 'aim_lat', 'aim_lon', 'aim_dist_m', 'aim_uncertainty_m', 'footprint_width_m', 'footprint_depth_m', 'camera_height_m', 'hfov_deg'];
  function secCsv() {
    const out = [SEC_COLS.join(',')];
    clips().forEach(c => (c.rows || []).forEach(r => { const p = secProps(c, r); out.push(SEC_COLS.map(k => F.csvCell(p[k])).join(',')); }));
    return out.join('\n');
  }
  function trackGJ() {
    const fs = [];
    clips().forEach(c => {
      const rows = c.rows || [], pts = rows.filter(r => r.lat !== null);
      fs.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(r => [r.lon, r.lat]) },
        properties: { kind: 'video_path', clip_id: c.id, video: c.vidName, start_utc: c.timestamp, duration_s: c.duration, seconds_logged: rows.length,
          class: c.cls, marks: (c.marks || []).map(m => ({ t_s: m.t, class: m.cls })), audio: !!c.audio, status: c.status, camera_height_m: c.camH } });
      pts.forEach(r => fs.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: Object.assign({ kind: 'video_second' }, secProps(c, r)),
        ...(r.ring ? { fov_polygon: { type: 'Polygon', coordinates: [r.ring] } } : {}) }));
    });
    return { type: 'FeatureCollection', metadata: meta({ description: 'Videos: one line per clip (the path walked) and one point per second with heading, tilt, aim point and fov_polygon (ground footprint).' }), features: fs };
  }
  const srtTime = s => { const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`; };
  function srt(c) {
    return (c.rows || []).map((r, i) => `${i + 1}\n${srtTime(r.t)} --> ${srtTime(r.t + 1)}\n${rowText(r, c)}\n`).join('\n');
  }
  function readme() {
    return [
      `${APP.name} export · ${S.proj.name}`, '',
      'images/  photos named {Survey}_{ID}_{UTC time}_{lat}_{lon}.jpg',
      'videos/  {Survey}_{ID}_{UTC time}.mp4 or .webm, each with a .srt of the same name:',
      '         VLC and most players show the per-second position, heading and tilt as captions',
      'data/    *_captures_points.geojson      one point per photo (where you stood), all fields',
      '         *_captures_footprints.geojson  the ground footprint polygon of each photo',
      '         *_captures.csv                 the photo records as a table',
      '         *_video_track.geojson          per clip: the path as a line + one point per second (fov_polygon = footprint)',
      '         *_video_seconds.csv            one row per second of every clip', '',
      'heading_deg          camera look direction, clockwise from true north (null = no compass fix)',
      'heading_source       COMPASS | COMPASS·LOW-CONF | STALE·HOLD | SIGNAL LOST | NO SENSOR DATA | SENSORS BLOCKED',
      'tilt_deg_from_nadir  0 = straight down, 90 = horizon',
      'camera_height_m      height of the camera above the ground (not GPS altitude)',
      'aim_lat / aim_lon    where the crosshair met the ground (camera_height_m · tan tilt ahead)',
      'aim_uncertainty_m    geometry-only ± for 2° tilt and 10° heading error; add gps_accuracy_m',
      'travel_bearing_deg   direction of walking/driving from GPS — metadata only, never the camera heading',
      't_s / t_actual_s     second into the video (row n covers n to n+1 s) / when the sensors were actually read',
      'gps_age_s            seconds since the last GPS update when that row was logged',
      'class (video rows)   the type picked at that second; tapping a type while filming marks a moment', '',
      'Phone browsers write videos without a duration in the file header, so some players show',
      'the length late or seek slowly; the time stamps and captions are still exact.', '',
      `${APP.name} ${APP.version} · Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License`
    ].join('\n');
  }
  async function buildZip() {
    const pn = S.proj.name, files = [];
    let missing = 0;
    for (const c of clips()) {
      const b = await store.getPhoto(c.id);
      if (!b) { missing++; continue; }
      files.push({ path: 'videos/' + c.vidName, content: b });
      files.push({ path: 'videos/' + c.vidName.replace(/\.\w+$/, '.srt'), content: srt(c) });
    }
    if (photos().length) files.push(
      { path: `data/${pn}_captures_points.geojson`, content: JSON.stringify(pointsGJ(), null, 2) },
      { path: `data/${pn}_captures_footprints.geojson`, content: JSON.stringify(footprintsGJ(), null, 2) },
      { path: `data/${pn}_captures.csv`, content: csv() });
    if (clips().length) files.push(
      { path: `data/${pn}_video_track.geojson`, content: JSON.stringify(trackGJ(), null, 2) },
      { path: `data/${pn}_video_seconds.csv`, content: secCsv() });
    files.push({ path: 'README.txt', content: readme() });
    const z = await FS.buildZip({
      store, caps: photos(), imgNameOf: c => c.imgName, files,
      zipName: `${pn}_${APP.name.replace(/\s+/g, '')}_${new Date().toISOString().split('T')[0]}.zip`
    });
    z.missing += missing;
    return z;
  }
  $('b-zip').addEventListener('click', async () => {
    if (!S.caps.length) { toast('Nothing to export yet', 'err'); return; }
    if (S.rec) { toast('Stop the video first', 'err'); return; }
    toast('Building ZIP…');
    try { const z = await buildZip(); FS.download(z.blob, z.name); toast(z.missing ? z.missing + ' file(s) missing on this phone — exported without them' : 'ZIP exported ✓', z.missing ? 'err' : 'ok'); }
    catch (e) { toast('Export failed: ' + e.message, 'err'); }
  });
  $('b-csv').addEventListener('click', () => {
    if (!S.caps.length) { toast('Nothing to export yet', 'err'); return; }
    if (photos().length) FS.download(csv(), `${S.proj.name}_photos_${Date.now()}.csv`, 'text/csv');
    if (clips().length) setTimeout(() => FS.download(secCsv(), `${S.proj.name}_video_seconds_${Date.now()}.csv`, 'text/csv'), 400);
  });
  const sharer = FS.createSharer({
    build: buildZip,
    keyOf: () => S.proj.name + '|' + S.caps.map(c => c.id + (c.edited || '')).join(','),
    onLabel: ready => { $('b-share').textContent = ready ? 'Tap to share' : 'Share ZIP'; },
    onToast: toast
  });
  if (sharer.canShareFiles()) $('b-share').hidden = false;
  $('b-share').addEventListener('click', () => {
    if (!S.caps.length) { toast('Nothing to export yet', 'err'); return; }
    if (S.rec) { toast('Stop the video first', 'err'); return; }
    sharer.share().catch(e => toast('Share failed: ' + e.message, 'err'));
  });

  /* ── Small things ── */
  let tt;
  function toast(m, cls) { const e = $('toast'); e.textContent = m; e.className = 'show' + (cls ? ' ' + cls : '') + (S.proj && activeTab !== 'cam' ? ' low' : ''); clearTimeout(tt); tt = setTimeout(() => { e.className = ''; }, 3200); }
  (function () { try { const m = navigator.deviceMemory; if (m && m <= 2) document.documentElement.classList.add('g-lite'); } catch (e) {} })();
  (function () {
    const el = $('offline-state');
    if (!('serviceWorker' in navigator)) { el.textContent = 'Offline mode not supported in this browser'; return; }
    // A new version takes over in the background. Reload straight away if no survey is open;
    // otherwise say so, rather than yanking the page mid-shoot.
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
  window.__field = { S, C, compass, store, capture, startRec, stopRec, restartCamera, watch, buildZip, csv, secCsv, trackGJ, srt, pointsGJ, APP };
})();
