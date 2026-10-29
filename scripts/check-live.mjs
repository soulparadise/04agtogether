import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { io } from 'socket.io-client';
import { pathToFileURL } from 'node:url';

export async function checkLive(base, expectedRelease, ip) {
  const url = new URL(base);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('HTTPS is required outside loopback');
  if (ip && (url.origin !== 'https://soulparadise.ru' || ip !== '45.130.41.94')) throw new Error('Unexpected deployment destination');
  const agent = url.protocol === 'https:' ? new https.Agent(ip ? { lookup: (_host, options, callback) => options?.all ? callback(null, [{ address: ip, family: 4 }]) : callback(null, ip, 4) } : {}) : new http.Agent();
  const extensionOrigin = 'chrome-extension://igpjafcbhhcandncnhdfpphkidmcpigh';
  const clients = [];
  const get = pathname => new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(new URL(pathname, base), { agent, timeout: 10000 }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', value => body += value); response.on('end', () => resolve({ status: response.statusCode, body }));
    }); request.on('timeout', () => request.destroy(new Error('HTTPS health timeout'))); request.on('error', reject);
  });
  try {
    const health = await get('/api/health'); assert.equal(health.status, 200);
    const initial = JSON.parse(health.body);
    assert.equal(initial.release, expectedRelease); assert.match(initial.instance, /^[a-f0-9]{16}$/);
    assert.equal((await get('/room/' + 'a'.repeat(32))).status, 200, 'SPA route must load');
    for (const origin of [url.origin, extensionOrigin]) {
      const socket = io(base, { agent, extraHeaders: { Origin: origin }, transports: ['polling'], upgrade: false, autoConnect: false, forceNew: true, reconnection: false, timeout: 10000 });
      clients.push(socket);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', () => reject(new Error('Production polling/Origin connection failed'))); socket.connect(); });
      assert.equal((await socket.timeout(10000).emitWithAck('infra:ping')).instance, initial.instance, 'Different Node workers cannot share in-memory rooms');
    }
    const request = (socket, event, payload) => socket.timeout(10000).emitWithAck(event, payload);
    const owner = await request(clients[0], 'room:create', { nickname: 'Release check' }); assert.equal(owner.ok, true);
    const viewer = await request(clients[1], 'room:join', { roomId: owner.room.id, nickname: 'Release viewer' });
    assert.equal(viewer.ok, true, 'Clients must see the same in-memory room; verify the Passenger process limit');
    let state = owner.room.playback;
    for (const [action, payload] of [['source', { url: new URL('/unused-release-check.mp4', base).href }], ['play', {}], ['seek', { position: 7 }], ['pause', {}]]) {
      const reply = await request(clients[0], `playback:${action}`, { ...payload, sourceId: state.sourceId, expectedVersion: state.version, ownerToken: owner.ownerToken });
      assert.equal(reply.ok, true); state = reply.state;
    }
    const actual = await request(clients[1], 'playback:get', {}); assert.equal(actual.ok, true); assert.equal(actual.state.version, state.version); assert.equal(actual.state.status, 'paused');
    const denied = await request(clients[1], 'playback:play', { sourceId: state.sourceId, expectedVersion: state.version, ownerToken: owner.ownerToken }); assert.equal(denied.ok, false);
    await Promise.all(clients.map(socket => request(socket, 'room:leave', {})));
    assert.equal(JSON.parse((await get('/api/health')).body).instance, initial.instance);
    console.log('Release HTTPS/API/SPA, web + extension polling, shared room and roles: OK');
  } finally { clients.forEach(socket => socket.disconnect()); agent.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkLive(process.argv[2], process.argv[3], process.argv[4]).catch(() => { console.error('Release check failed; verify HTTPS, extension Origin and a single Passenger process.'); process.exitCode = 1; });
}
