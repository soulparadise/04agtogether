import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build as frontend } from 'vite';
import { build as backend } from 'esbuild';
const repo = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repo, 'release');
const release = process.env.GITHUB_SHA || 'local';
if (release !== 'local' && !/^[a-f0-9]{40}$/.test(release)) throw new Error('Invalid release ID');
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'backend'), { recursive: true });
await frontend({ root: path.join(repo, 'frontend'), build: { outDir: path.join(output, 'frontend'), emptyOutDir: true } });
await backend({
  entryPoints: [path.join(repo, 'backend/app.cjs')],
  outfile: path.join(output, 'backend/app.js'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  external: ['bufferutil', 'utf-8-validate'],
  define: { 'process.env.NODE_ENV': '"production"' }
});
await writeFile(path.join(output, 'release.json'), JSON.stringify({ release }) + '\n');
