import { HTML5VideoAdapter } from '../../frontend/src/player/HTML5VideoAdapter.mjs';

// Same PlaybackSync interface; never replaces a site's URL, reloads or clears it.
export class ForeignVideoAdapter extends HTML5VideoAdapter {
  constructor(video, now = () => performance.now()) { super(video); this.now = now; this.expected = new Map(); this.intentPending = 0; }
  load() {}
  isSeeking() { return Boolean(this.video.seeking); }
  canCorrectTo(time) {
    // Do not discard the site's recovered HLS buffer for periodic correction.
    // Explicit room seeks still apply immediately.
    const ranges = this.video.buffered;
    if (!ranges) return true;
    for (let i = 0; i < ranges.length; i++) if (time >= ranges.start(i) && time < ranges.end(i) - 0.1) return true;
    return false;
  }
  mark(event, position) { this.expected.set(event, { until: this.now() + 2000, position }); }
  consume(event) {
    const expected = this.expected.get(event);
    if (!expected || expected.until < this.now()) { this.expected.delete(event); return false; }
    if (event === 'seeked' && Math.abs(this.getCurrentTime() - expected.position) > 0.5) return false;
    this.expected.delete(event); return true;
  }
  play() {
    if (this.intentPending) return Promise.resolve();
    if (this.video.paused) this.mark('play');
    return super.play();
  }
  pause() { if (!this.intentPending && !this.video.paused) { this.mark('pause'); super.pause(); } }
  seek(time) {
    if (this.intentPending || !this.isReady() || !Number.isFinite(time)) return;
    const target = Math.max(0, Math.min(time, this.getDuration() ?? time));
    if (Math.abs(this.getCurrentTime() - target) < 0.01) return;
    this.mark('seeked', target); super.seek(target);
  }
  destroy() {
    for (const [event, listener] of this.bindings) this.video.removeEventListener(event, listener);
    this.listeners.clear(); this.expected.clear();
  }
}
