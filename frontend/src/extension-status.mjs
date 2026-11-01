export function extensionNotice(reply) {
  if (!reply?.ok || !reply.room) return 'Просмотр отключён или ожидает разрешения браузера. Нажмите «Открыть фильм», чтобы продолжить.';
  if (reply.connected === false) return 'Нет связи с сервером просмотра — переподключаемся…';
  if (reply.bound === false) return 'Комната подключена. Нажмите «Открыть фильм», чтобы подключить плеер.';
  return 'Просмотр продолжается в расширении.';
}
