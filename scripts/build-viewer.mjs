import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['viewer/engine.js'], bundle: true, minify: true, write: false,
  platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'inline', metafile: true
});
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{--fg:#25334b;--fg-2:#56647a;--bg:#f5f7fb;--layer:#ffffff;--line:#c5cfdf;--accent:#3579d9;--warn:#a35b0b}html,body{margin:0;height:100%;font:13px system-ui;color:var(--fg);background:var(--bg)}body{display:flex;flex-direction:column}header{padding:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,select,input{font:inherit;border:1px solid var(--line);background:var(--layer);color:inherit;border-radius:7px;padding:6px;cursor:pointer}button:disabled,select:disabled,input:disabled{opacity:.55;cursor:default}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent)}#viewport{position:relative;flex:1;min-height:220px;overflow:hidden}#status,#notes{padding:6px 12px;margin:0}#notes{font-size:11px;color:var(--fg-2)}#frame{width:110px;accent-color:var(--accent)}</style></head>
<body><header><strong>Mol* 5.13.1</strong><label>表示 <select id="style"><option value="spacefill">原子球</option><option value="ball-and-stick">球棍</option><option value="cartoon">蛋白骨架</option></select></label><button id="reset">聚焦结构</button><button id="full">完整视野</button><button id="png">导出 PNG</button><button id="manifest">导出来源记录</button><label id="frames" hidden>帧 <input id="frame" type="range" min="1" max="1" value="1" step="1"></label></header><p id="status" role="status">正在读取原始坐标…</p><div id="viewport"></div><p id="notes"></p><script>${script}</script></body></html>`;
await mkdir('lib', { recursive: true });
await writeFile('lib/structure-viewer.html', html);
const license = await readFile('node_modules/molstar/LICENSE', 'utf8');
await writeFile('lib/MOLSTAR-LICENSE', license);
const packages = new Set(Object.keys(result.metafile.inputs).map((path) =>
  path.match(/node_modules\/(?:@[^/]+\/)?[^/]+/)?.[0]).filter(Boolean));
const notices = [];
for (const path of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(`${path}/package.json`, 'utf8'));
  let notice = '';
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'LICENSE-MIT']) {
    try { notice = await readFile(`${path}/${name}`, 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!notice) throw new Error(`Missing license text for bundled dependency ${pkg.name}`);
  const normalized = notice.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license})\n${normalized}`);
}
await writeFile('lib/VIEWER-LICENSES.txt', notices.join('\n\n---\n\n'));
console.log(`Built offline Mol* viewer (${Buffer.byteLength(html)} bytes)`);
