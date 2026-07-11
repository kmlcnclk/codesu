/**
 * Tiny Web-Audio cue player — no binary assets, no network.
 *
 * Two distinct, purposeful cues:
 *   • done    — a soft rising two-note chime ("your agent finished, take a look").
 *   • blocked — an insistent triple beep ("your agent needs your input").
 *
 * Autoplay policy (notably in Tauri's WKWebView) keeps an AudioContext suspended
 * until it is created/resumed inside a real user gesture. A context first touched
 * from a timer tick therefore stays silent. So we install one-time gesture
 * listeners (see {@link installAudioUnlock}) that create and resume the shared
 * context up front; later cues from the monitor then play normally.
 * All cues are envelope-shaped to avoid clicks.
 */

let ctx: AudioContext | null = null;

/** User-facing mute switch (persisted by the caller if desired). */
export let muted = false;
export function setMuted(v: boolean) {
  muted = v;
}

function make(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

function audio(): AudioContext | null {
  const ac = make();
  if (ac && ac.state === "suspended") void ac.resume();
  return ac;
}

/**
 * Unlock audio on the first user gesture. Idempotent; the listeners remove
 * themselves once the context is running. Call once from app startup.
 */
export function installAudioUnlock() {
  if (typeof window === "undefined") return;
  const unlock = () => {
    const ac = make();
    if (!ac) return;
    void ac.resume();
    // A near-silent blip forces WKWebView to actually start the output node.
    try {
      const g = ac.createGain();
      g.gain.value = 0.0001;
      const o = ac.createOscillator();
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.02);
    } catch {
      /* ignore */
    }
    if (ac.state === "running") {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    }
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** Play one enveloped sine/triangle tone. */
function tone(
  ac: AudioContext,
  freq: number,
  startAt: number,
  duration: number,
  peak: number,
  type: OscillatorType = "sine",
) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  // Fast attack, smooth exponential release — no clicks.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.02);
}

/** Agent finished its turn — gentle, satisfying rising chime. */
export function playDone() {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 660, t, 0.16, 0.18, "sine"); // E5
  tone(ac, 988, t + 0.11, 0.28, 0.16, "sine"); // B5
}

/** Agent needs your input — urgent, attention-grabbing triple beep. */
export function playBlocked() {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  tone(ac, 523, t, 0.12, 0.2, "triangle");
  tone(ac, 523, t + 0.17, 0.12, 0.2, "triangle");
  tone(ac, 392, t + 0.34, 0.22, 0.22, "triangle");
}
