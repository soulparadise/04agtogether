import { readFile, mkdir, lstat, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const { release } = JSON.parse(await readFile(new URL('release/release.json', root), 'utf8'));
if (release !== 'local' && !/^[a-f0-9]{40}$/.test(release)) throw new Error('Invalid release manifest');
async function inspect(directory) {
  for (const name of await readdir(directory)) {
    const item = new URL(name, directory); const stat = await lstat(item);
    if (stat.isSymbolicLink() || !/^[a-zA-Z0-9_.@-]+$/.test(name) || /^\.env|\.(?:pem|key|pfx|p12|ppk|log)$/i.test(name) || name === 'test-media') throw new Error('Unexpected or sensitive release entry');
    if (stat.isDirectory()) await inspect(new URL(name + '/', directory));
  }
}
await inspect(new URL('release/', root));
await mkdir(new URL('artifacts/', root), { recursive: true });
const archive = new URL(`artifacts/${release}.tgz`, root);
await new Promise((resolve, reject) => {
  const child = spawn('tar', ['-czf', fileURLToPath(archive), '-C', fileURLToPath(new URL('release/', root)), 'frontend', 'backend', 'tools', 'release.json'], { stdio: 'inherit' });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Packaging failed')));
});
const sha = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(new URL(`artifacts/${release}.tgz.sha256`, root), `${sha}  ${release}.tgz\n`);
console.log(`Prepared artifacts/${release}.tgz${release === 'local' ? ' (preview only; not deployable before a reviewed commit)' : ''}`);
