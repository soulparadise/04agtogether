import { io } from 'socket.io-client';
import { samePage, validatePair, publicPlaybackReply } from './security.mjs';

export class RoomConnection {
  static async createOwner({ origin, nickname, pageURL, title, initial = {} }, send) {
    const socket = io(origin, { transports: ['polling'], upgrade: false, forceNew: true, autoConnect: false });
    const request = (event, payload) => socket.timeout(7000).emitWithAck(event, payload);
    try {
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', () => reject(new Error('04agtogether недоступен. Проверьте соединение с приложением.'))); socket.connect(); });
      const created = await request('room:create', { nickname });
      if (!created.ok) throw new Error(created.error.message);
      const source = await request('playback:source', { mode: 'extension', url: pageURL, expectedVersion: created.room.playback.version, ownerToken: created.ownerToken });
      if (!source.ok) throw new Error(source.error.message);
      await request('room:update', { title: String(title || new URL(pageURL).hostname).trim().slice(0, 80), ownerToken: created.ownerToken });
      const pair = { origin, roomId: created.room.id, participantId: created.participantId, sessionToken: created.sessionToken, ownerToken: created.ownerToken };
      socket.disconnect();
      const connection = new RoomConnection(pair); connection.start();
      try {
        await connection.whenReady();
        // Keep the position the owner was watching before creating the room.
        const frame = { tabId: -1, frameId: 0, pageURL }; connection.bind(frame);
        if (initial.selection) await connection.select(initial.selection);
        if (Number.isFinite(initial.duration) && initial.duration > 0) await connection.content(frame, { type: 'intent', action: 'metadata', duration: initial.duration });
        await connection.content(frame, { type: 'intent', action: initial.playing ? 'play' : 'seek', position: Number.isFinite(initial.position) ? initial.position : 0 });
        connection.binding = null;
        connection.send = send || (() => {});
        return connection;
      } catch (error) { connection.disconnect(); throw error; }
    } finally { socket.disconnect(); }
  }
  constructor(pair, send = () => {}) {
    this.pair = validatePair(pair); this.send = send; this.connected = false; this.queue = Promise.resolve();
    this.socket = io(pair.origin, { transports: ['polling'], upgrade: false, autoConnect: false, forceNew: true });
    this.socket.on('connect', () => void this.resume());
    this.socket.on('disconnect', () => { this.resumeAttempt = (this.resumeAttempt || 0) + 1; this.connected = false; this.deliver({ type: 'connection', connected: false }); });
    this.socket.on('connect_error', () => { this.connected = false; this.error = 'Нет связи с 04agtogether — переподключаемся…'; this.deliver({ type: 'connection', connected: false }); });
    this.socket.on('playback:state', ({ roomId, state }) => { if (roomId === pair.roomId) this.accept(state); });
    this.socket.on('room:state', room => { if (room.id === pair.roomId) { this.room = room; this.title = room.title; this.accept(room.playback); } });
    this.socket.on('room:session-replaced', () => { this.error = 'Сессия продолжена в другой вкладке. Свяжите расширение с комнатой заново.'; this.disconnect(); });
  }
  request(event, payload) { return this.socket.timeout(7000).emitWithAck(event, payload); }
  async resume() {
    clearTimeout(this.resumeTimer);
    const attempt = this.resumeAttempt = (this.resumeAttempt || 0) + 1, socketId = this.socket.id;
    try {
      const reply = await this.request('room:resume', { roomId: this.pair.roomId, participantId: this.pair.participantId, sessionToken: this.pair.sessionToken, ...(this.pair.ownerToken ? { ownerToken: this.pair.ownerToken } : {}) });
      if (attempt !== this.resumeAttempt || !this.socket.connected || socketId !== this.socket.id) return;
      if (!reply.ok) { this.error = reply.error.message; this.disconnect(); return; }
      this.owner = reply.room.ownerId === this.pair.participantId;
      this.room = reply.room; this.title = reply.room.title; this.connected = true; this.error = '';
      this.deliver({ type: 'connection', connected: true }); this.accept(reply.room.playback);
    } catch {
      if (attempt !== this.resumeAttempt) return;
      this.error = 'Нет ответа сервера — восстанавливаем связь с комнатой…';
      clearTimeout(this.resumeTimer);
      if (this.socket.connected) this.resumeTimer = setTimeout(() => void this.resume(), 2000);
    }
  }
  start() { this.socket.connect(); }
  async whenReady() {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this.connected) return;
      if (this.error && !this.socket.active) throw new Error(this.error);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Не удалось подключиться к комнате. Проверьте приложение 04agtogether.');
  }
  accept(state) {
    if (!this.state || state.version > this.state.version || (state.version === this.state.version && state.serverNow >= this.state.serverNow)) this.state = state;
    this.deliver({ type: 'state', state: this.state });
  }
  deliver(message) { if (this.binding) this.send(this.binding, { ...message, owner: Boolean(this.owner) }); }
  async select(selection) {
    if (!this.owner || !this.connected) return { ok: false };
    const pageURL = this.state.source?.url;
    const revision = this.selectionRevision = (this.selectionRevision || 0) + 1;
    const task = this.queue.then(async () => {
      if (!this.connected || revision !== this.selectionRevision || !samePage(pageURL, this.state.source?.url)) return { ok: false };
      const current = this.state.source?.selection;
      if (JSON.stringify({ player: current?.player, voice: current?.voice }) === JSON.stringify(selection)) return { ok: true, state: this.state };
      const sourceId = this.state.sourceId;
      const reply = await this.request('playback:selection', { selection, sourceId, expectedVersion: this.state.version, ownerToken: this.pair.ownerToken });
      if (reply.state) this.accept(reply.state); return publicPlaybackReply(reply);
    });
    this.queue = task.catch(() => {}); return task;
  }
  bind(binding) {
    if (!this.connected || this.state?.source?.type !== 'extension') throw new Error('В комнате выберите режим Extension и страницу видео.');
    if (!samePage(binding.pageURL, this.state.source.url)) throw new Error('Откройте именно страницу видео, выбранную владельцем комнаты.');
    this.deliver({ type: 'stop', pause: true }); this.binding = binding; this.videoStatus = 'Ищем HTML5-видео…'; this.error = '';
  }
  permitted(sender) { return this.binding && sender.tabId === this.binding.tabId && sender.frameId === this.binding.frameId && samePage(sender.pageURL, this.binding.pageURL); }
  async content(sender, message) {
    if (!this.permitted(sender)) return { ok: false, error: { message: 'Эта вкладка/рамка не подключена к комнате.' } };
    if (!samePage(this.binding.pageURL, this.state?.source?.url) || this.state.source.type !== 'extension') return { ok: false, error: { message: 'Источник в комнате изменился. Отключите плеер и откройте новую страницу.' } };
    if (message.type === 'attach') return { ok: true, state: this.state, connected: this.connected, owner: this.owner };
    if (message.type === 'status') { this.videoStatus = String(message.status || '').slice(0, 160); return { ok: true }; }
    if (message.type === 'selection') return this.select(message.selection);
    if (!this.connected) return { ok: false, error: { message: 'Нет соединения с комнатой.' } };
    if (message.type === 'get') {
      const reply = await this.request('playback:get', {}); if (reply.state) this.accept(reply.state);
      return publicPlaybackReply(reply);
    }
    if (message.type !== 'intent' || !this.owner) return { ok: false, error: { message: 'Общим состоянием управляет только владелец.' } };
    if (message.sourceId !== undefined && message.sourceId !== this.state.sourceId) return { ok: false };
    if (!['play', 'pause', 'seek', 'metadata'].includes(message.action)) return { ok: false, error: { message: 'Неизвестная команда.' } };
    const sourceId = this.state.sourceId;
    const task = this.queue.then(async () => {
      if (!this.connected || sourceId !== this.state.sourceId || !this.permitted(sender)) return { ok: false };
      const command = async (action, extra) => {
        const reply = await this.request(`playback:${action}`, { ...extra, sourceId, expectedVersion: this.state.version, ownerToken: this.pair.ownerToken });
        if (reply.state) this.accept(reply.state); return publicPlaybackReply(reply);
      };
      if (message.action === 'metadata') return command('metadata', { duration: message.duration });
      const position = Number(message.position);
      if (!Number.isFinite(position) || position < 0 || position > 604800) return { ok: false };
      if (message.action === 'pause') {
        const paused = await command('pause', {});
        return paused.ok ? command('seek', { position }) : paused;
      }
      const sought = await command('seek', { position });
      if (!sought.ok || message.action === 'seek') return sought;
      return command(message.action, {});
    });
    this.queue = task.catch(() => {}); return task;
  }
  status() { return { roomId: this.pair.roomId, appOrigin: this.pair.origin, invitation: `${this.pair.origin}/room/${this.pair.roomId}`, title: this.title || '', connected: this.connected, owner: Boolean(this.owner), player: this.videoStatus || 'Ожидаем плеер…', error: this.error || '', bound: Boolean(this.binding), room: this.room ? { ...this.room, playback: this.state } : null, participantId: this.pair.participantId }; }
  async configureAccess(settings) {
    if (!this.owner || !this.connected) return { ok: false, error: { message: 'Нужны права владельца и связь с комнатой.' } };
    const app = new URL(this.pair.origin);
    if (app.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(app.hostname)) throw new Error('Пароль можно передавать только через HTTPS.');
    const response = await fetch(this.pair.origin + '/api/rooms/access', { method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, ...this.pair }) });
    const reply = await response.json();
    if (reply.ok) { this.room = reply.room; this.accept(reply.room.playback); }
    return reply;
  }
  async setSource(options) {
    if (!this.owner || !this.connected) return { ok: false, error: { message: 'Источник меняет только владелец.' } };
    const task = this.queue.then(async () => {
      const reply = await this.request('playback:source', { ...options, expectedVersion: this.state.version, ownerToken: this.pair.ownerToken });
      if (reply.state) this.accept(reply.state);
      return publicPlaybackReply(reply);
    });
    this.queue = task.catch(() => {}); return task;
  }
  disconnect() { clearTimeout(this.resumeTimer); this.connected = false; this.deliver({ type: 'stop' }); this.binding = null; this.socket.disconnect(); }
}
