import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { APP_ORIGINS } from '../extension/config.mjs';
const root = new URL('../extension/', import.meta.url);
const production = process.argv.includes('--production');
const out = new URL(production ? 'dist-production/' : 'dist/', root);
await mkdir(out, { recursive: true });
const identity = JSON.parse(await readFile(new URL('identity.json', root), 'utf8'));
const appOrigin = production ? 'https://soulparadise.ru' : process.env.EXTENSION_APP_ORIGIN || 'http://127.0.0.1:5173';
if (!APP_ORIGINS.includes(appOrigin)) throw new Error('EXTENSION_APP_ORIGIN must be an explicitly trusted app origin');
const manifest = {
  manifest_version: 3, name: '04agtogether', version: '0.2.20', minimum_chrome_version: '119',
  description: 'Совместный просмотр стандартного HTML5-видео в комнате 04agtogether.', key: identity.key,
  permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'webNavigation'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'background.js', type: 'module' },
  action: { default_popup: 'popup.html', default_title: '04agtogether' },
  externally_connectable: { matches: [...new Set((production ? [appOrigin] : APP_ORIGINS).map(origin => { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }))] },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; worker-src 'self'" }
};
await writeFile(new URL('manifest.json', out), JSON.stringify(manifest, null, 2));
await writeFile(new URL('build-info.json', out), JSON.stringify({ mode: production ? 'production' : 'development', appOrigin, extensionId: identity.id, version: manifest.version }, null, 2));
await Promise.all(['background', 'popup', 'offscreen', 'socket-worker', 'content'].map(name => build({
  entryPoints: [fileURLToPath(new URL(`src/${name}.mjs`, root))], outfile: fileURLToPath(new URL(`${name}.js`, out)),
  bundle: true, platform: 'browser', format: name === 'content' ? 'iife' : 'esm', target: 'chrome119',
  define: { 'process.env.NODE_ENV': '"production"', __APP_ORIGIN__: JSON.stringify(appOrigin) }, legalComments: 'eof'
})));
await Promise.all(['popup.html', 'popup.css', 'offscreen.html'].map(name => copyFile(new URL(name, root), new URL(name, out))));
console.log(`Unpacked extension: ${fileURLToPath(out)} (ID ${identity.id})`);
