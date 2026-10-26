/* CropView 3S — field edition for Saikat, Swarnakhali.
 * Built on the CropView sensor core (sensor-core.js) and FloodView's store (field-store.js):
 * walk, pick a tag, shoot. Each photo keeps position, look direction, tilt, ground
 * footprint, its tag and the date in both calendars.
 * Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License */
(function () {
  'use strict';
  const APP = { name: 'CropView 3S', version: '3S.1.0', db: 'cropview-3s-saikat', idPrefix: 'CV3S' };
  // Starting tags, from the first walk around Swarnakhali. Keys go into the export; keep them stable.
  const PRESETS = [
    { k: 'banana', label: 'Banana', bn: 'কলা', col: '#a3e635', img: 'img/banana.jpg' },
    { k: 'vegetable', label: 'Vegetables', bn: 'সবজি', col: '#34d399', img: 'img/vegetable.jpg' },
    { k: 'grove', label: 'Tree grove', bn: 'বাগান', col: '#2dd4bf', img: 'img/grove.jpg' },
    { k: 'open_field', label: 'Open field', bn: 'মাঠ', col: '#fde047', img: 'img/fieldedge.jpg' },
    { k: 'paddy', label: 'Paddy', bn: 'ধান', col: '#fb923c' },
    { k: 'mustard', label: 'Mustard', bn: 'সর্ষে', col: '#eab308' },
    { k: 'pond', label: 'Pond', bn: 'পুকুর', col: '#60a5fa' },
    { k: 'fallow', label: 'Fallow', bn: 'পতিত', col: '#c4a484' }
  ];
  const EXTRA_COLS = ['#f472b6', '#a78bfa', '#38bdf8', '#f87171', '#86efac', '#fdba74', '#d8b4fe', '#5eead4'];
  const GPS_LOCK = 12, GPS_BLOCK = 30, TILT_MAX = 85, HFOV = 65, CONE_PX = 90;
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  const F = window.FieldSensors, FS = window.FieldStore, B = window.BCal;
  const $ = id => document.getElementById(id);
  const esc = F.esc;
  const ls = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
               set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

  const S = { proj: null, camH: 1.5, fix: null, caps: [], dispAz: 0, map: null, tile: null, sat: false, mapCentred: false, layers: {}, stream: null,
              tags: ls.get('cv3s.tags', null) || PRESETS.slice(), cur: ls.get('cv3s.cur', 'banana') };
  const tagOf = k => S.tags.find(t => t.k === k) || { k, label: k, bn: '', col: '#9fb3a6' };
  if (!S.tags.some(t => t.k === S.cur)) S.cur = S.tags[0].k;
  const saveTags = () => { ls.set('cv3s.tags', S.tags); ls.set('cv3s.cur', S.cur); };

  const gps = F.createGpsSmoother(6);
  const travel = F.createTravelBearing();
  const compass = F.createCompass({
    onWarn: w => toast(w === 'denied' ? 'Motion sensors blocked — allow them in site settings, then tap the compass.' : 'No compass data. Tap the compass to retry.', 'err')
  });
  const C = compass.state;
  const store = FS.openStore(APP.db);
  const wake = FS.keepAwake(() => !!S.proj);

  /* ── Dates ── */
  function bLine(d) {
    const b = B.bengaliDate(d || new Date());
    return b ? `${b.bn} · ${b.weekdayBn} · ${b.rituBn}` : '';
  }
  const dd = new Date();
  const defName = 'Swarnakhali_' + dd.getDate() + dd.toLocaleString('en', { month: 'short' }).toLowerCase();
  $('pname').value = defName;
  $('allow-bdate').textContent = bLine();

  /* ── Start: the motion-sensor prompt must be asked synchronously inside the tap ── */
  $('allow').addEventListener('click', () => { compass.start(); startGPS(); startSurvey(); });
  renderResume();
  function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }

  async function renderResume() {
    await store.ready;
    const list = await store.listSessions();
    $('resume-wrap').hidden = !list.length;
    $('resume-list').innerHTML = list.slice(0, 5).map(s => `
      <button class="resume" type="button" data-name="${esc(s.name)}">
        <span><b>${esc(s.name)}</b><small>${s.count} photo${s.count === 1 ? '' : 's'} · ${esc(new Date(s.updated || s.started).toLocaleDateString('en-IN'))}</small></span><span aria-hidden="true">→</span>
      </button>`).join('');
    $('resume-list').querySelectorAll('.resume').forEach(b => b.addEventListener('click', () => { compass.start(); startGPS(); startSurvey(b.dataset.name); }));
  }

  let gpsOn = false;
  async function startSurvey(resumeName) {
    await store.ready;
    let p;
    if (resumeName) {
      const s = await store.getSession(resumeName);
      if (!s) { toast('Saved survey not found', 'err'); return; }
      p = { name: s.name, notes: s.notes || '', started: s.started, camH: s.camH || 1.5 };
    } else {
      const raw = $('pname').value.trim() || defName;
      const camH = parseFloat($('pcamh').value);
      if (!isFinite(camH) || camH < 0.2 || camH > 60) { toast('Camera height must be 0.2–60 m', 'err'); return; }
      const name = raw.replace(/[^a-zA-Z0-9_\-.]/g, '_');
      const old = await store.getSession(name);
      p = { name, notes: '', started: old ? old.started : new Date().toISOString(), camH };
      if (old) toast('Continuing ' + name, 'ok');
    }
    S.proj = p; S.camH = p.camH;
    await saveSession();
    show('none');
    $('app').hidden = false;
    $('h-proj').textContent = p.name;
    $('ver').textContent = APP.version;
    updDates();
    renderTags(); startCamera(); initMap(); wake();
    S.caps = (await store.capsFor(p.name)).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    renderList(); drawCaps();
    if (store.mem) toast('Phone storage unavailable — export a ZIP before closing', 'err');
    requestAnimationFrame(loop);
    if (!ls.get('cv3s.toured', false)) setTimeout(() => tour.start(), 600);
  }
  function saveSession() {
    const p = S.proj;
    return store.putSession({ name: p.name, notes: p.notes, camH: S.camH, started: p.started, updated: new Date().toISOString(), count: S.caps.length });
  }
  function updDates() {
    const b = B.bengaliDate(new Date());
    const en = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    $('bstrip').innerHTML = b ? `<b class="bn">${esc(b.bn)}</b> <span class="bn">· ${esc(b.rituBn)}</span> · ${esc(en)}` : esc(en);
    $('about-bdate').textContent = b ? `${bLine()} · ${b.en} · ${b.rituEn}` : '';
  }
  setInterval(() => { if (S.proj) updDates(); }, 60000);

  /* ── Sensors ── */
  function startGPS() {
    if (gpsOn) return; gpsOn = true;
    if (!navigator.geolocation) { toast('This browser has no location access', 'err'); return; }
    navigator.geolocation.watchPosition(p => { const g = gps.push(p.coords); if (g) { S.fix = g; travel.update(g); } },
      e => toast('GPS: ' + e.message, 'err'), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  async function startCamera() {
    try {
      if (S.stream) S.stream.getTracks().forEach(t => t.stop());
      S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      $('video').srcObject = S.stream;
    } catch (e) { toast('Camera: ' + e.message, 'err'); }
  }
  $('compass').addEventListener('click', () => {
    compass.recalibrate();
    if (C.perm !== 'denied') toast('Recalibrating — draw a slow figure-8 with the phone', 'ok');
  });
  const heading = () => C.heading, tilt = () => C.tilt;
  const fp = () => F.footprint({ camH: S.camH, tilt: tilt(), hfov: HFOV, tiltMax: TILT_MAX });
  const aim = h => (S.fix && heading() !== null) ? F.aimPoint(S.fix.lat, S.fix.lon, h ?? heading(), { camH: S.camH, tilt: tilt(), tiltMax: TILT_MAX }) : null;

  /* ── Render loop (decoupled from sensor events) ── */
  let lastSlow = 0;
  function loop(ts) {
    if (heading() !== null) S.dispAz = F.lerpAngle(S.dispAz, heading(), 0.2);
    $('rose').style.transform = `rotate(${-S.dispAz}deg)`;
    $('ring').setAttribute('stroke', C.signal === 'OK' ? 'rgba(74,222,128,.7)' : C.signal === 'STALE' ? 'var(--mustard)' : 'var(--red)');
    if (ts - lastSlow > 150) { lastSlow = ts; updHUD(); if (activeTab === 'map') updCone(); }
    requestAnimationFrame(loop);
  }
  const azLbl = a => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N'][Math.round(a / 45) % 8];
  function setChip(id, text, cls) { const e = $(id); e.textContent = text; e.className = 'chip' + (cls ? ' ' + cls : '') + (id === 'h-src' ? ' src' : ''); }
  function updHUD() {
    const g = S.fix, h = heading(), t = tilt();
    setChip('h-acc', g ? `${g.acc <= GPS_LOCK ? '⊕ ' : ''}± ${g.acc.toFixed(0)} m` : 'GPS…', !g ? 'warn' : g.acc <= GPS_LOCK ? 'ok' : g.acc <= GPS_BLOCK ? 'warn' : 'bad');
    const sc = C.signal === 'OK' ? '' : C.signal === 'STALE' ? 'warn' : 'bad';
    setChip('h-hdg', h === null ? 'HDG —' : `${Math.round(h)}° ${azLbl(h)}`, sc);
    setChip('h-tilt', t === null ? 'TILT —' : `TILT ${t}°`, t === null ? 'warn' : t > 90 ? 'warn' : '');
    setChip('h-src', C.src, sc || 'ok');
  }

  /* ── Tags ── */
  function swStyle(t) { return `--c:${t.col};${t.img ? `background-image:url('${t.img}')` : ''}`; }
  function renderTags() {
    $('tagrail').innerHTML = S.tags.map(t => `
      <button type="button" class="tag" role="radio" aria-checked="${t.k === S.cur}" data-k="${esc(t.k)}" style="--c:${t.col}">
        <span class="sw" style="${swStyle(t)}"></span><span class="t">${esc(t.label)}${t.bn ? `<small class="bn">${esc(t.bn)}</small>` : ''}</span>
      </button>`).join('') + '<button type="button" class="tag add" id="tag-plus">+ Tag</button>';
    $('tagrail').querySelectorAll('.tag[data-k]').forEach(b => b.addEventListener('click', () => { S.cur = b.dataset.k; saveTags(); renderTags(); }));
    $('tag-plus').addEventListener('click', () => { $('tag-sheet').hidden = false; $('sheet-tag').value = ''; setTimeout(() => $('sheet-tag').focus(), 50); });
    const c = tagOf(S.cur);
    $('shutter').style.setProperty('--tc', c.col);
    $('cur-tag').innerHTML = `${esc(c.label)}${c.bn ? `<small class="bn">${esc(c.bn)}</small>` : ''}`;
    $('map-legend').innerHTML = S.tags.filter(t => S.caps.some(x => x.cls === t.k)).map(t => `<span><i style="background:${t.col}"></i>${esc(t.label)}</span>`).join('');
    renderTagManage();
    const on = $('tagrail').querySelector('[aria-checked="true"]'); if (on) on.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
  // "Jute · পাট" or "Jute পাট" → label + Bengali part
  function addTag(raw) {
    raw = (raw || '').trim(); if (!raw) return false;
    const m = raw.match(/^(.*?)[\s·|/-]*([ঀ-৿][ঀ-৿\s]*)$/);
    let label = raw, bn = '';
    if (m) { label = m[1].trim() || m[2].trim(); bn = m[1].trim() ? m[2].trim() : ''; }
    let k = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!k) k = 'tag';
    if (S.tags.some(t => t.k === k)) { if (S.tags.find(t => t.k === k).label.toLowerCase() === label.toLowerCase()) { S.cur = k; saveTags(); renderTags(); toast('Tag already there — selected', 'ok'); return true; } k += '_' + S.tags.length; }
    const used = S.tags.length - PRESETS.length;
    S.tags.push({ k, label, bn, col: EXTRA_COLS[((used % EXTRA_COLS.length) + EXTRA_COLS.length) % EXTRA_COLS.length], custom: true });
    S.cur = k; saveTags(); renderTags(); renderList();
    toast('Tag added: ' + label, 'ok'); return true;
  }
  $('sheet-ok').addEventListener('click', () => { if (addTag($('sheet-tag').value)) $('tag-sheet').hidden = true; });
  $('sheet-tag').addEventListener('keydown', e => { if (e.key === 'Enter') $('sheet-ok').click(); });
  $('sheet-cancel').addEventListener('click', () => { $('tag-sheet').hidden = true; });
  $('b-add-tag').addEventListener('click', () => { if (addTag($('new-tag').value)) $('new-tag').value = ''; });
  function renderTagManage() {
    $('tag-manage').innerHTML = S.tags.map(t => {
      const n = S.caps.filter(c => c.cls === t.k).length;
      return `<div class="tm"><span class="sw" style="${swStyle(t)}"></span><span>${esc(t.label)} <small class="bn">${esc(t.bn || '')}</small></span><small>${n}</small>${t.custom && !n ? `<button type="button" data-rm="${esc(t.k)}">Remove</button>` : ''}</div>`;
    }).join('');
    $('tag-manage').querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      S.tags = S.tags.filter(t => t.k !== b.dataset.rm); if (S.cur === b.dataset.rm) S.cur = S.tags[0].k; saveTags(); renderTags();
    }));
  }

  /* ── Capture: read every sensor synchronously at the tap, then await ── */
  let busy = false;
  $('shutter').addEventListener('click', () => capture());
  async function capture() {
    if (busy || !S.proj) return;
    const g = S.fix;
    if (!g) { toast('No GPS fix yet — wait a moment', 'err'); return; }
    if (g.acc > GPS_BLOCK) { toast(`GPS too weak (± ${g.acc.toFixed(0)} m) — move to open sky`, 'err'); return; }
    const vid = $('video');
    if (!vid.videoWidth) { toast('Camera not ready yet', 'err'); return; }
    busy = true; $('shutter').classList.add('busy');
    try {
      const cv = $('snap'); cv.width = vid.videoWidth; cv.height = vid.videoHeight;
      cv.getContext('2d').drawImage(vid, 0, 0);
      const now = new Date(), ms = now.getTime(), h = heading(), t = tilt(), cls = S.cur;
      const f = fp(), ring = (f && h !== null) ? F.footprintRing(g.lat, g.lon, h, f) : null, a = aim(h);
      const tb = travel.get(), rel = F.lookRelTravel(h, tb), b = B.bengaliDate(now);
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
        bdate: b ? { bn: b.bn, en: b.en, ritu: b.rituEn, rituBn: b.rituBn } : null,
        cls, note: '', thumb: null
      };
      const fl = $('flash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      if (navigator.vibrate) try { navigator.vibrate(18); } catch (e) {}
      cap.thumb = thumbOf(cv);
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
      await store.putPhoto(id, blob);
      await store.putCap(cap);
      S.caps.unshift(cap);
      await saveSession();
      renderList(); drawCaps(); renderTags();
      const warn = h === null || C.signal === 'LOST' ? ' · no compass fix' : g.acc > GPS_LOCK ? ' · weak GPS' : '';
      toast(tagOf(cls).label + ' saved' + warn, warn ? '' : 'ok');
    } catch (e) { console.error(e); toast('Capture failed: ' + e.message, 'err'); }
    finally { busy = false; $('shutter').classList.remove('busy'); }
  }
  function thumbOf(src) {
    const W = 320, H = Math.round(src.height * W / src.width) || 180, c = document.createElement('canvas');
    c.width = W; c.height = H; c.getContext('2d').drawImage(src, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.62);
  }
  $('last').addEventListener('click', () => { if (S.caps.length) goTab('data'); });

  /* ── Map ── */
  function initMap() {
    if (S.map) return;
    S.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([22.57, 88.36], 9);   // West Bengal until the first fix
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
    if (!S.me) S.me = L.circleMarker([g.lat, g.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#4ade80', fillOpacity: 1, interactive: false }).addTo(S.map);
    else S.me.setLatLng([g.lat, g.lon]);
    if (!S.mapCentred) { S.map.setView([g.lat, g.lon], 18); S.mapCentred = true; }
    const col = C.signal === 'OK' ? '#4ade80' : C.signal === 'STALE' ? '#facc15' : '#f87171';
    if (heading() === null) { ['cone', 'live'].forEach(k => { if (S.layers[k]) { S.map.removeLayer(S.layers[k]); S.layers[k] = null; } }); return; }
    const h = S.dispAz;
    const mpp = 156543.03392 * Math.cos(g.lat * F.D2R) / Math.pow(2, S.map.getZoom());
    const len = Math.max(CONE_PX * mpp, 3), cone = [[g.lat, g.lon]];
    for (let i = 0; i <= 10; i++) cone.push(F.geoDest(g.lat, g.lon, len, h - HFOV / 2 + HFOV * i / 10));
    if (!S.layers.cone) S.layers.cone = L.polygon(cone, { color: col, weight: 1, fillColor: col, fillOpacity: .22, interactive: false }).addTo(S.map);
    else { S.layers.cone.setLatLngs(cone); S.layers.cone.setStyle({ color: col, fillColor: col }); }
    const f = fp(), r = f ? F.footprintRing(g.lat, g.lon, h, f) : null;
    if (r) { const ll = r.map(p => [p[1], p[0]]);
      if (!S.layers.live) S.layers.live = L.polygon(ll, { color: '#fff', weight: 1.2, dashArray: '3 3', fillColor: col, fillOpacity: .25, interactive: false }).addTo(S.map);
      else { S.layers.live.setLatLngs(ll); S.layers.live.setStyle({ fillColor: col }); } }
    else if (S.layers.live) { S.map.removeLayer(S.layers.live); S.layers.live = null; }
  }
  function drawCaps() {
    if (!S.map) return;
    S.layers.fp.clearLayers(); S.layers.caps.clearLayers();
    [...S.caps].reverse().forEach(c => {
      const col = tagOf(c.cls).col;
      if (c.ring) S.layers.fp.addLayer(L.polygon(c.ring.map(p => [p[1], p[0]]), { color: col, weight: 1.2, fillColor: col, fillOpacity: .16, interactive: false }));
      S.layers.caps.addLayer(L.circleMarker([c.lat, c.lon], { radius: 7, color: '#fff', weight: 2, fillColor: col, fillOpacity: .95 })
        .bindPopup(() => `${c.thumb ? `<img src="${c.thumb}" alt="">` : ''}<b>${esc(tagOf(c.cls).label)}</b> <span class="bn">${esc(tagOf(c.cls).bn || '')}</span><br>${esc(new Date(c.timestamp).toLocaleString('en-IN'))}${c.bdate ? '<br><span class="bn">' + esc(c.bdate.bn) + '</span>' : ''}<br>HDG ${c.heading ?? '—'}° · tilt ${c.tilt ?? '—'}°${c.note ? '<br>' + esc(c.note) : ''}`));
    });
  }

  /* ── Tabs ── */
  let activeTab = 'cam';
  function goTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach(x => { const on = x.dataset.tab === name; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); });
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + name));
    if (name === 'map' && S.map) setTimeout(() => { S.map.invalidateSize(); updCone(); }, 50);
    if (name === 'data') updStore();
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => goTab(t.dataset.tab)));

  /* ── Data: list, retag, note, delete ── */
  async function updStore() {
    let t = store.mem ? 'In memory only — export before closing.' : `${S.caps.length} photos on this phone`;
    const u = await store.usage(); if (u !== null && !store.mem) t += ` · ${(u / 1048576).toFixed(1)} MB`;
    $('store-info').textContent = t;
  }
  function renderList() {
    const n = S.caps.length;
    $('h-count').textContent = n + ' cap';
    $('cap-h').textContent = `Captures (${n})`;
    $('last-img').src = n ? (S.caps[0].thumb || '') : '';
    if (!n) { $('cap-list').innerHTML = '<p class="empty">No photos yet. Pick a tag on the Capture tab and tap the shutter.</p>'; return; }
    const opts = sel => S.tags.map(t => `<option value="${esc(t.k)}"${t.k === sel ? ' selected' : ''}>${esc(t.label)}${t.bn ? ' · ' + esc(t.bn) : ''}</option>`).join('')
      + (S.tags.some(t => t.k === sel) ? '' : `<option value="${esc(sel)}" selected>${esc(sel)}</option>`);
    $('cap-list').innerHTML = S.caps.map(c => `
      <div class="cap">
        <img src="${c.thumb || ''}" alt="" />
        <div>
          <div class="id">${esc(c.id)}</div>
          <div class="m">${esc(new Date(c.timestamp).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}${c.bdate ? `<br><span class="bn">${esc(c.bdate.bn)}</span>` : ''}<br>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)} · ±${(c.accuracy || 0).toFixed(0)} m<br>AZ:${c.heading ?? '—'}° · Tilt:${c.tilt ?? '—'}°</div>
          <select data-retag="${esc(c.id)}" aria-label="Tag">${opts(c.cls)}</select>
          <input data-note="${esc(c.id)}" value="${esc(c.note || '')}" placeholder="Note (optional)" maxlength="200" />
        </div>
        <div class="acts"><button type="button" data-map="${esc(c.id)}">MAP</button><button type="button" data-save="${esc(c.id)}">SAVE</button><button type="button" class="del" data-del="${esc(c.id)}">DEL</button></div>
      </div>`).join('');
    const find = id => S.caps.find(c => c.id === id);
    const persist = async c => { c.edited = Date.now(); await store.putCap(c); };
    $('cap-list').querySelectorAll('[data-retag]').forEach(s => s.addEventListener('change', async () => {
      const c = find(s.dataset.retag); c.cls = s.value; await persist(c); drawCaps(); renderTags(); toast('Tag changed to ' + tagOf(c.cls).label, 'ok');
    }));
    $('cap-list').querySelectorAll('[data-note]').forEach(i => i.addEventListener('change', async () => {
      const c = find(i.dataset.note); c.note = i.value.trim(); await persist(c); drawCaps(); toast('Note saved', 'ok');
    }));
    $('cap-list').querySelectorAll('[data-map]').forEach(b => b.addEventListener('click', () => {
      const c = find(b.dataset.map); goTab('map'); setTimeout(() => S.map.setView([c.lat, c.lon], 19), 80);
    }));
    $('cap-list').querySelectorAll('[data-save]').forEach(b => b.addEventListener('click', async () => {
      const c = find(b.dataset.save), blob = await store.getPhoto(c.id);
      if (blob) FS.download(blob, c.imgName); else toast('Photo not on this phone', 'err');
    }));
    $('cap-list').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this photo and its record?')) return;
      S.caps = S.caps.filter(c => c.id !== b.dataset.del);
      await store.delCap(b.dataset.del); await saveSession(); renderList(); drawCaps(); renderTags();
    }));
  }

  /* ── Export (same layout as CropView/FloodView, so the Data Explorer opens it) ── */
  function props(c) {
    const t = tagOf(c.cls);
    return {
      id: c.id, imgName: c.imgName, timestamp: c.timestamp, project: c.project,
      tag: c.cls, tag_label: t.label, tag_label_bn: t.bn || null, class: c.cls, note: c.note || null,
      bengali_date: c.bdate ? c.bdate.en : null, bengali_date_bn: c.bdate ? c.bdate.bn : null, ritu: c.bdate ? c.bdate.ritu : null,
      heading_deg: c.heading, azimuth_deg: c.heading, heading_source: c.headingSrc, heading_signal: c.signal, sensor_platform: c.platform,
      tilt_deg_from_nadir: c.tilt, tilt_deg: c.tilt, camera_height_m: c.camH, hfov_deg: c.hfov,
      gps_accuracy_m: c.accuracy, gps_samples: c.gpsSamples, altitude_m: c.altitude,
      aim_lat: c.aim ? +c.aim.lat.toFixed(8) : null, aim_lon: c.aim ? +c.aim.lon.toFixed(8) : null, aim_dist_m: c.aim ? +c.aim.dist.toFixed(2) : null,
      footprint_width_m: c.fp ? +c.fp.w.toFixed(2) : null, footprint_depth_m: c.fp ? +c.fp.d.toFixed(2) : null,
      travel_bearing_deg: c.travelBrg, look_side: c.lookSide
    };
  }
  const chrono = () => [...S.caps].reverse();
  const meta = extra => Object.assign({ app: APP.name, version: APP.version, project: S.proj.name, village: 'Swarnakhali, West Bengal', session_started: S.proj.started, exported: new Date().toISOString(), captures: S.caps.length }, extra || {});
  const pointsGJ = () => ({ type: 'FeatureCollection', metadata: meta(), features: chrono().map(c => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: props(c),
    ...(c.ring ? { fov_polygon: { type: 'Polygon', coordinates: [c.ring] } } : {}) })) });
  const footprintsGJ = () => ({ type: 'FeatureCollection', metadata: meta(), features: chrono().filter(c => c.ring).map(c => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [c.ring] }, properties: props(c) })) });
  const COLS = ['id', 'imgName', 'timestamp', 'bengali_date', 'bengali_date_bn', 'ritu', 'lat', 'lon', 'tag', 'tag_label', 'tag_label_bn', 'note', 'heading_deg', 'heading_source', 'tilt_deg_from_nadir', 'camera_height_m', 'gps_accuracy_m', 'altitude_m', 'aim_lat', 'aim_lon', 'aim_dist_m', 'footprint_width_m', 'footprint_depth_m', 'look_side'];
  const csv = () => '﻿' + [COLS.join(','), ...chrono().map(c => { const p = props(c); p.lat = c.lat; p.lon = c.lon; return COLS.map(k => F.csvCell(p[k])).join(','); })].join('\n');   // BOM: Excel shows Bengali correctly
  const readme = () => [
    `${APP.name} export · ${S.proj.name} · Swarnakhali, West Bengal`, '',
    'images/  photos named {Survey}_{ID}_{UTC time}_{lat}_{lon}.jpg',
    'data/    *_captures_points.geojson      one point per photo, all fields',
    '         *_captures_footprints.geojson  ground footprint polygon of each photo',
    '         *_captures.csv                 the same records as a table (UTF-8)', '',
    'tag / tag_label / tag_label_bn  the tag chosen in the field (tag = stable key)',
    'bengali_date                    Bangabda date (West Bengal Panjika), civil date in IST',
    'heading_deg          camera look direction, clockwise from true north (null = no compass fix)',
    'tilt_deg_from_nadir  0 = straight down, 90 = horizon',
    'camera_height_m      camera height above the ground (not GPS altitude)', '',
    `${APP.name} ${APP.version} · Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT License`
  ].join('\n');
  function buildZip() {
    const pn = S.proj.name;
    return FS.buildZip({ store, caps: S.caps, imgNameOf: c => c.imgName, zipName: `${pn}_CropView3S_${new Date().toISOString().split('T')[0]}.zip`,
      files: [
        { path: `data/${pn}_captures_points.geojson`, content: JSON.stringify(pointsGJ(), null, 2) },
        { path: `data/${pn}_captures_footprints.geojson`, content: JSON.stringify(footprintsGJ(), null, 2) },
        { path: `data/${pn}_captures.csv`, content: csv() },
        { path: 'README.txt', content: readme() }
      ] });
  }
  $('b-zip').addEventListener('click', async () => {
    if (!S.caps.length) { toast('No photos yet', 'err'); return; }
    toast('Building ZIP…');
    try { const z = await buildZip(); FS.download(z.blob, z.name); toast(z.missing ? z.missing + ' photo(s) missing — exported without them' : 'ZIP exported ✓', z.missing ? 'err' : 'ok'); }
    catch (e) { toast('Export failed: ' + e.message, 'err'); }
  });
  const sharer = FS.createSharer({ build: buildZip, keyOf: () => S.proj.name + '|' + S.caps.map(c => c.id + (c.edited || '')).join(','),
    onLabel: ready => { $('b-share').textContent = ready ? 'Tap to share' : 'Share ZIP'; }, onToast: toast });
  if (sharer.canShareFiles()) $('b-share').hidden = false;
  $('b-share').addEventListener('click', () => { if (!S.caps.length) { toast('No photos yet', 'err'); return; } sharer.share().catch(e => toast('Share failed: ' + e.message, 'err')); });

  /* ── About ── */
  $('b-help').addEventListener('click', () => { updDates(); $('about').hidden = false; });
  $('about-close').addEventListener('click', () => { $('about').hidden = true; });
  $('b-tour').addEventListener('click', () => { $('about').hidden = true; goTab('cam'); tour.start(); });
  document.querySelectorAll('.sheet-ov').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.hidden = true; }));

  /* ── First-run tutorial: a spotlight that walks across the real controls ── */
  const tour = (function () {
    const STEPS = [
      { el: null, h: 'Welcome, Saikat', p: 'A field camera for Swarnakhali. Six quick tips — about twenty seconds.', bn: 'স্বাগতম! মাঠের ছবি তোলার জন্য।' },
      { el: '#tagrail', h: 'Pick a tag first', p: 'Every photo gets the tag that is lit. It stays on until you pick another. “+ Tag” adds your own name.', bn: 'আগে ট্যাগ বেছে নিন — যেমন কলা, সবজি, ধান।' },
      { el: '#shutter', h: 'Tap to capture', p: 'Position, direction, tilt and today’s date in both calendars are saved with the photo.', bn: 'ছবি তুলতে বোতামে চাপুন।' },
      { el: '#h-acc', h: 'Wait for good GPS', p: 'Green ⊕ means ± 12 m or better. Over ± 30 m the shutter waits — step into the open.', bn: 'খোলা জায়গায় দাঁড়ান, জিপিএস সবুজ হলে ছবি তুলুন।' },
      { el: '#compass', h: 'Direction looks wrong?', p: 'Tap the compass and draw a slow figure-8 with the phone, away from metal and bikes.', bn: 'কম্পাসে চাপুন, ফোনটা ৮-এর মতো ঘোরান।' },
      { el: '.tabs', h: 'Map and Data', p: 'Map shows every shot. Data lets you change a tag, add a note, and export a ZIP — do it before you leave the field.', bn: 'মাঠ ছাড়ার আগে ZIP এক্সপোর্ট করুন।' }
    ];
    let i = 0;
    function place() {
      const s = STEPS[i], hole = $('tour-hole'), card = $('tour-card');
      $('tour-step').textContent = `${i + 1} / ${STEPS.length}`;
      $('tour-h').textContent = s.h; $('tour-p').textContent = s.p; $('tour-bn').textContent = s.bn;
      $('tour-next').textContent = i === STEPS.length - 1 ? 'Start' : 'Next';
      const el = s.el && document.querySelector(s.el);
      const ch = card.offsetHeight || 220, vh = window.innerHeight;
      if (!el) { hole.className = 'none'; card.style.top = Math.max(20, (vh - ch) / 2) + 'px'; return; }
      const r = el.getBoundingClientRect(), pad = 6;
      hole.className = '';
      Object.assign(hole.style, { left: (r.left - pad) + 'px', top: (r.top - pad) + 'px', width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
        borderRadius: el.id === 'shutter' || el.id === 'compass' ? '50%' : '18px' });
      card.style.top = (r.top > vh / 2 ? Math.max(12, r.top - ch - 22) : Math.min(vh - ch - 12, r.bottom + 22)) + 'px';
    }
    function start() { i = 0; $('tour').hidden = false; place(); requestAnimationFrame(place); }
    function end() { $('tour').hidden = true; ls.set('cv3s.toured', true); }
    $('tour-next').addEventListener('click', () => { if (++i >= STEPS.length) end(); else place(); });
    $('tour-skip').addEventListener('click', end);
    window.addEventListener('resize', () => { if (!$('tour').hidden) place(); });
    return { start, end };
  })();

  /* ── Small things ── */
  let tt;
  function toast(m, cls) { const e = $('toast'); e.textContent = m; e.className = 'show' + (cls ? ' ' + cls : ''); clearTimeout(tt); tt = setTimeout(() => { e.className = ''; }, 3200); }
  (function () { try { const m = navigator.deviceMemory; if (m && m <= 2) document.documentElement.classList.add('g-lite'); } catch (e) {} })();
  (function () {
    const el = $('offline-state');
    if (!('serviceWorker' in navigator)) { el.textContent = 'Offline mode not supported in this browser'; return; }
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready)
      .then(() => { el.textContent = '✓ Works offline'; el.className = 'fine ok'; })
      .catch(() => { el.textContent = 'Offline mode unavailable (needs https)'; });
  })();

  window.__field = { S, C, compass, store, capture, buildZip, csv, pointsGJ, APP, addTag, tour };
})();
