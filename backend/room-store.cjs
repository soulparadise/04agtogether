const fs = require('node:fs');
const path = require('node:path');

// Private single-process checkpoint. No raw session/owner tokens are stored.
function createRoomStore(directory) {
  directory = path.resolve(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('Unsafe room state directory');
  const file = path.join(directory, 'rooms.json');
  const lock = path.join(directory, 'writer.lock');
  for (const candidate of [file, lock]) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Unsafe room state file');
  const startup = path.join(directory, 'startup.lock');
  const guard = fs.openSync(startup, 'wx', 0o600);
  try {
    try {
      const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('Invalid room writer lock');
      try { process.kill(previous.pid, 0); throw new Error('Room state requires a single Node process'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      fs.unlinkSync(lock);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  } finally { fs.closeSync(guard); fs.unlinkSync(startup); }
  let closed = false;
  return {
    read() {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.schema !== 1 || !Array.isArray(data.rooms) || !Number.isFinite(data.savedAt)) throw new Error();
        return data;
      } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Room checkpoint is invalid; preserve it before recovery'); }
    },
    write(data) {
      if (closed) return;
      const temporary = path.join(directory, `rooms-${process.pid}.tmp`);
      if (fs.existsSync(temporary) && fs.lstatSync(temporary).isSymbolicLink()) throw new Error('Unsafe room checkpoint');
      const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, ...data })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, file);
    },
    close() { if (!closed) { closed = true; fs.unlinkSync(lock); } }
  };
}
module.exports = { createRoomStore };
