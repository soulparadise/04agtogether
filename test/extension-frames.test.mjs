import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverPlayer, registerOrigins } from '../extension/src/player-tabs.mjs';

test('src-less movie frame inherits a granted parent; other-origin nested frames stay gated', async () => {
  const probed = [], registered = [], upgraded = [];
  const chrome = {
    webNavigation: { getAllFrames: async () => [
      { frameId: 0, parentFrameId: -1, url: 'https://mg.lordfilm.md/mult/movie.html' },
      { frameId: 1, parentFrameId: 0, url: 'about:blank' },
      { frameId: 2, parentFrameId: 1, url: 'https://api.stiven-king.com/storage.html' },
      { frameId: 3, parentFrameId: 2, url: 'about:srcdoc' },
      { frameId: 4, parentFrameId: -1, url: 'about:blank' }
    ] },
    permissions: { contains: async ({ origins }) => origins[0] === 'https://mg.lordfilm.md/*' },
    tabs: { sendMessage: async (_tab, _message, { frameId }) => { probed.push(frameId); return { count: frameId === 1 ? 1 : 0, score: frameId === 1 ? 100 : 0 }; } },
    scripting: { getRegisteredContentScripts: async () => registered, registerContentScripts: async entries => registered.push(...entries), updateContentScripts: async entries => upgraded.push(...entries) }
  };
  const result = await discoverPlayer(chrome, 7);
  assert.equal(result.frame.frameId, 1);
  assert.deepEqual(probed, [0, 1, 0]);
  assert.deepEqual(result.neededOrigins, ['https://api.stiven-king.com']);
  await registerOrigins(chrome, ['https://mg.lordfilm.md/*']);
  assert.equal(registered[0].matchOriginAsFallback, true);
  registered[0].matchOriginAsFallback = false;
  await registerOrigins(chrome, ['https://mg.lordfilm.md/*']);
  assert.deepEqual(upgraded, [{ id: registered[0].id, matchOriginAsFallback: true }]);
});

test('player tab switch excludes hidden old video and asks only for the visible new frame origin', async () => {
  let secondSelected = false, cdnGranted = false;
  const probed = [];
  const chrome = {
    webNavigation: { getAllFrames: async () => [
      { frameId: 0, parentFrameId: -1, url: 'https://mg.lordfilm.md/mult/movie.html' },
      { frameId: 1, parentFrameId: 0, url: 'about:blank' },
      { frameId: 2, parentFrameId: 0, url: 'https://cdn.lordfilm64.com/?movie=fixture' }
    ] },
    permissions: { contains: async ({ origins }) => origins[0] === 'https://mg.lordfilm.md/*' || cdnGranted },
    tabs: { sendMessage: async (_tab, _message, { frameId }) => {
      probed.push(frameId);
      if (frameId === 0) return { count: 0, score: 0, childFrames: [
        { url: 'about:blank', visible: !secondSelected },
        { url: 'https://cdn.lordfilm64.com/?movie=fixture', visible: secondSelected }
      ] };
      // Hidden old frames may still report a larger video in their own viewport.
      return { count: 1, score: frameId === 1 ? 100000 : 100 };
    } }
  };
  let result = await discoverPlayer(chrome, 7);
  assert.equal(result.frame.frameId, 1); assert.deepEqual(result.neededOrigins, []);
  secondSelected = true; probed.length = 0;
  result = await discoverPlayer(chrome, 7);
  assert.equal(result.frame.frameId, 0); assert.equal(result.frame.count, 0);
  assert.deepEqual(result.neededOrigins, ['https://cdn.lordfilm64.com']);
  assert.deepEqual(probed, [0, 0]);
  cdnGranted = true;
  result = await discoverPlayer(chrome, 7);
  assert.equal(result.frame.frameId, 2);
  secondSelected = false;
  result = await discoverPlayer(chrome, 7);
  assert.equal(result.frame.frameId, 1, 'Switching back keeps the original Full HD path working');
});
