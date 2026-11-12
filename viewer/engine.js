import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { ModelSymmetry } from 'molstar/lib/mol-model-formats/structure/property/symmetry.js';

const VERSION = '5.13.1';
const target = document.getElementById('viewport');
const status = document.getElementById('status');
const style = document.getElementById('style');
const frame = document.getElementById('frame');
const frameLabel = document.getElementById('frameLabel');
const notesEl = document.getElementById('notes');
const menu = document.getElementById('menu');
const more = document.getElementById('more');
let plugin;
let payload;
let trajectory;
let model;
let representation;
let structure;
let busy = false;
let disposed = false;
let representationName = 'spacefill';
let framing = 'structure';
// Frame switching never goes through operation(): disabling the slider while
// it is being dragged, and rebuilding the whole model per frame, is what froze
// the desktop renderer on a 24-frame EXTXYZ. Requests coalesce to the latest
// frame and run one at a time.
let wantedFrame = null;
let frameRunning = false;
let frameScheduled = false;

// Theme: the host page sends computed --afgo-* colours so the viewer follows
// DSH light/dark. The headless renderer sends none and keeps the light
// defaults baked into the HTML, so conversation images stay stable.
const THEME_VARS = { fg: '--fg', fg2: '--fg-2', bg: '--bg', layer: '--layer', line: '--line', accent: '--accent', warn: '--warn' };
let canvasBackground = 0xf5f7fb;

function colorNumber(value) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#000';
  probe.fillStyle = String(value);
  const normalized = probe.fillStyle;
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return parseInt(normalized.slice(1), 16);
  const rgb = normalized.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return rgb ? (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]) : null;
}

function applyTheme(theme) {
  if (!theme || typeof theme !== 'object') return;
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    const value = typeof theme[key] === 'string' ? theme[key].trim() : '';
    if (value && value.length < 120) document.documentElement.style.setProperty(cssVar, value);
  }
  const background = colorNumber(theme.bg);
  if (background == null) return;
  canvasBackground = background;
  if (plugin?.canvas3d) {
    plugin.canvas3d.setProps({ renderer: { backgroundColor: Color(background) } });
    plugin.canvas3d.requestDraw();
  }
}

function focusAtoms() {
  framing = 'structure';
  plugin.managers.camera.focusSphere(structure.data.boundary.sphere, { minRadius: 1, extraRadius: 1.5, durationMs: 0 });
}

function report(type, fields = {}) {
  parent.postMessage({ source: 'afgo-molstar', channel: payload?.channel, type, ...fields }, '*');
}

function controls(disabled) {
  document.querySelectorAll('button,select,input').forEach((element) => { element.disabled = disabled; });
}

async function operation(action) {
  if (busy || disposed) return;
  busy = true;
  controls(true);
  try { await action(); }
  catch (error) {
    status.textContent = `无法显示结构：${error.message}。可返回产物下载原文件。`;
    report('error', { message: status.textContent });
  } finally {
    busy = false;
    controls(false);
  }
}

function renderNotes(items) {
  notesEl.replaceChildren(...items.map((item) => {
    const span = document.createElement('span');
    span.textContent = item.text;
    if (item.warn) span.className = 'warn';
    return span;
  }).flatMap((span, index) => index ? [document.createTextNode(' · '), span] : [span]));
}

function describe(index) {
  const symbols = model.data.atomicHierarchy.atoms.type_symbol;
  // Mol* stores type_symbol upper-cased for some formats (TI); show chemical case (Ti).
  const elements = [...new Set(Array.from({ length: symbols.rowCount }, (_, i) => symbols.value(i)))]
    .map((symbol) => String(symbol).charAt(0).toUpperCase() + String(symbol).slice(1).toLowerCase());
  const cell = ModelSymmetry.Provider.get(model.data)?.spacegroup?.cell;
  const occupancy = model.data.atomicConformation.occupancy;
  let partial = 0;
  for (let i = 0; i < occupancy.rowCount; i++) {
    if (occupancy.value(i) < 1) partial++;
  }
  const frames = trajectory.data.frameCount;
  status.textContent = `${structure.data.elementCount} 原子 · ${elements.join(', ')}${frames > 1 ? ` · 帧 ${index + 1}/${frames}` : ''}`;
  frameLabel.textContent = `${index + 1}/${frames}`;
  const notes = [];
  if (cell) notes.push({ text: `晶胞 ${Array.from(cell.size).map((v) => v.toFixed(2)).join(' × ')} Å` });
  notes.push({ text: '原始坐标，未生成超胞' });
  notes.push({ text: '键线为推断邻接', warn: true });
  if (partial) notes.push({ text: `${partial} 个部分占据位点，保留文件记录` });
  if (payload.format === 'extxyz') notes.push({ text: 'EXTXYZ 仅显示坐标帧；Lattice、PBC 和附加属性请核对原文件', warn: true });
  renderNotes(notes);
  return { elements, partial };
}

async function showFrame(index) {
  if (model) {
    // Same model node, new frame: structure, components, representation and
    // unit cell are children and update in place; the camera is untouched.
    await plugin.build().to(model.ref).update((old) => ({ ...old, modelIndex: index })).commit();
  } else {
    model = await plugin.builders.structure.createModel(trajectory, { modelIndex: index });
    structure = await plugin.builders.structure.createStructure(model, { name: 'model', params: {} });
    if (!structure.data?.elementCount) throw new Error('文件没有可显示的原子');
    if (structure.data.elementCount > 100000) throw new Error('当前结构超过 100,000 个原子的交互预览上限');
    const component = await plugin.builders.structure.tryCreateComponentStatic(structure, 'all');
    representation = await plugin.builders.structure.representation.addRepresentation(component, {
      type: representationName, color: 'element-symbol',
      typeParams: { ignoreHydrogens: false, quality: 'auto' }
    });
    await plugin.builders.structure.tryCreateUnitcell(model);
    plugin.canvas3d.commit(true);
    focusAtoms();
  }
  plugin.canvas3d.requestDraw();
  const { elements, partial } = describe(index);
  report('loaded', { atoms: structure.data.elementCount, frames: trajectory.data.frameCount, frame: index + 1, elements, partialOccupancySites: partial });
}

function requestFrame(index) {
  wantedFrame = index;
  frameLabel.textContent = `${index + 1}/${trajectory?.data?.frameCount ?? 1}`;
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(async () => {
    frameScheduled = false;
    if (frameRunning || disposed) return;
    frameRunning = true;
    try {
      while (wantedFrame != null && !disposed) {
        const next = wantedFrame;
        wantedFrame = null;
        await showFrame(next);
      }
    } catch (error) {
      status.textContent = `无法切换到该帧：${error.message}`;
      report('error', { message: status.textContent });
    } finally {
      frameRunning = false;
    }
  });
}

async function load(message) {
  payload = message;
  applyTheme(message.theme);
  const spec = DefaultPluginSpec();
  spec.canvas3d = { renderer: { backgroundColor: Color(canvasBackground) }, camera: { mode: 'orthographic' } };
  plugin = new PluginContext(spec);
  await plugin.init();
  if (disposed) { plugin.dispose(); return; }
  if (!await plugin.mountAsync(target)) throw new Error('当前设备无法初始化 WebGL');
  const observer = new ResizeObserver(() => plugin.handleResize());
  observer.observe(target);
  window.addEventListener('beforeunload', () => { observer.disconnect(); plugin.dispose(); }, { once: true });
  let format = message.format;
  if (['cif', 'mmcif', 'mcif'].includes(format)) {
    format = /_atom_site_fract_[xyz]\b/i.test(message.text) ? 'cifCore' : 'mmcif';
  }
  if (format === 'ent') format = 'pdb';
  if (format === 'extxyz') format = 'xyz';
  const data = await plugin.builders.data.rawData({ data: message.text, label: message.name });
  trajectory = await plugin.builders.structure.parseTrajectory(data, format);
  if (!trajectory.data?.frameCount) throw new Error('无法读取坐标帧');
  representationName = /^(pdb|mmcif)$/.test(format) ? 'cartoon' : format === 'cifCore' ? 'spacefill' : 'ball-and-stick';
  // Small PDB/mmCIF models can have no polymer residues; use atomic spheres.
  const firstModel = trajectory.data.representative;
  const hasPolymer = firstModel.atomicHierarchy.derived.residue.polymerType.some((value) => value > 0);
  if (representationName === 'cartoon' && !hasPolymer) representationName = 'ball-and-stick';
  document.querySelector('option[value="cartoon"]').disabled = !hasPolymer;
  style.value = representationName;
  frame.max = trajectory.data.frameCount;
  frame.value = 1;
  document.getElementById('frames').hidden = trajectory.data.frameCount < 2;
  await showFrame(0);
  // Liveness for the host page: a hung renderer stops beating and the page
  // can tell the user instead of freezing with it.
  setInterval(() => { if (!disposed) report('heartbeat'); }, 2000);
  if (message.autoExport === true) {
    const dataUri = await plugin.helpers.viewportScreenshot.getImageDataUri();
    report('png', { content: dataUri.split(',')[1], manifest: sceneManifest() });
  }
}

style.addEventListener('change', () => operation(async () => {
  representationName = style.value;
  await plugin.build().to(representation.ref).update((old) => ({
    ...old, type: { name: representationName, params: { ignoreHydrogens: false, quality: 'auto' } }
  })).commit();
}));
frame.addEventListener('input', () => { if (trajectory) requestFrame(Number(frame.value) - 1); });
document.getElementById('reset').addEventListener('click', () => { if (structure) focusAtoms(); });
document.getElementById('full').addEventListener('click', () => {
  framing = 'full';
  plugin?.managers.camera.reset(undefined, 0);
});
function closeMenu() { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); }
more.addEventListener('click', (event) => {
  event.stopPropagation();
  menu.hidden = !menu.hidden;
  more.setAttribute('aria-expanded', String(!menu.hidden));
});
document.addEventListener('click', (event) => { if (!menu.contains(event.target)) closeMenu(); });
document.getElementById('fullscreen').addEventListener('click', () => report('fullscreen'));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!menu.hidden) { closeMenu(); return; }
  report('fullscreen-exit');
});
document.getElementById('png').addEventListener('click', () => operation(async () => {
  closeMenu();
  const dataUri = await plugin.helpers.viewportScreenshot.getImageDataUri();
  report('png', { content: dataUri.split(',')[1], name: `task-${payload.taskId}-${payload.name}-frame-${frame.value}.png` });
}));
function sceneManifest() {
  return {
    schema: 'afgo.visualization/1', taskId: payload.taskId, fileId: payload.fileId,
    name: payload.name, sha256: payload.sha256, fetchedAt: payload.fetchedAt,
    renderer: { name: 'Mol*', version: VERSION }, frame: Number(frame.value),
    representation: representationName, framing, camera: plugin?.canvas3d?.camera.getSnapshot(),
    notes: notesEl.textContent
  };
}
document.getElementById('manifest').addEventListener('click', () => { closeMenu(); report('manifest', { manifest: sceneManifest() }); });
window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  if (event.data?.type === 'afgo-theme') {
    if (!payload || event.data.channel === payload.channel) applyTheme(event.data.theme);
    return;
  }
  if (payload || event.data?.type !== 'afgo-structure') return;
  operation(() => load(event.data));
});
window.addEventListener('beforeunload', () => { disposed = true; });
controls(true);
report('ready');
