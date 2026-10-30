import test from 'node:test';
import assert from 'node:assert/strict';
import { browsers, copyBrowserAddress, detectBrowser } from '../frontend/src/extension-browsers.mjs';

test('browser hints avoid Chrome guesses; manual browser addresses copy exactly', async () => {
  assert.equal((await detectBrowser({ userAgent: 'Chrome/140 Safari/537' })).id, '');
  assert.equal((await detectBrowser({ userAgent: 'Chrome/140', userAgentData: { brands: [{ brand: 'Google Chrome' }] } })).id, 'chrome');
  assert.equal((await detectBrowser({ userAgent: 'Chrome/140 YaBrowser/26' })).id, 'yandex');
  assert.equal((await detectBrowser({ userAgent: 'Chrome/140 Edg/140' })).id, 'edge');
  assert.equal((await detectBrowser({ userAgent: 'Chrome/140', brave: { isBrave: async () => true } })).id, 'brave');
  assert.equal((await detectBrowser({ userAgent: 'Firefox/140' })).id, '');
  assert.equal((await detectBrowser({ userAgent: 'Mobile Android Chrome/140' })).mobile, true);
  for (const browser of browsers) {
    let copied; await copyBrowserAddress(browser.address, { writeText: async value => { copied = value; } });
    assert.equal(copied, browser.address);
  }
  await assert.rejects(copyBrowserAddress('https://example.com', { writeText: async () => assert.fail() }));
});
