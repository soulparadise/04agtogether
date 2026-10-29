const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: client } = require('socket.io-client');
const { createApplication } = require('../backend/server.cjs');

async function setup(t, roomOptions) {
  const app = createApplication({ roomOptions });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function connect() {
    const socket = client(base, { transports: ['polling'], upgrade: false, forceNew: true, reconnection: false, autoConnect: false });
    t.after(() => socket.disconnect());
    const ready = once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
    socket.connect();
    await ready;
    assert.equal(socket.io.engine.transport.name, 'polling');
    return socket;
  }
  async function disconnect(socket) {
    const closed = once(app.io.sockets.sockets.get(socket.id), 'disconnect');
    socket.disconnect();
    await closed;
  }
  return { ...app, connect, disconnect };
}
const request = (socket, event, data = {}) => socket.timeout(2000).emitWithAck(event, data);
const create = (socket, nickname = 'Аня') => request(socket, 'room:create', { nickname });
const resume = (socket, session, extra = {}) => request(socket, 'room:resume', {
  roomId: session.room.id, participantId: session.participantId,
  sessionToken: session.sessionToken, ownerToken: session.ownerToken, ...extra
});
const member = (reply, id = reply.participantId) => reply.room.participants.find(item => item.id === id);
const update = (socket, title, ownerToken) => request(socket, 'room:update', { title, ownerToken });

test('create: random IDs, private credentials, owner role and duplicate create', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const owner = await app.connect();
  const created = await create(owner);
  assert.equal(created.ok, true);
  assert.match(created.room.id, /^[a-f0-9]{32}$/);
  assert.match(created.ownerToken, /^[a-f0-9]{64}$/);
  assert.notEqual(created.ownerToken, created.sessionToken);
  assert.equal(member(created).role, 'owner');
  assert.equal(created.room.participants.length, 1);
  assert.equal(JSON.stringify(created.room).includes(created.ownerToken), false);
  assert.equal(JSON.stringify(created.room).includes(created.sessionToken), false);
  const duplicate = await create(owner);
  assert.equal(duplicate.room.id, created.room.id);
  assert.equal(duplicate.participantId, created.participantId);
  const other = await create(await app.connect());
  assert.notEqual(other.room.id, created.room.id);
});

test('join/leave update participants, repeated join is idempotent, room snapshots hide tokens', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const owner = await app.connect();
  const created = await create(owner);
  const viewer = await app.connect();
  const changed = once(owner, 'room:state');
  const joined = await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Борис' });
  assert.equal(joined.ok, true);
  assert.equal(member(joined).role, 'viewer');
  assert.equal((await changed)[0].participants.length, 2);
  assert.equal(Object.hasOwn(joined, 'ownerToken'), false);
  assert.equal(JSON.stringify(joined).includes(created.ownerToken), false);
  assert.equal(JSON.stringify(joined).includes(created.sessionToken), false);
  const duplicate = await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Борис' });
  assert.equal(duplicate.participantId, joined.participantId);
  assert.equal(duplicate.room.participants.length, 2);
  const left = once(owner, 'room:state');
  await request(viewer, 'room:leave');
  assert.equal((await left)[0].participants.length, 1);
  assert.equal((await resume(viewer, joined)).error.code, 'SESSION_EXPIRED');
});

test('room isolation and server-side authorization on every protected update', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const owner = await app.connect();
  const created = await create(owner);
  const otherOwner = await app.connect();
  const other = await create(otherOwner, 'Другой владелец');
  const viewer = await app.connect();
  const joined = await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Аня', role: 'owner', ownerId: created.participantId });
  assert.equal(member(joined).role, 'viewer');
  assert.equal((await update(viewer, 'Взлом', '0'.repeat(64))).error.code, 'FORBIDDEN');
  assert.equal((await update(viewer, 'Взлом', created.ownerToken)).error.code, 'FORBIDDEN');
  assert.equal((await update(otherOwner, 'Взлом', created.ownerToken)).error.code, 'FORBIDDEN');
  assert.equal((await update(owner, 'Новый вечер', '0'.repeat(64))).error.code, 'FORBIDDEN');
  const changed = once(viewer, 'room:state');
  assert.equal((await update(owner, 'Новый вечер', created.ownerToken)).ok, true);
  assert.equal((await changed)[0].title, 'Новый вечер');
  const separate = await resume(otherOwner, other);
  assert.equal(separate.room.title, 'Вечер вместе');
  assert.equal(separate.room.participants.length, 1);
  assert.equal((await update(await app.connect(), 'Взлом', created.ownerToken)).error.code, 'NOT_IN_ROOM');
});

test('owner refresh restores identity even with stale polling; forged sessions cannot take over', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const owner = await app.connect();
  const created = await create(owner);
  const anotherTab = await app.connect();
  assert.equal((await resume(anotherTab, created, { sessionToken: 'f'.repeat(64) })).error.code, 'SESSION_EXPIRED');
  assert.equal((await resume(anotherTab, created, { ownerToken: 'f'.repeat(64) })).error.code, 'FORBIDDEN');
  // Keep the original socket connected, exactly as with stale browser polling.
  const replaced = once(owner, 'room:session-replaced');
  const restored = await resume(anotherTab, created);
  assert.equal((await replaced)[0].roomId, created.room.id);
  assert.equal((await update(owner, 'Старое подключение', created.ownerToken)).error.code, 'NOT_IN_ROOM');
  assert.equal(restored.ok, true);
  assert.equal(restored.participantId, created.participantId);
  assert.equal(restored.room.participants.length, 1);
  assert.equal(member(restored).role, 'owner');
  assert.equal((await update(anotherTab, 'После обновления', created.ownerToken)).ok, true);
});

test('temporary disconnect keeps owner, viewer resume does not duplicate, no ownership transfer', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const owner = await app.connect();
  const created = await create(owner);
  const viewer = await app.connect();
  const joined = await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Борис' });
  const offline = once(viewer, 'room:state');
  await app.disconnect(owner);
  const state = (await offline)[0];
  assert.equal(state.participants.find(item => item.id === created.participantId).connected, false);
  assert.equal(state.ownerId, created.participantId);
  assert.equal((await update(viewer, 'Нельзя', created.ownerToken)).error.code, 'FORBIDDEN');
  await app.disconnect(viewer);
  const restored = await resume(await app.connect(), joined);
  assert.equal(restored.participantId, joined.participantId);
  assert.equal(restored.room.participants.length, 2);
  assert.equal(member(restored).role, 'viewer');
  assert.equal((await resume(await app.connect(), created)).ok, true);
});

test('inactive rooms expire, active rooms survive; expired viewer must join again', { timeout: 10000 }, async t => {
  let clock = 0;
  const app = await setup(t, { now: () => clock, inactiveMs: 1000, reconnectMs: 100 });
  const owner = await app.connect();
  const created = await create(owner);
  const viewer = await app.connect();
  const joined = await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Борис' });
  await app.disconnect(viewer);
  clock = 200; app.rooms.sweep();
  assert.equal((await resume(await app.connect(), joined)).error.code, 'SESSION_EXPIRED');
  clock = 2000; app.rooms.sweep();
  assert.equal((await resume(owner, created)).ok, true);
  await app.disconnect(owner);
  clock = 2500; app.rooms.sweep();
  const probe = await app.connect();
  assert.equal((await resume(probe, created)).ok, true);
  await app.disconnect(probe);
  clock = 3500; app.rooms.sweep();
  assert.equal((await resume(await app.connect(), created)).error.code, 'ROOM_NOT_FOUND');
});

test('bad payloads, unknown rooms, capacity and explicit owner leave are safe', { timeout: 10000 }, async t => {
  const app = await setup(t, { maxRooms: 1, maxParticipants: 2 });
  const owner = await app.connect();
  assert.equal((await request(owner, 'room:create', null)).error.code, 'INVALID_REQUEST');
  assert.equal((await create(owner, ' ')).error.code, 'INVALID_NICKNAME');
  const created = await create(owner);
  const viewer = await app.connect();
  assert.equal((await request(viewer, 'room:join', { roomId: 'missing', nickname: 'Б' })).error.code, 'ROOM_NOT_FOUND');
  assert.equal((await create(viewer)).error.code, 'ROOM_LIMIT');
  await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Борис' });
  assert.equal((await request(await app.connect(), 'room:join', { roomId: created.room.id, nickname: 'Вера' })).error.code, 'PARTICIPANT_LIMIT');
  assert.equal((await update(owner, '', created.ownerToken)).error.code, 'INVALID_TITLE');
  await request(owner, 'room:leave');
  assert.equal((await update(owner, 'Вне комнаты', created.ownerToken)).error.code, 'NOT_IN_ROOM');
  assert.equal((await resume(owner, created)).ok, true);
});
