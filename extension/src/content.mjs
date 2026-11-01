import { PlaybackSync } from '../../frontend/src/player/PlaybackSync.mjs';
import { ForeignVideoAdapter } from './ForeignVideoAdapter.mjs';
import { samePage } from './security.mjs';
import { childFrameLayout } from './frame-layout.mjs';
import { readSelection } from './source-selection.mjs';

// Runs exclusively in Chrome's ISOLATED world. No credentials, DOM bridge,
// postMessage listener or page-script injection.
globalThis.__04agtogetherContent?.destroy();
let sync, adapter, video, observer, timer, overlay, statusText, startButton, active = false, owner = false, state, metadataSource, selectedPage;
const bindings = [];
let lastDiscovered, lastFrameLayout = '', discoveryTimer;
let lastSelection = '';
let lifecycle = 0;
let permissionNotice, permissionMessage, permissionButton;
function showPermissionNotice(origins) {
  if (!origins?.length) { permissionNotice?.remove(); permissionNotice = null; return; }
  if (!permissionNotice) {
    permissionNotice = document.createElement('div');
    permissionNotice.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;max-width:300px';
    const root = permissionNotice.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'padding:14px;background:#142019;color:#edf5de;border:1px solid #a2b888;border-radius:10px;font:14px/1.5 system-ui;box-shadow:0 4px 20px #0006';
    const title = document.createElement('strong'); title.textContent = '04agtogether · плеер не подключён';
    permissionMessage = document.createElement('p');
    permissionButton = document.createElement('button'); permissionButton.textContent = 'Открыть расширение для разрешения';
    permissionButton.style.cssText = 'padding:8px;cursor:pointer';
    permissionButton.addEventListener('click', () => {
      permissionButton.disabled = true;
      void chrome.runtime.sendMessage({ target: 'background', type: 'open-player-permissions' }).then(reply => {
        if (!reply?.ok) throw new Error(reply?.error?.message || 'Не удалось открыть расширение.');
      }).catch(() => { permissionMessage.textContent = 'Откройте 04agtogether кнопкой расширений браузера и разрешите доступ к плееру. Можно повторить попытку.'; })
        .finally(() => { if (permissionButton) permissionButton.disabled = false; });
    });
    box.append(title, permissionMessage, permissionButton); root.append(box); document.documentElement.append(permissionNotice);
  }
  permissionMessage.textContent = `Для совместного просмотра нужен доступ к плееру: ${origins.map(origin => new URL(origin).hostname).join(', ')}. В открывшемся расширении нажмите «Разрешить плеер». Без разрешения синхронизация не работает. Видео можно управлять как обычно.`;
}
const technicalPauses = new WeakSet(), ignoredPauseEvents = new WeakSet();
const engine = payload => chrome.runtime.sendMessage({ target: 'engine', type: 'content', payload });
function videos() {
  const found = [...document.querySelectorAll('video')].filter(v => area(v) > 0 && getComputedStyle(v).visibility !== 'hidden').sort((a, b) => area(b) - area(a));
  // Allplay also creates an advertising video; never bind or control that one.
  return document.querySelector('video.allplay__video') ? found.filter(v => v.matches('video.allplay__video')) : found;
}
function area(element) { const rect = element.getBoundingClientRect(); return Math.max(0, rect.width) * Math.max(0, rect.height); }
function status(text) {
  if (statusText?.textContent === text) return;
  if (statusText) statusText.textContent = text;
  void engine({ type: 'status', status: text }).catch(() => {});
}
function playbackStatus(ownAdapter, text) {
  if (adapter !== ownAdapter || !text) return;
  if (ownAdapter.waitForClock && !ownAdapter.warmupAt && ownAdapter.video.paused && !ownAdapter.video.error) {
    startButton.hidden = false;
    status('Нажмите «Начать просмотр», чтобы запустить плеер сайта.');
    return;
  }
  if (ownAdapter.video.error) {
    const explanations = { 1: 'загрузка прервана', 2: 'сетевая ошибка загрузки', 3: 'ошибка декодирования', 4: 'формат или источник не поддерживается' };
    status(`Ошибка видео сайта: ${explanations[ownAdapter.video.error.code] || `код ${ownAdapter.video.error.code}`}. Проверьте воспроизведение на сайте или выберите другой источник.`);
  } else if (!ownAdapter.isReady() && (ownAdapter.needsGesture || (ownAdapter.warmupAt && performance.now() - ownAdapter.warmupAt > 3000))) {
    startButton.hidden = false;
    status(ownAdapter.needsGesture ? 'Браузер не разрешил автоматический запуск. Нажмите «Начать просмотр».' : 'Плеер ещё не загрузил видео. Нажмите «Начать просмотр», чтобы запустить загрузку на сайте.');
  } else status(text);
}
function panel() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;transform:translateY(-50%)';
  const root = overlay.attachShadow({ mode: 'closed' });
  const box = document.createElement('div'); box.style.cssText = 'max-width:230px;padding:12px;background:#142019;color:#edf5de;border:1px solid #a2b888;border-radius:8px;font:12px/1.5 system-ui;pointer-events:none';
  const title = document.createElement('strong'); title.textContent = '04agtogether';
  statusText = document.createElement('p'); statusText.style.margin = '6px 0';
  startButton = document.createElement('button'); startButton.textContent = 'Начать просмотр'; startButton.hidden = true;
  startButton.style.pointerEvents = 'auto';
  startButton.addEventListener('click', () => { if (adapter?.isReady()) sync?.startViewing(); else initializeVideo(true); });
  box.append(title, statusText, startButton); root.append(box); document.documentElement.append(overlay);
  placePanel();
}
function placePanel() {
  if (!overlay) return;
  const anchor = video || videos()[0];
  overlay.hidden = !anchor;
  if (!anchor) return;
  const full = document.fullscreenElement;
  const parent = full && full !== anchor && full.contains(anchor) ? full : document.documentElement;
  if (overlay.parentNode !== parent) parent.append(overlay);
  const rect = anchor.getBoundingClientRect();
  overlay.style.left = `${rect.left + 12}px`;
  overlay.style.top = `${rect.top + rect.height / 2}px`;
  overlay.style.maxWidth = `${Math.max(60, rect.width - 24)}px`;
}
function releaseVideo(pause = false) {
  if (startButton) startButton.hidden = true;
  bindings.splice(0).forEach(([element, event, listener]) => element.removeEventListener(event, listener));
  if (pause && video && !video.paused) { technicalPauses.add(video); video.pause(); }
  sync?.destroy(); sync = null; adapter = null; video = null; metadataSource = null;
}
function initializeVideo(retry = false) {
  const current = adapter;
  if (!current || current.isReady() || (!retry && state?.status !== 'playing') || (!retry && current.warmupAt)) return;
  // Allplay's HLS loader is idle until its normal Play control is activated.
  // This only primes the current video; PlaybackSync still decides position/status.
  if (!current.video.matches('video.allplay__video')) return;
  if (!retry) {
    if (current.video.paused) {
      startButton.hidden = false;
      status('Нажмите «Начать просмотр», чтобы запустить плеер сайта.');
    }
    return;
  }
  current.warmupAt = performance.now(); current.needsGesture = false;
  const controls = [...document.querySelectorAll('button.allplay__control--overlaid[data-allplay="play"]')].filter(button => area(button) > 0);
  current.mark('play');
  if (current.video.paused && controls.length === 1) { controls[0].click(); return; }
  let play;
  try { play = current.play(); } catch (error) { play = Promise.reject(error); }
  Promise.resolve(play).catch(error => {
    if (adapter !== current) return;
    if (error.name === 'NotAllowedError') { current.needsGesture = true; playbackStatus(current, 'Ожидаем разрешение браузера'); }
    else if (error.name !== 'AbortError') playbackStatus(current, 'Не удалось запустить видео сайта. Попробуйте штатную кнопку Play или другой источник.');
  });
}
async function metadata() {
  const duration = adapter?.getDuration();
  if (!owner || !state?.sourceId || duration === null || !duration || (state.duration !== null && Math.abs(state.duration - duration) < 0.1) || metadataSource === state.sourceId) return;
  metadataSource = state.sourceId;
  try { const reply = await engine({ type: 'intent', action: 'metadata', duration, sourceId: state.sourceId }); if (!reply?.ok) metadataSource = null; }
  catch { metadataSource = null; }
}
function selectVideo() {
  if (!active) return;
  const selected = videos()[0];
  if (video?.isConnected && video === selected) { placePanel(); initializeVideo(); return; }
  if (!selected) { releaseVideo(); placePanel(); status('Ожидаем загрузку выбранного плеера. Если он не появится, запустите его на странице или проверьте разрешение iframe в расширении.'); return; }
  releaseVideo(true); video = selected; adapter = new ForeignVideoAdapter(video);
  placePanel();
  const ownAdapter = adapter;
  sync = new PlaybackSync({ adapter,
    request: async () => {
      const reply = await engine({ type: 'get' });
      if (!reply?.ok) throw new Error('Connection lost');
      return reply;
    },
    onState: next => { if (adapter === ownAdapter) state = next; },
    onStatus: text => playbackStatus(ownAdapter, text),
    onError: text => playbackStatus(ownAdapter, text),
    onBlocked: blocked => { if (startButton) startButton.hidden = !blocked; }, onMetadata: () => void metadata()
  });
  for (const [event, action] of Object.entries({ play: 'play', pause: 'pause', seeked: 'seek' })) {
    const listener = async domEvent => {
      if (ignoredPauseEvents.has(domEvent) || ownAdapter.consume(event) || !active || adapter !== ownAdapter || !ownAdapter.video.isConnected || videos()[0] !== ownAdapter.video || ownAdapter.video.readyState < 1 || (event === 'pause' && !ownAdapter.video.paused)) return;
      if (!owner) { sync?.apply(); return; }
      // Do not let an old server snapshot undo an in-progress local gesture.
      ownAdapter.intentPending++;
      try {
        const reply = await engine({ type: 'intent', action, position: ownAdapter.getCurrentTime(), sourceId: state.sourceId });
        if (adapter !== ownAdapter) return;
        if (!reply?.ok) status(reply?.error?.message || 'Команда не подтверждена.');
        if (reply?.state && sync) sync.accept(reply.state);
      } catch { if (adapter === ownAdapter) status('Нет связи с расширением. Подключите плеер заново.'); }
      finally { ownAdapter.intentPending--; if (adapter === ownAdapter) sync?.apply(true); }
    };
    video.addEventListener(event, listener); bindings.push([video, event, listener]);
  }
  if (state) sync.accept(state);
  void sync.refresh(); initializeVideo(); void metadata();
}
async function start() {
  const attempt = ++lifecycle;
  const reply = await engine({ type: 'attach' });
  if (attempt !== lifecycle) return;
  if (!reply?.ok) { panel(); status(reply?.error?.message || 'Сначала подключите эту вкладку в popup расширения.'); return; }
  if (active && samePage(selectedPage, reply.state.source?.url)) {
    acceptState(reply.state); selectVideo(); sync?.setConnected(reply.connected); void sync?.refresh(); return;
  }
  stop(); active = true; owner = reply.owner; state = reply.state; selectedPage = state.source.url; panel();
  observer = new MutationObserver(selectVideo); observer.observe(document.documentElement, { childList: true, subtree: true });
  timer = setInterval(() => { notifyDiscovery(); selectVideo(); void metadata(); }, 1000);
  selectVideo(); sync?.setConnected(reply.connected);
}
function stop() {
  showPermissionNotice([]);
  lifecycle++;
  active = false; observer?.disconnect(); clearInterval(timer); releaseVideo(); overlay?.remove(); overlay = null; statusText = null; startButton = null;
}
function acceptState(next) {
  if (state && (next.version < state.version || (next.version === state.version && next.serverNow < state.serverNow))) return;
  if (next.source?.type !== 'extension' || !samePage(next.source.url, selectedPage)) { releaseVideo(true); stop(); panel(); status('Источник изменился. Откройте выбранную владельцем страницу и подключите её плеер.'); return; }
  const changed = state?.sourceId !== next.sourceId;
  state = next;
  if (changed) { releaseVideo(true); selectVideo(); }
  else if (sync) sync.accept(state);
  else selectVideo();
}
const receive = (message, sender, reply) => {
  if (message.target !== 'player' || sender.id !== chrome.runtime.id) return;
  if (message.type === 'permission-notice') { showPermissionNotice(message.origins); reply({ ok: true }); return; }
  if (message.type === 'discover') { const found = videos(), first = found[0], selection = readSelection(document); reply({ active, sourceId: state?.sourceId, syncAttached: Boolean(sync && first === video), ready: first?.readyState ?? null, count: found.length, score: first ? area(first) : 0, childFrames: childFrameLayout(document), selection, initial: first ? { position: first.currentTime, duration: Number.isFinite(first.duration) ? first.duration : null, playing: !first.paused && !first.ended, selection } : {} }); }
  else if (message.type === 'start') { void start().then(() => reply({ ok: active })).catch(() => reply({ ok: false })); return true; }
  else if (message.type === 'stop') { releaseVideo(Boolean(message.pause)); stop(); reply({ ok: true }); }
  else if (message.type === 'connection') { sync?.setConnected(message.connected); if (message.connected) void sync?.refresh(); else status('Нет связи — восстанавливаем синхронизацию…'); }
  else if (message.type === 'state' && active) {
    acceptState(message.state);
  }
};
chrome.runtime.onMessage.addListener(receive);
function notifyDiscovery() {
  const current = videos()[0];
  const layout = JSON.stringify(childFrameLayout(document));
  const layoutChanged = layout !== lastFrameLayout;
  const selection = JSON.stringify(readSelection(document));
  const selectionChanged = selection !== lastSelection; lastSelection = selection;
  if (current === lastDiscovered && !layoutChanged && !selectionChanged) return;
  lastDiscovered = current;
  lastFrameLayout = layout;
  void chrome.runtime.sendMessage({ target: 'background', type: layoutChanged ? 'player-layout' : 'player-ready', needsAttach: Boolean(current) && !active }).catch(() => {});
}
const onChoice = () => { notifyDiscovery(); selectVideo(); };
const onTechnicalPause = event => { if (technicalPauses.delete(event.target)) ignoredPauseEvents.add(event); };
const onReady = event => { if (event.target !== videos()[0]) return; selectVideo(); };
document.addEventListener('change', onChoice, true);
document.addEventListener('pause', onTechnicalPause, true);
document.addEventListener('loadedmetadata', onReady, true);
document.addEventListener('canplay', onReady, true);
const discovery = new MutationObserver(() => {
  if (!discoveryTimer) discoveryTimer = setTimeout(() => { discoveryTimer = null; notifyDiscovery(); }, 100);
});
discovery.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'src'] });
window.addEventListener('resize', placePanel); document.addEventListener('scroll', placePanel, true); document.addEventListener('fullscreenchange', placePanel);
function destroy() { stop(); discovery.disconnect(); clearTimeout(discoveryTimer); chrome.runtime.onMessage.removeListener(receive); document.removeEventListener('change', onChoice, true); document.removeEventListener('pause', onTechnicalPause, true); document.removeEventListener('loadedmetadata', onReady, true); document.removeEventListener('canplay', onReady, true); window.removeEventListener('resize', placePanel); document.removeEventListener('scroll', placePanel, true); document.removeEventListener('fullscreenchange', placePanel); window.removeEventListener('pagehide', destroy); }
globalThis.__04agtogetherContent = { destroy };
window.addEventListener('pagehide', destroy);
// Navigation/reload: only a previously bound tab/frame can attach automatically.
const initialLifecycle = lifecycle;
void engine({ type: 'attach' }).then(reply => { if (reply?.ok && lifecycle === initialLifecycle) void start(); }).catch(() => {});
notifyDiscovery();
