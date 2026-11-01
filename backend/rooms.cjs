const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createPlayback, snapshotPlayback, applyPlayback } = require('./playback.cjs');
const { registerDevDiagnostics } = require('./dev-diagnostics.cjs');
const { createRoomStore } = require('./room-store.cjs');

const randomId = () => randomBytes(16).toString('hex');
const secret = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest();
const matches = (value, expected) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(hash(value), expected);
const failure = (code, message) => ({ ok: false, error: { code, message } });

function createRoomManager(io, {
  now = Date.now, clock = () => performance.now(), inactiveMs = 30 * 60_000, reconnectMs = 2 * 60_000,
  sweepMs = 30_000, maxRooms = 200, maxParticipants = 20, developmentDiagnostics = false, stateDirectory
} = {}) {
  const rooms = new Map();
  const store = stateDirectory ? createRoomStore(stateDirectory) : null;
  let checkpointAt = 0;
  function persist() {
    if (!store) return;
    checkpointAt = now();
    store.write({ savedAt: now(), rooms: [...rooms.values()].map(room => ({
      ...room, ownerHash: room.ownerHash.toString('hex'),
      participants: [...room.participants.values()].map(member => ({ ...member, sessionHash: member.sessionHash.toString('hex'), socketId: null })),
      playback: { ...room.playback, basePosition: snapshotPlayback(room.playback, clock).position, updatedAt: 0 }
    })) });
  }
  try {
    const saved = store?.read();
    if (saved) {
      if (saved.rooms.length > maxRooms) throw new Error('Room checkpoint capacity mismatch');
      const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
      const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
      for (const record of saved.rooms) {
        if (!validId(record.id) || !validId(record.ownerId) || !validHash(record.ownerHash) || typeof record.title !== 'string' || record.title.length > 80 || !Array.isArray(record.participants) || record.participants.length > maxParticipants
          || !Number.isSafeInteger(record.revision) || !Number.isFinite(record.playback?.basePosition) || !Number.isSafeInteger(record.playback.version)
          || !['playing', 'paused', 'ended'].includes(record.playback.status)) throw new Error('Invalid room checkpoint');
        const source = record.playback.source;
        if (record.playback.basePosition < 0 || record.playback.basePosition > 604800 || record.playback.version < 0 || (record.playback.duration !== null && (!Number.isFinite(record.playback.duration) || record.playback.duration <= 0 || record.playback.duration > 604800))) throw new Error('Invalid checkpoint playback');
        if (source) {
          const url = new URL(source.url);
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['extension', 'html5'].includes(source.type) || !validId(record.playback.sourceId)) throw new Error('Invalid checkpoint source');
        }
        delete record.login;
        if (source) record.playback.source = { type: source.type, url: source.url };
        const participants = new Map(record.participants.map(member => {
          if (!validId(member.id) || !validHash(member.sessionHash) || typeof member.nickname !== 'string' || member.nickname.length > 32) throw new Error('Invalid participant checkpoint');
          return [member.id, { ...member, sessionHash: Buffer.from(member.sessionHash, 'hex'), socketId: null, disconnectedAt: member.disconnectedAt ?? saved.savedAt }];
        }));
        if (!participants.has(record.ownerId)) throw new Error('Missing room owner');
        const playback = { ...record.playback, updatedAt: clock(), basePosition: Math.min(record.playback.duration ?? 604800, record.playback.basePosition + (record.playback.status === 'playing' ? Math.max(0, now() - saved.savedAt) / 1000 : 0)) };
        rooms.set(record.id, { ...record, ownerHash: Buffer.from(record.ownerHash, 'hex'), participants, playback, emptySince: record.emptySince ?? saved.savedAt });
      }
    }
  } catch (error) { store?.close(); throw error; }
  const nicknameOf = payload => {
    if (typeof payload?.nickname !== 'string') return null;
    const nickname = payload.nickname.trim().normalize('NFC');
    return nickname.length >= 1 && nickname.length <= 32 && !/[\u0000-\u001f\u007f]/.test(nickname) ? nickname : null;
  };
  const snapshot = room => ({
    id: room.id, title: room.title, revision: room.revision, ownerId: room.ownerId,
    playback: snapshotPlayback(room.playback, clock),
    participants: [...room.participants.values()].map(member => ({
      id: member.id, nickname: member.nickname,
      role: member.id === room.ownerId ? 'owner' : 'viewer', connected: member.socketId !== null
    }))
  });
  const channel = room => `room:${room.id}`;
  function publish(room) {
    room.revision++;
    persist();
    io.to(channel(room)).emit('room:state', snapshot(room));
  }
  function markEmpty(room) {
    if (![...room.participants.values()].some(member => member.socketId !== null)) room.emptySince ??= now();
    else room.emptySince = null;
  }
  function detach(socket, explicit = false) {
    const membership = socket.data.membership;
    if (!membership) return;
    const room = rooms.get(membership.roomId);
    const member = room?.participants.get(membership.participantId);
    socket.leave(`room:${membership.roomId}`);
    delete socket.data.membership;
    delete socket.data.credentials;
    if (!member || member.socketId !== socket.id) return;
    member.socketId = null;
    member.disconnectedAt = now();
    // Keep the owner's identity while the room exists. Ownership never migrates.
    if (explicit && member.id !== room.ownerId) room.participants.delete(member.id);
    markEmpty(room);
    publish(room);
  }
  function attach(socket, room, member, credentials) {
    detach(socket, true);
    member.socketId = socket.id;
    member.disconnectedAt = null;
    room.emptySince = null;
    socket.data.membership = { roomId: room.id, participantId: member.id };
    socket.data.credentials = credentials;
    socket.join(channel(room));
    publish(room);
    return { ok: true, room: snapshot(room), participantId: member.id, ...credentials };
  }
  function current(socket) {
    const membership = socket.data.membership;
    const room = rooms.get(membership?.roomId);
    const member = room?.participants.get(membership?.participantId);
    return room && member?.socketId === socket.id ? { room, member } : null;
  }
  function repeat(socket, roomId) {
    const active = current(socket);
    if (active && active.room.id === roomId) return {
      ok: true, room: snapshot(active.room), participantId: active.member.id, ...socket.data.credentials
    };
    return null;
  }
  function sweep() {
    const time = now();
    let removed = false;
    for (const [id, room] of rooms) {
      if (room.emptySince !== null && time - room.emptySince >= inactiveMs) {
        rooms.delete(id);
        removed = true;
        continue;
      }
      let changed = false;
      for (const [memberId, member] of room.participants) {
        if (memberId !== room.ownerId && member.socketId === null && time - member.disconnectedAt >= reconnectMs) {
          room.participants.delete(memberId);
          changed = true;
        }
      }
      if (changed) publish(room);
    }
    if (removed) { persist(); console.info('Room cleanup: inactive rooms expired'); }
    else if (store && time - checkpointAt >= 15_000 && [...rooms.values()].some(room => room.emptySince === null)) persist();
  }
  const timer = setInterval(sweep, sweepMs);
  timer.unref();
  function register(socket) {
    if (developmentDiagnostics) registerDevDiagnostics(socket, { io, current, channel, clock });
    const on = (event, handler) => socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') return;
      // Missing/malformed payloads must not crash the process or mutate rooms.
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        ack(failure('INVALID_REQUEST', 'Некорректный запрос.'));
        return;
      }
      sweep();
      ack(handler(payload));
    });
    on('room:create', payload => {
      const active = current(socket);
      if (active && active.member.id === active.room.ownerId) return repeat(socket, active.room.id);
      const nickname = nicknameOf(payload);
      if (!nickname) return failure('INVALID_NICKNAME', 'Укажите никнейм от 1 до 32 символов.');
      if (rooms.size >= maxRooms) return failure('ROOM_LIMIT', 'Сейчас слишком много комнат. Попробуйте позже.');
      const ownerToken = secret();
      const sessionToken = secret();
      const member = { id: randomId(), nickname, sessionHash: hash(sessionToken), socketId: null, disconnectedAt: now() };
      const room = { id: randomId(), title: 'Вечер вместе', ownerId: member.id, ownerHash: hash(ownerToken), revision: 0, emptySince: now(), participants: new Map([[member.id, member]]), playback: createPlayback(clock) };
      rooms.set(room.id, room);
      return attach(socket, room, member, { sessionToken, ownerToken });
    });
    on('room:join', payload => {
      const room = rooms.get(payload.roomId);
      if (!room) return failure('ROOM_NOT_FOUND', 'Комната не найдена или уже закрыта.');
      const existing = repeat(socket, room.id);
      if (existing) return existing;
      const nickname = nicknameOf(payload);
      if (!nickname) return failure('INVALID_NICKNAME', 'Укажите никнейм от 1 до 32 символов.');
      if (room.participants.size >= maxParticipants) return failure('PARTICIPANT_LIMIT', 'В комнате уже 20 участников.');
      const sessionToken = secret();
      const member = { id: randomId(), nickname, sessionHash: hash(sessionToken), socketId: null, disconnectedAt: now() };
      room.participants.set(member.id, member);
      return attach(socket, room, member, { sessionToken });
    });
    on('room:resume', payload => {
      const room = rooms.get(payload.roomId);
      if (!room) { console.info('Room resume: confirmed missing room'); return failure('ROOM_NOT_FOUND', 'Сервер подтвердил: комната не найдена или истекло время её хранения.'); }
      const member = room.participants.get(payload.participantId);
      if (!member || !matches(payload.sessionToken, member.sessionHash)) return failure('SESSION_EXPIRED', 'Сессия истекла. Войдите в комнату заново.');
      if (member.id === room.ownerId && !matches(payload.ownerToken, room.ownerHash)) return failure('FORBIDDEN', 'Не удалось подтвердить права владельца.');
      if (member.socketId && member.socketId !== socket.id) {
        // Browsers may leave the previous polling connection alive on reload.
        // Valid credentials replace it; the old socket immediately loses membership.
        const previousSocket = io.sockets.sockets.get(member.socketId);
        if (previousSocket) {
          previousSocket.emit('room:session-replaced', { roomId: room.id });
          detach(previousSocket);
        }
      }
      const existing = repeat(socket, room.id);
      if (existing) return existing;
      return attach(socket, room, member, {
        sessionToken: payload.sessionToken,
        ...(member.id === room.ownerId ? { ownerToken: payload.ownerToken } : {})
      });
    });
    on('room:leave', () => { detach(socket, true); return { ok: true }; });
    on('playback:get', () => {
      const active = current(socket);
      if (!active) return failure('NOT_IN_ROOM', 'Сначала войдите в комнату.');
      return { ok: true, roomId: active.room.id, state: snapshotPlayback(active.room.playback, clock) };
    });
    for (const action of ['source', 'play', 'pause', 'seek', 'metadata']) {
      on(`playback:${action}`, payload => {
        const active = current(socket);
        if (!active) return failure('NOT_IN_ROOM', 'Сначала войдите в комнату.');
        if (active.member.id !== active.room.ownerId || !matches(payload.ownerToken, active.room.ownerHash)) return failure('FORBIDDEN', 'Управлять видео может только владелец комнаты.');
        const result = applyPlayback(active.room.playback, action, payload, clock);
        if (!result.ok) return { ...result, state: snapshotPlayback(active.room.playback, clock) };
        active.room.playback = result.playback;
        active.room.revision++;
        persist();
        const state = snapshotPlayback(active.room.playback, clock);
        io.to(channel(active.room)).emit('playback:state', { roomId: active.room.id, state });
        return { ok: true, roomId: active.room.id, state };
      });
    }
    on('room:update', payload => {
      const active = current(socket);
      if (!active) return failure('NOT_IN_ROOM', 'Сначала войдите в комнату.');
      if (active.member.id !== active.room.ownerId || !matches(payload.ownerToken, active.room.ownerHash)) {
        return failure('FORBIDDEN', 'Изменять комнату может только её владелец.');
      }
      if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(payload.title)) {
        return failure('INVALID_TITLE', 'Название должно содержать от 1 до 80 символов.');
      }
      active.room.title = payload.title.trim();
      publish(active.room);
      return { ok: true, room: snapshot(active.room) };
    });
    socket.on('disconnect', () => detach(socket));
  }
  let closed = false;
  const close = () => { if (!closed) { clearInterval(timer); persist(); store?.close(); closed = true; process.removeListener('exit', close); } };
  if (store) process.once('exit', close);
  return { register, sweep, close };
}

module.exports = { createRoomManager };
