const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: client } = require('socket.io-client');
const { createApplication } = require('../backend/server.cjs');
const { createPlayback, applyPlayback } = require('../backend/playback.cjs');

async function setup(t) {
  let monotonic = 10000;
  let wall = 100000;
  const app = createApplication({ roomOptions: { clock: () => monotonic, now: () => wall } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  async function connect() {
    const socket = client(url, { transports: ['polling'], upgrade: false, forceNew: true, autoConnect: false, reconnection: false });
    t.after(() => socket.disconnect());
    const ready = once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
    socket.connect(); await ready;
    assert.equal(socket.io.engine.transport.name, 'polling');
    return socket;
  }
  const owner = await connect();
  const created = await request(owner, 'room:create', { nickname: 'Аня' });
  let state = created.room.playback;
  async function command(action, data = {}) {
    const reply = await request(owner, `playback:${action}`, { expectedVersion: state.version, sourceId: state.sourceId, ownerToken: created.ownerToken, ...data });
    if (reply.ok) state = reply.state;
    return reply;
  }
  async function join() {
    const socket = await connect();
    const joined = await request(socket, 'room:join', { roomId: created.room.id, nickname: 'Борис' });
    return { socket, joined };
  }
  return { app, owner, created, connect, command, join, state: () => state, advance: ms => monotonic += ms, wall: value => { wall = value; } };
}
const request = (socket, event, payload = {}) => socket.timeout(2000).emitWithAck(event, payload);
const source = 'https://example.invalid/allowed-test.mp4';

test('non-finite positions and durations cannot enter the server model', () => {
  const clock = () => 0;
  const loaded = applyPlayback(createPlayback(clock), 'source', { expectedVersion: 0, url: source }, clock).playback;
  for (const value of [NaN, Infinity, -Infinity]) {
    const common = { expectedVersion: loaded.version, sourceId: loaded.sourceId };
    assert.equal(applyPlayback(loaded, 'seek', { ...common, position: value }, clock).error.code, 'INVALID_POSITION');
    assert.equal(applyPlayback(loaded, 'metadata', { ...common, duration: value }, clock).error.code, 'INVALID_DURATION');
  }
  assert.equal(loaded.basePosition, 0);
});

test('all playback writes require the actual owner and token; separate rooms and outsiders are isolated', { timeout: 10000 }, async t => {
  const env = await setup(t);
  const { socket: viewer } = await env.join();
  const outsider = await env.connect();
  assert.equal((await request(outsider, 'playback:get')).error.code, 'NOT_IN_ROOM');
  const other = await env.connect();
  const separate = await request(other, 'room:create', { nickname: 'Другой' });
  for (const action of ['source', 'play', 'pause', 'seek', 'metadata']) {
    const data = { role: 'owner', ownerId: env.created.participantId, ownerToken: env.created.ownerToken, expectedVersion: 0, sourceId: null, url: source, position: 5, duration: 90 };
    assert.equal((await request(viewer, `playback:${action}`, data)).error.code, 'FORBIDDEN');
    assert.equal((await request(other, `playback:${action}`, data)).error.code, 'FORBIDDEN');
    assert.equal((await request(outsider, `playback:${action}`, data)).error.code, 'NOT_IN_ROOM');
    assert.equal((await env.command(action, { ...data, ownerToken: '0'.repeat(64) })).error.code, 'FORBIDDEN');
  }
  const broadcast = once(viewer, 'playback:state');
  const loaded = await env.command('source', { url: source });
  assert.equal(loaded.ok, true);
  assert.equal((await broadcast)[0].roomId, env.created.room.id);
  assert.equal((await request(other, 'playback:get')).state.source, null);
  assert.notEqual(separate.room.id, env.created.room.id);
  for (const [action, data] of [['play', {}], ['pause', {}], ['seek', { position: 12 }]]) {
    const changed = once(viewer, 'playback:state');
    const reply = await env.command(action, data);
    assert.equal(reply.ok, true);
    assert.equal((await changed)[0].state.version, reply.state.version);
  }
});

test('monotonic position, frozen pause, duration bounds and end/replay are authoritative', { timeout: 10000 }, async t => {
  const env = await setup(t);
  await env.command('source', { url: source });
  await env.command('metadata', { duration: 90 });
  await env.command('play');
  env.advance(12500); env.wall(-1000000);
  assert.equal((await request(env.owner, 'playback:get')).state.position, 12.5);
  await env.command('pause'); env.advance(15000);
  assert.equal((await request(env.owner, 'playback:get')).state.position, 12.5);
  await env.command('seek', { position: 500 });
  assert.equal(env.state().position, 90);
  await env.command('play');
  assert.equal(env.state().position, 0);
  env.advance(100000);
  const ended = (await request(env.owner, 'playback:get')).state;
  assert.equal(ended.position, 90); assert.equal(ended.status, 'ended');
});

test('new viewers and reconnected sessions receive current playing position via polling', { timeout: 10000 }, async t => {
  const env = await setup(t);
  await env.command('source', { url: source }); await env.command('play');
  env.advance(18000);
  const { socket, joined } = await env.join();
  assert.equal(joined.room.playback.position, 18);
  assert.equal(joined.room.playback.status, 'playing');
  const disconnected = once(env.app.io.sockets.sockets.get(socket.id), 'disconnect');
  socket.disconnect(); await disconnected;
  env.advance(4000);
  const replacement = await env.connect();
  const restored = await request(replacement, 'room:resume', { roomId: env.created.room.id, participantId: joined.participantId, sessionToken: joined.sessionToken });
  assert.equal(restored.participantId, joined.participantId);
  assert.equal(restored.room.playback.position, 22);
  assert.equal((await request(replacement, 'playback:get')).state.position, 22);
});

test('source changes reset position and reject old-source commands and stale versions', { timeout: 10000 }, async t => {
  const env = await setup(t);
  await env.command('source', { url: source }); await env.command('play'); env.advance(8000);
  const old = env.state();
  await env.command('source', { url: 'https://example.invalid/next.webm' });
  assert.equal(env.state().position, 0); assert.equal(env.state().status, 'paused');
  assert.equal(env.state().duration, null);
  assert.notEqual(env.state().sourceId, old.sourceId);
  assert.ok(env.state().version > old.version);
  assert.equal((await env.command('seek', { sourceId: old.sourceId, position: 20 })).error.code, 'STALE_SOURCE');
  assert.equal((await env.command('play', { expectedVersion: old.version })).error.code, 'STALE_STATE');
  assert.equal((await env.command('source', { url: source, expectedVersion: old.version })).error.code, 'STALE_STATE');
  assert.equal((await request(env.owner, 'playback:get')).state.position, 0);
});

test('invalid URLs and numerical times are refused without mutating playback', { timeout: 10000 }, async t => {
  const env = await setup(t);
  for (const url of ['javascript:alert(1)', 'data:video/mp4,test', 'file:///C:/secret.mp4', 'blob:https://example.org/id', 'ftp://example.org/video.mp4', 'https://user:pass@example.org/a.mp4', 'not a url', 'https://example.org/\nvideo', 'x'.repeat(4097), 123]) {
    assert.equal((await env.command('source', { url })).error.code, 'INVALID_SOURCE');
  }
  assert.equal(env.state().version, 0);
  await env.command('source', { url: 'http://127.0.0.1:5173/test-media/sync-test.mp4' });
  for (const position of [-1, '12', null, 604801]) assert.equal((await env.command('seek', { position })).error.code, 'INVALID_POSITION');
  for (const duration of [0, -1, '90', null, 604801]) assert.equal((await env.command('metadata', { duration })).error.code, 'INVALID_DURATION');
  assert.equal(env.state().position, 0);
});
