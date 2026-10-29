// Original synthetic video/audio, generated locally; no third-party footage.
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const folder = new URL('../frontend/public/test-media/', import.meta.url);
await mkdir(folder, { recursive: true });
const output = fileURLToPath(new URL('sync-test.mp4', folder));
const child = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=15',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '32',
  '-c:a', 'aac', '-b:a', '48k', '-af', 'volume=0.08', '-movflags', '+faststart', output
], { stdio: 'inherit' });
child.on('error', () => { console.error('Для генерации образца нужен ffmpeg в PATH.'); process.exitCode = 1; });
child.on('exit', code => {
  if (code !== 0) process.exitCode = code || 1;
  else console.log('Образец готов: /test-media/sync-test.mp4 (90 секунд). В LAN используйте адрес из вывода pnpm dev:lan для обоих устройств.');
});
