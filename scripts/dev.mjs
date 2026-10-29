import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startDevelopmentBackend } from '../backend/dev.cjs';
import config from '../frontend/vite.config.mjs';
import { findLanAddress } from './lan.mjs';

let backend;
let frontend;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([
    frontend?.close(),
    backend && new Promise(resolve => backend.io.close(resolve))
  ]);
  process.exit(code);
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

try {
  const lan = process.argv.includes('--lan') ? findLanAddress() : null;
  backend = await startDevelopmentBackend();
  frontend = await createServer({
    ...config,
    // Load the ESM config directly: Vite's temporary bundled config would
    // otherwise trigger Node watch repeatedly when that temporary file changes.
    configFile: false,
    server: { ...config.server, host: lan?.address || config.server.host },
    root: fileURLToPath(new URL('../frontend/', import.meta.url))
  });
  await frontend.listen();
  frontend.printUrls();
  if (lan) {
    console.log(`LAN (${lan.name}): http://${lan.address}:5173`);
    console.log(`Общий тестовый MP4: http://${lan.address}:5173/test-media/sync-test.mp4`);
    console.log('Другой интерфейс: DEV_LAN_HOST=<его частный IPv4>. Firewall и проброс портов не изменяются.');
    if (lan.addresses.length > 1) console.log('Частные интерфейсы:', lan.addresses.map(entry => `${entry.name}: ${entry.address}`).join(', '));
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
