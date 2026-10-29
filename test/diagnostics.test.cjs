const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: client } = require('socket.io-client');
const { createApplication } = require('../backend/server.cjs');

async function setup(t, developmentDiagnostics) {
  const app = createApplication({ developmentDiagnostics });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.io.close(resolve)));
  async function connect() {
    const socket = client(`http://127.0.0.1:${app.server.address().port}`, { transports: ['polling'], upgrade: false, forceNew: true, autoConnect: false });
    t.after(() => socket.disconnect());
    const ready = once(socket, 'connect'); socket.connect(); await ready;
    return socket;
  }
  return { ...app, connect };
}
const request = (socket, event, data = {}) => socket.timeout(2000).emitWithAck(event, data);

test('production factory never registers diagnostic events', { timeout: 5000 }, async t => {
  const app = await setup(t, false);
  const socket = await app.connect();
  assert.equal(app.io.sockets.sockets.get(socket.id).listeners('dev:metrics').length, 0);
});

test('dev metrics are scoped, whitelisted and cannot forge roles or control playback', { timeout: 10000 }, async t => {
  const app = await setup(t, true);
  const owner = await app.connect();
  const created = await request(owner, 'room:create', { nickname: 'Owner' });
  const source = await request(owner, 'playback:source', { ownerToken: created.ownerToken, expectedVersion: 0, url: 'https://example.invalid/test.mp4' });
  const viewer = await app.connect();
  await request(viewer, 'room:join', { roomId: created.room.id, nickname: 'Viewer' });
  const outsider = await app.connect();
  const diagnostic = { sourceId: source.state.sourceId, position: 10, sampledAtServer: source.state.serverNow, rtt: 12, corrections: 1, role: 'owner', ownerToken: created.ownerToken, sessionToken: created.sessionToken };
  assert.equal((await request(outsider, 'dev:metrics', diagnostic)).ok, false);
  const incoming = once(owner, 'dev:metrics');
  assert.equal((await request(viewer, 'dev:metrics', diagnostic)).ok, true);
  const [report] = await incoming;
  assert.equal(report.samples[0].role, 'viewer');
  assert.equal(JSON.stringify(report).includes(created.ownerToken), false);
  assert.equal(JSON.stringify(report).includes(created.sessionToken), false);
  assert.equal((await request(owner, 'playback:get')).state.position, 0);
});
