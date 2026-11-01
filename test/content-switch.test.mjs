import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

// Exercise the shipped content controller, not a substitute synchronizer.
const bundle = (await build({ entryPoints: ['extension/src/content.mjs'], bundle: true, platform: 'browser', format: 'iife', write: false })).outputFiles[0].text;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(t, owner = false) {
  const events = new Map(), intervals = new Set(), sent = [], statuses = [];
  let receive, family = 'venom', selected, state, blocked = false, primed = 0;
  class Element {
    style = {}; children = []; isConnected = true; hidden = false; listeners = new Map();
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    attachShadow() { this.shadow = new Element(); return this.shadow; }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    remove() { this.isConnected = false; }
    getBoundingClientRect() { return { left: 20, top: 40, width: 640, height: 360 }; }
    fire(type) {
      const event = { type, target: this };
      for (const fn of events.get(type) || []) fn(event);
      for (const fn of this.listeners.get(type) || []) fn(event);
    }
  }
  class Video extends Element {
    readyState = 4; duration = 300; currentTime = 0; paused = true; ended = false;
    matches(selector) { return selector === 'video.allplay__video' && this.family === 'allplay'; }
    play() {
      if (blocked) return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
      if (!this.paused) return Promise.resolve();
      this.paused = false; this.fire('play');
      setTimeout(() => { if (!this.paused) { this.currentTime += 0.05; this.fire('timeupdate'); } }, 50);
      return Promise.resolve();
    }
    pause() { if (this.paused) return; this.paused = true; queueMicrotask(() => this.fire('pause')); }
  }
  const root = new Element();
  const control = new Element();
  control.click = () => { primed++; if (!blocked) { selected.readyState = 4; selected.fire('loadedmetadata'); void selected.play(); } };
  const document = {
    documentElement: root, location: { hostname: 'example.com' },
    defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) },
    createElement: () => new Element(),
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
    querySelector(selector) { return selector === 'video.allplay__video' ? family === 'allplay' ? selected : null : selector === 'video' ? selected : null; },
    querySelectorAll(selector) {
      if (selector === 'video') return selected ? [selected] : [];
      if (selector === 'script[src]') return family === 'venom' ? [{ src: 'https://js.fprxnet.ws/npm/player-venom@0.3.7/dist/player.js' }] : [];
      if (selector === 'button.allplay__control--overlaid[data-allplay="play"]') return [control];
      return [];
    }
  };
  const makeState = (id, player, status = 'playing', position = 40) => ({
    source: { type: 'extension', url: 'https://example.com/film', selection: { player: { id: player, label: player }, voice: null, version: id } },
    sourceId: `source-${id}`, version: id, serverNow: performance.now(), updatedAt: performance.now(), basePosition: position, position, status, duration: null
  });
  selected = new Video(); selected.family = family; state = makeState(1, family);
  const context = vm.createContext({ document, performance, URL, console,
    getComputedStyle: document.defaultView.getComputedStyle,
    MutationObserver: class { observe() {} disconnect() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval: (...args) => { const timer = setInterval(...args); intervals.add(timer); return timer; }, clearInterval,
    setTimeout, clearTimeout,
    chrome: { runtime: { id: 'fixture', onMessage: { addListener: fn => { receive = fn; }, removeListener() {} }, sendMessage: async message => {
      if (message.target === 'background') return { ok: true };
      const payload = message.payload;
      if (payload.type === 'status') statuses.push(payload.status);
      if (payload.type === 'intent') sent.push(payload);
      return { ok: true, owner, connected: true, state: { ...state, serverNow: performance.now() } };
    } } }
  });
  vm.runInContext(bundle, context);
  t.after(() => { context.__04agtogetherContent.destroy(); intervals.forEach(clearInterval); });
  const send = message => new Promise(resolve => receive({ target: 'player', ...message }, { id: 'fixture' }, resolve));
  for (let i = 0; i < 5; i++) await tick();
  return {
    sent, statuses, send, root, get video() { return selected; }, get primed() { return primed; },
    block(value) { blocked = value; },
    async switchTo(id, player, ready = 4, status = 'playing', position = 60, reuse = false, local = false) {
      const old = selected;
      if (!reuse) { selected = new Video(); old.isConnected = false; }
      family = player; selected.family = player; selected.readyState = ready; selected.paused = reuse ? selected.paused : true;
      if (!local) {
        state = makeState(id, player, status, position);
        receive({ target: 'player', type: 'state', state }, { id: 'fixture' }, () => {});
      } else selected.fire('loadedmetadata');
      for (let i = 0; i < 5; i++) await tick();
      if (player === 'allplay' && status === 'playing' && !blocked) control.click();
      await new Promise(resolve => setTimeout(resolve, 60));
      return old;
    },
    wrongPlayer() { family = family === 'venom' ? 'allplay' : 'venom'; selected.family = family; }
  };
}

test('permission notice explains the host, survives repeated discovery and disappears when no access is needed', async t => {
  const f = await fixture(t);
  await f.send({ type: 'permission-notice', origins: ['https://player.example'] });
  const notice = f.root.children.at(-1), box = notice.shadow.children[0];
  assert.match(box.children[1].textContent, /player.example/);
  assert.equal(box.children[2].textContent, 'Открыть расширение для разрешения');
  await f.send({ type: 'permission-notice', origins: ['https://second.example'] });
  assert.equal(f.root.children.at(-1), notice);
  assert.match(box.children[1].textContent, /second.example/);
  await f.send({ type: 'permission-notice', origins: [] });
  assert.equal(notice.isConnected, false);
  assert.equal(f.sent.length, 0);
});

test('local player switches and native Allplay start keep room playback without matching the Owner choice', async t => {
  const f = await fixture(t);
  assert.equal(f.video.paused, false);
  const old = await f.switchTo(2, 'allplay', 0, 'playing', 70);
  assert.ok(f.primed > 0, 'Native Play primes Allplay before synchronizing');
  assert.equal(old.paused, true); assert.equal(f.video.paused, false); assert.ok(f.video.currentTime >= 70);
  for (const [id, player] of [[3, 'venom'], [4, 'allplay'], [5, 'venom']]) {
    await f.switchTo(id, player, player === 'allplay' ? 0 : 4, 'playing', 70 + id, false, true);
    assert.equal(f.video.paused, false); assert.ok(f.video.currentTime >= 70);
    const discovery = await f.send({ type: 'discover' });
    assert.equal(discovery.sourceId, 'source-2', 'A local player choice does not replace the room source');
    assert.equal(discovery.syncAttached, true);
  }
  assert.equal(f.sent.length, 0, 'Viewer loading/play/pause must never publish room commands');
});

test('technical owner pause during reuse never becomes a shared Pause; blocked lazy Play asks for a gesture', async t => {
  const owner = await fixture(t, true);
  await owner.switchTo(2, 'venom', 4, 'playing', 90, true);
  assert.equal(owner.sent.filter(command => command.action === 'pause').length, 0);
  const viewer = await fixture(t);
  viewer.block(true); await viewer.switchTo(2, 'allplay', 0);
  assert.ok(viewer.statuses.some(status => status.includes('Начать просмотр')));
  viewer.block(false);
  // Metadata alone must not retry a blocked play; model the native user Play.
  viewer.video.readyState = 4; viewer.video.fire('loadedmetadata');
  await viewer.video.play();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(viewer.video.paused, false);
});
