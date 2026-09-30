/* CropView native bridge (Android / Capacitor only — does nothing on the web build).
 *
 * 1. Exports: Android WebView ignores <a download>, so every download the app
 *    triggers (photo SAVE, ZIP, GeoJSON, CSV) is written to the device and handed
 *    to the Android share sheet (Drive, WhatsApp, Files, Gmail…).
 * 2. Photos: the web build keeps full-res images only in memory (saveCaps stores
 *    full:null), so they are lost if the app is closed. Here each full image is
 *    also written to app storage and reloaded on start.
 */
(function () {
  const Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;
  const { Filesystem, Share } = Cap.Plugins;
  const DATA = 'DATA', CACHE = 'CACHE', DIR = 'captures';

  const blobToB64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });

  /* ── 1. Downloads → file + share sheet ── */
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (u) => setTimeout(() => revoke(u), 60000); // app revokes right after click()

  async function saveAndShare(href, name) {
    try {
      const b64 = href.startsWith('data:') ? href.split(',')[1] : await blobToB64(await (await fetch(href)).blob());
      const safe = name.replace(/[\\/:*?"<>|]/g, '_');
      const { uri } = await Filesystem.writeFile({ path: 'exports/' + safe, data: b64, directory: CACHE, recursive: true });
      await Share.share({ title: safe, files: [uri], dialogTitle: 'Save / send ' + safe });
    } catch (e) {
      if (!/cancel/i.test(String(e && e.message))) {
        console.error(e);
        if (typeof toast === 'function') toast('Export failed: ' + (e.message || e), 'err');
      }
    }
  }

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute('download') && /^(blob|data):/.test(this.href)) {
      saveAndShare(this.href, this.getAttribute('download') || 'cropview-export');
      return;
    }
    return nativeClick.call(this);
  };

  // External links (Data Explorer) → open in the phone's browser.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[target="_blank"][href^="http"]');
    if (a) { e.preventDefault(); window.location.href = a.href; }
  }, true);

  /* ── 2. Persist full-resolution photos ── */
  const fileName = (c) => DIR + '/' + String(c.imgName || c.id).replace(/[\\/:*?"<>|]/g, '_') + '.jpg';

  const origSave = window.saveCaps;
  let writing = false;
  window.saveCaps = function () {
    origSave();                                    // metadata → localStorage, as before
    if (writing) return;
    const todo = S.caps.filter((c) => c.full && !c.file);
    if (!todo.length) return;
    writing = true;
    (async () => {
      for (const c of todo) {
        try {
          const path = fileName(c);
          await Filesystem.writeFile({ path, data: c.full.split(',')[1], directory: DATA, recursive: true });
          c.file = path;
        } catch (e) { console.error('photo save failed', e); }
      }
      writing = false;
      origSave();                                  // store the file paths too
      if (S.caps.some((c) => c.full && !c.file)) window.saveCaps(); // captured while writing
    })();
  };

  const origLoad = window.loadCaps;
  window.loadCaps = function () {
    origLoad();
    (async () => {
      let n = 0;
      for (const c of S.caps) {
        if (c.file && !c.full) {
          try {
            const r = await Filesystem.readFile({ path: c.file, directory: DATA });
            c.full = 'data:image/jpeg;base64,' + r.data; n++;
          } catch (e) { console.warn('missing photo', c.file); }
        }
      }
      if (n && typeof rendList === 'function') rendList();
    })();
  };
})();
