import { APP_ORIGINS, DEFAULT_APP_ORIGIN } from '../config.mjs';
import { trustedWebContext, validatePair, webOrigin, samePage, permissionPattern } from './security.mjs';
import { discoverPlayer, registerOrigins } from './player-tabs.mjs';

let creating;
const attaching = new Map();
const attachAgain = new Set();
const discoveryRevision = new Map();
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
async function currentAppContext(tabId, roomId, expectedOrigin) {
  const tab = await chrome.tabs.get(tabId);
  // tabs.Tab.url is withheld until host access/activeTab is granted. The
  // existing webNavigation permission can verify the actual top document
  // before consent without trusting a URL supplied by the web message.
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
  const context = trustedWebContext({ url: frame?.url, tab, frameId: 0 }, roomId);
  if (context.origin !== expectedOrigin) throw new Error('Страница комнаты изменилась. Откройте фильм из нужной комнаты ещё раз.');
  return context;
}
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
async function attachTab(tabId, pageURL, onlyIfChanged = true) {
  if (attaching.has(tabId)) { attachAgain.add(tabId); return attaching.get(tabId); }
  const scan = async () => {
    const revision = discoveryRevision.get(tabId);
    const stale = () => revision !== discoveryRevision.get(tabId);
    const tab = await chrome.tabs.get(tabId);
    if (!samePage(tab.url, pageURL)) throw new Error('Страница фильма уже изменилась.');
    const found = await discoverPlayer(chrome, tabId);
    if (stale()) return;
    if (found.changed) { attachAgain.add(tabId); return; }
    await chrome.storage.session.set({ playerNeeds: found.frame?.count ? [] : found.neededOrigins });
    await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'permission-notice', origins: found.frame?.count ? [] : found.neededOrigins }, { frameId: 0 }).catch(() => {});
    if (!found.frame) throw new Error('Плеер недоступен. Разрешите его iframe в расширении; закрытые и DRM-плееры не поддерживаются.');
    const session = await storedSession();
    if (stale()) return;
    if (onlyIfChanged && found.frame.active && found.frame.syncAttached !== false && session?.binding?.frameId === found.frame.frameId && samePage(session.binding.pageURL, pageURL)) return found;
    if (session?.binding?.tabId === tabId && session.binding.frameId !== found.frame.frameId) {
      await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'stop', pause: true }, { frameId: session.binding.frameId }).catch(() => {});
      if (stale()) return;
    }
    check(await engine({ type: 'bind', binding: { tabId, frameId: found.frame.frameId, pageURL } }));
    if (stale()) return;
    check(await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'start' }, { frameId: found.frame.frameId }));
    await chrome.tabs.sendMessage(tabId, { target: 'player', type: 'permission-notice', origins: found.frame.count ? [] : found.neededOrigins }, { frameId: 0 }).catch(() => {});
    return found;
  };
  const task = (async () => {
    let found;
    do {
      attachAgain.delete(tabId);
      try { found = await scan(); }
      catch (error) { if (!attachAgain.has(tabId)) throw error; }
      onlyIfChanged = true;
    } while (attachAgain.delete(tabId));
    return found;
  })();
  attaching.set(tabId, task);
  try { return await task; } finally {
    attaching.delete(tabId);
  }
}
async function openForViewer(pending) {
  const verifyContext = async () => {
    if (!Number.isInteger(pending.appTabId)) throw new Error('Откройте нужную комнату на сайте и нажмите «Открыть фильм» ещё раз.');
    await currentAppContext(pending.appTabId, pending.pair.roomId, pending.pair.origin);
  };
  await verifyContext();
  const previous = await storedSession();
  if (previous?.binding) await chrome.tabs.sendMessage(previous.binding.tabId, { target: 'player', type: 'stop', pause: true }, { frameId: previous.binding.frameId }).catch(() => {});
  const connected = check(await engine({ type: 'pair', pair: pending.pair }));
  if (connected.room?.id !== pending.pair.roomId) throw new Error('Не удалось подтвердить нужную комнату. Откройте приглашение заново.');
  const nickname = connected.room?.participants?.find(member => member.id === connected.participantId)?.nickname;
  if (nickname) await chrome.storage.local.set({ nickname });
  const source = connected.room?.playback?.source;
  if (source?.type !== 'extension') throw new Error('В этой комнате сейчас используется встроенный плеер.');
  webOrigin(source.url);
  if (!await permissionsFor(pending.pair.origin, source.url)) return requestConsent({ ...pending, filmURL: source.url });
  await verifyContext();
  // Bind a specific newly opened tab before navigation. Other tabs, even with
  // the same film URL, never inherit this session automatically.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  try { await verifyContext(); }
  catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
  check(await engine({ type: 'bind', binding: { tabId: tab.id, frameId: 0, pageURL: source.url, awaitingNavigation: true } }));
  await chrome.storage.session.remove('pending');
  await chrome.tabs.update(tab.id, { url: source.url });
  return { ok: true };
}
async function disconnect() {
  const previous = await storedSession();
  if (previous?.binding) await chrome.tabs.sendMessage(previous.binding.tabId, { target: 'player', type: 'permission-notice', origins: [] }, { frameId: 0 }).catch(() => {});
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
  if (message.type === 'open-player-permissions' && sender.tab && sender.frameId === 0) {
    const session = await storedSession();
    if (session?.binding?.tabId !== sender.tab.id || !samePage(sender.tab.url, session.binding.pageURL)) throw new Error('Эта вкладка не подключена к просмотру.');
    // Re-discover; never accept a permission origin supplied by page DOM.
    await attachTab(sender.tab.id, session.binding.pageURL).catch(() => {});
    const { playerNeeds = [] } = await chrome.storage.session.get('playerNeeds');
    if (!playerNeeds.length) return { ok: true };
    await chrome.windows.create({ url: popupURL + '#player-permission', type: 'popup', width: 380, height: 570 });
    return { ok: true };
  }
  if (message.type === 'persist' && offscreen) {
    if (message.session) await chrome.storage.session.set({ session: message.session });
    else await chrome.storage.session.remove(['session', 'pair']);
    return { ok: true };
  }
  if (message.type === 'deliver' && offscreen) {
    await chrome.tabs.sendMessage(message.binding.tabId, { target: 'player', ...message.payload }, { frameId: message.binding.frameId }).catch(() => {});
    return { ok: true };
  }
  if (['player-ready', 'player-layout'].includes(message.type) && sender.tab) {
    discoveryRevision.set(sender.tab.id, (discoveryRevision.get(sender.tab.id) || 0) + 1);
    const session = await storedSession();
    if (session?.binding?.tabId !== sender.tab.id || !samePage(sender.tab.url, session.binding.pageURL)) return { ok: false };
    // A hidden old player can still contain a video. Re-evaluate visibility in
    // its parent, rather than keeping it just because the element exists.
    await attachTab(sender.tab.id, session.binding.pageURL, !(sender.frameId === session.binding.frameId && message.needsAttach));
    return { ok: true };
  }
  if (!popup) throw new Error('Недоверенный контекст расширения.');
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
    const context = trustedWebContext(sender, ['open-film', 'room-status', 'leave-room', 'room-source'].includes(message.type) ? message.roomId : undefined);
    if (['open-film', 'room-source'].includes(message.type)) {
      await currentAppContext(context.tabId, message.roomId, context.origin);
    }
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
    if (message.type === 'room-source') {
      const status = await engine({ type: 'status' });
      if (!status.owner || status.appOrigin !== context.origin || status.roomId !== message.roomId) throw new Error('Подключите эту комнату в расширении с правами владельца.');
      return engine({ type: 'set-source', options: { mode: message.mode, url: message.url } });
    }
    if (message.type !== 'open-film') throw new Error('Неизвестное сообщение.');
    const stored = await storedSession();
    if (stored?.pair.origin === context.origin && stored.pair.roomId === message.roomId && stored.binding) {
      const tab = await chrome.tabs.get(stored.binding.tabId).catch(() => null);
      const status = await engine({ type: 'status' });
      if (tab && status.connected && status.appOrigin === context.origin && status.roomId === message.roomId && samePage(status.room?.playback?.source?.url, message.filmURL) && samePage(message.filmURL, stored.binding.pageURL) && samePage(tab.url, stored.binding.pageURL)) { await chrome.tabs.update(tab.id, { active: true }); return { ok: true }; }
    }
    const session = message.session || (stored?.pair.origin === context.origin && stored.pair.roomId === message.roomId ? stored.pair : null);
    const pair = validatePair({ ...session, roomId: message.roomId, origin: context.origin });
    webOrigin(message.filmURL);
    const pending = { pair, filmURL: message.filmURL, appTabId: context.tabId };
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
chrome.permissions.onAdded.addListener(permissions => {
  void (async () => {
    await registerOrigins(chrome, permissions.origins);
    const session = await storedSession();
    // Registration covers future documents. An already loaded player iframe
    // also needs discovery/injection now, limited to the bound film tab.
    if (session?.binding) await attachTab(session.binding.tabId, session.binding.pageURL);
  })().catch(() => {});
});
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
