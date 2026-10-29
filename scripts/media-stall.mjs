// Dev-only stall of one fixed synthetic fixture. Never fetches a URL.
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

export function mediaStallMiddleware() {
  const runs = new Map();
  const fixture = fileURLToPath(new URL('../frontend/public/test-media/sync-test.mp4', import.meta.url));
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://local.test');
    let referrer;
    try { referrer = new URL(req.headers.referer); } catch { next(); return; }
    if (url.pathname !== '/test-media/sync-test.mp4' || referrer.searchParams.get('mediaStall') !== '1') { next(); return; }
    try {
      const { size } = await stat(fixture);
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if ((req.headers.range && !range) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', Vary: 'Referer' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const key = (url.searchParams.get('bufferRun') || 'default').slice(0, 80);
      if (!runs.has(key)) {
        if (runs.size >= 100) runs.clear();
        runs.set(key, performance.now() + 10000);
      }
      let stream;
      res.once('close', () => stream?.destroy());
      // Enough initial bytes for metadata and an initial buffer, followed by a
      // real stalled HTTP body. New range requests share the same deadline.
      const initialEnd = start === 0 ? Math.min(end, 98303) : start - 1;
      if (initialEnd >= start) {
        stream = createReadStream(fixture, { start, end: initialEnd });
        await new Promise(resolve => { stream.once('end', resolve); stream.once('close', resolve); stream.once('error', () => { res.destroy(); resolve(); }); stream.pipe(res, { end: false }); });
      }
      if (initialEnd === end) { res.end(); return; }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, runs.get(key) - performance.now())));
      if (res.destroyed) return;
      stream = createReadStream(fixture, { start: Math.max(start, initialEnd + 1), end });
      stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404).end('Generate the local test video first'); else res.destroy(); }
  };
}
