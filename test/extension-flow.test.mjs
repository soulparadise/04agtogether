import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { trustedWebContext, validatePair } from '../extension/src/security.mjs';
import { RoomConnection } from '../extension/src/RoomConnection.mjs';
const require = createRequire(import.meta.url);
const { createApplication } = require('../backend/server.cjs');

test('web handoff accepts only exact app origins, top frames and matching room paths', () => {
  const roomId = 'a'.repeat(32);
  const sender = { url: `http://127.0.0.1:5173/room/${roomId}`, frameId: 0, tab: { id: 7 } };
  assert.equal(trustedWebContext(sender, roomId).origin, 'http://127.0.0.1:5173');
  assert.equal(trustedWebContext({ ...sender, url: `https://soulparadise.ru/room/${roomId}` }, roomId).origin, 'https://soulparadise.ru');
  for (const altered of [
    { url: `https://soulparadise.ru.attacker.invalid/room/${roomId}` }, { url: `http://127.0.0.1:5174/room/${roomId}` },
    { url: `http://127.0.0.1:5173/room/${'b'.repeat(32)}` }, { frameId: 2 }, { id: 'another-extension' }, { tab: null }
  ]) assert.throws(() => trustedWebContext({ ...sender, ...altered }, roomId));
  const pair = validatePair({ origin: 'http://127.0.0.1:5173', roomId, participantId: 'b'.repeat(32), sessionToken: 'c'.repeat(64), role: 'owner' });
  assert.equal(pair.role, undefined); assert.equal(pair.ownerToken, undefined);
});

test('one-click creation uses existing rooms; viewer handoff and saved binding resume keep server roles', async t => {
  const app = createApplication(); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`, pageURL = 'http://127.0.0.1:5174/';
  const owner = await RoomConnection.createOwner({ origin, nickname: 'Owner', title: 'Тестовый фильм', pageURL, initial: { position: 12, duration: 90, playing: false } });
  t.after(() => owner.disconnect());
  assert.equal(owner.status().title, 'Тестовый фильм'); assert.equal(owner.status().owner, true);
  assert.equal(owner.state.position, 12); assert.ok(!owner.status().invitation.includes(owner.pair.ownerToken));
  const tab = io(origin, { transports: ['polling'], upgrade: false }); t.after(() => tab.disconnect()); await once(tab, 'connect');
  const joined = await tab.timeout(2000).emitWithAck('room:join', { roomId: owner.pair.roomId, nickname: 'Viewer' });
  const pair = { origin, roomId: joined.room.id, participantId: joined.participantId, sessionToken: joined.sessionToken };
  const viewer = new RoomConnection(pair); t.after(() => viewer.disconnect()); viewer.start(); await viewer.whenReady();
  const binding = { tabId: 8, frameId: 0, pageURL };
  viewer.bind(binding);
  assert.equal((await viewer.content(binding, { type: 'attach' })).owner, false);
  assert.equal((await viewer.content({ ...binding, tabId: 9 }, { type: 'attach' })).ok, false);
  assert.equal((await viewer.content(binding, { type: 'intent', action: 'play', position: 12, ownerToken: owner.pair.ownerToken, owner: true })).ok, false);
  const saved = { pair: viewer.pair, binding: viewer.binding }; viewer.disconnect();
  const restored = new RoomConnection(saved.pair); t.after(() => restored.disconnect()); restored.start(); await restored.whenReady(); restored.bind(saved.binding);
  const response = await restored.content(binding, { type: 'attach' });
  assert.equal(response.owner, false); assert.equal(response.state.position, 12);
  assert.ok(!JSON.stringify(response).includes(pair.sessionToken));
});

test('background hands off automatically, survives worker reload and releases the closed bound tab (Chrome API harness)', async t => {
  const previousChrome = globalThis.chrome;
  const roomId = 'a'.repeat(32), token = 'b'.repeat(64), filmURL = 'http://127.0.0.1:5174/';
  const store = {}, listeners = {}, tabs = new Map([[1, { id: 1, url: `http://127.0.0.1:5173/room/${roomId}` }]]);
  let currentFilm = filmURL;
  let grants = false, active = null, calls = 0, openedConsent = 0, nextTab = 10, starts = 0, selectedFrame = 0, interruptNextBind = false;
  const activeFrames = new Set();
  const delivered = [];
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const publicStatus = () => active ? { connected: true, appOrigin: active.pair.origin, roomId: active.pair.roomId, participantId: active.pair.participantId, owner: Boolean(active.pair.ownerToken), room: { id: active.pair.roomId, playback: { source: { type: 'extension', url: currentFilm } } } } : { connected: false };
  globalThis.chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, getContexts: async () => [{}],
      onMessage: event('internal'), onMessageExternal: event('external'), sendMessage: async message => {
        calls++;
        if (message.type === 'status') return publicStatus();
        if (message.type === 'pair') { active = { pair: message.pair }; store.session = active; return { ok: true, ...publicStatus() }; }
        if (message.type === 'bind') {
          activeFrames.delete(active.binding?.frameId); active.binding = message.binding;
          if (interruptNextBind) {
            interruptNextBind = false;
            listeners.internal({ target: 'background', type: 'player-layout' }, { id: 'test-extension', tab: tabs.get(10), frameId: 0 }, () => {});
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          return { ok: true };
        }
        if (message.type === 'disconnect') { active = null; delete store.session; return { ok: true }; }
        return { ok: true };
      } },
    storage: { session: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store[key]])), set: async values => Object.assign(store, values), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; } }, local: { get: async () => ({ nickname: 'Viewer' }) } },
    permissions: { contains: async () => grants, getAll: async () => ({ origins: [] }), onAdded: event('added') },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, executeScript: async () => {} },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: filmURL }, { frameId: 1, parentFrameId: 0, url: 'about:blank' }] },
    tabs: { get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); }, create: async ({ url }) => { const tab = { id: nextTab++, url }; tabs.set(tab.id, tab); return tab; },
      update: async (id, patch) => Object.assign(tabs.get(id), patch), sendMessage: async (_id, message, { frameId } = {}) => {
        delivered.push(message);
        if (message.type === 'start') { starts++; activeFrames.add(frameId); return { ok: true }; }
        if (message.type === 'confirm-selection') return { ok: activeFrames.has(frameId) };
        return { count: frameId === selectedFrame ? 1 : 0, score: 100, active: activeFrames.has(frameId), childFrames: frameId === 0 ? [{ url: 'about:blank', visible: selectedFrame === 1 }] : [] };
      }, onRemoved: event('removed'), onUpdated: event('updated') },
    action: { openPopup: async () => { openedConsent++; } }
  };
  t.after(() => { globalThis.chrome = previousChrome; });
  await import('../extension/src/background.mjs?flow-test=first');
  const send = (channel, message, sender) => new Promise(resolve => listeners[channel](message, sender, resolve));
  const sender = { url: tabs.get(1).url, tab: tabs.get(1), frameId: 0 };
  const message = { type: 'open-film', roomId, filmURL, session: { participantId: 'c'.repeat(32), sessionToken: token, role: 'owner' } };
  assert.equal((await send('external', message, { ...sender, url: 'https://attacker.invalid/' })).ok, false);
  assert.equal(calls, 0, 'Untrusted pages must not reach the connection engine');
  assert.equal((await send('external', message, sender)).needsPermission, true); assert.equal(openedConsent, 1);
  const popup = { id: 'test-extension', url: chrome.runtime.getURL('popup.html') };
  const pending = await send('internal', { target: 'background', type: 'popup-state' }, popup);
  assert.ok(!JSON.stringify(pending).includes(token));
  grants = true;
  assert.equal((await send('internal', { target: 'background', type: 'finish-open' }, popup)).ok, true);
  assert.equal(tabs.get(10).url, filmURL); assert.equal(store.session.binding.tabId, 10);
  assert.equal(active.pair.role, undefined);
  assert.equal((await send('internal', { target: 'background', type: 'bootstrap' }, { id: 'test-extension', url: filmURL, tab: { id: 10, url: filmURL }, frameId: 0 })).ok, false);
  await import('../extension/src/background.mjs?flow-test=restarted');
  await listeners.updated(10, { status: 'complete' }, tabs.get(10));
  // Event handlers are asynchronous but return void, as Chrome expects.
  for (let i = 0; i < 30 && !starts; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(starts > 0, 'Reloading a bound film automatically starts its content controller');
  assert.ok(!JSON.stringify(delivered).includes(token), 'Content messages contain no room credential');
  assert.equal(store.session.binding.pageURL, filmURL);
  selectedFrame = 1; interruptNextBind = true;
  await send('internal', { target: 'background', type: 'player-layout' }, { id: 'test-extension', tab: tabs.get(10), frameId: 0 });
  for (let i = 0; i < 30 && !activeFrames.has(1); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(activeFrames.has(1), 'A bind interrupted by parent layout must still start the new frame');
  for (const frameId of [0, 1, 0]) {
    selectedFrame = frameId; activeFrames.clear();
    assert.equal((await send('internal', { target: 'background', type: 'confirm-selection' }, popup)).ok, true, 'Every manual confirmation rediscovers and starts the actual frame');
    assert.equal(store.session.binding.frameId, frameId);
  }
  assert.equal((await send('internal', { target: 'background', type: 'player-ready' }, { id: 'test-extension', tab: { id: 11, url: filmURL }, frameId: 0 })).ok, false);
  const siteRoomId = 'd'.repeat(32);
  tabs.get(1).url = `http://127.0.0.1:5173/room/${siteRoomId}`;
  const ownerSender = { ...sender, url: tabs.get(1).url };
  const ownerOpen = { ...message, roomId: siteRoomId, session: { participantId: 'e'.repeat(32), sessionToken: token, ownerToken: 'f'.repeat(64) } };
  assert.equal((await send('external', ownerOpen, ownerSender)).ok, true);
  assert.equal(active.pair.roomId, siteRoomId); assert.equal(active.pair.ownerToken, ownerOpen.session.ownerToken);
  assert.equal(store.session.binding.tabId, 11, 'A different site-created room does not reuse the old room tab');
  currentFilm = filmURL + 'second-film';
  assert.equal((await send('external', { ...ownerOpen, filmURL: currentFilm }, ownerSender)).ok, true);
  assert.equal(store.session.binding.pageURL, currentFilm); assert.equal(store.session.binding.tabId, 12);
  assert.ok([...tabs.values()].every(tab => !tab.url.includes(token) && !tab.url.includes(ownerOpen.session.ownerToken)), 'Film URLs never contain room credentials');
  listeners.removed(12);
  for (let i = 0; i < 30 && store.session; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.session, undefined);
});
