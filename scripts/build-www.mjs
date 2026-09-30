// Builds www/ (the bundled Android app) from the same index.html used on GitHub Pages.
// CDN links are swapped for local copies from node_modules so the app runs with no internet.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';

const OUT = 'www', NM = 'node_modules';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/vendor/fonts`, { recursive: true });

const swaps = [
  [/\s*<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com"\s*\/?>/, ''],
  [/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Comfortaa[^"]*" rel="stylesheet"\s*\/?>/,
   ['300','400','600','700'].map(w => `<link rel="stylesheet" href="vendor/fonts/${w}.css" />`).join('\n  ')],
  [/https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.css/, 'vendor/leaflet/leaflet.css'],
  [/https:\/\/unpkg\.com\/leaflet@[\d.]+\/dist\/leaflet\.js/, 'vendor/leaflet/leaflet.js'],
  [/https:\/\/cdn\.jsdelivr\.net\/npm\/@turf\/turf@6\/turf\.min\.js/, 'vendor/turf.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jszip\/[\d.]+\/jszip\.min\.js/, 'vendor/jszip.min.js'],
  [/<\/body>/, '<script src="cv-native.js"></script>\n</body>'],
];

let html = readFileSync('index.html', 'utf8');
for (const [re, rep] of swaps) {
  if (!re.test(html)) throw new Error(`build-www: pattern not found in index.html: ${re}`);
  html = html.replace(re, rep);
}
writeFileSync(`${OUT}/index.html`, html);

cpSync(`${NM}/leaflet/dist`, `${OUT}/vendor/leaflet`, { recursive: true });
cpSync(`${NM}/@turf/turf/turf.min.js`, `${OUT}/vendor/turf.min.js`);
cpSync(`${NM}/jszip/dist/jszip.min.js`, `${OUT}/vendor/jszip.min.js`);
for (const w of ['300','400','600','700']) cpSync(`${NM}/@fontsource/comfortaa/${w}.css`, `${OUT}/vendor/fonts/${w}.css`);
cpSync(`${NM}/@fontsource/comfortaa/files`, `${OUT}/vendor/fonts/files`, { recursive: true });
cpSync('native/cv-native.js', `${OUT}/cv-native.js`);
console.log('www/ built — fully offline bundle ready.');
