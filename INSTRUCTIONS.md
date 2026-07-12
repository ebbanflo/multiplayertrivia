# HMMM? — Maintainer's Guide

This document is for whoever (human or AI) works on this codebase next.
It explains the architecture, the multiplayer protocol, every game mode's
rules as implemented, and the traps that already bit us once. Read this
before changing `js/game.js`.

## What this is

A static-site trivia game (GitHub Pages) with real-time multiplayer over
**Supabase Realtime broadcast + presence channels**. There is **no
database, no backend, no build step** — vanilla ES modules, vendored
dependencies, and one Supabase channel per room. The live site is at
`https://ebbanflo.github.io/multiplayertrivia/`, deployed by pointing
GitHub Pages at a branch.

## File map

| File | Role |
|---|---|
| `index.html` | Single page, all screens as `<section class="screen">`, all dialogs. No build step — script tags only. |
| `js/config.js` | All tunables: Supabase URL/key, scoring constants, power-up definitions, `MODE_POWERUPS` (which power-ups each mode shows), mode constants. Reads URL params for test hooks. |
| `js/net.js` | Transport layer. Three implementations of one tiny interface (below). |
| `js/game.js` | **The engine.** One `Game` class used by every player; host-only logic guarded by `this.isHost`. All rules live here. |
| `js/questions.js` | Question sourcing: two public APIs fetched in parallel, normalized, deduped, with `js/data/fallback-questions.js` (90 bundled questions) as offline backup. Also `royaleDifficulty()` — the endless-mode difficulty curve. |
| `js/ui.js` | `GameUI` — renders engine events into the DOM. Never talks to the network. Also `showScreen/toast/modal/confirmModal` helpers. |
| `js/main.js` | Title screen, matchmaking (host/join/solo), join-link handling, help overlay. |
| `js/audio.js` | WebAudio-synthesized SFX, no asset files. Mute persisted in localStorage. |
| `css/style.css` | The whole claymation look. Player colors are `.pcolor-0..3` by roster slot. |
| `tests/e2e.spec.js` | Playwright E2E: full matches with 1-5 browser pages. |
| `js/vendor/supabase.js` | Vendored supabase-js UMD build (global `window.supabase`). |
| `assets/fonts/` | Vendored woff2 fonts (Titan One, Baloo 2). |

## Architecture in one paragraph

The **host's browser is the authoritative referee**. It fetches
questions, arbitrates who answered first (by client-reported reaction
time, with a `RESOLVE_GRACE_MS` window so network jitter doesn't decide
photo finishes), owns all scores/lives/pots, validates purchases, and
broadcasts every state change. Guests send intents (`answer`, `buy`,
`timeup`, …) and mirror state from host broadcasts. Both roles run the
same `Game` class; `emit()` broadcasts AND handles locally (transports
never echo to self). Clients trust the host; the host trusts clients'
claimed reaction times — it's a friendly game, not an anti-cheat system.
Note the question payload includes `correctIndex`, so devtools cheating
is possible by design tradeoff (enables local 50/50, instant reveals).

## Transport interface (`js/net.js`)

```
await t.join()        resolves when connected & presence tracked
t.send(type, data)    broadcast to peers (never echoes to sender)
t.on(type, fn)        fn({ from, data })
t.onPresence(fn)      fn([{ id, name, role }]) on any membership change
t.leave()
```

- `SupabaseTransport` — production. One channel `hmmm:<CODE>` per room,
  broadcast event `'game'` with `{ t, from, d }` envelope, presence keyed
  by player id. Public channels; anon publishable key; no tables, no RLS.
- `LocalTransport` — same-browser `BroadcastChannel` with heartbeat-based
  presence (700 ms beat / 2.5 s timeout). Activated by `?t=local`. This is
  what every Playwright test uses: multiple pages in one browser context
  share the channel and exercise identical engine/UI code paths.
- `NullTransport` — solo mode. Everything is a no-op; zero network.

## Event protocol

All events flow through `Game._wire()` / `Game._handle()`.
**⚠️ An event type MUST be listed in the `types` array in `_wire()` or
guests silently never receive it.** This bug shipped once (`royale-ante`)
— scores looked fine because the next full-scores broadcast papered over
it. When adding an event, add it to `_wire()` first.

Shared: `lobby-state, start-game, question, verdict, q-end, round-end,
next-round, game-end, rematch-vote, player-left, quit, powerup-applied`.
To-host intents: `answer, timeup, buy`.
Royale: `royale-ante`, duels (`duel-request/-pending/-q/-answer/-verdict/-end`),
ghosts (`ghost-shot, ghost-answer`).
Co-op: `revive-q/-answer/-result/-pick/-done`.

Question keys (`qKey`) namespace the mode: classic `"<round>-<i>"`,
royale `"r-<n>"`, co-op `"c-<n>"`, solo `"s-<n>"`, duel `"d-<qIndex>-<turn>"`,
revive `"v-<qIndex>"`. Stale/duplicate events are dropped by qKey checks.

Question lifecycle: host `emit('question')` → each client runs a local
3-2-1 countdown (`COUNTDOWN_MS`) → `phase='answering'`, `goAt` recorded →
answers carry `elapsed` ms → host arbitrates → `verdict` per wrong answer
(question continues) → `q-end` with reveal → `REVEAL_MS` pause → next
step. Timers are client-local; each client reports its own `timeup`.

## Modes and their rules (as implemented)

Settings object: `{ mode, difficulty, timer, rounds, ramp, staticDiff,
ante, goal }`. Lobby chips map to these via `data-setting` attributes;
which groups are visible per mode is `groupVisible` in
`GameUI._renderLobby`. Host-only; mirrored via `lobby-state`.

### Classic
Rounds × 10 questions (`QUESTIONS_PER_ROUND`). First correct wins
`100 + speedBonus` (bonus scales with remaining time; untimed mode uses a
virtual 60 s decay — see `_speedBonus`). Wrong = −50 and locked out;
others can still steal. Question ends on first-correct / all locked /
all timed out. Difficulty `increasing` splits the whole game into
easy/medium/hard thirds. Highest score wins; ties allowed.

### Royale (endless elimination)
Everyone starts `ROYALE_START` (1000). Each question begins with an
**ante** (`settings.ante`: 25/50/100) from every living player into a
pot; winner takes the pot (no base points); no winner → pot **rolls
over**. Wrong still −50 (clamped at 0). **Score 0 ⇒ eliminated**, keeps
spectating. Last alive wins. Requires a timer (no-timer is forced off).
Difficulty via `royaleDifficulty(i, ramp, staticDiff)` — dial 1 static,
2 slow ramp, 3 ramp, 4 wobbly (~40 % random), 5 chaos. Questions draw
from `qPool` per difficulty, refilled in batches of 10
(`_drawQuestion`).
- **Duel** (power-up, free, stake 0–200): queued via `pendingDuel`, runs
  after the current question resolves. Alternating solo untimed
  questions, initiator first; first miss loses;
  `transfer = min(stake, loserStack)`; stack < stake ⇒ eliminated.
  One duel pending at a time; cancels safely if a duelist dies/leaves.
- **Ghost shot**: if reason `'locked'` (every living player answered
  wrong) and eliminated players exist, `q-end` is deferred; ghosts get
  `GHOST_SHOT_MS` (8 s) to answer the same question (they've seen the
  living players' wrong stamps). Each correct ghost revives with
  `GHOST_REVIVE_POINTS` (100). Timeout-only questions do NOT trigger it.

### Co-op (team vs the goal)
One shared `teamScore` racing `settings.goal` (1000/5000/10000, 0 =
endless). Per-player `livesMap` starts at `COOP_LIVES` (3). Wrong answer
= −1 heart to that player, **never team points**; timeout costs nothing.
0 hearts ⇒ spectate (`eliminated` set reused). Winner of a question banks
`100 + speedBonus` into `teamScore` (Double Down doubles it). Win: reach
goal (everybody wins, confetti). Lose: all hearts gone. Power-ups spend
from **teamScore**: 50/50, Double Down, and **Revive** (200): queued like
a duel; after the question, the buyer answers ONE untimed question alone;
correct ⇒ buyer picks a fallen teammate (auto if only one; auto-pick
after `REVIVE_PICK_MS` if they stall) who returns with
`COOP_REVIVE_LIVES` (2); wrong ⇒ points gone. Buyer dead/gone before it
starts ⇒ refunded.

### Solo (offline)
`NullTransport`, started from the title button — skips the lobby. 3
lives (`SOLO_LIVES`), untimed (settings.timer forced 0), endless via the
ramp-3 curve. Miss = −1 heart, no point loss. No shop
(`MODE_POWERUPS.solo = []`; `#shop.solo` CSS hides items but keeps
PAUSE/QUIT). Game over reports questions survived + points; rematch
machinery doubles as PLAY AGAIN (1 vote needed).

### Cross-mode systems
- **Roster & colors**: host-ordered array (host = slot 0); slot index
  drives `.pcolor-N` everywhere. Room code alphabet excludes O/0/I.
  `MAX_PLAYERS` = 4; extra joiners get a `lobby-state` without their id
  and self-eject ("room full").
- **Stamps**: every wrong pick is broadcast in `verdict` and stamped on
  that answer in the player's color (`_stampAnswer`, stacking rail).
  This is deliberate public information — eliminations help the others.
- **Disconnects**: presence loss or `quit` → `_hostRemovePlayer`. Games
  continue while ≥2 remain in roster (royale: ends when ≤1 *alive*);
  host leaving kills the room for everyone (it's the referee).
- **Pause** is a local privacy overlay only — multiplayer clocks keep
  running (solo genuinely pauses since nothing is timed).
- **Freeze** (classic/royale) freezes every non-buyer for `FREEZE_MS`.
- **Rematch**: everyone votes (`rematchVotes.size >= roster.length`) →
  host re-runs `start()`; `usedTexts` persists so questions don't repeat.

## Test harness

```bash
npm install && npm test         # Playwright, python3 http.server on :4173
PW_CHROMIUM=/path/to/chrome npx playwright test   # if browsers mismatch
```

- Tests run multiple pages in ONE browser context at
  `/?t=local&debug=1` — LocalTransport makes them peers.
- `debug=1` exposes `window.__HMMM = { transport, engine, ui }`;
  tests assert engine state directly (see `engineState` helper).
- Trivia APIs are stubbed with `context.route()` fixtures — the
  normalizer code paths still run.
- `?rstart=N` (debug only) shrinks the Royale starting stack so
  elimination tests take 4 questions instead of 40.
- **Pitfall**: don't test "input is blocked" by clicking a disabled/
  covered element — Playwright auto-waits and the click lands LATER as a
  real action (this once made a freeze test corrupt a match). Probe the
  engine directly: `page.evaluate(() => __HMMM.engine.answer(i))` and
  assert nothing changed.
- Suite runtime ~8 min; timers in tests use the 30 s mode and instant
  clicks.

## Known traps (each of these bit us once)

1. **New event type not registered in `_wire()`** → guests never hear it,
   and full-scores broadcasts mask the bug. Check this FIRST when state
   desyncs.
2. The global CSS reset kills UA styles: dialogs need `margin: auto`
   (restored in `.modal`), and `[hidden]` loses to `display:flex` unless
   `[hidden] { display:none !important }` (present — keep it).
3. Playwright auto-wait deferred clicks (above).
4. The Supabase free-tier project **auto-pauses after ~1 week idle**.
   Connection failures show a "server may be napping" message; restore
   at supabase.com → project → Restore. Nothing is lost (no DB).
5. supabase-js default client-side broadcast throttle is 10 msg/s —
   fine for current traffic (a handful per question). If you ever add a
   high-frequency stream (we removed live cursors for this reason),
   raise `realtime.params.eventsPerSecond` in `createClient` and mind
   the 2 M messages/month free quota.
6. GitHub Pages serves from the branch configured in repo Settings →
   Pages; `.nojekyll` must stay. All asset paths are relative.

## Supabase

Project `hmmm-trivia` (id `lapkrvmlmwfrwqmzxukt`, us-east-1, free tier),
URL + publishable key in `js/config.js` (safe to ship — no tables, no
auth, realtime public channels only). To repoint: swap those two
constants; no schema needed. Capacity: 200 concurrent connections
(= 50 four-player rooms at once), 2 M realtime messages/month
(≈ 400–500 per full match).

## Adding things — the grain of the codebase

- New tunable → `js/config.js`, never inline.
- New rule → host-side in `game.js`, broadcast the outcome, mirror in
  the client `_handle` case, render in `ui.js`. Never let the UI mutate
  game state directly.
- New mode → add mode chip + setting groups in `index.html`, visibility
  in `groupVisible`, a `MODE_POWERUPS` entry, a `start()` branch, a
  `_<mode>NextQuestion()`, a continuation branch in `_finalizeQuestion`,
  and an E2E test that plays a full game of it.
- Side-quests that interrupt flow (duel, revive) follow the queue
  pattern: set `pending*` during a question, run it from the
  `_finalizeQuestion` continuation, then resume `_<mode>NextQuestion()`.
- Keep the claymation voice in UI copy: chunky, silly, all-caps bursts
  ("SQUASHED!", "the clay beyond").
