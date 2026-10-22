import { readFileSync } from 'node:fs';
const js = readFileSync('dist/offline/reader.js', 'utf8');
const css = readFileSync('dist/offline/reader.css', 'utf8');
const head = js.slice(0, 120);
const hasImport = /(^|[;{}])\s*import\s*[({"']/.test(js);
const hasExport = /(^|[;{}])\s*export\s/.test(js);
const remoteUrls = [...css.matchAll(/url\(\s*['"]?(?!data:)([^)'"]+)/g)].map((m) => m[1]).slice(0, 8);
const dataUriCount = (css.match(/url\(\s*['"]?data:/g) ?? []).length;
console.log(JSON.stringify({
  jsBytes: js.length,
  cssBytes: css.length,
  head,
  hasImport,
  hasExport,
  dataUriFonts: dataUriCount,
  nonDataUrls: remoteUrls,
  hasSourceMapping: /sourceMappingURL/.test(js),
  mentionsRoot: js.includes('"root"') || js.includes("'root'"),
}, null, 1));
