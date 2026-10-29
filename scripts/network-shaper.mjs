// Development/test only. Real HTTP request/response delay; no system networking changes.
import http from 'node:http';
import { mediaStallMiddleware } from './media-stall.mjs';
export const NETWORK_PROFILES = ['none', '100', '300', '500', 'jitter'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createNetworkShaper({ target }) {
  const upstreamTarget = new URL(target);
  if (upstreamTarget.protocol !== 'http:' || upstreamTarget.hostname !== '127.0.0.1') throw new Error('Test relay target must be loopback HTTP');
  const clients = new Map();
  const active = new Set();
  let closed = false;
  function getClient(name) {
    if (!clients.has(name)) clients.set(name, { online: true, step: 0 });
    return clients.get(name);
  }
  function latency(profile, client) {
    return profile === 'jitter' ? [40, 300, 100, 500, 200, 80][client.step++ % 6] : Number(profile) || 0;
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local.test');
    if (!url.pathname.startsWith('/socket.io/')) { res.writeHead(404).end(); return; }
    const profile = url.searchParams.get('testNetwork') || 'none';
    const name = (url.searchParams.get('testClient') || 'default').slice(0, 80);
    if (!NETWORK_PROFILES.includes(profile)) { res.writeHead(400).end('Unknown test profile'); return; }
    // The map is test-only and bounded even when a LAN client sends arbitrary IDs.
    if (!clients.has(name) && clients.size >= 100) { res.writeHead(429).end(); return; }
    const client = getClient(name);
    if (closed || !client.online) { res.writeHead(503).end('Simulated offline'); return; }
    const entry = { name, res, upstream: null };
    active.add(entry);
    const finish = () => { active.delete(entry); entry.upstream?.destroy(); };
    res.once('close', finish);
    await delay(latency(profile, client));
    if (closed || res.destroyed || !client.online) { res.destroy(); return; }
    const upstream = http.request({
      hostname: upstreamTarget.hostname, port: upstreamTarget.port,
      path: req.url, method: req.method, headers: req.headers
    }, async response => {
      response.pause();
      await delay(latency(profile, client));
      if (closed || res.destroyed || !client.online) { response.destroy(); return; }
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    entry.upstream = upstream;
    upstream.on('error', () => { if (!res.destroyed && !res.headersSent) res.writeHead(502).end('Test upstream unavailable'); else res.destroy(); });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }
  return {
    handle,
    setOnline(name, online) {
      getClient(name).online = online;
      if (!online) for (const entry of active) if (entry.name === name) { entry.upstream?.destroy(); entry.res.destroy(); }
    },
    close() {
      closed = true;
      for (const entry of active) { entry.upstream?.destroy(); entry.res.destroy(); }
      active.clear(); clients.clear();
    }
  };
}

export function networkTestPlugin() {
  return {
    name: '04agtogether-dev-network-test', apply: 'serve',
    configureServer(vite) {
      vite.middlewares.use(mediaStallMiddleware());
      const target = vite.config.server.proxy['/socket.io'].target;
      const shaper = createNetworkShaper({ target });
      vite.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://local.test');
        if (url.pathname.startsWith('/socket.io/') && url.searchParams.has('testNetwork')) void shaper.handle(req, res);
        else next();
      });
      vite.httpServer.once('close', () => shaper.close());
    }
  };
}
