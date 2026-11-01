import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionNotice } from '../frontend/src/extension-status.mjs';

test('room banner recovers after consent but distinguishes disconnect, reconnect and missing binding', () => {
  const connected = { ok: true, room: { id: 'room' }, connected: true, bound: true };
  assert.match(extensionNotice({ ok: false }), /отключён/);
  assert.equal(extensionNotice(connected), 'Просмотр продолжается в расширении.');
  assert.match(extensionNotice({ ...connected, connected: false }), /переподключаемся/);
  assert.match(extensionNotice({ ...connected, bound: false }), /подключить плеер/);
  assert.match(extensionNotice({ connected: true, bound: true }), /отключён/);
});
