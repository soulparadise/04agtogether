import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
const portProbe = net.createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const appPath = new URL('../release/backend/app.js', import.meta.url);
const app = spawn(process.execPath, [fileURLToPath(appPath)], {
  env: { ...process.env, PORT: String(port), EXTENSION_ORIGINS: 'chrome-extension://igpjafcbhhcandncnhdfpphkidmcpigh' }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
app.stdout.on('data', data => output += data);
app.stderr.on('data', data => output += data);
const base = `http://127.0.0.1:${port}`;
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
  const extension = await (await fetch(base + '/downloads/extension.json')).json();
  const download = await fetch(base + extension.url);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.match(download.headers.get('content-type'), /application\/zip/);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const zip = Buffer.from(await download.arrayBuffer());
  assert.equal(createHash('sha256').update(zip).digest('hex'), extension.sha256);
  assert.equal((await fetch(base + '/downloads/' + extension.filename)).status, 200);
  assert.equal((await fetch(base + '/downloads/missing.zip')).status, 404);
  // Exercise the exact bundled probe that the hosting deployment will run.
  const probe = spawn(process.execPath, [fileURLToPath(new URL('../release/tools/check.cjs', import.meta.url)), base, manifest.release], { stdio: 'inherit' });
  const [code] = await once(probe, 'exit'); assert.equal(code, 0, 'Bundled release probe must succeed');
  console.log('Built frontend, API, SPA routing and production release probe: OK');
} finally {
  app.kill();
  await once(app, 'exit');
}
