// HMMM? configuration.
// The publishable key is safe to ship in a static site; it only grants
// access allowed by the Supabase project's policies (we use realtime
// broadcast/presence channels only — no database tables).
export const SUPABASE_URL = 'https://lapkrvmlmwfrwqmzxukt.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_M9Xu80-XQ1Vyjg55T-Cp8g_2EnL2_Mm';

const params = new URLSearchParams(location.search);

// ?t=local switches to a same-browser BroadcastChannel transport,
// used for automated tests and offline demos (both players must be
// tabs of the same browser).
export const TRANSPORT = params.get('t') === 'local' ? 'local' : 'supabase';

// ?debug=1 exposes engine internals on window.__HMMM for tests.
export const DEBUG = params.get('debug') === '1';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789'; // no O/0/I
export const CODE_LENGTH = 4;

export const MAX_PLAYERS = 4;
export const QUESTIONS_PER_ROUND = 10;

// Royale mode: endless elimination. Everyone starts with a stack, antes
// into a pot every question, and the question winner takes the pot.
// Hit 0 and you're out — last one standing wins.
// (?rstart=N with debug lets tests start with a small stack.)
const rstart = params.get('rstart');
export const ROYALE_START = (DEBUG && rstart) ? parseInt(rstart, 10) : 1000;
export const ROYALE_ANTE = 25;
export const COUNTDOWN_MS = 3000;      // 3..2..1 lead-in before answers unlock
export const REVEAL_MS = 3200;         // pause on the answer reveal
export const RESOLVE_GRACE_MS = 350;   // wait for a competing answer before declaring a winner

export const SCORE_BASE = 100;         // points for a correct answer
export const SCORE_SPEED_MAX = 100;    // max speed bonus
export const SCORE_WRONG = -50;        // penalty for a wrong answer

export const POWERUPS = {
  fifty:    { name: '50/50',       icon: '➗', cost: 75,  desc: 'Zap away two wrong answers' },
  freeze:   { name: 'FREEZE',      icon: '🧊', cost: 100, desc: 'Freeze ALL opponents for 5s' },
  timewarp: { name: 'TIME WARP',   icon: '⏰', cost: 75,  desc: '+15 seconds on YOUR clock' },
  double:   { name: 'DOUBLE DOWN', icon: '✖️', cost: 100, desc: '2x points on your next correct answer' },
  duel:     { name: 'DUEL', icon: '⚔️', cost: 0, costLabel: '0-200',
              desc: 'Challenge a foe: alternating solo questions, first miss pays the stake' },
  revive:   { name: 'REVIVE', icon: '💚', cost: 200,
              desc: 'Answer one untimed question to bring a fallen teammate back with 2 lives' },
};

// Which power-ups appear in the shop, per mode (solo has no shop).
export const MODE_POWERUPS = {
  classic: ['fifty', 'freeze', 'timewarp', 'double'],
  royale:  ['fifty', 'freeze', 'timewarp', 'double', 'duel'],
  coop:    ['fifty', 'double', 'revive'],
  solo:    [],
};

export const COOP_LIVES = 3;
export const COOP_REVIVE_LIVES = 2;
export const REVIVE_PICK_MS = 15000; // auto-pick if the buyer dawdles
export const FREEZE_MS = 5000;
export const TIMEWARP_MS = 15000;

export const SOLO_LIVES = 3;
export const DUEL_MAX_STAKE = 200;
export const GHOST_SHOT_MS = 8000;    // window for the fallen to attempt a revival
export const GHOST_REVIVE_POINTS = 100;
