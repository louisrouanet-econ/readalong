// Phones: read with the device's own voice (speechSynthesis) instead of the Kokoro model, which needs more memory
// than Safari gives a tab on an iPhone. Same interface and times as Player, so the app works unchanged: each passage
// gets estimated word times (like the voiced ones), and the "word boundary" events of the device voice move a clock
// through them, so the highlight follows the voice. Times are estimates, so the timeline is approximate.
import { Player } from "./player.js";

const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
export const deviceVoiceAvailable = () => !!synth;

/** The best English voice on the device: an enhanced or premium one if it was downloaded, an on-device one if possible. */
function pickVoice() {
  const all = synth.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
  const score = (v) => (/premium/i.test(v.name) ? 40 : /enhanced|neural|natural/i.test(v.name) ? 30 : 0) +
    (/^en[-_]us/i.test(v.lang) ? 10 : /^en[-_]gb/i.test(v.lang) ? 6 : 0) + (v.localService ? 5 : 0) + (v.default ? 2 : 0) +
    (/samantha|ava|allison|susan|zoe|daniel|karen|moira/i.test(v.name) ? 3 : 0) -
    (/eloquence|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|kathy|ralph|grandma|grandpa|flo|reed|rocko|sandy|shelley|eddy/i.test(v.name) ? 100 : 0);
  return all.sort((a, b) => score(b) - score(a))[0] || null;
}

export class DeviceVoicePlayer extends Player {
  constructor() {
    super();
    this.plan = [];
    this.recs = [];      // per passage: {wids, s, e, dur, first[]}, word times estimated from the text
    this.u = null;       // the utterance being spoken
    this.timer = 0;      // pause before a passage
    this.clock = null;   // {base, at, k}: chunk time at the last word boundary
    this.heard = false;  // the voice sends word boundaries (some voices do not)
    this.voice = null;
    if (synth) {
      const load = () => { this.voice = pickVoice(); };
      load();
      synth.addEventListener?.("voiceschanged", load);
      // like <audio>, speech must first be started from a tap on iPhone: say nothing, silently, on the first tap
      const unlock = () => {
        for (const ev of ["touchend", "click", "keydown"]) document.removeEventListener(ev, unlock, true);
        try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch { /* ignore */ }
      };
      for (const ev of ["touchend", "click", "keydown"]) document.addEventListener(ev, unlock, true);
    }
  }

  /** The reading's passages; estimates must be those given to setup() so times agree with the timeline. */
  usePlan(plan, estimates) {
    this.plan = plan;
    this.recs = plan.map((c, ci) => {
      const dur = estimates[ci], say = c.say || "", L = Math.max(1, say.length);
      const body = Math.max(0.1, dur - c.pause);
      const wids = [], s = [], e = [], first = [];
      (c.cs || []).forEach((a, j) => {
        const b = j + 1 < c.cs.length ? c.cs[j + 1] : L;
        const t0 = c.pause + (body * a) / L, t1 = c.pause + (body * b) / L;
        const w = c.spans[j][0];
        first.push(wids.length);
        w.forEach((wid, k) => { wids.push(wid); s.push(t0 + ((t1 - t0) * k) / w.length); e.push(t0 + ((t1 - t0) * (k + 1)) / w.length); });
      });
      return { wids: Int32Array.from(wids), s: Float32Array.from(s), e: Float32Array.from(e), dur, first };
    });
  }

  get chunkTime() {
    const rec = this.recs[this.ci];
    if (!this.clock || !rec) return this.pendingSeek;
    let t = this.clock.base + ((performance.now() - this.clock.at) / 1000) * this.rate;
    // never run ahead of the voice: wait at the next word until its boundary arrives
    if (this.heard && this.clock.k >= 0) {
      const next = this.clock.k + 1 < rec.first.length ? rec.s[rec.first[this.clock.k + 1]] : rec.dur;
      t = Math.min(t, next - 0.02);
    }
    return Math.max(0, Math.min(t, rec.dur));
  }

  setRate(r) {
    this.rate = r;
    if (this.u) { const t = this.chunkTime; this.silence(); this.pendingSeek = t; this.speakFrom(this.ci, t); }
  }
  stop() { this.want = false; this.silence(); this.clock = null; }
  silence() {
    clearTimeout(this.timer); this.timer = 0;
    this.u = null;
    if (synth) synth.cancel();
  }

  async seekChunk(ci, t = 0) {
    this.silence();
    this.ci = Math.max(0, Math.min(this.n - 1, ci));
    this.pendingSeek = t;
    this.clock = null;
    if (this.want) this.speakFrom(this.ci, t);
    this.dispatchEvent(new Event("seek"));
  }
  play() {
    this.want = true;
    if (!this.u && !this.timer) this.speakFrom(this.ci, this.pendingSeek);
    this.dispatchEvent(new Event("state"));
  }
  pause() {
    const t = this.chunkTime;
    this.want = false;
    this.silence();
    this.pendingSeek = t; this.clock = null;
    this.dispatchEvent(new Event("state"));
  }
  async resume() { if (this.want && !this.u && !this.timer) this.speakFrom(this.ci, this.pendingSeek); }
  chunkReady() { /* nothing is voiced ahead */ }
  preloadNext() {}

  /** Speak passage ci from time t (seconds into it): from the word at t, after the passage's pause if t is 0. */
  speakFrom(ci, t) {
    const c = this.plan[ci], rec = this.recs[ci];
    if (!synth || !c || !rec) return;
    let j = 0;
    while (j + 1 < rec.first.length && rec.s[rec.first[j + 1]] <= t + 0.01) j++;
    const start = rec.first.length ? Math.max(t, rec.s[rec.first[j]] || 0) : t;
    const offset = c.cs && c.cs.length ? c.cs[j] : 0;
    const text = (c.say || "").slice(offset);
    this.clock = { base: start, at: performance.now(), k: rec.first.length ? j : -1 };
    if (!text.trim()) { this.timer = setTimeout(() => { this.timer = 0; this.next(); }, 50); return; }
    const say = () => {
      this.timer = 0;
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = "en-US";
      u.rate = Math.max(0.5, Math.min(2, this.rate));
      u.onstart = () => { if (this.u === u) this.clock = { base: rec.s[rec.first[j]] ?? start, at: performance.now(), k: this.clock.k }; };
      u.onboundary = (e) => {
        if (this.u !== u || (e.name && e.name !== "word")) return;
        const at = offset + e.charIndex;
        let k = j;
        while (k + 1 < c.cs.length && c.cs[k + 1] <= at) k++;
        this.heard = true;
        this.clock = { base: rec.s[rec.first[k]], at: performance.now(), k };
      };
      u.onend = () => { if (this.u === u) { this.u = null; this.next(); } };
      u.onerror = (e) => {
        if (this.u !== u || e.error === "interrupted" || e.error === "canceled") return;
        this.u = null; this.want = false; this.dispatchEvent(new Event("state"));
      };
      this.u = u;
      synth.speak(u);
    };
    // the pause before a passage (paragraph, heading) only when it starts from the top
    const wait = t < 0.05 ? (c.pause / this.rate) * 1000 : 0;
    if (wait > 30) this.timer = setTimeout(say, wait); else say();
  }
  next() {
    if (!this.want) return;
    if (this.ci + 1 >= this.n) { this.want = false; this.clock = null; this.dispatchEvent(new Event("ended")); this.dispatchEvent(new Event("state")); return; }
    this.ci += 1;
    this.pendingSeek = 0;
    this.speakFrom(this.ci, 0);
    this.dispatchEvent(new Event("chunk"));
  }
}
