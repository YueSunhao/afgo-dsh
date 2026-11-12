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
<style>:root{--fg:#25334b;--fg-2:#56647a;--bg:#f5f7fb;--layer:#ffffff;--line:#c5cfdf;--accent:#3579d9;--warn:#a35b0b}
*{box-sizing:border-box}html,body{margin:0;height:100%;font:12px/1.4 system-ui,-apple-system,"PingFang SC",sans-serif;color:var(--fg);background:var(--bg)}
body{display:flex;flex-direction:column}
header{display:flex;gap:4px;align-items:center;padding:6px 8px;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);white-space:nowrap;min-width:0}
button,select,input{font:inherit;color:inherit}
button,select{height:26px;border:1px solid transparent;background:transparent;border-radius:6px;padding:0 8px;cursor:pointer}
select{border-color:var(--line);background:var(--layer);padding:0 4px}
button:hover:not(:disabled){background:color-mix(in srgb,var(--fg) 8%,transparent)}
button:disabled,select:disabled,input:disabled{opacity:.5;cursor:default}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.icon{width:28px;padding:0;font-size:14px}.spacer{flex:1 1 auto}
#frames{display:inline-flex;gap:6px;align-items:center;color:var(--fg-2);margin-left:4px}#frames[hidden]{display:none}
#frame{width:120px;accent-color:var(--accent)}#frameLabel{font-variant-numeric:tabular-nums;min-width:44px}
.menu{position:relative}
#menu{position:absolute;right:0;top:30px;z-index:5;min-width:168px;padding:4px;border:1px solid var(--line);border-radius:8px;background:var(--layer);box-shadow:0 8px 24px #0003;display:flex;flex-direction:column}
#menu[hidden]{display:none}#menu button{text-align:left;height:28px}
#menu .about{margin:4px 8px 2px;padding-top:6px;border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent);color:var(--fg-2);font-size:11px;white-space:normal}
#viewport{position:relative;flex:1;min-height:200px;overflow:hidden}
footer{display:flex;gap:4px 12px;flex-wrap:wrap;padding:6px 10px;border-top:1px solid color-mix(in srgb,var(--line) 55%,transparent);color:var(--fg-2);font-size:11px}
footer .warn{color:var(--warn)}#status{color:var(--fg)}</style></head>
<body><header><select id="style" aria-label="表示方式"><option value="spacefill">原子球</option><option value="ball-and-stick">球棍</option><option value="cartoon">蛋白骨架</option></select><button id="reset" title="把相机对准原子">聚焦</button><button id="full" title="恢复包含晶胞的完整视野">重置视野</button><label id="frames" hidden>帧 <input id="frame" type="range" min="1" max="1" value="1" step="1" aria-label="轨迹帧"><span id="frameLabel">1/1</span></label><span class="spacer"></span><button id="fullscreen" class="icon" title="全屏（Esc 退出）" aria-label="全屏">⤢</button><span class="menu"><button id="more" class="icon" title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded="false">⋯</button><span id="menu" role="menu" hidden><button id="png" role="menuitem">导出 PNG</button><button id="manifest" role="menuitem">导出来源记录</button><span class="about">结构查看器 Mol* 5.13.1，离线运行，不联网。</span></span></span></header><div id="viewport"></div><footer><span id="status" role="status">正在读取原始坐标…</span><span id="notes"></span></footer><script>${script}</script></body></html>`;
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
