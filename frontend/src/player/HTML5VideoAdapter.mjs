// The synchronizer uses this interface; it never accesses HTMLVideoElement.
export class HTML5VideoAdapter {
  constructor(video) {
    this.video = video;
    this.listeners = new Map();
    this.bindings = [];
    for (const [domEvent, event] of Object.entries({ loadedmetadata: 'ready', canplay: 'ready', waiting: 'buffering', playing: 'playing', ended: 'ended', error: 'error', durationchange: 'duration' })) {
      const listener = () => this.emit(event);
      video.addEventListener(domEvent, listener);
      this.bindings.push([domEvent, listener]);
    }
  }
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
    return () => this.listeners.get(event)?.delete(listener);
  }
  emit(event) { this.listeners.get(event)?.forEach(listener => listener()); }
  load(source) {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (source?.type === 'html5') { this.video.src = source.url; this.video.load(); }
  }
  play() { return this.video.play(); }
  pause() { this.video.pause(); }
  seek(time) {
    if (!Number.isFinite(time) || time < 0 || !this.isReady()) return;
    const duration = this.getDuration();
    this.video.currentTime = duration === null ? time : Math.min(time, duration);
  }
  getCurrentTime() { return this.video.currentTime; }
  getDuration() { return Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : null; }
  getPlaybackState() { return this.video.ended ? 'ended' : this.video.paused ? 'paused' : 'playing'; }
  isReady() { return this.video.readyState >= 1; }
  destroy() {
    for (const [event, listener] of this.bindings) this.video.removeEventListener(event, listener);
    this.listeners.clear();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
}
