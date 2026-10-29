import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createServer } from 'vite';
import { io } from 'socket.io-client';
import { startDevelopmentBackend } from '../backend/dev.cjs';
import config from '../frontend/vite.config.mjs';

test('source app: Vite proxy, origin protection, two polling clients and backend restart', { timeout: 25000 }, async t => {
  let backend = await startDevelopmentBackend({ port: 0 });
  const backendPort = backend.server.address().port;
  assert.equal(backend.server.address().address, '127.0.0.1');
  t.after(() => new Promise(resolve => backend.io.close(resolve)));
  const target = `http://127.0.0.1:${backendPort}`;
  // Vite treats port 0 as its default port, so reserve a free port explicitly.
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const frontendPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const frontend = await createServer({
    ...config,
    configFile: false,
    root: fileURLToPath(new URL('../frontend/', import.meta.url)),
    server: {
      ...config.server,
      port: frontendPort,
      hmr: false,
      proxy: Object.fromEntries(Object.entries(config.server.proxy).map(([route, options]) => [route, { ...options, target }]))
    }
  });
  t.after(() => frontend.close());
  await frontend.listen();
  const base = `http://127.0.0.1:${frontend.httpServer.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.match(await (await fetch(base + '/src/main.jsx')).text(), /createRoot/);
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).release, 'development');
  assert.equal((await fetch(base + '/api/unknown')).status, 404);
  const denied = await fetch(base + '/socket.io/?EIO=4&transport=polling', { headers: { Origin: 'https://unrelated.invalid' } });
  assert.equal(denied.status, 403);

  const clients = [0, 1].map(() => io(base, {
    transports: ['polling'], upgrade: false, forceNew: true,
    autoConnect: false, extraHeaders: { Origin: base },
    reconnectionDelay: 100, reconnectionDelayMax: 200, randomizationFactor: 0
  }));
  t.after(() => clients.forEach(client => client.disconnect()));
  const waitFor = (client, event) => once(client, event, { signal: AbortSignal.timeout(8000) });
  const connected = clients.map(client => waitFor(client, 'connect'));
  clients.forEach(client => client.connect());
  await Promise.all(connected);
  const oldIds = clients.map(client => client.id);
  assert.notEqual(oldIds[0], oldIds[1]);
  for (const client of clients) {
    assert.equal(client.io.engine.transport.name, 'polling');
    assert.equal((await client.timeout(2000).emitWithAck('infra:ping')).transport, 'polling');
  }

  const disconnected = clients.map(client => waitFor(client, 'disconnect'));
  const reconnected = clients.map(client => waitFor(client, 'connect'));
  await new Promise(resolve => backend.io.close(resolve));
  await Promise.all(disconnected);
  backend = await startDevelopmentBackend({ port: backendPort });
  await Promise.all(reconnected);
  for (const [index, client] of clients.entries()) {
    assert.notEqual(client.id, oldIds[index]);
    assert.equal((await client.timeout(2000).emitWithAck('infra:ping')).transport, 'polling');
  }
});
