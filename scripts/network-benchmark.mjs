import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createApplication } from '../backend/server.cjs';
import { PlaybackSync } from '../frontend/src/player/PlaybackSync.mjs';
import { createNetworkShaper } from './network-shaper.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(predicate, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('Network scenario timed out'); await sleep(25); }
}

// Explicit media-clock simulation. No frames are decoded and no media is fetched.
class ModelAdapter {
  constructor() { this.position = 0; this.anchor = performance.now(); this.paused = true; this.buffering = false; this.listeners = new Map(); }
  on(event, listener) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(listener); return () => this.listeners.get(event)?.delete(listener); }
  emit(event) { this.listeners.get(event)?.forEach(listener => listener()); }
  getCurrentTime() { return Math.min(600, this.position + (!this.paused && !this.buffering ? (performance.now() - this.anchor) / 1000 : 0)); }
  seek(position) { this.position = position; this.anchor = performance.now(); }
  load() { this.paused = true; this.seek(0); queueMicrotask(() => this.emit('ready')); }
  play() { if (this.paused) { this.anchor = performance.now(); this.paused = false; } return Promise.resolve(); }
  pause() { this.position = this.getCurrentTime(); this.anchor = performance.now(); this.paused = true; }
  isReady() { return true; }
  getDuration() { return 600; }
  getPlaybackState() { return this.paused ? 'paused' : 'playing'; }
  stall(stalled) { this.position = this.getCurrentTime(); this.anchor = performance.now(); this.buffering = stalled; this.emit(stalled ? 'buffering' : 'ready'); }
  destroy() { this.pause(); this.listeners.clear(); }
}

export async function createHarness() {
  const app = createApplication();
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const shaper = createNetworkShaper({ target: `http://127.0.0.1:${app.server.address().port}` });
  const relay = http.createServer((req, res) => void shaper.handle(req, res));
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const base = `http://127.0.0.1:${relay.address().port}`;
  const clients = [];
  const request = (socket, event, payload = {}) => socket.timeout(8000).emitWithAck(event, payload);
  async function connect(profile = 'none') {
    const name = `client-${clients.length}`;
    const socket = io(base, {
      transports: ['polling'], upgrade: false, forceNew: true, autoConnect: false,
      query: { testNetwork: profile, testClient: name }, extraHeaders: { Origin: base },
      reconnectionDelay: 100, reconnectionDelayMax: 200, randomizationFactor: 0
    });
    const item = { socket, name, profile, session: null, sync: null };
    clients.push(item);
    socket.on('disconnect', () => item.sync?.setConnected(false));
    socket.on('connect', async () => {
      if (!item.session || !item.sync) return;
      item.sync.setConnected(true);
      try {
        const reply = await request(socket, 'room:resume', item.session);
        if (!reply.ok) throw new Error(reply.error.code);
        item.sync.accept(reply.room.playback); void item.sync.refresh();
      } catch { /* The scenario's deadline reports a failed recovery. */ }
    });
    const ready = once(socket, 'connect', { signal: AbortSignal.timeout(10000) });
    socket.connect(); await ready;
    assert.equal(socket.io.engine.transport.name, 'polling');
    return item;
  }
  function attach(item, reply) {
    item.session = { roomId: reply.room.id, participantId: reply.participantId, sessionToken: reply.sessionToken, ...(reply.ownerToken ? { ownerToken: reply.ownerToken } : {}) };
    item.adapter = new ModelAdapter();
    item.sync = new PlaybackSync({ adapter: item.adapter, diagnostics: true, now: () => performance.now() + (reply.ownerToken ? 37000 : 123000), request: (event, payload) => request(item.socket, event, payload) });
    item.socket.on('playback:state', report => { if (report.roomId === item.session.roomId) item.sync.accept(report.state); });
    item.sync.accept(reply.room.playback); void item.sync.refresh();
    return item;
  }
  async function owner() {
    const item = await connect();
    const reply = await request(item.socket, 'room:create', { nickname: 'Owner' });
    return attach(item, reply);
  }
  async function viewer(owner, profile) {
    const item = await connect(profile);
    return attach(item, await request(item.socket, 'room:join', { roomId: owner.session.roomId, nickname: 'Viewer' }));
  }
  async function command(owner, action, payload = {}) {
    const current = await request(owner.socket, 'playback:get');
    const reply = await request(owner.socket, `playback:${action}`, { ...payload, ownerToken: owner.session.ownerToken, sourceId: current.state.sourceId, expectedVersion: current.state.version });
    assert.equal(reply.ok, true, reply.error?.code);
    return reply;
  }
  async function close() {
    clients.forEach(item => { item.sync?.destroy(); item.socket.disconnect(); });
    shaper.close();
    await Promise.all([new Promise(resolve => relay.close(resolve)), new Promise(resolve => app.io.close(resolve))]);
  }
  return { app, shaper, owner, viewer, command, close, request };
}

function sample(owner, viewer) {
  const ownerPosition = owner.adapter.getCurrentTime();
  const viewerPosition = viewer.adapter.getCurrentTime();
  const metric = viewer.sync.getDiagnostics();
  return { measuredAt: performance.now(), ownerPosition, viewerPosition, deviation: Math.abs(ownerPosition - viewerPosition), targetPosition: metric.targetPosition, clientDrift: metric.drift, bestRttMs: metric.bestRtt, rttMs: metric.rtt, corrections: metric.corrections };
}
async function samples(owner, viewer, count = 8) {
  const result = [];
  for (let index = 0; index < count; index++) { result.push(sample(owner, viewer)); await sleep(350); }
  return result;
}
function summarize(measurements) {
  const deviations = measurements.map(item => item.deviation).sort((a, b) => a - b);
  const rtts = measurements.map(item => item.rttMs).filter(Number.isFinite);
  return { samples: measurements.length, meanDeviation: deviations.reduce((sum, value) => sum + value, 0) / deviations.length, maxDeviation: deviations.at(-1), meanRttMs: rtts.reduce((sum, value) => sum + value, 0) / rtts.length, corrections: measurements.at(-1).corrections };
}

export async function runNetworkBenchmarks({ profiles = ['none', '100', '300', '500', 'jitter'], extended = true } = {}) {
  const report = { kind: 'SIMULATION: real HTTP polling + delayed HTTP relay + media clock adapters; not browser video measurements', delayDefinition: '100/300/500 = milliseconds per HTTP request leg AND per response leg; nominal additional RTT = 2x; jitter = 40..500 ms per leg', stabilizationRule: 'Observe 4.2 seconds of startup, then wait for 3 completed clock samples. No filtering by measured deviation.', createdAt: new Date().toISOString(), scenarios: [] };
  const harness = await createHarness();
  let failure;
  try {
    for (const profile of profiles) {
      const owner = await harness.owner();
      await harness.command(owner, 'source', { url: 'https://example.invalid/model-only.mp4' });
      await harness.command(owner, 'metadata', { duration: 600 });
      const viewer = await harness.viewer(owner, profile);
      await harness.command(owner, 'play');
      await waitFor(() => viewer.sync.state.status === 'playing');
      const startupMeasurements = await samples(owner, viewer, 12);
      await waitFor(() => viewer.sync.getDiagnostics().clockSamples >= 3);
      const measurements = await samples(owner, viewer, 20);
      const summary = summarize(measurements);
      report.scenarios.push({ name: `steady-${profile}`, profile, startupMeasurements, startupMaxDeviation: Math.max(...startupMeasurements.map(item => item.deviation)), measurements, passed: summary.maxDeviation <= 0.5, ...summary });
      console.log(`steady-${profile}: max=${summary.maxDeviation.toFixed(3)}s RTT=${summary.meanRttMs.toFixed(0)}ms`);
      if (profile === '500' && extended) {
        const measurements = [];
        for (const position of [45, 90, 135]) {
          const started = performance.now();
          await harness.command(owner, 'seek', { position });
          await harness.command(owner, 'pause');
          await waitFor(() => viewer.sync.state.status === 'paused' && Math.abs(viewer.adapter.getCurrentTime() - position) < 0.5);
          measurements.push({ ...sample(owner, viewer), commandConvergenceMs: performance.now() - started });
          await harness.command(owner, 'play'); await waitFor(() => viewer.sync.state.status === 'playing');
        }
        report.scenarios.push({ name: 'seek-pause-500', measurements, ...summarize(measurements) });
        assert.ok(measurements.every(item => item.deviation <= 0.5));
      }
      owner.sync.destroy(); viewer.sync.destroy(); owner.socket.disconnect(); viewer.socket.disconnect();
    }
    if (extended) {
    const owner = await harness.owner();
    await harness.command(owner, 'source', { url: 'https://example.invalid/model-only.mp4' });
    await harness.command(owner, 'metadata', { duration: 600 }); await harness.command(owner, 'play');
    const viewer = await harness.viewer(owner, '100');
    await sleep(3000);
    const recoveries = [];
    for (let run = 0; run < 3; run++) {
      harness.shaper.setOnline(viewer.name, false); await waitFor(() => !viewer.socket.connected);
      await sleep(1500); harness.shaper.setOnline(viewer.name, true);
      await waitFor(() => viewer.socket.connected && viewer.sync.getDiagnostics().recoveryMs !== null);
      recoveries.push({ ...sample(owner, viewer), ...viewer.sync.getDiagnostics() });
    }
    report.scenarios.push({ name: 'reconnect-100', measurements: recoveries, ...summarize(recoveries) });
    const buffers = [];
    for (let run = 0; run < 3; run++) {
      const before = viewer.sync.getDiagnostics().corrections;
      viewer.adapter.stall(true); await sleep(2500);
      assert.equal(viewer.sync.getDiagnostics().corrections, before, 'No repeated seeks while stalled');
      assert.equal(owner.adapter.getPlaybackState(), 'playing');
      const duringStall = viewer.sync.getDiagnostics().corrections - before;
      const ready = performance.now(); viewer.adapter.stall(false);
      await waitFor(() => Math.abs(owner.adapter.getCurrentTime() - viewer.adapter.getCurrentTime()) < 0.5);
      buffers.push({ ...sample(owner, viewer), bufferRecoveryMs: performance.now() - ready, correctionsDuringStall: duringStall, catchUpCorrections: viewer.sync.getDiagnostics().corrections - before });
    }
    report.scenarios.push({ name: 'viewer-buffer-100', measurements: buffers, ...summarize(buffers) });
    const arrivals = [];
    for (let run = 0; run < 3; run++) {
      const joinedAt = performance.now();
      const arrival = await harness.viewer(owner, '300');
      await sleep(2500);
      assert.equal(arrival.sync.state.status, 'playing');
      arrivals.push({ ...sample(owner, arrival), joinConvergenceMs: performance.now() - joinedAt });
      arrival.sync.destroy(); arrival.socket.disconnect();
    }
    report.scenarios.push({ name: 'late-join-300', measurements: arrivals, ...summarize(arrivals) });
    assert.ok([...recoveries, ...buffers, ...arrivals].every(item => item.deviation <= 0.5));
    }
  } catch (error) { failure = error; report.failure = error.message; }
  finally { await harness.close(); }
  const output = new URL('../test-results/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('network-simulation.json', output), JSON.stringify(report, null, 2) + '\n');
  console.log('Saved test-results/network-simulation.json');
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profilesArg = process.argv.find(arg => arg.startsWith('--profiles='));
  const profiles = profilesArg ? profilesArg.split('=')[1].split(',') : undefined;
  runNetworkBenchmarks({ profiles, extended: !process.argv.includes('--steady-only') }).then(report => {
    if (report.scenarios.some(scenario => scenario.passed === false)) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
