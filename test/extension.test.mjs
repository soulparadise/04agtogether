import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { RoomConnection } from '../extension/src/RoomConnection.mjs';
import { ForeignVideoAdapter } from '../extension/src/ForeignVideoAdapter.mjs';
import { localAppOrigin } from '../extension/src/security.mjs';
const require = createRequire(import.meta.url);
const { createApplication } = require('../backend/server.cjs');
const { id } = require('../extension/identity.json');
const origin = `chrome-extension://${id}`;
const request = (socket, event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);
const waitFor = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Timed out'); };
async function fixture(t, extensionOrigins = []) {
  const app = createApplication({ extensionOrigins }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test('extension Origin requires an explicit allowlist; local pairing rejects lookalike hosts', async t => {
  assert.throws(() => localAppOrigin('http://localhost.attacker.invalid'));
  assert.equal(localAppOrigin('http://192.168.88.240:5173'), 'http://192.168.88.240:5173');
  const denied = await fixture(t);
  assert.equal((await fetch(denied + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: origin } })).status, 403);
  const allowed = await fixture(t, [origin]);
  const response = await fetch(allowed + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: origin } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal((await fetch(allowed + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'chrome-extension://' + 'a'.repeat(32) } })).status, 403);
});

test('extension bridge resumes two roles, sends play/pause/seek, confines credentials and reconnects', async t => {
  const base = await fixture(t);
  async function client() { const socket = io(base, { transports: ['polling'], upgrade: false, forceNew: true }); t.after(() => socket.disconnect()); await once(socket, 'connect'); return socket; }
  const ownerTab = await client(), viewerTab = await client();
  const created = await request(ownerTab, 'room:create', { nickname: 'Owner' });
  const pageURL = 'http://127.0.0.1:5174/';
  const source = await request(ownerTab, 'playback:source', { url: pageURL, mode: 'extension', expectedVersion: 0, ownerToken: created.ownerToken });
  assert.equal(source.state.source.type, 'extension');
  const joined = await request(viewerTab, 'room:join', { roomId: created.room.id, nickname: 'Viewer' });
  const pair = reply => ({ origin: base, roomId: reply.room.id, participantId: reply.participantId, sessionToken: reply.sessionToken, ...(reply.ownerToken ? { ownerToken: reply.ownerToken } : {}) });
  const owner = new RoomConnection(pair(created)), viewer = new RoomConnection(pair(joined));
  t.after(() => { owner.disconnect(); viewer.disconnect(); });
  owner.start(); viewer.start(); await waitFor(() => owner.connected && viewer.connected);
  const ownerFrame = { tabId: 1, frameId: 0, pageURL }, viewerFrame = { tabId: 2, frameId: 3, pageURL };
  owner.bind(ownerFrame); viewer.bind(viewerFrame);
  const attach = await owner.content(ownerFrame, { type: 'attach' });
  assert.equal(attach.owner, true);
  assert.ok(!JSON.stringify(attach).includes(created.sessionToken)); assert.ok(!JSON.stringify(attach).includes(created.ownerToken));
  assert.equal((await owner.content({ ...ownerFrame, frameId: 9 }, { type: 'intent', action: 'play', position: 0 })).ok, false);
  assert.equal((await viewer.content(viewerFrame, { type: 'intent', action: 'play', position: 0 })).ok, false);
  assert.equal((await owner.content(ownerFrame, { type: 'intent', action: 'metadata', duration: 90 })).ok, true);
  await owner.content(ownerFrame, { type: 'intent', action: 'seek', position: 12 });
  await owner.content(ownerFrame, { type: 'intent', action: 'play', position: 12 });
  let state = (await viewer.content(viewerFrame, { type: 'get' })).state;
  assert.equal(state.status, 'playing'); assert.ok(state.position >= 12);
  await owner.content(ownerFrame, { type: 'intent', action: 'pause', position: 15 });
  state = (await viewer.content(viewerFrame, { type: 'get' })).state;
  assert.equal(state.status, 'paused'); assert.equal(state.position, 15);
  owner.disconnect(); owner.start(); await waitFor(() => owner.connected); owner.bind(ownerFrame);
  assert.equal((await owner.content(ownerFrame, { type: 'attach' })).owner, true);
  // The backend also rejects a viewer even if it knows the actual owner token.
  assert.equal((await request(viewer.socket, 'playback:play', { expectedVersion: state.version, sourceId: state.sourceId, ownerToken: created.ownerToken })).error.code, 'FORBIDDEN');
});

test('foreign adapter suppresses remote echoes and detaches without changing the site media', () => {
  class Video extends EventTarget {
    src = '/owned-by-site.mp4'; currentTime = 0; duration = 90; readyState = 4; paused = true;
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    load() { throw new Error('Must not reload a site video'); }
  }
  const video = new Video(), adapter = new ForeignVideoAdapter(video);
  let echoes = 0;
  video.addEventListener('play', () => { if (!adapter.consume('play')) echoes++; });
  adapter.load({ type: 'extension', url: 'https://example.invalid/film' });
  adapter.play(); assert.equal(echoes, 0);
  video.pause(); video.play(); assert.equal(echoes, 1);
  adapter.seek(20); assert.equal(adapter.consume('seeked'), true);
  adapter.destroy(); assert.equal(video.src, '/owned-by-site.mp4'); assert.equal(video.paused, false);
});
