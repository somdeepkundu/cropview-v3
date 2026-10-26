/* Powai Lake Survey — starter capture app built on sensor-core.js and field-store.js.
 * Rename, re-colour and replace CLASSES for your survey; keep the sensor rules.
 * Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License */
(function () {
  'use strict';
  const APP = { name: 'Powai Lake Survey', version: '1.0.0', db: 'powai-lake-survey', idPrefix: 'PL' };
  // One button per class. Keys go into the export, so keep them stable.
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
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  const F = window.FieldSensors, FS = window.FieldStore;
  const $ = id => document.getElementById(id);
  const esc = F.esc;
  const clsOf = k => CLASSES.find(c => c.k === k) || { k, label: k, col: '#9ca69e' };

  const S = {
    proj: null, camH: 1.5, fix: null, lastGPS: null, caps: [], dispAz: 0,
    map: null, tile: null, sat: false, mapCentred: false, layers: {}, stream: null, platform: 'unknown'
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

  async function renderResume() {
    await store.ready;
    const list = await store.listSessions();
    $('resume-wrap').hidden = !list.length;
    $('resume-list').innerHTML = list.slice(0, 5).map(s => `
      <button class="resume" type="button" data-name="${esc(s.name)}">
        <span><b>${esc(s.name)}</b><small>${s.count} photo${s.count === 1 ? '' : 's'} · ${esc(new Date(s.updated || s.started).toLocaleDateString())} · camera ${(+s.camH || 1.5).toFixed(2)} m</small></span><span aria-hidden="true">→</span>
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
    renderShoot(); startCamera(); initMap(); wake();
    S.caps = (await store.capsFor(p.name)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
  async function startCamera() {
    try {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      $('video').srcObject = S.stream;
    } catch (e) { toast('Camera: ' + e.message, 'err'); }
  }
  $('compass').addEventListener('click', () => {
    compass.recalibrate();                      // re-asks permission inside this tap
    if (C.perm !== 'denied') toast('Recalibrating — draw a slow figure-8 with the phone', 'ok');
  });

  const heading = () => C.heading;               // null until the first valid reading
  const tilt = () => C.tilt;
  const fp = () => F.footprint({ camH: S.camH, tilt: tilt(), hfov: HFOV, tiltMax: TILT_MAX });
  const aim = h => (S.fix && heading() !== null) ? F.aimPoint(S.fix.lat, S.fix.lon, h ?? heading(), { camH: S.camH, tilt: tilt(), tiltMax: TILT_MAX }) : null;

  /* ── Render loop: decoupled from sensor events, so the rose and cone stay live
       between events and the health colour updates even when nothing fires ── */
  let lastSlow = 0;
  function loop(ts) {
    if (heading() !== null) S.dispAz = F.lerpAngle(S.dispAz, heading(), 0.2);
    $('rose').style.transform = `rotate(${-S.dispAz}deg)`;
    $('ring').setAttribute('stroke', C.signal === 'OK' ? '#3c5a3a' : C.signal === 'STALE' ? 'var(--warn)' : 'var(--bad)');
    if (ts - lastSlow > 120) { lastSlow = ts; updHUD(); updTilt(); if (activeTab === 'map') updCone(); if (activeTab === 'data') updData(); }
    requestAnimationFrame(loop);
  }
  const azLbl = a => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][Math.round(a / 45) % 8];
  const fmtM = m => (m < 10 ? m.toFixed(1) : Math.round(m)) + ' m';
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

  /* ── Capture: read everything synchronously first, so the record matches
       the instant of the tap; only then await the photo encode and the store ── */
  let busy = false;
  function renderShoot() {
    $('shoot').innerHTML = CLASSES.map(c => `<button type="button" class="cbtn" data-cls="${esc(c.k)}" style="--c:${c.col}">${esc(c.label.toUpperCase())}</button>`).join('');
    $('shoot').querySelectorAll('.cbtn').forEach(b => b.addEventListener('click', () => capture(b.dataset.cls)));
    $('map-legend').innerHTML = CLASSES.map(c => `<span><i style="background:${c.col}"></i>${esc(c.label)}</span>`).join('');
  }
  async function capture(cls) {
    if (busy || !S.proj) return;
    const g = S.fix;
    if (!g) { toast('No GPS fix yet — wait for LAT/LON', 'err'); return; }
    if (g.acc > GPS_BLOCK) { toast(`GPS too weak (± ${g.acc.toFixed(0)} m) — move to open sky`, 'err'); return; }
    const vid = $('video');
    if (!vid.videoWidth) { toast('Camera not ready yet', 'err'); return; }
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
    const W = 320, H = Math.round(src.height * W / src.width) || 180, c = document.createElement('canvas');
    c.width = W; c.height = H; c.getContext('2d').drawImage(src, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.62);
  }

  /* ── Map: live cone (fixed ~90 px wedge so the direction is always visible),
       the true footprint dashed, the crosshair point, and saved captures ── */
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
      if (c.ring) S.layers.fp.addLayer(L.polygon(c.ring.map(p => [p[1], p[0]]), { color: col, weight: 1.2, fillColor: col, fillOpacity: .16, interactive: false }));
      if (c.aim && c.aim.dist > 0.5) {
        S.layers.caps.addLayer(L.polyline([[c.lat, c.lon], [c.aim.lat, c.aim.lon]], { color: col, weight: 1.5, dashArray: '2 3', interactive: false }));
        S.layers.caps.addLayer(L.circleMarker([c.aim.lat, c.aim.lon], { radius: 3.5, color: '#fff', weight: 1, fillColor: col, fillOpacity: 1, interactive: false }));
      }
      S.layers.caps.addLayer(L.circleMarker([c.lat, c.lon], { radius: 7, color: '#fff', weight: 2, fillColor: col, fillOpacity: .95 })
        .bindPopup(() => `<b>${esc(clsOf(c.cls).label)}</b><br>${esc(new Date(c.timestamp).toLocaleString())}<br>HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}°${c.aim ? ' · aim ' + fmtM(c.aim.dist) : ''}`));
    });
  }

  /* ── Tabs ── */
  let activeTab = 'cam';
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', String(x === t)); });
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + activeTab));
    if (activeTab === 'map' && S.map) setTimeout(() => { S.map.invalidateSize(); updCone(); }, 50);
    if (activeTab === 'data') { updData(); updStore(); }
  }));

  /* ── Data panel ── */
  function updData() {
    const g = S.fix, h = heading(), f = fp(), a = aim();
    const rows = [
      ['Position', g ? `${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}` : null],
      ['Accuracy', g ? `± ${g.acc.toFixed(1)} m (${g.samples}/${gps.max} fixes, worst dropped)` : null],
      ['Heading', h === null ? null : `${Math.round(h)}° ${azLbl(h)} [${C.src}]`],
      ['Sensors', `${C.platform} · permission ${C.perm} · abs ${C.absCount} · ori ${C.oriCount} · resyncs ${C.resyncs}`],
      ['Tilt', tilt() === null ? null : `${tilt()}° from straight down${tilt() > 90 ? ' (above horizon)' : ''}`],
      ['Camera height', S.camH.toFixed(2) + ' m above ground'],
      ['Footprint', f ? `${f.w.toFixed(1)} × ${f.d.toFixed(1)} m${f.farCapped ? ' (far edge clipped)' : ''}` : (g ? '— (aimed above horizon)' : null)],
      ['Crosshair', a ? `${fmtM(a.dist)} ahead, ± ${fmtM(a.unc)}` : null],
      ['Travel', travel.get() === null ? null : `${Math.round(travel.get())}° (metadata only)`]
    ];
    $('kv').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd class="${v ? '' : 'na'}">${v ? esc(v) : '—'}</dd>`).join('');
  }
  async function updStore() {
    let t = store.mem ? 'In memory only — export before closing.' : `${S.caps.length} photos on this phone`;
    const u = await store.usage(); if (u !== null && !store.mem) t += ` · ${(u / 1048576).toFixed(1)} MB used`;
    if (store.persisted === false) t += ' · storage not marked persistent';
    $('store-info').textContent = t;
  }
  $('camh-set').addEventListener('click', () => {
    const v = parseFloat($('camh-edit').value);
    if (!isFinite(v) || v < 0.2 || v > 60) { toast('Camera height must be 0.2–60 m', 'err'); return; }
    S.camH = v; saveSession(); toast('Camera height ' + v.toFixed(2) + ' m — applies to new photos', 'ok');
  });
  function renderList() {
    const n = S.caps.length;
    $('h-count').textContent = n + ' photo' + (n === 1 ? '' : 's');
    if (!n) { $('cap-list').innerHTML = '<p class="empty">No photos yet. Aim, then tap a class button on the Camera tab.</p>'; return; }
    $('cap-list').innerHTML = S.caps.map(c => `
      <div class="cap">
        <img src="${c.thumb || ''}" alt="" />
        <div class="meta">
          <span class="pill" style="background:${clsOf(c.cls).col}">${esc(clsOf(c.cls).label)}</span> <b>${esc(new Date(c.timestamp).toLocaleTimeString())}</b><br>
          ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)} · ± ${(c.accuracy || 0).toFixed(0)} m<br>
          HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}°${c.aim ? ' · aim ' + fmtM(c.aim.dist) : ''}
        </div>
        <button type="button" data-del="${esc(c.id)}">Delete</button>
      </div>`).join('');
    $('cap-list').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this photo and its record?')) return;
      S.caps = S.caps.filter(c => c.id !== b.dataset.del);
      await store.delCap(b.dataset.del); await saveSession(); renderList(); drawCaps();
    }));
  }

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
  const chrono = () => [...S.caps].reverse();
  const meta = extra => Object.assign({ app: APP.name, version: APP.version, project: S.proj.name, notes: S.proj.notes, session_started: S.proj.started, exported: new Date().toISOString(), captures: S.caps.length }, extra || {});
  function pointsGJ() {
    return { type: 'FeatureCollection', metadata: meta(), features: chrono().map(c => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: props(c),
      ...(c.ring ? { fov_polygon: { type: 'Polygon', coordinates: [c.ring] } } : {}) })) };   // fov_polygon: CropView-compatible
  }
  function footprintsGJ() {
    const fs = chrono().filter(c => c.ring).map(c => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [c.ring] }, properties: Object.assign(props(c), { capture_lat: c.lat, capture_lon: c.lon }) }));
    return { type: 'FeatureCollection', metadata: meta({ description: 'Ground footprint of each photo: the camera field of view projected onto the ground. Use it to sample satellite pixels.' }), features: fs };
  }
  const COLS = ['id', 'imgName', 'timestamp', 'project', 'lat', 'lon', 'class', 'note', 'heading_deg', 'heading_source', 'tilt_deg_from_nadir', 'camera_height_m', 'hfov_deg', 'gps_accuracy_m', 'altitude_m', 'aim_lat', 'aim_lon', 'aim_dist_m', 'aim_uncertainty_m', 'footprint_width_m', 'footprint_depth_m', 'travel_bearing_deg', 'look_side'];
  function csv() {
    return [COLS.join(','), ...chrono().map(c => { const p = props(c); p.lat = c.lat; p.lon = c.lon; return COLS.map(k => F.csvCell(p[k])).join(','); })].join('\n');
  }
  function readme() {
    return [
      `${APP.name} export · ${S.proj.name}`, '',
      'images/  photos named {Survey}_{ID}_{UTC time}_{lat}_{lon}.jpg',
      'data/    *_captures_points.geojson      one point per photo (where you stood), all fields',
      '         *_captures_footprints.geojson  the ground footprint polygon of each photo',
      '         *_captures.csv                 the same records as a table', '',
      'heading_deg          camera look direction, clockwise from true north (null = no compass fix)',
      'heading_source       COMPASS | COMPASS·LOW-CONF | STALE·HOLD | SIGNAL LOST | NO SENSOR DATA | SENSORS BLOCKED',
      'tilt_deg_from_nadir  0 = straight down, 90 = horizon',
      'camera_height_m      height of the camera above the ground (not GPS altitude)',
      'aim_lat / aim_lon    where the crosshair met the ground (camera_height_m · tan tilt ahead)',
      'aim_uncertainty_m    geometry-only ± for 2° tilt and 10° heading error; add gps_accuracy_m',
      'travel_bearing_deg   direction of walking/driving from GPS — metadata only, never the camera heading', '',
      `${APP.name} ${APP.version} · Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License`
    ].join('\n');
  }
  function buildZip() {
    const pn = S.proj.name;
    return FS.buildZip({
      store, caps: S.caps, imgNameOf: c => c.imgName,
      zipName: `${pn}_${APP.name.replace(/\s+/g, '')}_${new Date().toISOString().split('T')[0]}.zip`,
      files: [
        { path: `data/${pn}_captures_points.geojson`, content: JSON.stringify(pointsGJ(), null, 2) },
        { path: `data/${pn}_captures_footprints.geojson`, content: JSON.stringify(footprintsGJ(), null, 2) },
        { path: `data/${pn}_captures.csv`, content: csv() },
        { path: 'README.txt', content: readme() }
      ]
    });
  }
  $('b-zip').addEventListener('click', async () => {
    if (!S.caps.length) { toast('No photos yet', 'err'); return; }
    toast('Building ZIP…');
    try { const z = await buildZip(); FS.download(z.blob, z.name); toast(z.missing ? z.missing + ' photo(s) missing on this phone — exported without them' : 'ZIP exported ✓', z.missing ? 'err' : 'ok'); }
    catch (e) { toast('Export failed: ' + e.message, 'err'); }
  });
  $('b-csv').addEventListener('click', () => { if (!S.caps.length) { toast('No photos yet', 'err'); return; } FS.download(csv(), `${S.proj.name}_${Date.now()}.csv`, 'text/csv'); });
  const sharer = FS.createSharer({
    build: buildZip,
    keyOf: () => S.proj.name + '|' + S.caps.map(c => c.id + (c.edited || '')).join(','),
    onLabel: ready => { $('b-share').textContent = ready ? 'Tap to share' : 'Share ZIP'; },
    onToast: toast
  });
  if (sharer.canShareFiles()) $('b-share').hidden = false;
  $('b-share').addEventListener('click', () => { if (!S.caps.length) { toast('No photos yet', 'err'); return; } sharer.share().catch(e => toast('Share failed: ' + e.message, 'err')); });

  /* ── Small things ── */
  let tt;
  function toast(m, cls) { const e = $('toast'); e.textContent = m; e.className = 'show' + (cls ? ' ' + cls : ''); clearTimeout(tt); tt = setTimeout(() => { e.className = ''; }, 3200); }
  (function () { try { const m = navigator.deviceMemory; if (m && m <= 2) document.documentElement.classList.add('g-lite'); } catch (e) {} })();
  (function () {
    const el = $('offline-state');
    if (!('serviceWorker' in navigator)) { el.textContent = 'Offline mode not supported in this browser'; return; }
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { el.textContent = '✓ Ready to work offline'; el.className = 'fine ok'; })
      .catch(() => { el.textContent = 'Offline mode unavailable (needs https or localhost)'; });
  })();

  // for tests and debugging in the console
  window.__field = { S, C, compass, store, capture, buildZip, csv, pointsGJ, APP };
})();
