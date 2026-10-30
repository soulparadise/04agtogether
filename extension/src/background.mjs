import { APP_ORIGINS, DEFAULT_APP_ORIGIN } from '../config.mjs';
import { trustedWebContext, validatePair, webOrigin, samePage, permissionPattern } from './security.mjs';
import { discoverPlayer, registerOrigins } from './player-tabs.mjs';

let creating;
const attaching = new Map();
const attachAgain = new Set();
const offscreenURL = chrome.runtime.getURL('offscreen.html');
const popupURL = chrome.runtime.getURL('popup.html');
const fail = error => ({ ok: false, error: { message: error.message || 'Не удалось подключить просмотр.' } });
async function ensureEngine() {
  if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenURL] })).length) return;
  creating ??= chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Run the dedicated Socket.IO HTTP polling worker independently of MV3 service worker suspension.' }).finally(() => { creating = null; });
  await creating;
}
async function engine(message) { await ensureEngine(); return chrome.runtime.sendMessage({ target: 'engine', ...message }); }
function check(reply) { if (!reply?.ok) throw new Error(reply?.error?.message || 'Нет соединения с комнатой.'); return reply; }
async function storedSession() {
  const stored = await chrome.storage.session.get(['session', 'pair']);
  return stored.session || (stored.pair ? { pair: stored.pair } : null);
}
async function pendingLaunch() {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending && pending.expiresAt > Date.now()) return pending;
  if (pending) await chrome.storage.session.remove('pending');
  return null;
}
async function permissionsFor(origin, filmURL) {
  return chrome.permissions.contains({ origins: [...new Set([permissionPattern(origin), permissionPattern(filmURL)])] });
}
async function requestConsent(pending) {
  await chrome.storage.session.set({ pending: { ...pending, expiresAt: Date.now() + 120000 } });
  // A permission request needs a Chrome user gesture. Show the same compact
  // popup only on the first visit to a site, never an ordinary pairing screen.
  try { if (!chrome.action.openPopup) throw new Error(); await chrome.action.openPopup(); }
  catch { await chrome.windows.create({ url: popupURL + '#permission', type: 'popup', width: 380, height: 570 }); }
  return { ok: true, needsPermission: true };
}
async function attachTab(tabId, pageURL, onlyIfChanged = false) {
  if (attaching.has(tabId)) { attachAgain.add(tabId); return attaching.get(tabId); }
  const task = (async () => {
    const tab = await chrome.tabs.get(tabId);
    if (!samePage(tab.url, pageURL)) throw new Error('Страница фильма уже изменилась.');
    const found = await discoverPlayer(chrome, tabId);
    await chrome.storage.session.set({ playerNeeds: found.frame?.count ? [] : found.neededOrigins });
    if (!found.frame) throw new Error('Плеер недоступен. Разрешите его iframe в расширении; закрытые и DRM-плееры не поддерживаются.');
    const session = await storedSession();
    if (found.frame.selection) {
      const status = await engine({ type: 'status' });
      if (status.owner) {
        const previous = status.room?.playback?.source?.selection;
        const selection = { ...found.frame.selection, voice: found.frame.selection.voice || (previous?.player.id === found.frame.selection.player.id ? previous.voice : null) };
        check(await engine({ type: 'selection', selection }));
      }
    }
    if (onlyIfChanged && session?.binding?.frameId === found.frame.frameId && samePage(session.binding.pageURL, pageURL)) return found;
    check(await engine({ type: 'bind', binding: { tabId, frameId: found.frame.frameId, pageURL } }));
    await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'start' }, { frameId: found.frame.frameId });
    return found;
  })();
  attaching.set(tabId, task);
  try { return await task; } finally {
    attaching.delete(tabId);
    if (attachAgain.delete(tabId)) queueMicrotask(() => { void attachTab(tabId, pageURL, true).catch(() => {}); });
  }
}
async function openForViewer(pending) {
  const connected = check(await engine({ type: 'pair', pair: pending.pair }));
  const nickname = connected.room?.participants?.find(member => member.id === connected.participantId)?.nickname;
  if (nickname) await chrome.storage.local.set({ nickname });
  const source = connected.room?.playback?.source;
  if (source?.type !== 'extension') throw new Error('В этой комнате сейчас используется встроенный плеер.');
  webOrigin(source.url);
  if (!await permissionsFor(pending.pair.origin, source.url)) return requestConsent({ ...pending, filmURL: source.url });
  // Bind a specific newly opened tab before navigation. Other tabs, even with
  // the same film URL, never inherit this session automatically.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  check(await engine({ type: 'bind', binding: { tabId: tab.id, frameId: 0, pageURL: source.url, awaitingNavigation: true } }));
  await chrome.storage.session.remove('pending');
  await chrome.tabs.update(tab.id, { url: source.url });
  return { ok: true };
}
async function disconnect() {
  check(await engine({ type: 'disconnect' }));
  await chrome.storage.session.remove(['session', 'pair', 'pending', 'playerNeeds']);
  return { ok: true };
}
async function watch(message) {
  const tab = await chrome.tabs.get(message.tabId);
  webOrigin(tab.url);
  if (APP_ORIGINS.includes(new URL(tab.url).origin)) throw new Error('Откройте страницу фильма, затем нажмите «Смотреть вместе».');
  const nickname = String(message.nickname || '').trim();
  if (!nickname || nickname.length > 32) throw new Error('Укажите никнейм от 1 до 32 символов.');
  if (!await permissionsFor(DEFAULT_APP_ORIGIN, tab.url)) throw new Error('Разрешите доступ к приложению и странице фильма.');
  const found = await discoverPlayer(chrome, tab.id);
  if (!found.frame?.count) { await chrome.storage.session.set({ playerNeeds: found.neededOrigins }); return { ok: false, neededOrigins: found.neededOrigins, error: { message: 'HTML5-видео пока не найдено. Запустите плеер сайта или разрешите его iframe.' } }; }
  check(await engine({ type: 'create', options: { origin: DEFAULT_APP_ORIGIN, nickname, pageURL: tab.url, title: tab.title, initial: found.frame.initial } }));
  await chrome.storage.local.set({ nickname });
  await chrome.storage.session.remove('pending');
  await attachTab(tab.id, tab.url);
  return { ok: true };
}
async function handleInternal(message, sender) {
  const offscreen = !sender.tab && sender.url === offscreenURL;
  const popup = sender.url?.split('#')[0] === popupURL; // action popup or permission window
  if (message.type === 'bootstrap' && offscreen) return storedSession();
  if (message.type === 'persist' && offscreen) {
    if (message.session) await chrome.storage.session.set({ session: message.session });
    else await chrome.storage.session.remove(['session', 'pair']);
    return { ok: true };
  }
  if (message.type === 'deliver' && offscreen) {
    await chrome.tabs.sendMessage(message.binding.tabId, { target: 'player', ...message.payload }, { frameId: message.binding.frameId }).catch(() => {});
    if (message.payload.type === 'state' && !message.payload.owner && message.payload.state.source?.selection) {
      await chrome.tabs.sendMessage(message.binding.tabId, { target: 'player', type: 'source-target', selection: message.payload.state.source.selection }, { frameId: 0 }).catch(() => {});
    }
    return { ok: true };
  }
  if (['player-ready', 'player-layout'].includes(message.type) && sender.tab) {
    const session = await storedSession();
    if (session?.binding?.tabId !== sender.tab.id || !samePage(sender.tab.url, session.binding.pageURL)) return { ok: false };
    // A hidden old player can still contain a video. Re-evaluate visibility in
    // its parent, rather than keeping it just because the element exists.
    await attachTab(sender.tab.id, session.binding.pageURL, !(sender.frameId === session.binding.frameId && message.needsAttach));
    return { ok: true };
  }
  if (!popup) throw new Error('Недоверенный контекст расширения.');
  if (message.type === 'select-voice') {
    const status = await engine({ type: 'status' });
    const selection = status.room?.playback?.source?.selection;
    if (!status.owner || !['allplay', 'venom'].includes(message.player)) throw new Error('Укажи выбранный плеер владельца.');
    const { voiceOption } = await import('./source-selection.mjs');
    const player = { id: message.player, label: message.player === 'allplay' ? 'Плеер 2 · Allplay' : 'Full HD · player-venom' };
    const reply = await engine({ type: 'selection', selection: { player, voice: voiceOption(message.label) } });
    if (reply.ok) {
      const session = await storedSession();
      if (session?.binding) await chrome.tabs.sendMessage(session.binding.tabId, { target: 'player', type: 'confirm-selection', selection: reply.state.source.selection }, { frameId: session.binding.frameId });
    }
    return reply;
  }
  if (message.type === 'confirm-selection') {
    const session = await storedSession();
    if (!session?.binding) throw new Error('Сначала откройте фильм.');
    return chrome.tabs.sendMessage(session.binding.tabId, { target: 'player', type: 'confirm-selection' }, { frameId: session.binding.frameId });
  }
  if (message.type === 'popup-state') {
    const pending = await pendingLaunch();
    const { nickname } = await chrome.storage.local.get('nickname');
    const { playerNeeds = [] } = await chrome.storage.session.get('playerNeeds');
    return { ...await engine({ type: 'status' }), nickname: nickname || '', neededOrigins: playerNeeds, pending: pending ? { filmURL: pending.filmURL, appOrigin: pending.pair.origin } : null };
  }
  if (message.type === 'watch') return watch(message);
  if (message.type === 'finish-open') {
    const pending = await pendingLaunch();
    if (!pending) throw new Error('Приглашение устарело. Нажмите «Открыть фильм» в комнате ещё раз.');
    if (!await permissionsFor(pending.pair.origin, pending.filmURL)) throw new Error('Доступ к странице фильма не разрешён.');
    return openForViewer(pending);
  }
  if (message.type === 'retry-player') {
    const session = await storedSession();
    if (!session?.binding) throw new Error('Активный просмотр не найден.');
    await attachTab(session.binding.tabId, session.binding.pageURL); return { ok: true };
  }
  if (message.type === 'disconnect') return disconnect();
  return { ok: false };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'background' || sender.id !== chrome.runtime.id) return;
  void handleInternal(message, sender).then(reply).catch(error => reply(fail(error))); return true;
});
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  void (async () => {
    const context = trustedWebContext(sender, ['open-film', 'room-status', 'leave-room'].includes(message.type) ? message.roomId : undefined);
    if (message.type === 'ping') return { ok: true };
    if (message.type === 'profile') return { ok: true, nickname: (await chrome.storage.local.get('nickname')).nickname || '' };
    if (message.type === 'room-status') {
      const status = await engine({ type: 'status' });
      return status.appOrigin === context.origin && status.roomId === message.roomId ? { ok: true, ...status } : { ok: false };
    }
    if (message.type === 'leave-room') {
      const status = await engine({ type: 'status' });
      if (status.appOrigin !== context.origin || status.roomId !== message.roomId) throw new Error('Эта комната не подключена в расширении.');
      return disconnect();
    }
    if (message.type !== 'open-film') throw new Error('Неизвестное сообщение.');
    const stored = await storedSession();
    if (stored?.pair.origin === context.origin && stored.pair.roomId === message.roomId && stored.binding) {
      const tab = await chrome.tabs.get(stored.binding.tabId).catch(() => null);
      if (tab && samePage(tab.url, stored.binding.pageURL)) { await chrome.tabs.update(tab.id, { active: true }); return { ok: true }; }
    }
    const session = message.session || (stored?.pair.origin === context.origin && stored.pair.roomId === message.roomId ? stored.pair : null);
    const pair = validatePair({ ...session, roomId: message.roomId, origin: context.origin });
    webOrigin(message.filmURL);
    const pending = { pair, filmURL: message.filmURL };
    if (!await permissionsFor(pair.origin, pending.filmURL)) return requestConsent(pending);
    return openForViewer(pending);
  })().then(reply).catch(error => reply(fail(error))); return true;
});

async function checkTab(tabId, url, closed = false) {
  const session = await storedSession();
  if (session?.binding?.tabId !== tabId) return;
  if (session.binding.awaitingNavigation && url === 'about:blank' && !closed) return;
  if (closed || (url && !samePage(url, session.binding.pageURL))) await disconnect();
  else if (url) await attachTab(tabId, session.binding.pageURL).catch(() => {});
}
chrome.tabs.onRemoved.addListener(tabId => { void checkTab(tabId, null, true).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) void checkTab(tabId, change.url).catch(() => {});
  else if (change.status === 'complete') void checkTab(tabId, tab.url).catch(() => {});
});
chrome.permissions.onAdded.addListener(permissions => { void registerOrigins(chrome, permissions.origins).catch(() => {}); });
void (async () => {
  await registerOrigins(chrome, (await chrome.permissions.getAll()).origins);
  const session = await storedSession();
  if (!session) return;
  if (session.binding) {
    const tab = await chrome.tabs.get(session.binding.tabId).catch(() => null);
    if (!tab || !samePage(tab.url, session.binding.pageURL)) { await chrome.storage.session.remove(['session', 'pair']); return; }
  }
  await ensureEngine();
})().catch(() => {});
