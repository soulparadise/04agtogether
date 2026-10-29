import { EXTENSION_ID } from '../../extension/config.mjs';
export function extensionRequest(message, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.sendMessage) { reject(new Error('Расширение 04agtogether не обнаружено.')); return; }
    const timer = setTimeout(() => reject(new Error('Расширение не ответило. Обновите его и страницу комнаты.')), timeout);
    try {
      runtime.sendMessage(EXTENSION_ID, message, reply => {
        clearTimeout(timer);
        if (runtime.lastError || !reply) { reject(new Error('Расширение 04agtogether не обнаружено. Установите или обновите его и перезагрузите страницу.')); return; }
        resolve(reply);
      });
    } catch { clearTimeout(timer); reject(new Error('Расширение недоступно в этом браузере.')); }
  });
}
export function savedNickname() {
  try { return localStorage.getItem('04agtogether:nickname') || ''; } catch { return ''; }
}
export function rememberNickname(value) {
  try { localStorage.setItem('04agtogether:nickname', value); } catch { /* Optional preference, never credentials. */ }
}
