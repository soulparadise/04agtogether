import { webOrigin, samePage, permissionPattern } from './security.mjs';
import { DEFAULT_APP_ORIGIN, APP_ORIGINS } from '../config.mjs';
const $ = id => document.getElementById(id);
const background = message => chrome.runtime.sendMessage({ target: 'background', ...message });
let tab, state, busy = false, savedNickname = '', extraOrigins = [];
function fail(error) { $('error').textContent = error?.message || 'Действие не выполнено.'; }
async function refresh() {
  state = await background({ type: 'popup-state' });
  savedNickname = state.nickname || savedNickname;
  $('room').hidden = !state.roomId;
  $('room').textContent = state.title || '';
  $('connection').textContent = state.roomId ? `${state.connected ? 'На связи' : 'Восстанавливаем связь…'} · ${state.owner ? 'Owner · Владелец' : 'Viewer · Зритель'}` : 'Откройте фильм и пригласите друзей';
  if (state.roomId) $('player').textContent = state.player || 'Ищем плеер…';
  $('nickname-row').hidden = Boolean(savedNickname || state.pending || state.roomId);
  const anotherFilm = tab?.url && !samePage(tab.url, state.room?.playback?.source?.url);
  $('watch').hidden = Boolean(state.roomId && !state.pending && !anotherFilm);
  $('watch').textContent = state.pending ? 'Открыть фильм' : 'Смотреть вместе';
  $('watch').disabled = busy || (!state.pending && (!tab?.url || APP_ORIGINS.includes(new URL(tab.url).origin)));
  $('copy').hidden = !state.owner || !state.roomId;
  $('disconnect').hidden = !state.roomId;
  $('invitation').value = state.invitation || '';
  $('hint').textContent = state.pending ? 'Chrome запросит доступ к сайту. После разрешения фильм откроется и подключится автоматически.' : state.roomId ? 'Управляйте видео обычными кнопками сайта.' : 'Видео загружается с исходного сайта. Первый доступ к сайту нужно разрешить в Chrome.';
  if (state.error) fail(new Error(state.error));
  frames(state.neededOrigins || []);
}
function frames(origins) {
  const signature = origins.join('|');
  if ($('frames').dataset.origins === signature) return;
  $('frames').dataset.origins = signature; $('frames').hidden = !origins.length;
  $('frame-buttons').replaceChildren(...origins.map(origin => {
    const button = document.createElement('button'); button.textContent = `Разрешить плеер: ${new URL(origin).hostname}`;
    button.addEventListener('click', () => {
      void chrome.permissions.request({ origins: [permissionPattern(origin)] }).then(async granted => {
        if (!granted) throw new Error('Доступ к фрейму не разрешён.');
        extraOrigins.push(origin);
        const reply = await background(state.roomId ? { type: 'retry-player' } : { type: 'watch', tabId: tab.id, nickname: savedNickname || $('nickname').value.trim() });
        if (!reply?.ok) { frames(reply?.neededOrigins || []); throw new Error(reply?.error?.message || 'Плеер не найден.'); }
        await refresh();
      }).catch(fail);
    }); return button;
  }));
}
$('watch').addEventListener('click', () => {
  if (busy) return;
  const nickname = savedNickname || $('nickname').value.trim();
  if (!state?.pending && !nickname) { $('nickname-row').hidden = false; $('nickname').focus(); return; }
  const urls = state.pending ? [state.pending.appOrigin, state.pending.filmURL] : [DEFAULT_APP_ORIGIN, tab.url, ...extraOrigins];
  // Called immediately inside the click: no awaited work loses the user gesture.
  const grant = chrome.permissions.request({ origins: [...new Set(urls.map(permissionPattern))] });
  busy = true; $('watch').disabled = true; $('error').textContent = '';
  void grant.then(async granted => {
    if (!granted) throw new Error('Доступ к выбранному сайту не разрешён.');
    const reply = await background(state.pending ? { type: 'finish-open' } : { type: 'watch', tabId: tab.id, nickname });
    if (!reply?.ok) { frames(reply?.neededOrigins || []); throw new Error(reply?.error?.message || 'Не удалось начать просмотр.'); }
    if (location.hash === '#permission' && !reply.needsPermission) window.close();
    await refresh();
  }).catch(fail).finally(() => { busy = false; $('watch').disabled = false; });
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.invitation); $('copy').textContent = 'Ссылка скопирована'; }
  catch { $('invitation').hidden = false; $('invitation').select(); }
});
$('disconnect').addEventListener('click', () => { void background({ type: 'disconnect' }).then(refresh).catch(fail); });
void (async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { webOrigin(tab?.url); } catch { tab = null; }
  await refresh();
  if (!state.roomId && !state.pending && tab) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => document.querySelectorAll('video').length });
      $('player').textContent = result ? 'HTML5-видео обнаружено' : 'Проверим плеер и доступные фреймы при подключении';
    } catch { $('player').textContent = 'Откройте обычную страницу с HTML5-видео.'; }
  }
})().catch(fail);
const timer = setInterval(() => { if (!busy) void refresh().catch(() => {}); }, 1500);
window.addEventListener('pagehide', () => clearInterval(timer));
