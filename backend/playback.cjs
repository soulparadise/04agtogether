const { randomBytes } = require('node:crypto');

const MAX_TIME = 7 * 24 * 3600;
const fail = (code, message) => ({ ok: false, error: { code, message } });
const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME;
function selectionOf(value) {
  const option = value => value && typeof value === 'object' && typeof value.id === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value.id)
    && typeof value.label === 'string' && value.label.trim().length >= 1 && value.label.length <= 96 && !/[\u0000-\u001f\u007f]/.test(value.label) ? { id: value.id, label: value.label.trim() } : null;
  if (!value || typeof value !== 'object' || !['allplay', 'venom'].includes(value.player?.id)) return null;
  const player = option(value.player), voice = value.voice === null ? null : option(value.voice);
  return player && (value.voice === null || voice) ? { player, voice } : null;
}

function createPlayback(clock) {
  return { source: null, sourceId: null, status: 'paused', basePosition: 0, updatedAt: clock(), version: 0, duration: null };
}
function snapshotPlayback(state, clock) {
  const serverNow = clock();
  let position = state.basePosition + (state.status === 'playing' ? Math.max(0, serverNow - state.updatedAt) / 1000 : 0);
  position = Math.min(position, state.duration ?? MAX_TIME);
  const ended = state.source && state.duration !== null && position >= state.duration;
  return { ...state, status: ended ? 'ended' : state.status, position, serverNow };
}
function applyPlayback(state, action, payload, clock) {
  if (action !== 'source' && (!state.source || payload.sourceId !== state.sourceId)) {
    return fail('STALE_SOURCE', 'Источник уже изменился. Получите актуальное состояние.');
  }
  if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion !== state.version) {
    return fail('STALE_STATE', 'Состояние уже изменилось. Повторите действие.');
  }
  const current = snapshotPlayback(state, clock);
  const next = { ...state, basePosition: current.position, updatedAt: current.serverNow, version: state.version + 1 };
  if (action === 'source') {
    if (payload.mode !== undefined && !['embedded', 'extension'].includes(payload.mode)) return fail('INVALID_SOURCE', 'Неизвестный режим плеера.');
    if (typeof payload.url !== 'string' || payload.url.length > 4096 || /[\u0000-\u001f\u007f]/.test(payload.url)) return fail('INVALID_SOURCE', 'Укажите корректную HTTP(S)-ссылку на видео.');
    let url;
    try { url = new URL(payload.url.trim()); } catch { return fail('INVALID_SOURCE', 'Некорректная ссылка на видео.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return fail('INVALID_SOURCE', 'Разрешены только HTTP(S)-ссылки без логина и пароля в адресе.');
    Object.assign(next, { source: { type: payload.mode === 'extension' ? 'extension' : 'html5', url: url.href }, sourceId: randomBytes(16).toString('hex'), status: 'paused', basePosition: 0, duration: null });
  } else if (action === 'selection') {
    const selection = selectionOf(payload.selection);
    if (state.source?.type !== 'extension' || !selection) return fail('INVALID_SELECTION', 'Не удалось подтвердить выбранный плеер или озвучку.');
    Object.assign(next, { source: { ...state.source, selection: { ...selection, version: (state.source.selection?.version || 0) + 1 } }, sourceId: randomBytes(16).toString('hex'), duration: null });
  } else if (action === 'play') {
    next.status = 'playing';
    if (state.duration !== null && current.position >= state.duration) next.basePosition = 0;
  } else if (action === 'pause') next.status = 'paused';
  else if (action === 'seek') {
    if (!validTime(payload.position)) return fail('INVALID_POSITION', 'Некорректная позиция видео.');
    next.basePosition = Math.min(payload.position, state.duration ?? MAX_TIME);
  } else if (action === 'metadata') {
    if (!validTime(payload.duration) || payload.duration === 0) return fail('INVALID_DURATION', 'Некорректная длительность видео.');
    next.duration = payload.duration;
    next.basePosition = Math.min(next.basePosition, next.duration);
  } else return fail('INVALID_ACTION', 'Неизвестная команда воспроизведения.');
  return { ok: true, playback: next };
}
module.exports = { createPlayback, snapshotPlayback, applyPlayback, selectionOf };
