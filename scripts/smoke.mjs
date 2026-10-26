import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import net from 'node:net';
import { io } from 'socket.io-client';
const portProbe = net.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const appPath = new URL('../release/backend/app.js', import.meta.url);
const app = spawn(process.execPath, [fileURLToPath(appPath)], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
app.stdout.on('data', data => output += data);
app.stderr.on('data', data => output += data);
const base = `http://127.0.0.1:${port}`;
const clients = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null) throw new Error(output || 'Backend exited');
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Bundled backend must start');
  const manifest = JSON.parse(await readFile(new URL('../release/release.json', import.meta.url), 'utf8'));
  assert.equal((await (await fetch(base + '/api/health')).json()).release, manifest.release);
  const html = await (await fetch(base)).text();
  assert.match(html, /04agtogether/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(base + '/api/unknown')).status, 404);
  assert.equal((await fetch(base + '/missing.js')).status, 404);
  assert.match(await (await fetch(base + '/future-route')).text(), /04agtogether/);
  await Promise.all([0, 1].map(async () => {
    const socket = io(base, { transports: ['polling'], upgrade: false, forceNew: true, autoConnect: false, reconnection: false });
    clients.push(socket);
    const connected = once(socket, 'connect');
    socket.connect();
    await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error('Polling timeout')), 5000).unref())]);
    assert.equal((await socket.timeout(2000).emitWithAck('infra:ping')).transport, 'polling');
  }));
  console.log('Built frontend, API, SPA routing and two polling clients: OK');
} finally {
  clients.forEach(client => client.disconnect());
  app.kill();
  await once(app, 'exit');
}
