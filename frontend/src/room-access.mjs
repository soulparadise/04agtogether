export async function roomAccessRequest(action, payload) {
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) throw new Error('Откройте сайт по HTTPS, чтобы безопасно передать пароль.');
  const response = await fetch(`/api/rooms/${action}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  try { return await response.json(); }
  catch { throw new Error('Не удалось связаться с сервером комнаты. Повторите попытку.'); }
}
