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

export const QUESTIONS_PER_ROUND = 10;
export const COUNTDOWN_MS = 3000;      // 3..2..1 lead-in before answers unlock
export const REVEAL_MS = 3200;         // pause on the answer reveal
export const RESOLVE_GRACE_MS = 350;   // wait for a competing answer before declaring a winner

export const SCORE_BASE = 100;         // points for a correct answer
export const SCORE_SPEED_MAX = 100;    // max speed bonus
export const SCORE_WRONG = -50;        // penalty for a wrong answer

export const POWERUPS = {
  fifty:    { name: '50/50',       icon: '➗', cost: 75,  desc: 'Zap away two wrong answers' },
  freeze:   { name: 'FREEZE',      icon: '🧊', cost: 100, desc: 'Freeze your opponent for 5s' },
  timewarp: { name: 'TIME WARP',   icon: '⏰', cost: 75,  desc: '+15 seconds on YOUR clock' },
  shield:   { name: 'SHIELD',      icon: '🛡️', cost: 75,  desc: 'No penalty on your next miss' },
  double:   { name: 'DOUBLE DOWN', icon: '✖️', cost: 100, desc: '2x points on your next correct answer' },
};
export const FREEZE_MS = 5000;
export const TIMEWARP_MS = 15000;
