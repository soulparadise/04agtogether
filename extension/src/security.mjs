import { APP_ORIGINS } from '../config.mjs';
export const samePage = (a, b) => {
  try { const left = new URL(a), right = new URL(b); left.hash = ''; right.hash = ''; return left.href === right.href; } catch { return false; }
};
export function webOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Нужна обычная HTTP(S)-страница без логина в URL.');
  return url.origin;
}
export const permissionPattern = value => { const url = new URL(webOrigin(value)); return `${url.protocol}//${url.hostname}/*`; };
export function localAppOrigin(value) {
  const origin = webOrigin(value), host = new URL(origin).hostname;
  const octets = host.split('.').map(Number);
  const privateIP = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (host !== 'localhost' && host !== '127.0.0.1' && !privateIP) throw new Error('Прототип подключается только к локальному 04agtogether.');
  return origin;
}
export function validatePair(value) {
  if (!value || webOrigin(value.origin) !== value.origin || !/^[a-f0-9]{32}$/.test(value.roomId) || !/^[a-f0-9]{32}$/.test(value.participantId)
    || !/^[a-f0-9]{64}$/.test(value.sessionToken) || (value.ownerToken !== undefined && !/^[a-f0-9]{64}$/.test(value.ownerToken))) throw new Error('Откройте комнату 04agtogether и войдите в неё.');
  return { origin: value.origin, roomId: value.roomId, participantId: value.participantId, sessionToken: value.sessionToken, ...(value.ownerToken ? { ownerToken: value.ownerToken } : {}) };
}
export function publicPlaybackReply(reply) {
  return { ok: reply.ok === true, ...(reply.state ? { state: reply.state } : {}), ...(reply.error ? { error: { code: reply.error.code, message: reply.error.message } } : {}) };
}
// Chrome supplies sender; never take an app origin or role from the message.
export function trustedWebContext(sender, roomId) {
  const reject = (code, explanation) => { throw new Error(`Недоверенный источник сообщения: ${explanation} (${code}).`); };
  let url;
  try { url = new URL(sender?.url); } catch { reject('SOURCE_URL', 'браузер не передал корректный адрес страницы'); }
  if (sender.id) reject('SOURCE_EXTENSION', 'браузер указал расширение в качестве отправителя');
  if (!sender.tab) reject('SOURCE_TAB', 'браузер не передал вкладку отправителя');
  if (sender.frameId === undefined) reject('SOURCE_FRAME_MISSING', 'браузер не передал номер фрейма страницы');
  if (sender.frameId !== 0) reject('SOURCE_FRAME', 'не подтверждена главная страница вкладки');
  if (!APP_ORIGINS.includes(url.origin)) reject('SOURCE_ORIGIN', 'адрес приложения не входит в список разрешённых');
  if (roomId !== undefined && (!/^[a-f0-9]{32}$/.test(roomId) || url.pathname.replace(/\/$/, '') !== `/room/${roomId}`)) throw new Error('Сообщение не соответствует открытой комнате.');
  return { origin: url.origin, tabId: sender.tab.id };
}
