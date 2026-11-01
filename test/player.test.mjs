import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML5VideoAdapter } from '../frontend/src/player/HTML5VideoAdapter.mjs';
import { PlaybackSync } from '../frontend/src/player/PlaybackSync.mjs';
import { ForeignVideoAdapter } from '../extension/src/ForeignVideoAdapter.mjs';

class FakeVideo extends EventTarget {
  currentTime = 0; duration = 90; readyState = 4; paused = true; ended = false; src = ''; volume = 0.4; muted = true; loads = 0; rejectPlay = false;
  play() {
    if (this.rejectPlay) return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
    this.paused = false; this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() { this.loads++; this.currentTime = 0; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
const snapshot = (patch = {}) => ({ source: { type: 'html5', url: 'https://example.invalid/test.mp4' }, sourceId: 'source-a', version: 1, status: 'paused', basePosition: 10, position: 10, updatedAt: 500000, serverNow: 500000, duration: 90, ...patch });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Allplay metadata alone cannot start sync seeks before its native media clock advances', () => {
  let now = 0;
  const video = new FakeVideo(); video.matches = () => true;
  const adapter = new ForeignVideoAdapter(video, () => now);
  assert.equal(adapter.isReady(), false);
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(adapter.isReady(), false);
  video.paused = false; video.currentTime = 0.05; now = 50;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(adapter.isReady(), true);
  adapter.destroy();
});

test('first natural Allplay clock catches up outside the current buffer exactly once', t => {
  let now = 0;
  const video = new FakeVideo(); video.matches = () => true;
  video.buffered = { length: 1, start: () => 0, end: () => 2 };
  const adapter = new ForeignVideoAdapter(video, () => now);
  const sync = new PlaybackSync({ adapter, now: () => now, intervalMs: 0, request: async () => ({ ok: false }) });
  t.after(() => { sync.destroy(); adapter.destroy(); });
  sync.accept(snapshot({ status: 'playing', position: 60, basePosition: 60, source: { type: 'extension', url: 'https://example.invalid/film' } }));
  assert.equal(video.currentTime, 0);
  video.paused = false; video.currentTime = 0.05; now = 50;
  video.dispatchEvent(new Event('timeupdate'));
  assert.ok(video.currentTime >= 60, 'Initial catch-up must load the room position, not wait for minutes of buffer');
  video.currentTime = 0.1; now = 100;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(video.currentTime, 0.1, 'Ordinary timeupdates must not force further seeks');
});

test('start viewing spends the gesture on play even if media falsely reports playing', async t => {
  const env = setup(t);
  env.sync.accept(snapshot({ status: 'playing' })); await flush();
  let calls = 0;
  env.video.paused = false;
  env.adapter.play = () => { calls++; return Promise.resolve(); };
  env.sync.blocked = true;
  env.sync.startViewing();
  assert.equal(calls, 1);
  await flush();
  assert.equal(env.sync.blocked, false);
});

test('foreign player waits for asynchronous seek completion before playing or seeking again', async t => {
  const video = new FakeVideo();
  let position = 0, plays = 0, seeks = 0;
  Object.defineProperty(video, 'currentTime', { get: () => position, set: value => { position = value; seeks++; video.seeking = true; } });
  const originalPlay = video.play.bind(video);
  video.play = () => { assert.equal(video.seeking, false, 'play during an unfinished HLS seek can stall decoding'); plays++; return originalPlay(); };
  video.seeking = false;
  const adapter = new ForeignVideoAdapter(video);
  const sync = new PlaybackSync({ adapter, intervalMs: 0, request: async () => ({ ok: false }) });
  t.after(() => { sync.destroy(); adapter.destroy(); });
  sync.accept(snapshot({ status: 'playing', source: { type: 'extension', url: 'https://example.invalid/film' } }));
  assert.equal(seeks, 1); assert.equal(plays, 0);
  sync.apply(true); assert.equal(seeks, 1); assert.equal(plays, 0);
  video.seeking = false; video.dispatchEvent(new Event('seeked'));
  await flush();
  assert.equal(plays, 1); assert.equal(video.paused, false);
});

function setup(t, options = {}) {
  let localNow = 1000;
  const video = new FakeVideo();
  const adapter = new HTML5VideoAdapter(video);
  const requests = [];
  const blocked = [];
  const sync = new PlaybackSync({ adapter, intervalMs: 0, now: () => localNow,
    request: async (event, payload) => {
      requests.push({ event, payload });
      const serverNow = 500000 + localNow - 1000;
      const state = sync.state;
      const position = state.status === 'playing' ? state.basePosition + (serverNow - state.updatedAt) / 1000 : state.position;
      return { ok: true, state: { ...state, serverNow, position } };
    },
    onBlocked: value => blocked.push(value), ...options });
  t.after(() => sync.destroy());
  return { video, adapter, sync, requests, blocked, advance: ms => localNow += ms };
}

test('client ignores old versions/source snapshots and remote apply never sends control events', async t => {
  const env = setup(t);
  env.sync.accept(snapshot({ version: 4 }));
  assert.equal(env.video.currentTime, 10);
  assert.equal(env.sync.accept(snapshot({ version: 3, position: 2 })), false);
  assert.equal(env.video.currentTime, 10);
  env.sync.accept(snapshot({ version: 5, sourceId: 'source-b', basePosition: 0, position: 0 }));
  assert.equal(env.sync.accept(snapshot({ version: 5, sourceId: 'source-a' })), false);
  assert.equal(env.sync.accept(snapshot({ version: 4, status: 'playing' })), false);
  assert.equal(env.video.currentTime, 0);
  env.sync.accept(snapshot({ version: 6, sourceId: 'source-b', status: 'playing', basePosition: 20, position: 20 }));
  await flush();
  env.video.dispatchEvent(new Event('pause')); env.video.dispatchEvent(new Event('timeupdate'));
  assert.equal(env.requests.length, 0);
  assert.equal(env.video.volume, 0.4); assert.equal(env.video.muted, true);
});

test('clock offsets and half RTT are accounted for, small drift does not seek', t => {
  const env = setup(t);
  env.advance(100);
  env.sync.accept(snapshot({ status: 'playing' }), { sentAt: 1000, receivedAt: 1100 });
  assert.ok(Math.abs(env.video.currentTime - 10.05) < 0.001);
  env.advance(2000); env.video.currentTime = 12.1;
  env.sync.apply();
  assert.equal(env.video.currentTime, 12.1);
  env.video.currentTime = 8; env.sync.apply();
  assert.ok(Math.abs(env.video.currentTime - 12.05) < 0.001);
});

test('autoplay rejection stays local; user gesture resumes against current state', async t => {
  const env = setup(t);
  env.video.rejectPlay = true;
  env.sync.accept(snapshot({ status: 'playing' }));
  await flush();
  assert.equal(env.sync.blocked, true);
  assert.equal(env.sync.state.status, 'playing');
  assert.equal(env.requests.length, 0);
  env.advance(3000); env.video.rejectPlay = false;
  env.sync.startViewing();
  await flush();
  assert.equal(env.video.paused, false);
  assert.equal(env.video.currentTime, 13);
  assert.ok(env.requests.every(request => request.event === 'playback:get'));
});

test('buffer recovery catches up without global pause; readiness, end and cleanup release resources', async t => {
  const env = setup(t);
  env.video.readyState = 0;
  env.sync.accept(snapshot({ status: 'playing', position: 5, basePosition: 5 }));
  assert.equal(env.video.currentTime, 0);
  env.advance(2000); env.video.readyState = 4;
  env.video.dispatchEvent(new Event('loadedmetadata')); await flush();
  assert.ok(Math.abs(env.video.currentTime - 7) < 0.01);
  env.video.dispatchEvent(new Event('waiting'));
  env.advance(5000); env.video.currentTime = 7;
  env.video.dispatchEvent(new Event('canplay')); await flush();
  assert.ok(Math.abs(env.video.currentTime - 12) < 0.01);
  assert.ok(env.requests.every(request => request.event === 'playback:get'));
  env.sync.accept(snapshot({ version: 2, status: 'ended', position: 90, basePosition: 90 }));
  assert.equal(env.video.paused, true); assert.equal(env.video.currentTime, 90);
  env.sync.destroy();
  const before = env.requests.length;
  env.video.dispatchEvent(new Event('canplay')); await flush();
  assert.equal(env.requests.length, before); assert.equal(env.video.src, '');
});

test('media errors stay local and changing source clears the error and old resource', t => {
  const errors = [];
  const env = setup(t, { onError: error => errors.push(error) });
  env.sync.accept(snapshot());
  env.video.dispatchEvent(new Event('error'));
  assert.equal(env.sync.failed, true);
  assert.equal(env.sync.state.status, 'paused');
  assert.equal(env.requests.length, 0);
  assert.ok(errors.at(-1).includes('Видео не удалось загрузить'));
  env.sync.accept(snapshot({ sourceId: 'new-source', version: 2, source: { type: 'html5', url: 'https://example.invalid/new.webm' }, position: 0, basePosition: 0 }));
  assert.equal(env.sync.failed, false);
  assert.equal(env.video.currentTime, 0);
  assert.equal(env.video.src, 'https://example.invalid/new.webm');
  assert.equal(errors.at(-1), '');
});

test('periodic checks do not keep seeking during a stalled viewer buffer', async t => {
  const env = setup(t);
  env.sync.accept(snapshot({ status: 'playing' })); await flush();
  env.video.readyState = 2;
  env.video.dispatchEvent(new Event('waiting'));
  const stalledAt = env.video.currentTime;
  env.advance(5000); env.sync.apply();
  assert.equal(env.video.currentTime, stalledAt);
  env.video.readyState = 4;
  env.video.dispatchEvent(new Event('canplay')); await flush();
  assert.ok(Math.abs(env.video.currentTime - 15) < 0.01);
  assert.ok(env.requests.every(request => request.event === 'playback:get'));
});

test('repeated canplay events with small drift do not turn HLS readiness into forced seeks', async t => {
  const env = setup(t);
  env.sync.accept(snapshot({ status: 'playing' })); await flush();
  for (let i = 0; i < 4; i++) {
    env.advance(2000);
    env.video.currentTime = 12 + i * 2 - 0.2;
    const before = env.video.currentTime;
    env.video.dispatchEvent(new Event('canplay')); await flush();
    assert.equal(env.video.currentTime, before, 'ready is not a new room seek command');
  }
});

test('a duration-only revision preserves smooth playback rather than forcing a small seek', async t => {
  const env = setup(t);
  env.sync.accept(snapshot({ status: 'playing' })); await flush();
  env.advance(2000); env.video.currentTime = 11.8;
  env.sync.accept(snapshot({ version: 2, status: 'playing', basePosition: 12, position: 12, updatedAt: 502000, serverNow: 502000, duration: 95 }));
  assert.equal(env.video.currentTime, 11.8);
  env.sync.accept(snapshot({ version: 3, status: 'playing', basePosition: 40, position: 40, updatedAt: 502000, serverNow: 502000, duration: 95 }));
  assert.equal(env.video.currentTime, 40, 'An explicit room seek still applies');
});

test('foreign HLS recovery keeps its buffer and avoids overlapping seeks; explicit room seek still works', async t => {
  let now = 1000, bufferEnd = 11;
  const video = new FakeVideo();
  video.buffered = { length: 1, start: () => 0, end: () => bufferEnd };
  const adapter = new ForeignVideoAdapter(video, () => now);
  const sync = new PlaybackSync({ adapter, intervalMs: 0, now: () => now, request: async () => ({ ok: false }) });
  t.after(() => sync.destroy());
  sync.accept(snapshot({ status: 'playing' })); await flush();
  now += 2000; video.currentTime = 11;
  sync.apply();
  assert.equal(video.currentTime, 11, 'Do not seek outside the currently recovered buffer every polling interval');
  video.dispatchEvent(new Event('canplay')); await flush();
  assert.equal(video.currentTime, 11);
  bufferEnd = 30; video.seeking = true;
  sync.apply(); assert.equal(video.currentTime, 11, 'Do not interrupt an unfinished local seek');
  video.seeking = false;
  sync.apply(); assert.equal(video.currentTime, 12, 'Catch up once the target is buffered');
  sync.accept(snapshot({ version: 2, status: 'playing', basePosition: 40, position: 40, updatedAt: 502000, serverNow: 502000 }));
  assert.equal(video.currentTime, 40);
});

test('diagnostics are opt-in and measure corrections plus fresh-state reconnect recovery', async t => {
  const normal = setup(t);
  assert.equal(normal.sync.getDiagnostics(), null);
  const env = setup(t, { diagnostics: true });
  env.sync.accept(snapshot({ status: 'playing' })); await flush();
  assert.equal(env.sync.getDiagnostics().corrections, 1);
  env.sync.setConnected(false); env.advance(3000);
  env.sync.setConnected(true);
  assert.equal(env.sync.getDiagnostics().recoveryMs, null);
  env.advance(100);
  await env.sync.refresh(); await flush();
  const metric = env.sync.getDiagnostics();
  assert.equal(metric.recoveryMs, 3100);
  assert.equal(metric.resyncMs, 100);
  assert.equal(metric.connected, true);
  assert.ok(metric.drift <= 0.5);
});

test('a delayed old state can refine the clock but cannot replace the current source/version', t => {
  const env = setup(t);
  env.sync.accept(snapshot({ version: 4, status: 'playing' }));
  env.advance(3000);
  const accepted = env.sync.accept(snapshot({ version: 3, sourceId: 'old-source', serverNow: 505000 }), { sentAt: 3900, receivedAt: 4100 });
  assert.equal(accepted, false);
  assert.equal(env.sync.state.version, 4);
  assert.equal(env.sync.state.sourceId, 'source-a');
  assert.ok(env.video.currentTime > 14);
});

test('diagnostic telemetry waits for clock calibration and follows completed probes', async t => {
  const env = setup(t, { diagnostics: true });
  env.sync.accept(snapshot());
  const reports = [];
  const unsubscribe = env.sync.subscribeDiagnostics(metric => reports.push(metric));
  await env.sync.refresh();
  await env.sync.refresh();
  assert.equal(reports.length, 0, 'Telemetry must not compete with initial polling calibration');
  await env.sync.refresh();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].clockSamples, 3);
  unsubscribe();
  await env.sync.refresh();
  assert.equal(reports.length, 1);
});
