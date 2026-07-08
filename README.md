# HMMM? 🤔

**A real-time 2-4 player trivia battle royale** with claymation-era 90s vibes.
Share a 4-character room code, race your opponents to the right answer, and
spend your points on dirty tricks.

![status](https://img.shields.io/badge/players-2--4-ff4fa3) ![style](https://img.shields.io/badge/style-claymation-7b5be6) ![stack](https://img.shields.io/badge/stack-static%20%2B%20supabase-23c4b2)

## How to play

1. One player clicks **HOST GAME** and gets a room code (like `U2A1`).
2. Everyone else (1-3 opponents) clicks **JOIN GAME** and types the code —
   works across phones, laptops, whatever. When anyone answers, you'll see
   exactly which option they picked, stamped live on your screen in their
   color.
3. The host picks the settings and hits **START BATTLE!**

### Rules — lock-out duel

- All players see the **same question** at the same time. 10 questions per round.
- **First correct answer wins the question**: 100 points + a speed bonus (up to +100).
- **Wrong answer: −50 points and you're locked out** — but everyone else can
  still steal, so speed *and* accuracy matter. Watching rivals eliminate
  answers for you (or lying in wait while they burn themselves) is a
  strategy of its own.
- Most points at the end of the final round wins.

### Royale mode 👑

An endless, elimination-based alternative to the classic match:

- Everyone starts with **1000 points**; every question, each survivor
  **antes 25 into a pot** and the question winner **takes the pot**
  (nobody right? it rolls over and grows). Wrong answers still cost 50.
- **Hit 0 and you're eliminated** — you stay and spectate. The **last
  player standing wins**. Hiding just bleeds you out through the antes.
- The **ramp dial (1-5)** sets the difficulty arc: 1 stays on one fixed
  difficulty of your choice, 2 ramps slowly, 3 is the normal ramp,
  4 ramps but ~40% of questions go rogue, 5 is pure chaos.
- Power-ups all work — costs come out of your survival stack, and
  Double Down doubles the pot you take.

### Settings (chosen by the host)

| Setting | Options |
|---|---|
| Mode | Classic · **Royale ∞** |
| Difficulty (classic) | Easy · Medium · Hard · **Ramp Up!** (easy → hard across the game) |
| Ramp dial (royale) | 1 static · 2 slow · 3 ramp · 4 wobbly · 5 chaos |
| Timer | 30 sec · 1 min · No timer (classic only — Royale needs a clock) |
| Rounds (classic) | 1 · 2 · 3 · 5 (10 questions each) |

### Power-ups 🛒

Buy these mid-question with your points:

| | Power-up | Cost | Effect |
|---|---|---|---|
| ➗ | 50/50 | 75 | Zap away two wrong answers |
| 🧊 | Freeze | 100 | ALL your opponents can't answer for 5 seconds |
| ⏰ | Time Warp | 75 | +15 seconds on *your* clock |
| 🛡️ | Shield | 75 | No penalty on your next miss |
| ✖️ | Double Down | 100 | 2× points on your next correct answer |

## Hosting on GitHub Pages

The game is a fully static site — no build step, no server of your own.

1. Merge this branch into your default branch (or point Pages straight at it).
2. Repo **Settings → Pages → Source: Deploy from a branch**, pick the branch
   and `/ (root)`, save.
3. Play at `https://<username>.github.io/multiplayertrivia/`.

## How it works

- **Realtime**: [Supabase Realtime](https://supabase.com/docs/guides/realtime)
  broadcast + presence channels — one channel per room code. No database
  tables, no accounts; the publishable key in `js/config.js` is safe to ship.
- **Authority**: the host's browser referees the match — it fetches the
  questions, arbitrates who answered first (by reaction time, with a grace
  window so network lag doesn't decide photo finishes), keeps score, and
  validates power-up purchases.
- **Questions**: pulled from two public APIs at once —
  [Open Trivia DB](https://opentdb.com) and
  [The Trivia API](https://the-trivia-api.com) — deduplicated and mixed, with
  a bundled offline bank (`js/data/fallback-questions.js`) as backup, so the
  game works even when the APIs don't.
- **Live opponent feedback**: the moment any player locks in an answer,
  their pick is stamped on your screen in their color — a shake for a miss,
  a star when they steal the question. Traffic is a handful of messages per
  question, so the Supabase free tier lasts essentially forever.
- **Drop-in resilience**: if someone leaves mid-match, the battle keeps going
  for everyone else; the room only dies when fewer than two players remain
  (or the host — the referee — disappears).
- **Audio**: all sound effects are synthesized with WebAudio — zero asset files.
- **Fonts** (Titan One, Baloo 2) and the Supabase client are vendored, so the
  site is fully self-contained.

## Development

```bash
npm install          # test tooling only (Playwright)
npm run serve        # http://localhost:4173
npm test             # two-player end-to-end tests
```

The E2E tests run two to five browser pages against a local BroadcastChannel
transport (`?t=local`) with stubbed trivia APIs, playing full matches —
matchmaking, lock-out scoring, every power-up, timeouts, rounds, rematches,
four-player battles, mid-game dropouts, and full-room rejections.

To point the game at your own Supabase project, change `SUPABASE_URL` and
`SUPABASE_KEY` in `js/config.js`. No schema needed — realtime channels only.
