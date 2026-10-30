export const browsers = [
  { id: 'chrome', name: 'Google Chrome', address: 'chrome://extensions' },
  { id: 'yandex', name: 'Яндекс Браузер', address: 'browser://extensions' },
  { id: 'edge', name: 'Microsoft Edge', address: 'edge://extensions' },
  { id: 'opera', name: 'Opera', address: 'opera://extensions' },
  { id: 'brave', name: 'Brave', address: 'brave://extensions' },
  { id: 'vivaldi', name: 'Vivaldi', address: 'vivaldi://extensions' }
];
export async function detectBrowser(nav = navigator) {
  const ua = nav.userAgent || '';
  const mobile = Boolean(nav.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1));
  let brands = nav.userAgentData?.brands || [];
  try { if (await nav.brave?.isBrave?.()) return { id: 'brave', mobile }; } catch { /* Optional browser API. */ }
  const tests = [['yandex', /YaBrowser/i], ['edge', /Edg/i], ['opera', /OPR|Opera/i], ['vivaldi', /Vivaldi/i]];
  for (const [id, pattern] of tests) if (pattern.test(ua) || brands.some(item => pattern.test(item.brand))) return { id, mobile };
  // Chromium tokens alone cannot distinguish Chrome from other Chromium browsers.
  if (brands.some(item => item.brand === 'Google Chrome')) return { id: 'chrome', mobile };
  return { id: '', mobile };
}
export async function copyBrowserAddress(address, clipboard = navigator.clipboard) {
  if (!browsers.some(browser => browser.address === address)) throw new Error('Выбери браузер.');
  await clipboard.writeText(address);
}
