export class PlaybackSync {
  constructor({ adapter, request, now = () => performance.now(), onState = () => {}, onStatus = () => {}, onBlocked = () => {}, onError = () => {}, onMetadata = () => {}, intervalMs = 2000, diagnostics = false }) {
    Object.assign(this, { adapter, request, now, onState, onStatus, onBlocked, onError, onMetadata });
    this.state = null;
    this.samples = [];
    this.offset = null;
    this.blocked = false;
    this.destroyed = false;
    this.lastSeek = -Infinity;
    this.diagnosticsEnabled = diagnostics;
    this.corrections = 0;
    this.connected = true;
    this.calibrationAttempts = 0;
    this.diagnosticListeners = new Set();
    this.unsubscribers = [
      adapter.on('ready', () => { this.failed = false; this.buffering = false; this.onError(''); this.apply(true); this.onMetadata(); void this.refresh(); }),
      adapter.on('duration', () => this.onMetadata()),
      adapter.on('buffering', () => { this.buffering = true; onStatus('Буферизация — догоняем общий просмотр…'); }),
      adapter.on('playing', () => { this.buffering = false; this.apply(); }),
      adapter.on('ended', () => { onStatus('Видео завершено'); void this.refresh(); }),
      adapter.on('error', () => { this.failed = true; onStatus('Видео недоступно'); onError('Видео не удалось загрузить. Проверьте прямую ссылку, доступ к файлу и поддержку формата браузером.'); })
    ];
    this.timer = intervalMs > 0 ? setInterval(() => { this.apply(); void this.refresh(); }, intervalMs) : null;
  }
  accept(state, timing) {
    if (this.destroyed) return false;
    if (timing) {
      const rtt = Math.max(0, timing.receivedAt - timing.sentAt);
      this.samples.push({ rtt, offset: state.serverNow - (timing.sentAt + timing.receivedAt) / 2 });
      this.samples = this.samples.slice(-8);
      this.offset = this.samples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
    }
    if (this.state && (state.version < this.state.version || (state.version === this.state.version && (state.sourceId !== this.state.sourceId || state.serverNow < this.state.serverNow)))) {
      // The payload may be old while its round-trip clock sample is useful.
      // Apply the new clock to the latest state, never the obsolete command.
      if (timing) this.apply();
      return false;
    }
    const sourceChanged = !this.state || state.sourceId !== this.state.sourceId;
    const changed = !this.state || state.version !== this.state.version;
    this.state = state;
    this.awaitingFreshState = false;
    this.receivedAt = this.now();
    this.onState(state);
    if (sourceChanged) {
      this.failed = false;
      this.pendingPlay = null;
      this.blocked = false;
      this.onBlocked(false);
      this.onError('');
      this.adapter.load(state.source);
    }
    this.apply(changed || sourceChanged);
    return true;
  }
  targetPosition() {
    if (!this.state) return 0;
    let position = this.state.position;
    if (this.state.status === 'playing') {
      position = this.offset === null
        ? position + Math.max(0, this.now() - this.receivedAt) / 1000
        : this.state.basePosition + Math.max(0, this.now() + this.offset - this.state.updatedAt) / 1000;
    }
    return Math.max(0, Math.min(position, this.state.duration ?? this.adapter.getDuration() ?? 604800));
  }
  apply(force = false, gesture = false) {
    if (this.destroyed || !this.state?.source) { this.onStatus('Добавьте видео, чтобы начать просмотр'); return; }
    if (this.failed) { this.onStatus('Видео недоступно'); return; }
    if (!this.adapter.isReady()) { this.onStatus('Загружаем видео…'); return; }
    // Seeking repeatedly into unbuffered media can prevent buffer recovery.
    // A new explicit command still applies; canplay performs one fresh catch-up.
    if (this.buffering && this.state.status === 'playing' && !force && !gesture) {
      this.onStatus('Буферизация — догоняем общий просмотр…'); return;
    }
    const target = this.targetPosition();
    const drift = Math.abs(this.adapter.getCurrentTime() - target);
    const threshold = this.state.status === 'playing' ? 0.45 : 0.08;
    if (drift > (force ? 0.08 : threshold) && (force || this.now() - this.lastSeek > 1500)) {
      this.adapter.seek(target);
      if (this.diagnosticsEnabled) this.corrections++;
      this.lastSeek = this.now();
    }
    const duration = this.state.duration ?? this.adapter.getDuration();
    const ended = duration !== null && target >= duration;
    if (this.state.status !== 'playing' || ended) {
      this.adapter.pause();
      this.blocked = false;
      this.onBlocked(false);
      this.onStatus(ended || this.state.status === 'ended' ? 'Видео завершено' : 'Общая пауза');
      return;
    }
    if (this.blocked && !gesture) return;
    if (gesture) { this.blocked = false; this.onBlocked(false); }
    if (this.adapter.getPlaybackState() !== 'playing' && !this.pendingPlay) {
      const sourceId = this.state.sourceId;
      const pending = {};
      this.pendingPlay = pending;
      // Call play synchronously inside the gesture; never await network first.
      let play;
      try { play = this.adapter.play(); } catch (error) { play = Promise.reject(error); }
      Promise.resolve(play).then(() => {
        if (!this.destroyed && this.state.sourceId === sourceId) {
          if (this.state.status !== 'playing') this.adapter.pause();
          else if (!this.buffering) this.onStatus(this.samples.length < 3 ? 'Уточняем синхронизацию…' : 'Синхронизировано');
        }
      }).catch(error => {
        if (this.destroyed || this.state.sourceId !== sourceId || this.state.status !== 'playing') return;
        if (error.name === 'NotAllowedError') {
          this.blocked = true; this.onBlocked(true); this.onStatus('Нажмите «Начать просмотр», чтобы включить видео');
        } else if (error.name !== 'AbortError') this.onError('Не удалось начать воспроизведение. Проверьте формат и доступность видео.');
      }).finally(() => { if (this.pendingPlay === pending) this.pendingPlay = null; });
    } else if (!this.buffering) this.onStatus(this.samples.length < 3 ? 'Уточняем синхронизацию…' : 'Синхронизировано');
  }
  async refresh() {
    if (this.destroyed || this.inFlight) return;
    this.inFlight = true;
    if (this.samples.length < 3) this.calibrationAttempts++;
    const sentAt = this.now();
    let sampled = false;
    try {
      const reply = await this.request('playback:get', {});
      if (!this.destroyed && reply.ok) { this.accept(reply.state, { sentAt, receivedAt: this.now() }); sampled = true; }
    } catch { if (!this.destroyed) this.onStatus('Восстанавливаем синхронизацию…'); }
    finally {
      this.inFlight = false;
      // Diagnostics must not compete with the initial clock probes or add a
      // periodic packet immediately ahead of them in the polling write queue.
      if (sampled && this.diagnosticsEnabled && this.samples.length >= 3) {
        const metric = this.getDiagnostics();
        this.diagnosticListeners.forEach(listener => listener(metric));
      }
      // A bounded initial burst avoids waiting several periodic cycles for a
      // clean sample after join/metadata packets have drained from long-polling.
      if (!this.destroyed && this.timer && this.connected && this.samples.length < 3 && this.calibrationAttempts < 3) {
        clearTimeout(this.calibrationTimer);
        this.calibrationTimer = setTimeout(() => void this.refresh(), 100);
      }
    }
  }
  startViewing() { this.apply(true, true); void this.refresh(); }
  subscribeDiagnostics(listener) {
    if (!this.diagnosticsEnabled) return () => {};
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }
  setConnected(connected) {
    if (this.connected === connected) return;
    this.connected = connected;
    if (!this.diagnosticsEnabled) return;
    if (!connected) {
      this.disconnectedAt = this.now(); this.reconnectedAt = null;
      this.recoveryMs = null; this.resyncMs = null;
    } else {
      this.reconnectedAt = this.now(); this.awaitingFreshState = true;
    }
  }
  getDiagnostics() {
    if (!this.diagnosticsEnabled) return null;
    const position = this.adapter.getCurrentTime();
    const targetPosition = this.targetPosition();
    const drift = Math.abs(position - targetPosition);
    const playing = this.adapter.getPlaybackState() === 'playing';
    const stable = this.state?.source && this.adapter.isReady() && this.connected && !this.awaitingFreshState && !this.blocked && !this.buffering
      && drift <= 0.5 && playing === (this.state.status === 'playing' && targetPosition < (this.state.duration ?? Infinity));
    if (stable && this.reconnectedAt != null && this.resyncMs == null) {
      this.resyncMs = this.now() - this.reconnectedAt;
      this.recoveryMs = this.now() - this.disconnectedAt;
    }
    return {
      position, targetPosition, drift, sourceId: this.state?.sourceId ?? null,
      sampledAtServer: this.offset === null ? null : this.now() + this.offset,
      playing, buffering: Boolean(this.buffering), autoplayBlocked: this.blocked,
      connected: this.connected, corrections: this.corrections,
      rtt: this.samples.length ? this.samples.at(-1).rtt : null,
      bestRtt: this.samples.length ? Math.min(...this.samples.map(sample => sample.rtt)) : null,
      clockSamples: this.samples.length,
      recoveryMs: this.recoveryMs ?? null, resyncMs: this.resyncMs ?? null
    };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.timer);
    clearTimeout(this.calibrationTimer);
    this.unsubscribers.forEach(unsubscribe => unsubscribe());
    this.diagnosticListeners.clear();
    this.adapter.destroy();
  }
}
