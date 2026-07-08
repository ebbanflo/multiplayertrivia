// Retro synthesized sound effects — pure WebAudio, no asset files.
// Everything is generated from oscillators for that crunchy early-90s
// edutainment-CD feel.

let ctx = null;
let muted = localStorage.getItem('hmmm-muted') === '1';

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq = 440, type = 'square', dur = 0.12, vol = 0.16, when = 0, slide = 0 }) {
  if (muted) return;
  try {
    const a = ac();
    const t0 = a.currentTime + when;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch { /* audio is never worth crashing over */ }
}

export const sfx = {
  click()    { tone({ freq: 620, type: 'square', dur: 0.07, vol: 0.12 }); },
  hover()    { tone({ freq: 380, type: 'triangle', dur: 0.04, vol: 0.05 }); },
  join()     { tone({ freq: 392 }); tone({ freq: 523, when: 0.1 }); tone({ freq: 659, when: 0.2 }); },
  countdown(){ tone({ freq: 440, type: 'triangle', dur: 0.15, vol: 0.2 }); },
  go()       { tone({ freq: 880, type: 'square', dur: 0.25, vol: 0.2 }); },
  correct()  { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, when: i * 0.08, dur: 0.14, vol: 0.18 })); },
  wrong()    { tone({ freq: 220, type: 'sawtooth', dur: 0.35, vol: 0.16, slide: -120 }); },
  steal()    { tone({ freq: 700, type: 'square', dur: 0.1 }); tone({ freq: 500, when: 0.1, dur: 0.15, slide: -200 }); },
  tick()     { tone({ freq: 900, type: 'square', dur: 0.03, vol: 0.09 }); },
  powerup()  { [660, 880, 1320].forEach((f, i) => tone({ freq: f, type: 'triangle', when: i * 0.06, dur: 0.1, vol: 0.15 })); },
  freeze()   { tone({ freq: 1200, type: 'sine', dur: 0.5, vol: 0.15, slide: -900 }); },
  fanfare()  { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone({ freq: f, when: i * 0.12, dur: 0.2, vol: 0.2 })); },
  womp()     { [300, 260, 220, 150].forEach((f, i) => tone({ freq: f, type: 'sawtooth', when: i * 0.18, dur: 0.22, vol: 0.14 })); },
};

export function isMuted() { return muted; }
export function toggleMute() {
  muted = !muted;
  localStorage.setItem('hmmm-muted', muted ? '1' : '0');
  return muted;
}
