// Plays a reading as a sequence of voiced passages ("chunks") that may still be in production.
// Two <audio> elements alternate so the next passage is ready the moment one ends; <audio> keeps the
// pitch natural when the speed changes. Times are global (seconds from the start of the reading).
export class Player extends EventTarget {
  constructor() {
    super();
    this.els = [new Audio(), new Audio()];
    for (const el of this.els) {
      el.preload = "auto";
      el.preservesPitch = true;
      el.addEventListener("ended", () => this.onEnded(el));
    }
    this.cur = 0;            // index into els
    this.ci = 0;             // current chunk
    this.n = 0;
    this.durs = [];          // known or estimated duration per chunk
    this.known = [];         // true when the real duration is known
    this.offsets = [0];
    this.urlFor = async () => null; // (ci) -> object URL or null if not voiced yet
    this.want = false;       // user wants playback
    this.waiting = false;
    this.rate = 1;
    this.loadedCi = [-1, -1];
    this.pendingSeek = 0;
  }
  get el() { return this.els[this.cur]; }
  get other() { return this.els[1 - this.cur]; }

  setup(n, estimates, urlFor) {
    this.stop();
    this.n = n;
    this.durs = estimates.slice();
    this.known = new Array(n).fill(false);
    this.urlFor = urlFor;
    this.recompute();
    this.ci = 0;
    this.pendingSeek = 0;
  }
  stop() {
    this.want = false;
    for (const el of this.els) { el.pause(); el.removeAttribute("src"); el.load(); }
    this.loadedCi = [-1, -1];
  }
  recompute() {
    this.offsets = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) this.offsets[i + 1] = this.offsets[i] + this.durs[i];
  }
  setDuration(ci, d) {
    if (this.known[ci] && Math.abs(this.durs[ci] - d) < 1e-3) return;
    this.durs[ci] = d;
    this.known[ci] = true;
    this.recompute();
  }
  get duration() { return this.offsets[this.n] || 0; }
  get playing() { return this.want && !this.waiting; }
  get chunkTime() { return this.loadedCi[this.cur] === this.ci ? this.el.currentTime : this.pendingSeek; }
  get currentTime() { return this.offsets[this.ci] + this.chunkTime; }
  setRate(r) { this.rate = r; for (const el of this.els) el.playbackRate = r; }

  chunkAt(t) {
    let lo = 0, hi = this.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.offsets[m] <= t) lo = m; else hi = m - 1; }
    return lo;
  }

  async load(el, ci) {
    const url = await this.urlFor(ci);
    if (!url) return false;
    const idx = this.els.indexOf(el);
    if (this.loadedCi[idx] !== ci) {
      el.src = url;
      el.playbackRate = this.rate;
      this.loadedCi[idx] = ci;
    }
    return true;
  }

  /** Jump to chunk ci at local time t (seconds into that chunk). */
  async seekChunk(ci, t = 0) {
    this.ci = Math.max(0, Math.min(this.n - 1, ci));
    this.pendingSeek = t;
    const el = this.el;
    if (this.loadedCi[this.cur] === this.ci) { el.currentTime = t; if (this.want) this.resume(); }
    else {
      el.pause();
      if (await this.load(el, this.ci)) {
        await once(el, "loadedmetadata");
        el.currentTime = this.pendingSeek;
        if (this.want) this.resume();
      } else this.setWaiting(this.want);
    }
    this.dispatchEvent(new Event("seek"));
  }
  seek(t) { const ci = this.chunkAt(t); return this.seekChunk(ci, Math.max(0, t - this.offsets[ci])); }

  play() { this.want = true; this.resume(); this.dispatchEvent(new Event("state")); }
  pause() { this.want = false; this.el.pause(); this.setWaiting(false); this.dispatchEvent(new Event("state")); }
  toggle() { this.want ? this.pause() : this.play(); }

  async resume() {
    if (!this.want) return;
    const el = this.el;
    if (this.loadedCi[this.cur] !== this.ci) {
      if (!(await this.load(el, this.ci))) { this.setWaiting(true); return; }
      await once(el, "loadedmetadata");
      el.currentTime = this.pendingSeek;
    }
    this.setWaiting(false);
    try { await el.play(); } catch (e) { if (e.name !== "AbortError") { this.want = false; this.dispatchEvent(new Event("state")); } }
    this.preloadNext();
  }
  async preloadNext() {
    if (this.ci + 1 < this.n) await this.load(this.other, this.ci + 1);
  }
  setWaiting(w) {
    if (this.waiting !== w) { this.waiting = w; this.dispatchEvent(new Event("state")); }
  }
  /** Called by the app when a chunk has just been voiced. */
  chunkReady(ci) {
    if (this.want && this.waiting && ci === this.ci) this.resume();
    else if (ci === this.ci + 1 && this.want) this.preloadNext();
  }
  async onEnded(el) {
    if (el !== this.el) return;
    if (this.ci + 1 >= this.n) { this.want = false; this.dispatchEvent(new Event("ended")); this.dispatchEvent(new Event("state")); return; }
    this.ci += 1;
    this.pendingSeek = 0;
    if (this.loadedCi[1 - this.cur] === this.ci) {
      this.cur = 1 - this.cur;
      this.el.currentTime = 0;
      this.el.playbackRate = this.rate;
      try { await this.el.play(); } catch { /* ignore */ }
      this.preloadNext();
    } else {
      this.cur = 1 - this.cur;
      this.resume();
    }
    this.dispatchEvent(new Event("chunk"));
  }
}

function once(el, ev) {
  if (ev === "loadedmetadata" && el.readyState >= 1) return Promise.resolve();
  return new Promise((r) => el.addEventListener(ev, r, { once: true }));
}
