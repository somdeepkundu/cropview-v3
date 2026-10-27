/* field-store.js — keep field captures safe on the phone and get them off it.
 *
 * From FloodView 1.1 (somdeepkundu/floodview, index.html):
 *  • Full-resolution photos as Blobs in IndexedDB + navigator.storage.persist(),
 *    so they survive a reload, a closed tab or a dead battery. Memory fallback
 *    (some private windows) with a loud "export before closing" warning.
 *  • Sessions keyed by survey name → a resume list after reload.
 *  • ZIP export: images/ + data/*_points.geojson + *_footprints.geojson + *.csv + README.txt.
 *  • Two-tap share: Android opens the share sheet only right after a tap, and
 *    building a ZIP takes longer than that window (FloodView 1.0.2 fix).
 *
 * Needs vendor/jszip.min.js for the ZIP. Somdeep Kundu, RuDRA Lab, C-TARA, IIT Bombay · MIT
 */
(function (root) {
  'use strict';

  function openStore(dbName) {
    const DB = { db: null, mem: false, memCaps: {}, memPhotos: {}, memSess: {} };
    DB.ready = (async () => {
      try {
        if (!('indexedDB' in root)) throw new Error('no IndexedDB');
        DB.db = await new Promise((res, rej) => {
          const r = indexedDB.open(dbName, 1);
          r.onupgradeneeded = () => {
            const d = r.result;
            if (!d.objectStoreNames.contains('caps')) d.createObjectStore('caps', { keyPath: 'id' }).createIndex('project', 'project');
            if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
            if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'name' });
          };
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked'));
        });
        // Ask the browser not to evict this origin's data under storage pressure.
        try { if (navigator.storage && navigator.storage.persist) DB.persisted = await navigator.storage.persist(); } catch (e) {}
      } catch (e) { DB.mem = true; console.warn('IndexedDB unavailable, keeping captures in memory', e); }
    })();
    function req(store, mode, fn) {
      return new Promise((res, rej) => {
        const tx = DB.db.transaction(store, mode); const r = fn(tx.objectStore(store));
        tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted'));
      });
    }
    DB.putCap = async c => { if (DB.mem) { DB.memCaps[c.id] = c; return; } await req('caps', 'readwrite', s => s.put(c)); };
    DB.delCap = async id => {
      if (DB.mem) { delete DB.memCaps[id]; delete DB.memPhotos[id]; return; }
      await req('caps', 'readwrite', s => s.delete(id)); await req('photos', 'readwrite', s => s.delete(id));
      await req('photos', 'readwrite', s => s.delete(IDBKeyRange.bound(id + '#', id + '#￿')));
    };
    DB.putPhoto = async (id, blob) => { if (DB.mem) { DB.memPhotos[id] = blob; return; } await req('photos', 'readwrite', s => s.put(blob, id)); };
    DB.getPhoto = async id => { if (DB.mem) return DB.memPhotos[id] || null; return (await req('photos', 'readonly', s => s.get(id))) || null; };
    /* Video is written in pieces while recording ("<id>#000001", …), so a crash or a
       dead battery mid-take loses seconds, not the clip. joinParts() glues them into
       one Blob under <id> and removes the pieces. */
    const partRange = id => IDBKeyRange.bound(id + '#', id + '#￿');
    DB.putPart = async (id, seq, blob) => {
      const k = id + '#' + String(seq).padStart(6, '0');
      if (DB.mem) { DB.memPhotos[k] = blob; return; }
      await req('photos', 'readwrite', s => s.put(blob, k));
    };
    DB.getParts = async id => {
      if (DB.mem) return Object.keys(DB.memPhotos).filter(k => k.startsWith(id + '#')).sort().map(k => DB.memPhotos[k]);
      return (await req('photos', 'readonly', s => s.getAll(partRange(id)))) || [];
    };
    DB.joinParts = async (id, type) => {
      const parts = await DB.getParts(id);
      if (!parts.length) return null;
      const blob = new Blob(parts, { type });
      await DB.putPhoto(id, blob);
      if (DB.mem) Object.keys(DB.memPhotos).filter(k => k.startsWith(id + '#')).forEach(k => delete DB.memPhotos[k]);
      else await req('photos', 'readwrite', s => s.delete(partRange(id)));
      return blob;
    };
    DB.capsFor = async project => {
      if (DB.mem) return Object.values(DB.memCaps).filter(c => c.project === project);
      return (await req('caps', 'readonly', s => s.index('project').getAll(project))) || [];
    };
    DB.putSession = async s => { if (DB.mem) { DB.memSess[s.name] = s; return; } try { await req('sessions', 'readwrite', st => st.put(s)); } catch (e) {} };
    DB.getSession = async name => { if (DB.mem) return DB.memSess[name] || null; try { return (await req('sessions', 'readonly', s => s.get(name))) || null; } catch (e) { return null; } };
    DB.listSessions = async () => {
      const all = DB.mem ? Object.values(DB.memSess) : ((await req('sessions', 'readonly', s => s.getAll()).catch(() => [])) || []);
      return all.filter(s => s.count > 0).sort((x, y) => (y.updated || '').localeCompare(x.updated || ''));
    };
    DB.usage = async () => { try { if (navigator.storage && navigator.storage.estimate) return (await navigator.storage.estimate()).usage; } catch (e) {} return null; };
    return DB;
  }

  /* Download a Blob or string. On Capacitor the WebView ignores <a download>;
     native-bridge.js intercepts this click and routes it to Filesystem + Share. */
  function download(content, name, type) {
    const b = content instanceof Blob ? content : new Blob([content], { type: type || 'application/octet-stream' });
    const u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  /* Build the export ZIP. `files` is [{path, content}] for data files; photos are
     pulled from the store by capture id. Returns {blob, name, missing}. */
  async function buildZip({ store, caps, imgNameOf, files, zipName }) {
    if (typeof JSZip === 'undefined') throw new Error('ZIP library not loaded (vendor/jszip.min.js)');
    const zip = new JSZip(); let missing = 0;
    for (const c of caps) {
      const b = await store.getPhoto(c.id);
      if (b) zip.file('images/' + imgNameOf(c), b, { binary: true }); else missing++;
    }
    for (const f of files) zip.file(f.path, f.content);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { blob, name: zipName, missing };
  }

  /* Two-tap share. First tap builds the ZIP and tries to share; if the tap's
     user-activation expired while building (Android: "Permission denied" /
     NotAllowedError), keep the file and relabel the button "TAP TO SHARE".
     The second tap calls navigator.share() with no await before it.
     keyOf() must change whenever the data changes, so a stale ZIP is never sent. */
  function createSharer({ build, keyOf, onLabel, onToast }) {
    let ready = null;
    const canShareFiles = () => {
      try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 't.zip', { type: 'application/zip' })] })); } catch (e) { return false; }
    };
    function shareReady() {
      const f = ready.file;
      navigator.share({ files: [f], title: f.name })
        .then(() => { ready = null; onLabel(false); })
        .catch(e => { if (e && e.name === 'AbortError') return; onToast('Share failed: ' + e.message + ' — use Export ZIP', 'err'); });
    }
    async function share() {
      if (ready && ready.key === keyOf()) { shareReady(); return 'shared-ready'; }   // 2nd tap: nothing awaited before share()
      const z = await build();
      const f = new File([z.blob], z.name, { type: 'application/zip' });
      if (!(navigator.canShare && navigator.canShare({ files: [f] }))) { download(z.blob, z.name); onToast('Sharing files is not supported here — downloaded instead', 'err'); return 'downloaded'; }
      ready = { file: f, key: keyOf() };
      try { await navigator.share({ files: [f], title: z.name }); ready = null; onLabel(false); return 'shared'; }
      catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        onLabel(true); onToast('ZIP ready — tap Share once more', 'ok');               // the tap expired while building
        return 'needs-second-tap';
      }
    }
    return { share, canShareFiles, get pending() { return !!ready; } };
  }

  /* Screen wake lock for the length of a survey; re-acquired when the tab returns. */
  function keepAwake(isActive) {
    let lock = null;
    async function get() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch (e) {} }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && isActive()) get(); });
    return get;
  }

  root.FieldStore = { openStore, download, buildZip, createSharer, keepAwake };
})(typeof self !== 'undefined' ? self : this);
