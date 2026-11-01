import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { RoomConnection } from '../extension/src/RoomConnection.mjs';
const { createApplication } = createRequire(import.meta.url)('../backend/server.cjs');
const request = (socket, event, payload = {}) => socket.timeout(3000).emitWithAck(event, payload);
async function open(t, options = {}) {
  const app = createApplication({ roomOptions: options }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const sockets = [];
  const connect = async () => { const socket = io(`http://127.0.0.1:${app.server.address().port}`, { transports: ['polling'], upgrade: false, forceNew: true }); sockets.push(socket); await once(socket, 'connect'); return socket; };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; sockets.forEach(socket => socket.disconnect()); await new Promise(resolve => app.io.close(resolve)); };
  t.after(close); return { ...app, connect, close };
}

test('private checkpoint restores the real room and credentials after process-clock reset without storing raw tokens', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), '04-room-state-')); t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('04-room-state-'));
    return rm(directory, { recursive: true, force: true });
  });
  let now = 1_000_000, clock = 100;
  const first = await open(t, { stateDirectory: directory, now: () => now, clock: () => clock });
  const owner = await first.connect(); const created = await request(owner, 'room:create', { nickname: 'Owner' });
  let state = created.room.playback;
  for (const [action, extra] of [['source', { mode: 'extension', url: 'https://example.com/film' }], ['seek', { position: 30 }], ['play', {}]]) {
    const reply = await request(owner, `playback:${action}`, { sourceId: state.sourceId, expectedVersion: state.version, ownerToken: created.ownerToken, ...extra }); assert.equal(reply.ok, true); state = reply.state;
  }
  assert.throws(() => createApplication({ roomOptions: { stateDirectory: directory } }), /single Node/);
  now += 20_000; clock += 20_000; first.rooms.sweep(); await first.close();
  const saved = await readFile(path.join(directory, 'rooms.json'), 'utf8'); assert.ok(!saved.includes(created.ownerToken)); assert.ok(!saved.includes(created.sessionToken));
  const legacy = JSON.parse(saved);
  legacy.rooms[0].login = { name: 'Old login', hash: 'private legacy hash' };
  legacy.rooms[0].playback.source.selection = { player: { id: 'venom', label: 'Full HD' }, voice: null, version: 1 };
  await writeFile(path.join(directory, 'rooms.json'), JSON.stringify(legacy));
  now += 3000; clock = 1;
  const second = await open(t, { stateDirectory: directory, now: () => now, clock: () => clock }); const socket = await second.connect();
  const resumed = await request(socket, 'room:resume', { roomId: created.room.id, participantId: created.participantId, sessionToken: created.sessionToken, ownerToken: created.ownerToken });
  assert.equal(resumed.ok, true); assert.equal(resumed.room.id, created.room.id); assert.equal(resumed.room.playback.status, 'playing'); assert.equal(resumed.room.playback.position, 53); assert.equal(resumed.room.playback.source.selection, undefined);
  assert.equal((await request(await second.connect(), 'room:resume', { roomId: created.room.id, participantId: created.participantId, sessionToken: 'a'.repeat(64), ownerToken: created.ownerToken })).error.code, 'SESSION_EXPIRED');
  await second.close();
  const migrated = await readFile(path.join(directory, 'rooms.json'), 'utf8');
  assert.ok(!migrated.includes('Old login') && !migrated.includes('selection'));
});

test('timeout during resume remains reconnecting; a confirmed retry restores the connection', async () => {
  const pair = { origin: 'http://127.0.0.1:5173', roomId: 'a'.repeat(32), participantId: 'b'.repeat(32), sessionToken: 'c'.repeat(64) };
  const connection = new RoomConnection(pair); connection.socket = { connected: true, id: 'test', disconnect() { this.connected = false; } };
  let tries = 0;
  connection.request = async () => { if (++tries === 1) throw new Error('timeout'); return { ok: true, room: { ownerId: 'd'.repeat(32), title: 'Room', playback: { version: 0, serverNow: 0, source: null } } }; };
  try { await connection.resume(); assert.equal(connection.connected, false); assert.match(connection.error, /восстанавливаем связь/); await connection.resume(); assert.equal(connection.connected, true); }
  finally { connection.disconnect(); }
});
