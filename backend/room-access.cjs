const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const options = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
function loginName(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\p{C}]/u.test(value)) return null;
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return name.length >= 3 && name.length <= 64 ? { name, key: name.toLowerCase().normalize('NFKC') } : null;
}
const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 128 && Buffer.byteLength(value) <= 512;
const validLogin = value => value && typeof value.key === 'string' && Boolean(loginName(value.name)) && loginName(value.name).key === value.key && value.algorithm === 'scrypt-v1' && /^[a-f0-9]{32}$/.test(value.salt) && /^[a-f0-9]{128}$/.test(value.hash);
async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return { algorithm: 'scrypt-v1', salt, hash: (await derive(password, salt, 64, options)).toString('hex') };
}
async function passwordMatches(password, login) {
  const actual = await derive(password, login.salt, 64, options);
  return timingSafeEqual(actual, Buffer.from(login.hash, 'hex'));
}
// Bounded per-process/IP attempts, shared across unknown and existing names.
function attemptLimiter(now = Date.now) {
  const attempts = new Map(); let busy = 0;
  return {
    enter(address) {
      const time = now();
      for (const [key, item] of attempts) if (time >= item.until) attempts.delete(key);
      if (attempts.size >= 1000 && !attempts.has(address)) return null;
      const item = attempts.get(address) || { count: 0, until: time + 5 * 60_000 };
      attempts.set(address, item);
      if (++item.count > 10 || busy >= 2) return null;
      busy++;
      return () => { busy--; };
    }
  };
}
module.exports = { loginName, validPassword, validLogin, passwordHash, passwordMatches, attemptLimiter };
