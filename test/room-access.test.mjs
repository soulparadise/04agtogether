import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { RoomConnection } from '../extension/src/RoomConnection.mjs';
const { createApplication } = createRequire(import.meta.url)('../backend/server.cjs');
const request = (socket, event, payload = {}) => socket.timeout(3000).emitWithAck(event, payload);
async function fixture(t, roomOptions = {}, extra = {}) {
  const app = createApplication({ roomOptions, ...extra });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`, clients = [];
  const connect = async () => { const socket = io(origin, { transports: ['polling'], upgrade: false, forceNew: true }); clients.push(socket); await once(socket, 'connect', { signal: AbortSignal.timeout(3000) }); return socket; };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; clients.forEach(socket => socket.disconnect()); await new Promise(resolve => app.io.close(resolve)); };
  t.after(close);
  const post = async (action, payload, headers = {}) => {
    const response = await fetch(origin + '/api/rooms/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000) });
    return { status: response.status, ...await response.json() };
  };
  return { ...app, origin, connect, close, post };
}
const credentials = created => ({ roomId: created.room.id, participantId: created.participantId, sessionToken: created.sessionToken, ownerToken: created.ownerToken });

test('HTTP name/password joins existing rooms as Viewer; names normalize, invitations bypass passwords and only Owner can configure', async t => {
  const app = await fixture(t), owner = await app.connect(), other = await app.connect();
  const created = await request(owner, 'room:create', { nickname: 'Owner' }), second = await request(other, 'room:create', { nickname: 'Other owner' });
  const password = 'Test password 2026';
  const configured = await app.post('access', { ...credentials(created), enabled: true, name: '  Кино   У Друзей ', password });
  assert.equal(configured.ok, true); assert.equal(configured.room.loginName, 'Кино У Друзей');
  const exposed = JSON.stringify(configured); assert.ok(!exposed.includes(password)); assert.ok(!exposed.includes('salt')); assert.ok(!exposed.includes('scrypt'));
  assert.equal((await app.post('access', { ...credentials(second), name: 'кино у друзей', password })).error.code, 'NAME_TAKEN');
  const wrong = await app.post('join', { name: 'Кино У Друзей', password: 'wrong password', nickname: 'Viewer' });
  const missing = await app.post('join', { name: 'Несуществующая комната', password: 'wrong password', nickname: 'Viewer' });
  assert.deepEqual(wrong.error, missing.error);
  const joined = await app.post('join', { name: ' КИНО  у друзей ', password, nickname: 'Viewer' });
  assert.equal(joined.ok, true); assert.equal(joined.room.id, created.room.id); assert.equal(joined.ownerToken, undefined);
  const viewer = await app.connect();
  const resumed = await request(viewer, 'room:resume', { roomId: joined.room.id, participantId: joined.participantId, sessionToken: joined.sessionToken });
  assert.equal(resumed.ok, true); assert.equal(resumed.room.participants.find(member => member.id === joined.participantId).role, 'viewer');
  assert.equal((await app.post('access', { roomId: joined.room.id, participantId: joined.participantId, sessionToken: joined.sessionToken, ownerToken: created.ownerToken, enabled: false })).error.code, 'FORBIDDEN');
  assert.equal((await request(viewer, 'playback:source', { ownerToken: created.ownerToken, expectedVersion: 0, url: 'https://example.com/film', mode: 'extension' })).error.code, 'FORBIDDEN');
  assert.equal((await request(await app.connect(), 'room:join', { roomId: created.room.id, nickname: 'Invited' })).ok, true);
  assert.equal((await app.post('access', { ...credentials(created), enabled: false })).ok, true);
  assert.equal((await app.post('access', { ...credentials(second), name: 'кино у друзей', password })).ok, true);
  assert.equal((await app.post('join', { name: 'кино у друзей', password, nickname: 'New viewer' })).room.id, second.room.id);
  assert.equal((await app.post('join', { name: 'кино у друзей', password, nickname: 'Viewer' }, { Origin: 'https://attacker.invalid' })).status, 403);
});

test('private login hash, owner identity and source survive restart; site-created owner handoff reuses the room', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), '04-access-'));
  let firstApp, secondApp;
  t.after(async () => { await secondApp?.close(); await firstApp?.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('04-access-')); return rm(directory, { recursive: true, force: true }); });
  const app = await fixture(t, { stateDirectory: directory }), web = await app.connect();
  firstApp = app;
  const created = await request(web, 'room:create', { nickname: 'Site owner' });
  await request(web, 'playback:source', { mode: 'extension', url: 'https://example.com/first', expectedVersion: 0, ownerToken: created.ownerToken });
  const connection = new RoomConnection({ origin: app.origin, ...credentials(created) }); connection.start(); t.after(() => connection.disconnect()); await connection.whenReady();
  assert.equal(connection.owner, true); assert.equal(connection.pair.roomId, created.room.id);
  const password = 'Private test phrase';
  assert.equal((await connection.configureAccess({ name: 'Вечер в пятницу', password })).ok, true);
  assert.equal((await connection.setSource({ mode: 'extension', url: 'https://example.com/second' })).ok, true);
  await connection.content({ tabId: 7, frameId: 0, pageURL: 'https://example.com/second' }, { type: 'attach' });
  connection.bind({ tabId: 7, frameId: 0, pageURL: 'https://example.com/second' });
  assert.equal((await connection.content(connection.binding, { type: 'intent', action: 'seek', position: 42 })).ok, true);
  connection.disconnect(); await app.close();
  const saved = await readFile(path.join(directory, 'rooms.json'), 'utf8');
  assert.ok(!saved.includes(password)); assert.ok(!saved.includes(created.ownerToken)); assert.ok(!saved.includes(created.sessionToken));
  assert.ok(saved.includes('scrypt-v1'));
  const restored = await fixture(t, { stateDirectory: directory });
  secondApp = restored;
  const login = await restored.post('join', { name: 'вечер В ПЯТНИЦУ', password, nickname: 'Viewer' });
  assert.equal(login.ok, true); assert.equal(login.room.playback.source.url, 'https://example.com/second'); assert.equal(login.room.playback.position, 42);
  const owner = await request(await restored.connect(), 'room:resume', credentials(created));
  assert.equal(owner.ok, true); assert.equal(owner.participantId, created.participantId);
  assert.equal((await restored.post('access', { ...credentials(created), name: 'Вечер в пятницу', password: 'Replacement password' })).ok, true);
  assert.equal((await restored.post('join', { name: 'Вечер в пятницу', password, nickname: 'Viewer' })).ok, false);
  await restored.close();
});

test('login attempts are bounded, expired names are released and production refuses plaintext HTTP', async t => {
  let now = 1000;
  const app = await fixture(t, { now: () => now, inactiveMs: 100 });
  const owner = await app.connect(), created = await request(owner, 'room:create', { nickname: 'Owner' });
  assert.equal((await app.post('access', { ...credentials(created), name: 'Комната для входа', password: 'Password test' })).ok, true);
  for (let i = 0; i < 9; i++) assert.equal((await app.post('join', { name: 'unknown', password: 'wrong password', nickname: 'Viewer' })).error.code, 'INVALID_LOGIN');
  assert.equal((await app.post('join', { name: 'Комната для входа', password: 'Password test', nickname: 'Viewer' })).status, 429);
  await request(owner, 'room:leave'); now += 5 * 60_000 + 1; app.rooms.sweep();
  const newOwner = await request(await app.connect(), 'room:create', { nickname: 'New owner' });
  assert.equal((await app.post('access', { ...credentials(newOwner), name: 'комната для входа', password: 'Password test' })).ok, true);
  const production = await fixture(t, {}, { release: 'production-test' });
  assert.equal((await production.post('join', { name: 'unknown', password: 'Password test' })).status, 400);
});
