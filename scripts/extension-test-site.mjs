import express from 'express';
import { fileURLToPath } from 'node:url';
const app = express();
app.get('/', (_req, res) => res.sendFile(fileURLToPath(new URL('../extension/fixture.html', import.meta.url))));
app.get('/media.mp4', (_req, res) => res.sendFile(fileURLToPath(new URL('../frontend/public/test-media/sync-test.mp4', import.meta.url))));
const server = app.listen(5174, '127.0.0.1', () => console.log('HTML5 test page: http://127.0.0.1:5174/'));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
