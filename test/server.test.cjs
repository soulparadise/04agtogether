const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { io: client } = require('socket.io-client');
const { createApplication } = require('../backend/server.cjs');

test('health and two concurrent polling sessions work; unknown API routes stay 404', { timeout: 10000 }, async t => {
  const { server, io } = createApplication({ release: 'test-release' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => io.close(resolve)));
  const response = await fetch(base + '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).release, 'test-release');
  assert.equal((await fetch(base + '/api/missing')).status, 404);
  const sockets = [0, 1].map(() => client(base, { transports: ['polling'], upgrade: false, forceNew: true, reconnection: false, autoConnect: false }));
  t.after(() => sockets.forEach(socket => socket.disconnect()));
  await Promise.all(sockets.map(async socket => {
    const connected = once(socket, 'connect');
    socket.connect();
    await connected;
    assert.equal(socket.io.engine.transport.name, 'polling');
    const reply = await socket.timeout(2000).emitWithAck('infra:ping');
    assert.deepEqual(reply, { service: '04agtogether', transport: 'polling' });
  }));
  assert.notEqual(sockets[0].id, sockets[1].id);
});

test('cross-origin polling handshakes are refused', { timeout: 5000 }, async t => {
  const { server, io } = createApplication();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => io.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'https://unrelated.invalid' } });
  assert.equal(response.status, 403);
});
