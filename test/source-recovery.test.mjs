import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { io } from 'socket.io-client';
import { matchesSelection, selectionHint, voiceOption, applyVoice, applyPlayer } from '../extension/src/source-selection.mjs';
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

test('selection changes preserve playback, reject viewers/stale commands and resume the latest source', async t => {
  const app = await open(t); const owner = await app.connect(), viewer = await app.connect();
  const created = await request(owner, 'room:create', { nickname: 'Owner' });
  await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Viewer' });
  let state = created.room.playback;
  const command = async (action, extra) => { const reply = await request(owner, `playback:${action}`, { sourceId: state.sourceId, expectedVersion: state.version, ownerToken: created.ownerToken, ...extra }); assert.equal(reply.ok, true); state = reply.state; return reply; };
  await command('source', { mode: 'extension', url: 'https://example.com/film' }); await command('seek', { position: 200 }); await command('play');
  const oldSource = state.sourceId;
  const selection = { player: { id: 'allplay', label: 'Плеер 2 · Allplay' }, voice: voiceOption('Рус. Дублированный') };
  await command('selection', { selection });
  assert.equal(state.status, 'playing'); assert.ok(state.position >= 200); assert.notEqual(state.sourceId, oldSource); assert.equal(state.source.selection.version, 1);
  const got = await request(viewer, 'playback:get'); assert.deepEqual(got.state.source.selection, state.source.selection);
  assert.equal((await request(viewer, 'playback:selection', { selection, sourceId: state.sourceId, expectedVersion: state.version, ownerToken: created.ownerToken })).error.code, 'FORBIDDEN');
  assert.equal((await request(owner, 'playback:pause', { sourceId: oldSource, expectedVersion: state.version, ownerToken: created.ownerToken })).error.code, 'STALE_SOURCE');
  await command('pause'); await command('seek', { position: 345 });
  const renewed = await app.connect();
  const resumed = await request(renewed, 'room:resume', { roomId: created.room.id, participantId: created.participantId, sessionToken: created.sessionToken, ownerToken: created.ownerToken });
  assert.equal(resumed.ok, true); assert.equal(resumed.room.playback.position, 345); assert.deepEqual(resumed.room.playback.source.selection, state.source.selection);
});

test('private checkpoint restores the real room and credentials after process-clock reset without storing raw tokens', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), '04-room-state-')); t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('04-room-state-'));
    return rm(directory, { recursive: true, force: true });
  });
  let now = 1_000_000, clock = 100;
  const first = await open(t, { stateDirectory: directory, now: () => now, clock: () => clock });
  const owner = await first.connect(); const created = await request(owner, 'room:create', { nickname: 'Owner' });
  let state = created.room.playback;
  for (const [action, extra] of [['source', { mode: 'extension', url: 'https://example.com/film' }], ['selection', { selection: { player: { id: 'venom', label: 'Full HD' }, voice: voiceOption('Дубляж') } }], ['seek', { position: 30 }], ['play', {}]]) {
    const reply = await request(owner, `playback:${action}`, { sourceId: state.sourceId, expectedVersion: state.version, ownerToken: created.ownerToken, ...extra }); assert.equal(reply.ok, true); state = reply.state;
  }
  assert.throws(() => createApplication({ roomOptions: { stateDirectory: directory } }), /single Node/);
  now += 20_000; clock += 20_000; first.rooms.sweep(); await first.close();
  const saved = await readFile(path.join(directory, 'rooms.json'), 'utf8'); assert.ok(!saved.includes(created.ownerToken)); assert.ok(!saved.includes(created.sessionToken));
  now += 3000; clock = 1;
  const second = await open(t, { stateDirectory: directory, now: () => now, clock: () => clock }); const socket = await second.connect();
  const resumed = await request(socket, 'room:resume', { roomId: created.room.id, participantId: created.participantId, sessionToken: created.sessionToken, ownerToken: created.ownerToken });
  assert.equal(resumed.ok, true); assert.equal(resumed.room.id, created.room.id); assert.equal(resumed.room.playback.status, 'playing'); assert.equal(resumed.room.playback.position, 53); assert.equal(resumed.room.playback.source.selection.voice.label, 'Дубляж');
  assert.equal((await request(await second.connect(), 'room:resume', { roomId: created.room.id, participantId: created.participantId, sessionToken: 'a'.repeat(64), ownerToken: created.ownerToken })).error.code, 'SESSION_EXPIRED');
  await second.close();
});

test('timeout during resume remains reconnecting; a confirmed retry restores the connection', async () => {
  const pair = { origin: 'http://127.0.0.1:5173', roomId: 'a'.repeat(32), participantId: 'b'.repeat(32), sessionToken: 'c'.repeat(64) };
  const connection = new RoomConnection(pair); connection.socket = { connected: true, id: 'test', disconnect() { this.connected = false; } };
  let tries = 0;
  connection.request = async () => { if (++tries === 1) throw new Error('timeout'); return { ok: true, room: { ownerId: 'd'.repeat(32), title: 'Room', playback: { version: 0, serverNow: 0, source: null } } }; };
  try { await connection.resume(); assert.equal(connection.connected, false); assert.match(connection.error, /восстанавливаем связь/); await connection.resume(); assert.equal(connection.connected, true); }
  finally { connection.disconnect(); }
});

test('source adapter compares labels, never option indexes, and refuses unidentified tabs or ambiguous voices', () => {
  const desired = { player: { id: 'allplay', label: 'Плеер 2' }, voice: voiceOption('Дубляж') };
  assert.equal(matchesSelection({ ...desired, voice: voiceOption('Другая') }, desired), false);
  assert.match(selectionHint(null, desired), /другой плеер/);
  const options = [{ textContent: 'Другая', value: '0' }, { textContent: 'Дубляж', value: '42' }];
  let changed = false;
  const select = { options, selectedOptions: [options[0]], labels: [], getAttribute: () => 'Озвучка', dispatchEvent: () => { changed = true; } };
  const document = { defaultView: { Event: class {} }, querySelector: selector => selector === 'video.allplay__video' ? {} : null, querySelectorAll: selector => selector === 'select' ? [select] : [] };
  assert.equal(applyVoice(document, desired), true); assert.equal(select.value, '42'); assert.equal(changed, true);
  options.push({ textContent: 'Дубляж', value: '99' }); assert.equal(applyVoice(document, desired), false);
  assert.equal(applyPlayer(document, desired), false);
});
