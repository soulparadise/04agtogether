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
    attachShadow() { return new Element(); }
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
      this.paused = false; this.fire('play'); return Promise.resolve();
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
    sent, statuses, send, get video() { return selected; }, get primed() { return primed; },
    block(value) { blocked = value; },
    async switchTo(id, player, ready = 4, status = 'playing', position = 60, reuse = false) {
      const old = selected;
      if (!reuse) { selected = new Video(); old.isConnected = false; }
      family = player; selected.family = player; selected.readyState = ready; selected.paused = reuse ? selected.paused : true;
      state = makeState(id, player, status, position);
      receive({ target: 'player', type: 'state', state }, { id: 'fixture' }, () => {});
      for (let i = 0; i < 5; i++) await tick();
      return old;
    },
    wrongPlayer() { family = family === 'venom' ? 'allplay' : 'venom'; selected.family = family; }
  };
}

test('content handoff primes lazy Allplay, keeps latest Play/position and supports repeated verified confirmations', async t => {
  const f = await fixture(t);
  assert.equal(f.video.paused, false);
  const old = await f.switchTo(2, 'allplay', 0, 'playing', 70);
  assert.ok(f.primed > 0, 'Allplay must be primed before metadata, otherwise both sides wait forever');
  assert.equal(old.paused, true); assert.equal(f.video.paused, false); assert.ok(f.video.currentTime >= 70);
  for (const [id, player] of [[3, 'venom'], [4, 'allplay'], [5, 'venom']]) {
    await f.switchTo(id, player, player === 'allplay' ? 0 : 4, 'playing', 70 + id);
    assert.equal(f.video.paused, false); assert.ok(f.video.currentTime >= 70 + id);
    assert.equal((await f.send({ type: 'confirm-selection', sourceId: `source-${id}` })).ok, true);
    f.wrongPlayer(); assert.equal((await f.send({ type: 'confirm-selection', sourceId: `source-${id}` })).ok, false);
    f.wrongPlayer(); assert.equal((await f.send({ type: 'confirm-selection', sourceId: `source-${id}` })).ok, true);
  }
  assert.equal(f.sent.length, 0, 'Viewer loading/play/pause must never publish room commands');
});

test('technical owner pause during reuse never becomes a shared Pause; blocked lazy Play asks for a gesture', async t => {
  const owner = await fixture(t, true);
  await owner.switchTo(2, 'venom', 4, 'playing', 90, true);
  assert.equal(owner.sent.filter(command => command.action === 'pause').length, 0);
  const viewer = await fixture(t);
  viewer.block(true); await viewer.switchTo(2, 'allplay', 0);
  assert.ok(viewer.statuses.some(status => status.includes('Браузер не разрешил')));
  viewer.block(false);
  assert.equal((await viewer.send({ type: 'confirm-selection', sourceId: 'source-2' })).ok, true);
  await tick(); assert.equal(viewer.video.paused, false);
});
