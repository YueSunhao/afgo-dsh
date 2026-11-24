// Functional startup tests — real React effects, no browser, network or user credentials.
// Also run under the installed DSH Electron runtime to include the real Gateway round trip.
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import React from 'react';
import renderer from 'react-test-renderer';

let client;
globalThis.window = { __ModuleLoader__: { load: def => { client = def.factory(() => React); } } };
await import('../lib/client.js');

function uiServices() {
  const entries = new Map(), dictionaries = new Map();
  return { entries, layout: {}, slots: {
    inject: (_, factory) => factory(),
    register: (seat, component) => { entries.set(seat.name, component); return () => entries.delete(seat.name); }
  }, locale: {
    register: (ns, dict) => { dictionaries.set(ns, dict.zh); return () => dictionaries.delete(ns); },
    bind: ns => key => dictionaries.get(ns)[key]
  } };
}

async function openPanel(t, ui) {
  const Panel = ui.entries.get('main');
  assert.ok(Panel, 'main panel is registered');
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Panel)); });
  t.after(() => renderer.act(() => { tree.unmount(); }));
  return tree;
}

function assertFirstRun(tree) {
  assert.equal(tree.root.findByProps({ type: 'password' }).props.placeholder, '粘贴你的 API Key');
  assert.ok(tree.root.findByType('form'));
  assert.ok(tree.root.findAllByType('p').some(p => p.children.includes('连接星使智算账号')));
  assert.equal(tree.root.findAllByProps({ role: 'alert' }).length, 0);
}

async function fixture(dispatch, mount = async () => {}) {
  const ui = uiServices();
  const remote = { $mount: mount, get afgoWorkbench() { throw new Error('cannot get property "remote.afgoWorkbench" without inject'); } };
  await client.apply({ ...ui, remote, get: name => name === 'remote' ? remote : name === 'remote.afgoWorkbench' ? { dispatch } : undefined,
    effect: f => f(), inject: (deps, f) => f(ui) });
  return ui;
}
const unconfigured = { ok: true, value: { ok: true, data: { configured: false, writable: true } } };

test('fresh account waits for namespace mount, then opens the API Key form without verify', async t => {
  const actions = [];
  let mounted = false;
  const ui = await fixture(({ action }) => { assert.ok(mounted); actions.push(action); return unconfigured; }, async () => { await Promise.resolve(); mounted = true; });
  const tree = await openPanel(t, ui);
  assertFirstRun(tree);
  assert.deepEqual(actions, ['connection']);
});

test('directory marks use only public official images and recover when selecting another tool', async t => {
  const { ToolMark } = client.__test;
  const mark = (icon, name = 'sample') => React.createElement(ToolMark, { entry: { icon, name, type: 'kit' }, size: 20 });
  const bucket = 'https://galileo.obs.cn-north-4.myhuaweicloud.com';
  let tree;
  await renderer.act(async () => { tree = renderer.create(mark('/toolbox-icons/sample/a.png')); });
  t.after(() => renderer.act(() => { tree.unmount(); }));
  assert.equal(tree.root.findByType('img').props.src, 'https://sidereus-ai.com/toolbox-icons/sample/a.png');
  for (const icon of [null, 'https://outside.example/icon.png', 'https://user@sidereus-ai.com/icon.png', 'https://sidereus-ai.com/icon.png?token=private', 'data:image/png;base64,QQ==', `${bucket}/private/file.png`, `${bucket}/toolbox-icons/a.png?token=private`, `${bucket}/toolbox-icons/%2e%2e/private.png`]) {
    await renderer.act(async () => { tree.update(mark(icon)); });
    assert.equal(tree.root.findByType('img').props.src, `${bucket}/icons/app_icon_1.png`);
    assert.equal(tree.root.findByType('img').props.title, '星使通用图标');
  }
  const cn = `${bucket}/toolbox-icons/prod/原生ORCA/0.0.9/icon.png`;
  await renderer.act(async () => { tree.update(mark(cn, '原生ORCA')); });
  assert.equal(tree.root.findByType('img').props.src, new URL(cn).href);
  const img = () => tree.root.findByType('img').props;
  const fail = () => renderer.act(async () => { img().onError(); });
  const native = `${bucket}/toolbox-icons/prod/PySCF/1.0.0/icon.svg`;
  await renderer.act(async () => { tree.update(mark(native, 'PySCF-SP')); });
  assert.equal(img().src, native);
  assert.equal(img().title, '星使工具原图');
  await fail();
  assert.equal(img().title, '上游项目标识：PySCF');
  await fail();
  assert.equal(img().src, `${bucket}/icons/app_icon_3.png`);
  await fail();
  assert.equal(tree.root.findAllByType('img').length, 0);
  assert.equal(tree.root.findByType('svg').findByType('title').children[0], '本地类型图标：Kit');
  await renderer.act(async () => { tree.update(mark('https://static.sidereus-ai.com/items/b.webp')); });
  assert.equal(tree.root.findByType('img').props.loading, 'lazy');
});

test('public brand artwork needs no account and image failure leaves the first-run form usable', async t => {
  const actions = [];
  const ui = await fixture(({ action }) => { actions.push(action); return unconfigured; });
  const tree = await openPanel(t, ui);
  const images = tree.root.findAllByType('img');
  assert.ok(images.some(img => img.props.src === 'https://sidereus-ai.com/favicon.ico'));
  assert.ok(images.some(img => img.props.alt === '星使智算 SidereusAI'));
  assert.ok(images.every(img => img.props.referrerPolicy === 'no-referrer'));
  await renderer.act(async () => { images.forEach(img => img.props.onError()); });
  assert.equal(tree.root.findAllByType('img').length, 0);
  assertFirstRun(tree);
  assert.deepEqual(actions, ['connection']);
  const Sidebar = ui.entries.get('sidebar.panellist');
  let sidebar;
  await renderer.act(async () => { sidebar = renderer.create(React.createElement(Sidebar, { size: 18, active: true })); });
  t.after(() => renderer.act(() => { sidebar.unmount(); }));
  const mark = sidebar.root.findByType('img');
  assert.equal(mark.props.width, 18);
  await renderer.act(async () => { mark.props.onError(); });
  assert.equal(sidebar.root.findByType('svg').props.width, 18);
});

test('a rejected mount shows its cause, not a timeout, and Retry can recover in place', async t => {
  let attempts = 0;
  const ui = await fixture(() => unconfigured, async () => { if (++attempts === 1) throw new Error('测试：远程接口注册失败'); });
  const tree = await openPanel(t, ui);
  assert.deepEqual(tree.root.findByProps({ role: 'alert' }).children, ['测试：远程接口注册失败']);
  assert.equal(tree.root.findAllByProps({ type: 'password' }).length, 0);
  await renderer.act(async () => { tree.root.findAllByType('button').find(b => b.children.includes('重试')).props.onClick(); });
  assert.equal(attempts, 2);
  assertFirstRun(tree);
});

test('a saved but invalid key offers reverification, not a false service failure', async t => {
  const actions = [];
  const tree = await openPanel(t, await fixture(({ action }) => {
    actions.push(action);
    return { ok: true, value: action === 'connection' ? { ok: true, data: { configured: true } } : { ok: false, error: { code: 'invalid_key', message: '测试：Key 已失效' } } };
  }));
  assert.deepEqual(actions, ['connection', 'verify']);
  assert.equal(tree.root.findByProps({ type: 'password' }).props.placeholder, '留空验证已保存的 Key');
  assert.deepEqual(tree.root.findByProps({ role: 'alert' }).children, ['测试：Key 已失效']);
});

// This branch uses the installed packages, never another copy of Cordis. A plain
// Node CI still runs the UI regressions above. Run the integration locally via:
// ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test tests/workbench_startup.test.mjs
test('DSH runtime: sidebar page → Client Gateway → Host Gateway → empty credential → form', {
  skip: !(process.env.DSH_INSTALL_DIR && process.versions.electron), timeout: 10000
}, async t => {
  const require = createRequire(import.meta.url);
  const resolve = name => require.resolve(`@deepseek-ai/${name}`, { paths: [process.env.DSH_INSTALL_DIR] });
  const dsh = name => require(resolve(name));
  const { Context } = dsh('cordis');
  const clientRoot = new Context(), host = new Context();
  const served = [], described = [], ui = uiServices();
  // A linked plugin's declared peer is normally supplied by the DSH launcher.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === '@deepseek-ai/dsh-typert-protocol' && context.parentURL === new URL('../lib/workbench.js', import.meta.url).href
      ? { url: pathToFileURL(resolve('dsh-typert-protocol')).href, shortCircuit: true } : next(specifier, context);
  } });
  t.after(async () => { try { await clientRoot.fiber.dispose(); await host.fiber.dispose(); } finally { hooks.deregister(); } });
  host.provide('credentials', { describe(ref) { described.push(ref); return { configured: false, writable: true }; } });
  host.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  let route;
  host.provide('connection', { rpc: { intercept(path, claims, handle) { route = { path, claims, handle }; return () => {}; } } });
  await host.plugin(dsh('dsh-typert-registry').default);
  await host.plugin(dsh('dsh-api-gateway').default);
  let platformCalls = 0;
  const { installWorkbench } = await import('../lib/workbench.js');
  await host.plugin({ inject: ['credentials', 'typert'], apply: ctx => installWorkbench(ctx, {
    credential: 'AFGO_TEST_ONLY', baseUrl: 'https://example.invalid/api', call() { ++platformCalls; throw new Error('offline test'); }
  }) });
  const peer = { id: 'test-page', principal: { kind: 'owner' }, signal: new AbortController().signal };
  clientRoot.provide('connection', { interactions: 'none', rpc: { open() {}, async call(path, endpoint, payload, signal) {
    assert.equal(route.path, path); assert.ok(route.claims(endpoint));
    served.push([endpoint, payload.args.input.action]);
    return route.handle(endpoint, payload, signal, peer);
  } } });
  for (const name of ['layout', 'slots', 'locale']) clientRoot.provide(name, ui[name]);
  await clientRoot.plugin(dsh('dsh-typert-registry/client'));
  await clientRoot.plugin(dsh('dsh-api-gateway/client'));
  await clientRoot.plugin(client);
  const tree = await openPanel(t, ui);
  assertFirstRun(tree);
  assert.deepEqual(served, [['afgoWorkbench/dispatch', 'connection']]);
  assert.deepEqual(described, ['AFGO_TEST_ONLY']);
  assert.equal(platformCalls, 0);

  // An empty submit stays local; the user is not asked to type a Key into chat.
  await renderer.act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(tree.root.findByProps({ role: 'alert' }).children, ['请粘贴 API Key。']);
  assert.equal(served.length, 1);
  assert.equal(platformCalls, 0);

  // Supplying test input goes to connect (not connection). A failed verification
  // must stay on the form and not attempt a credential write.
  await renderer.act(async () => { tree.root.findByProps({ type: 'password' }).props.onChange({ target: { value: 'test-only-not-a-key' } }); });
  await renderer.act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(served.at(-1), ['afgoWorkbench/dispatch', 'connect']);
  assert.equal(platformCalls, 1);
  assert.deepEqual(tree.root.findByProps({ role: 'alert' }).children, ['offline test']);
});
