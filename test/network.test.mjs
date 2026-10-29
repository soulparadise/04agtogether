import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, sleep } from '../scripts/network-benchmark.mjs';

test('actual delayed HTTP polling preserves origin checks, roles and reconnection', { timeout: 20000 }, async t => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = await harness.owner();
  await harness.command(owner, 'source', { url: 'https://example.invalid/test.mp4' });
  const viewer = await harness.viewer(owner, '100');
  const before = performance.now();
  const state = await harness.request(viewer.socket, 'playback:get');
  assert.ok(performance.now() - before >= 180, 'Real request/response delay must be present');
  const denied = await harness.request(viewer.socket, 'playback:play', { ownerToken: owner.session.ownerToken, sourceId: state.state.sourceId, expectedVersion: state.state.version });
  assert.equal(denied.error.code, 'FORBIDDEN');
  await harness.command(owner, 'play');
  await waitFor(() => viewer.sync.state.status === 'playing');
  harness.shaper.setOnline(viewer.name, false); await waitFor(() => !viewer.socket.connected);
  await sleep(300); harness.shaper.setOnline(viewer.name, true);
  await waitFor(() => viewer.socket.connected && viewer.sync.getDiagnostics().recoveryMs !== null);
  assert.ok(viewer.sync.getDiagnostics().drift <= 0.5);
  assert.equal(viewer.socket.io.engine.transport.name, 'polling');
});
