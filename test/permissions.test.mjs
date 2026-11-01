import test from 'node:test';
import assert from 'node:assert/strict';
import { missingPermissionPatterns, requestMissingPermissions } from '../extension/src/permission-request.mjs';

test('granted site permissions are reused and only a new visible frame origin is requested', async () => {
  const grants = new Set(['https://soulparadise.ru/*', 'https://film.example/*']);
  const requests = [];
  const chrome = { permissions: {
    contains: async ({ origins }) => grants.has(origins[0]),
    request: ({ origins }) => { requests.push(origins); origins.forEach(origin => grants.add(origin)); return Promise.resolve(true); }
  } };
  const urls = ['https://soulparadise.ru', 'https://film.example/movie', 'https://film.example/other'];
  assert.equal(await requestMissingPermissions(chrome, await missingPermissionPatterns(chrome, urls)), true);
  assert.equal(requests.length, 0);
  urls.push('https://player.example/embed');
  const missing = await missingPermissionPatterns(chrome, urls);
  assert.deepEqual(missing, ['https://player.example/*']);
  const granted = requestMissingPermissions(chrome, missing);
  assert.equal(requests.length, 1, 'Chrome request starts synchronously inside the gesture');
  await granted;
  assert.deepEqual(await missingPermissionPatterns(chrome, urls), []);
  await requestMissingPermissions(chrome, []);
  assert.equal(requests.length, 1);
  grants.delete('https://player.example/*');
  assert.deepEqual(await missingPermissionPatterns(chrome, urls), missing, 'Revocation is respected');
});
