// Front-desk feedback shared by the circulation desk and the self-checkout kiosk: short WebAudio tones that
// tell a librarian (who is looking at the book, not the screen) what just happened, behind a remembered mute
// switch. Tones are distinct by pitch *and* rhythm, never the only signal (the screen always says the same).
//
//   import { tone, soundOn, setSound } from "/static/js/pages/lib/desk-feedback.js";
//   tone("ok") · tone("warn") · tone("error") · tone("hold") · tone("done") · tone("info")

const KEY = "sw-desk-prefs";

function read(key = KEY) {
  try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
}
function write(prefs, key = KEY) {
  try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* private mode: keep in memory */ }
}

const prefs = read();
export const deskPrefs = prefs;
export function savePrefs(patch) { Object.assign(prefs, patch); write(prefs); }

export const soundOn = () => prefs.sound !== false;
export function setSound(on) { savePrefs({ sound: !!on }); }

// [frequency Hz, duration s] steps; type per kind.
const TONES = {
  ok: { wave: "sine", gain: 0.18, steps: [[880, 0.07], [1320, 0.1]] },
  info: { wave: "sine", gain: 0.14, steps: [[660, 0.08]] },
  warn: { wave: "triangle", gain: 0.2, steps: [[740, 0.1], [740, 0.1]] },
  error: { wave: "square", gain: 0.09, steps: [[220, 0.18], [165, 0.28]] },
  hold: { wave: "sine", gain: 0.2, steps: [[587, 0.1], [784, 0.1], [988, 0.1], [1175, 0.18]] },
  done: { wave: "sine", gain: 0.18, steps: [[660, 0.08], [880, 0.08], [1320, 0.14]] },
};

let ctx = null;
/** Play the feedback tone for `kind`. `force` plays even when muted (used to preview the switch). */
export function tone(kind, { force = false, enabled = soundOn() } = {}) {
  if (!enabled && !force) return;
  // Browsers only allow audio after the user has interacted with the page; don't even try before that.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  const spec = TONES[kind] || TONES.info;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    let at = ctx.currentTime + 0.01;
    for (const [freq, dur] of spec.steps) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = spec.wave;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(spec.gain, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + dur + 0.02);
      at += dur + 0.035;
    }
  } catch { /* no audio device / blocked: the visual feedback still says everything */ }
}

/** Briefly tint `el` (the scan card) with the outcome colour; respects reduced motion via CSS. */
export function flash(el, kind) {
  if (!el) return;
  el.classList.remove("flash-ok", "flash-warn", "flash-error", "flash-hold");
  void el.offsetWidth; // restart the animation
  el.classList.add(`flash-${kind}`);
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => el.classList.remove(`flash-${kind}`), 900);
}
