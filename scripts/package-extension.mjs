import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Explicit allowlist: stale files, build metadata and local fixtures never ship.
const files = ['manifest.json', 'background.js', 'popup.js', 'offscreen.js', 'socket-worker.js', 'content.js', 'popup.html', 'popup.css', 'offscreen.html'];
const table = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
export async function packageExtension() {
  const root = new URL('../', import.meta.url);
  const source = new URL('extension/dist-production/', root);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
  const info = JSON.parse(await readFile(new URL('build-info.json', source), 'utf8'));
  if (info.mode !== 'production' || info.appOrigin !== 'https://soulparadise.ru' || !/^\d+(\.\d+){1,3}$/.test(manifest.version)) throw new Error('Expected production extension');
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file), data = await readFile(new URL(file, source));
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12); // Fixed 1980-01-01 timestamp: reproducible archive.
    header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    header.copy(directory, 8, 6, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, index, end]);
  const downloads = new URL('release/frontend/downloads/', root); await mkdir(downloads, { recursive: true });
  const filename = `04agtogether-extension-v${manifest.version}.zip`;
  await writeFile(new URL(filename, downloads), zip);
  await writeFile(new URL('04agtogether-extension.zip', downloads), zip);
  await writeFile(new URL('extension.json', downloads), JSON.stringify({ version: manifest.version, filename, url: '/downloads/04agtogether-extension.zip', sha256: createHash('sha256').update(zip).digest('hex') }) + '\n');
  console.log(`Extension ZIP: ${filename} (${zip.length} bytes; manifest at archive root)`);
}
