// Game engine. The HOST is authoritative: it owns the roster, question
// list, scores, answer arbitration and power-up validation, and
// broadcasts every state change. GUESTS mirror state from host events.
// Both roles run the same engine; host-only logic is guarded by
// this.isHost.
//
// Rooms hold 2-4 players. All rules are written against the roster, so
// a 2-player game behaves exactly like the original duel.
//
// UI code subscribes with engine.onUI(event, fn) and never touches the
// network directly.

import {
  QUESTIONS_PER_ROUND, COUNTDOWN_MS, REVEAL_MS, RESOLVE_GRACE_MS,
  SCORE_BASE, SCORE_SPEED_MAX, SCORE_WRONG,
  POWERUPS, FREEZE_MS, TIMEWARP_MS, MAX_PLAYERS,
  ROYALE_START, ROYALE_ANTE, SOLO_LIVES,
  DUEL_MAX_STAKE, GHOST_SHOT_MS, GHOST_REVIVE_POINTS,
  MODE_POWERUPS, COOP_LIVES, COOP_REVIVE_LIVES, REVIVE_PICK_MS,
} from './config.js';
import { buildQuestionSet, fetchDifficulty, royaleDifficulty } from './questions.js';

export class Game {
  constructor(transport, self) {
    this.t = transport;
    this.me = self;                  // { id, name, role: 'host' | 'guest' }
    this.isHost = self.role === 'host';
    // Roster order is assigned by the host (host first, guests in join
    // order) and shared with everyone — it drives player colors.
    this.roster = this.isHost ? [{ ...self }] : [];
    this.hostPresent = this.isHost;
    this.settings = {
      mode: 'classic', difficulty: 'medium', timer: 60, rounds: 1,
      ramp: 3, staticDiff: 'medium', ante: ROYALE_ANTE, goal: 5000,
    };
    this.phase = 'lobby';            // lobby|countdown|answering|reveal|intermission|gameover
    this.scores = {};                // playerId -> score
    this.uiHandlers = new Map();

    // Per-question client state
    this.currentQ = null;            // { qKey, round, qIndex, q, duration }
    this.goAt = 0;                   // performance.now() when answers unlocked
    this.myAnswered = false;
    this.myLockedOut = false;
    this.frozenUntil = 0;
    this.myDeadlineExtra = 0;        // timewarp extension for the current question
    this.usedPowerupsThisQ = new Set();
    this.myDouble = false;           // mirrored badge (host holds the truth)

    // Royale mode client state (mirrored from host events)
    this.pot = 0;
    this.eliminated = new Set();     // playerIds knocked out this game
    this.ghostShotQKey = null;       // set while a last-shot window is open
    this.ghostAnswered = false;

    // Co-op mode client state (mirrored from host events)
    this.teamScore = 0;
    this.livesMap = {};              // playerId -> hearts remaining

    // Host-only state
    this.questions = [];
    this.qIndex = -1;
    this.usedTexts = new Set();
    this.hq = null;                  // per-question arbitration state
    this.fx = {};                    // playerId -> { shield, double }
    this.rematchVotes = new Set();
    this.hostTimers = [];
    this.alive = new Set();          // royale: players still standing
    this.qPool = null;               // royale: { easy: [], medium: [], hard: [] }
    this.pendingDuel = null;         // royale: { a, b, stake } queued for after this question
    this.duel = null;                // royale: active duel { a, b, stake, turn, dNum, q, qKey }
    this.ghost = null;               // royale: open last-shot window state
    this.lives = SOLO_LIVES;         // solo: hearts remaining
    this.pendingRevive = null;       // coop: { buyerId } queued for after this question
    this.reviveQ = null;             // coop: active revive attempt state

    this._wire();
  }

  // ---------------- roster helpers ----------------
  others() { return this.roster.filter((p) => p.id !== this.me.id); }
  playerName(id) {
    const p = this.roster.find((x) => x.id === id);
    return p ? p.name : 'THEM';
  }
  playerSlot(id) { return this.roster.findIndex((x) => x.id === id); }

  // ---------------- UI plumbing ----------------
  onUI(event, fn) {
    if (!this.uiHandlers.has(event)) this.uiHandlers.set(event, []);
    this.uiHandlers.get(event).push(fn);
  }
  ui(event, data) {
    for (const fn of this.uiHandlers.get(event) || []) fn(data);
  }

  // Broadcast to peers AND handle locally (transports never echo).
  emit(type, data) {
    this.t.send(type, data);
    this._handle(type, this.me.id, data);
  }

  // ---------------- lifecycle ----------------
  _wire() {
    const types = [
      'lobby-state', 'start-game', 'question', 'answer', 'timeup', 'buy',
      'powerup-applied', 'verdict', 'q-end', 'round-end', 'next-round',
      'game-end', 'rematch-vote', 'player-left', 'quit', 'royale-ante',
      'duel-request', 'duel-pending', 'duel-q', 'duel-answer', 'duel-verdict',
      'duel-end', 'ghost-shot', 'ghost-answer',
      'revive-q', 'revive-answer', 'revive-result', 'revive-pick', 'revive-done',
    ];
    for (const type of types) {
      this.t.on(type, ({ from, data }) => this._handle(type, from, data));
    }
    this.t.onPresence((members) => this._onPresence(members));
  }

  destroy() {
    this._clearHostTimers();
    this.t.leave();
  }

  _clearHostTimers() {
    for (const timer of this.hostTimers) clearTimeout(timer);
    this.hostTimers = [];
  }
  _after(ms, fn) {
    this.hostTimers.push(setTimeout(fn, ms));
  }

  // ---------------- presence ----------------
  _onPresence(members) {
    if (this.isHost) {
      const present = new Set(members.map((m) => m.id));
      // Departures (any phase)
      for (const p of this.others()) {
        if (!present.has(p.id)) this._hostRemovePlayer(p.id);
      }
      // Arrivals: seat new guests while in the lobby, up to capacity.
      const seated = new Set(this.roster.map((p) => p.id));
      let changed = false;
      let overflow = false;
      for (const m of members) {
        if (m.id === this.me.id || m.role !== 'guest' || seated.has(m.id)) continue;
        if (this.phase === 'lobby' && this.roster.length < MAX_PLAYERS) {
          this.roster.push({ id: m.id, name: m.name, role: 'guest' });
          seated.add(m.id);
          changed = true;
        } else {
          overflow = true; // full room or mid-game — tell them via lobby-state
        }
      }
      if (changed || overflow) this._broadcastLobby();
      if (changed) this.ui('lobby-update', this.lobbyView());
    } else {
      const host = members.find((m) => m.id !== this.me.id && m.role === 'host');
      if (host) {
        const firstSighting = !this.hostPresent;
        this.hostPresent = true;
        if (!this.roster.length) this.roster = [{ ...host }, { ...this.me }];
        // Show the lobby right away with a provisional roster; the
        // host's authoritative lobby-state refines it moments later.
        if (firstSighting && this.phase === 'lobby') {
          this.ui('lobby-update', this.lobbyView());
        }
      } else if (this.hostPresent && this.phase !== 'gameover') {
        // The host's browser referees the match — without it the room is dead.
        this.hostPresent = false;
        this.ui('opponent-left', { name: this.roster[0]?.name, fatal: true });
      }
    }
  }

  // Host: drop a player from the room (disconnect or quit).
  _hostRemovePlayer(id) {
    if (!this.roster.some((p) => p.id === id)) return;
    const name = this.playerName(id);
    this.roster = this.roster.filter((p) => p.id !== id);
    this.rematchVotes.delete(id);

    if (this.phase === 'lobby') {
      this._broadcastLobby();
      this.ui('lobby-update', this.lobbyView());
      return;
    }
    // Mid-game: everyone learns; the match continues if 2+ remain.
    this.alive.delete(id);
    if (this.pendingDuel && (this.pendingDuel.a === id || this.pendingDuel.b === id)) {
      this.pendingDuel = null;
    }
    if (this.duel && (this.duel.a === id || this.duel.b === id)) {
      // A duelist walked out — the duel is off, no transfer.
      this.duel = null;
      this.emit('duel-end', { canceled: true, scores: { ...this.scores } });
      this._after(1500, () => {
        if (this.alive.size <= 1) this._royaleGameEnd();
        else this._royaleNextQuestion();
      });
    }
    this.emit('player-left', { playerId: id, name, roster: this.roster });
    if (this.roster.length < 2) {
      this._clearHostTimers();
      return;
    }
    if (this.hq && !this.hq.resolved) {
      this.hq.active.delete(id);
      this._maybeResolve();
    }
    // Royale: a quitter can leave one player standing — that's a win.
    if (this.settings.mode === 'royale' && this.phase !== 'gameover'
        && this.phase !== 'lobby' && this.alive.size <= 1
        && (!this.hq || this.hq.resolved)) {
      this._clearHostTimers();
      this._royaleGameEnd();
    }
    // Co-op: cancel a revive whose buyer walked; wipe check if the last
    // living teammate left.
    if (this.settings.mode === 'coop') {
      if (this.pendingRevive && this.pendingRevive.buyerId === id) {
        this.pendingRevive = null;
        this.teamScore += POWERUPS.revive.cost;
      }
      if (this.reviveQ && this.reviveQ.buyerId === id) {
        this.reviveQ = null;
        this.emit('revive-result', { canceled: true, buyerId: id, correct: false, teamScore: this.teamScore });
        this._after(1200, () => this._coopNextQuestion());
      }
      if (this.phase !== 'gameover' && this.phase !== 'lobby'
          && this.alive.size === 0 && (!this.hq || this.hq.resolved)) {
        this._clearHostTimers();
        this.phase = 'gameover';
        this.emit('game-end', {
          scores: { ...this.scores }, winnerIds: [], teamScore: this.teamScore,
          coop: { victory: false, questions: this.qIndex + 1 },
        });
      }
    }
  }

  lobbyView() {
    return {
      code: this.t.code,
      me: this.me,
      roster: this.roster,
      settings: this.settings,
      canStart: this.isHost && this.roster.length >= 2,
      maxPlayers: MAX_PLAYERS,
    };
  }

  _broadcastLobby() {
    if (!this.isHost) return;
    this.t.send('lobby-state', {
      settings: this.settings,
      players: this.roster,
      inGame: this.phase !== 'lobby',
    });
  }

  // Host lobby controls
  updateSetting(key, value) {
    if (!this.isHost || this.phase !== 'lobby') return;
    this.settings[key] = value;
    // Royale requires a clock — a no-timer standoff would never resolve.
    if (this.settings.mode === 'royale' && !(this.settings.timer > 0)) {
      this.settings.timer = 60;
    }
    this._broadcastLobby();
    this.ui('lobby-update', this.lobbyView());
  }

  // ---------------- host: game flow ----------------
  async start() {
    if (this.settings.mode === 'solo') {
      if (this.isHost) this._startSolo();
      return;
    }
    if (!this.isHost || this.roster.length < 2) return;
    const mode = this.settings.mode;
    const endless = mode === 'royale' || mode === 'coop';
    this.ui('loading', { on: true });
    try {
      if (endless) {
        // Endless modes: pre-warm the pool for the opening difficulty;
        // later batches are fetched as the game runs.
        this.qPool = { easy: [], medium: [], hard: [] };
        const first = royaleDifficulty(0, this.settings.ramp, this.settings.staticDiff);
        this.qPool[first] = await fetchDifficulty(10, first, this.usedTexts);
        for (const q of this.qPool[first]) this.usedTexts.add(q.text);
      } else {
        this.questions = await buildQuestionSet(
          this.settings.difficulty, this.settings.rounds, this.usedTexts,
        );
      }
    } finally {
      this.ui('loading', { on: false });
    }
    this.qIndex = -1;
    this.scores = {};
    this.fx = {};
    this.pot = 0;
    this.teamScore = 0;
    this.livesMap = {};
    this.pendingDuel = null;
    this.duel = null;
    this.ghost = null;
    this.pendingRevive = null;
    this.reviveQ = null;
    this.eliminated = new Set();
    this.alive = new Set(this.roster.map((p) => p.id));
    for (const p of this.roster) {
      this.scores[p.id] = mode === 'royale' ? ROYALE_START : 0;
      this.livesMap[p.id] = COOP_LIVES;
      this.fx[p.id] = {};
    }
    this.rematchVotes.clear();
    this.emit('start-game', {
      settings: this.settings, roster: this.roster, scores: this.scores,
      teamScore: this.teamScore, livesMap: { ...this.livesMap },
    });
    this._after(600, () => {
      if (mode === 'royale') this._royaleNextQuestion();
      else if (mode === 'coop') this._coopNextQuestion();
      else this._nextQuestion();
    });
  }

  // ---------------- host: co-op flow ----------------
  // The team races a shared score to the goal; each player has hearts.
  async _coopNextQuestion() {
    this.qIndex += 1;
    const diff = royaleDifficulty(this.qIndex, this.settings.ramp, this.settings.staticDiff);
    const q = await this._drawQuestion(diff);
    const qKey = `c-${this.qIndex}`;
    this.hq = {
      qKey,
      q,
      active: new Set(this.alive),
      answers: new Map(),
      lockedOut: new Set(),
      timeups: new Set(),
      resolved: false,
      candidates: [],
      graceTimer: null,
    };
    this.emit('question', {
      qKey, mode: 'coop', qNum: this.qIndex + 1, q,
      duration: this.settings.timer > 0 ? this.settings.timer * 1000 : null,
      teamScore: this.teamScore, goal: this.settings.goal,
      livesMap: { ...this.livesMap },
    });
  }

  _nextQuestion() {
    this.qIndex += 1;
    const q = this.questions[this.qIndex];
    const round = Math.floor(this.qIndex / QUESTIONS_PER_ROUND) + 1;
    const qKey = `${round}-${this.qIndex % QUESTIONS_PER_ROUND}`;
    this.hq = {
      qKey,
      q,
      active: new Set(this.roster.map((p) => p.id)),
      answers: new Map(),
      lockedOut: new Set(),
      timeups: new Set(),
      resolved: false,
      candidates: [],
      graceTimer: null,
    };
    this.emit('question', {
      qKey,
      round,
      qIndex: this.qIndex % QUESTIONS_PER_ROUND,
      totalRounds: this.settings.rounds,
      q,
      duration: this.settings.timer > 0 ? this.settings.timer * 1000 : null,
    });
  }

  // ---------------- host: solo flow ----------------
  // A lone clay warrior vs the question mines: 3 lives, no timer,
  // endless ramping questions. No shop, no pot — pure survival.
  async _startSolo() {
    this.ui('loading', { on: true });
    try {
      this.qPool = { easy: [], medium: [], hard: [] };
      const first = royaleDifficulty(0, this.settings.ramp, this.settings.staticDiff);
      this.qPool[first] = await fetchDifficulty(10, first, this.usedTexts);
      for (const q of this.qPool[first]) this.usedTexts.add(q.text);
    } finally {
      this.ui('loading', { on: false });
    }
    this.qIndex = -1;
    this.scores = { [this.me.id]: 0 };
    this.fx = { [this.me.id]: {} };
    this.lives = SOLO_LIVES;
    this.alive = new Set([this.me.id]);
    this.eliminated = new Set();
    this.rematchVotes.clear();
    this.emit('start-game', {
      settings: this.settings, roster: this.roster, scores: this.scores, lives: this.lives,
    });
    this._after(600, () => this._soloNextQuestion());
  }

  async _soloNextQuestion() {
    this.qIndex += 1;
    const diff = royaleDifficulty(this.qIndex, this.settings.ramp, this.settings.staticDiff);
    const q = await this._drawQuestion(diff);
    const qKey = `s-${this.qIndex}`;
    this.hq = {
      qKey,
      q,
      active: new Set([this.me.id]),
      answers: new Map(),
      lockedOut: new Set(),
      timeups: new Set(),
      resolved: false,
      candidates: [],
      graceTimer: null,
    };
    this.emit('question', {
      qKey, mode: 'solo', qNum: this.qIndex + 1, lives: this.lives, q, duration: null,
    });
  }

  // ---------------- host: royale flow ----------------
  async _royaleNextQuestion() {
    this.qIndex += 1;

    // Ante phase: every surviving player pays into the pot. Running dry
    // on the ante alone is a legitimate (slow, ignoble) way to go out.
    // The host-chosen ante size (25/50/100) sets the pace of doom.
    const ante = this.settings.ante || ROYALE_ANTE;
    const anteEliminated = [];
    for (const id of this.alive) {
      const paid = Math.min(ante, this.scores[id]);
      this.scores[id] -= paid;
      this.pot += paid;
      if (this.scores[id] <= 0) {
        this.scores[id] = 0;
        anteEliminated.push(id);
      }
    }
    for (const id of anteEliminated) this.alive.delete(id);
    this.emit('royale-ante', {
      scores: { ...this.scores }, pot: this.pot, eliminated: anteEliminated,
    });
    if (this.alive.size <= 1) { this._royaleGameEnd(); return; }

    // Draw a question at the ramp dial's difficulty (reveal pauses hide
    // any refill fetch time).
    const diff = royaleDifficulty(this.qIndex, this.settings.ramp, this.settings.staticDiff);
    const q = await this._drawQuestion(diff);

    const qKey = `r-${this.qIndex}`;
    this.hq = {
      qKey,
      q,
      active: new Set(this.alive),
      answers: new Map(),
      lockedOut: new Set(),
      timeups: new Set(),
      resolved: false,
      candidates: [],
      graceTimer: null,
    };
    this.emit('question', {
      qKey,
      mode: 'royale',
      qNum: this.qIndex + 1,
      pot: this.pot,
      q,
      duration: this.settings.timer * 1000,
    });
  }

  _royaleGameEnd() {
    // Last one standing wins; if the final players fell together, the
    // biggest stack among the just-fallen takes it.
    let winnerIds;
    if (this.alive.size >= 1) {
      winnerIds = [...this.alive];
    } else {
      const top = Math.max(...this.roster.map((p) => this.scores[p.id] ?? 0));
      winnerIds = this.roster.filter((p) => (this.scores[p.id] ?? 0) === top).map((p) => p.id);
    }
    this.phase = 'gameover';
    this.emit('game-end', { scores: { ...this.scores }, winnerIds });
  }

  _speedBonus(elapsedMs, durationMs) {
    if (durationMs) {
      const remaining = Math.max(0, durationMs - elapsedMs);
      return Math.round(SCORE_SPEED_MAX * (remaining / durationMs));
    }
    // No-timer mode: bonus decays over a virtual 60s window.
    return Math.max(10, SCORE_SPEED_MAX - Math.floor(elapsedMs / 600));
  }

  // Every active player has either answered or been locked out.
  _allDone() {
    const hq = this.hq;
    for (const id of hq.active) {
      if (!hq.answers.has(id) && !hq.lockedOut.has(id)) return false;
    }
    return true;
  }

  _maybeResolve() {
    const hq = this.hq;
    if (!hq || hq.resolved) return;
    if (!this._allDone()) return;
    if (hq.candidates.length) {
      this._resolveOrEnd('correct');
    } else if (hq.timeups.size && hq.timeups.size >= hq.lockedOut.size) {
      this._resolveOrEnd('timeout');
    } else {
      this._resolveOrEnd('locked');
    }
  }

  _hostOnAnswer(playerId, { qKey, idx, elapsed }) {
    const hq = this.hq;
    if (!hq || hq.resolved || hq.qKey !== qKey || !hq.active.has(playerId)) return;
    if (hq.answers.has(playerId) || hq.lockedOut.has(playerId)) return;

    const correct = idx === hq.q.correctIndex;
    hq.answers.set(playerId, { idx, elapsed, correct });

    if (!correct) {
      hq.lockedOut.add(playerId);
      let delta = SCORE_WRONG;
      if (this.settings.mode === 'solo') {
        delta = 0; // solo misses cost a heart, not points
        this.lives -= 1;
      } else if (this.settings.mode === 'coop') {
        delta = 0; // coop misses cost the PLAYER a heart, never the team
        this.livesMap[playerId] = Math.max(0, (this.livesMap[playerId] || 0) - 1);
        if (this.livesMap[playerId] === 0) this.alive.delete(playerId);
      }
      this.scores[playerId] += delta;
      if (this.settings.mode === 'royale' && this.scores[playerId] < 0) {
        this.scores[playerId] = 0;
      }
      this.emit('verdict', {
        qKey, playerId, idx, correct: false, delta, lives: this.lives,
        livesMap: { ...this.livesMap },
        scores: { ...this.scores },
      });
      this._maybeResolve();
      return;
    }

    hq.candidates.push({ playerId, elapsed, idx });
    if (this._allDone()) {
      this._resolveOrEnd('correct');
    } else if (!hq.graceTimer) {
      // Brief grace window so a slightly-slower network doesn't decide
      // a photo finish — we compare reaction times, not packet arrival.
      hq.graceTimer = setTimeout(() => this._resolveOrEnd('correct'), RESOLVE_GRACE_MS);
      this.hostTimers.push(hq.graceTimer);
    }
  }

  _hostOnTimeup(playerId, { qKey }) {
    const hq = this.hq;
    if (!hq || hq.resolved || hq.qKey !== qKey || !hq.active.has(playerId)) return;
    if (hq.answers.has(playerId) || hq.lockedOut.has(playerId)) return;
    hq.lockedOut.add(playerId);
    hq.timeups.add(playerId);
    this._maybeResolve();
  }

  _resolveOrEnd(reason) {
    const hq = this.hq;
    if (!hq || hq.resolved) return;
    hq.resolved = true;
    if (hq.graceTimer) clearTimeout(hq.graceTimer);
    const royale = this.settings.mode === 'royale';

    let winnerId = null;
    let winDelta = 0;
    let doubled = false;
    if (hq.candidates.length) {
      hq.candidates.sort((a, b) => a.elapsed - b.elapsed);
      const w = hq.candidates[0];
      winnerId = w.playerId;
      const fx = this.fx[winnerId] || {};
      if (royale) {
        // Winner takes the pot (Double Down doubles the haul).
        winDelta = this.pot;
        this.pot = 0;
      } else {
        const duration = this.settings.timer > 0 ? this.settings.timer * 1000 : null;
        winDelta = SCORE_BASE + this._speedBonus(w.elapsed, duration);
      }
      if (fx.double) { winDelta *= 2; doubled = true; fx.double = false; }
      if (this.settings.mode === 'coop') this.teamScore += winDelta;
      else this.scores[winnerId] += winDelta;
    }

    // Royale ghost shot: every living player answered WRONG, and there
    // are fallen players watching — they get one chance to resurrect
    // before the reveal.
    if (royale && reason === 'locked' && !winnerId) {
      const ghosts = this.roster
        .map((p) => p.id)
        .filter((id) => !hq.active.has(id) && !this.alive.has(id));
      if (ghosts.length) {
        this._startGhostShot(ghosts, reason);
        return;
      }
    }

    this._finalizeQuestion(reason, winnerId, winDelta, doubled, null);
  }

  _finalizeQuestion(reason, winnerId, winDelta, doubled, ghostData) {
    const hq = this.hq;
    const royale = this.settings.mode === 'royale';

    // Royale: wrong-answer penalties may have finished someone off.
    const eliminated = [];
    if (royale) {
      for (const id of this.alive) {
        if (this.scores[id] <= 0) {
          this.scores[id] = 0;
          eliminated.push(id);
        }
      }
      for (const id of eliminated) this.alive.delete(id);
    }

    const isLastInRound = (this.qIndex % QUESTIONS_PER_ROUND) === QUESTIONS_PER_ROUND - 1;
    const isLastQuestion = !royale && this.qIndex === this.questions.length - 1;

    this.emit('q-end', {
      qKey: hq.qKey,
      correctIndex: hq.q.correctIndex,
      winnerId,
      winDelta,
      doubled,
      reason,
      pot: this.pot,
      lives: this.lives,
      teamScore: this.teamScore,
      livesMap: { ...this.livesMap },
      eliminated,
      ghostRevived: ghostData ? ghostData.revived : [],
      ghostAnswers: ghostData ? ghostData.answers : {},
      scores: { ...this.scores },
    });

    this._after(REVEAL_MS, () => {
      if (this.settings.mode === 'coop') {
        const goal = this.settings.goal;
        if (goal > 0 && this.teamScore >= goal) {
          this.phase = 'gameover';
          this.emit('game-end', {
            scores: { ...this.scores }, winnerIds: this.roster.map((p) => p.id),
            teamScore: this.teamScore,
            coop: { victory: true, questions: this.qIndex + 1 },
          });
        } else if (this.alive.size === 0) {
          this.phase = 'gameover';
          this.emit('game-end', {
            scores: { ...this.scores }, winnerIds: [],
            teamScore: this.teamScore,
            coop: { victory: false, questions: this.qIndex + 1 },
          });
        } else if (this.pendingRevive) {
          this._startRevive();
        } else {
          this._coopNextQuestion();
        }
      } else if (this.settings.mode === 'solo') {
        if (this.lives <= 0) {
          this.phase = 'gameover';
          this.emit('game-end', {
            scores: { ...this.scores }, winnerIds: [],
            solo: { questions: this.qIndex + 1 },
          });
        } else {
          this._soloNextQuestion();
        }
      } else if (royale) {
        if (this.alive.size <= 1) this._royaleGameEnd();
        else if (this.pendingDuel) this._startDuel();
        else this._royaleNextQuestion();
      } else if (isLastQuestion) {
        const top = Math.max(...this.roster.map((p) => this.scores[p.id] ?? 0));
        const winnerIds = this.roster
          .filter((p) => (this.scores[p.id] ?? 0) === top)
          .map((p) => p.id);
        this.phase = 'gameover';
        this.emit('game-end', { scores: { ...this.scores }, winnerIds });
      } else if (isLastInRound) {
        const round = Math.floor(this.qIndex / QUESTIONS_PER_ROUND) + 1;
        this.emit('round-end', { round, scores: { ...this.scores } });
      } else {
        this._nextQuestion();
      }
    });
  }

  // ---------------- host: ghost last shot ----------------
  _startGhostShot(ghosts, reason) {
    this.ghost = {
      qKey: this.hq.qKey,
      reason,
      waiting: new Set(ghosts),
      answers: new Map(),
    };
    this.emit('ghost-shot', { qKey: this.hq.qKey, ghosts, duration: GHOST_SHOT_MS });
    this._after(GHOST_SHOT_MS + 800, () => this._resolveGhostShot());
  }

  _hostOnGhostAnswer(playerId, { qKey, idx }) {
    const g = this.ghost;
    if (!g || g.qKey !== qKey || !g.waiting.has(playerId) || g.answers.has(playerId)) return;
    g.answers.set(playerId, idx);
    if (g.answers.size >= g.waiting.size) this._resolveGhostShot();
  }

  _resolveGhostShot() {
    const g = this.ghost;
    if (!g) return;
    this.ghost = null;
    const revived = [];
    const answers = {};
    for (const [id, idx] of g.answers) {
      answers[id] = idx;
      if (idx === this.hq.q.correctIndex) {
        this.alive.add(id);
        this.scores[id] = GHOST_REVIVE_POINTS;
        revived.push(id);
      }
    }
    this._finalizeQuestion(g.reason, null, 0, false, { revived, answers });
  }

  // ---------------- host: duels ----------------
  _hostOnDuelRequest(playerId, { qKey, targetId, stake }) {
    const hq = this.hq;
    if (this.settings.mode !== 'royale') return;
    if (!hq || hq.resolved || hq.qKey !== qKey) return;
    if (this.pendingDuel || this.duel) return;
    if (playerId === targetId) return;
    if (!this.alive.has(playerId) || !this.alive.has(targetId)) return;
    const amount = Math.max(0, Math.min(DUEL_MAX_STAKE, Math.round(stake) || 0));
    const fx = this.fx[playerId] = this.fx[playerId] || {};
    fx.usedThisQ = fx.usedThisQ && fx.usedThisQKey === qKey ? fx.usedThisQ : new Set();
    fx.usedThisQKey = qKey;
    if (fx.usedThisQ.has('duel')) return;
    fx.usedThisQ.add('duel');

    this.pendingDuel = { a: playerId, b: targetId, stake: amount };
    this.emit('duel-pending', { ...this.pendingDuel });
  }

  _startDuel() {
    const d = this.pendingDuel;
    this.pendingDuel = null;
    // A duelist may have been eliminated (or left) since the challenge.
    if (!d || !this.alive.has(d.a) || !this.alive.has(d.b)) {
      this.emit('duel-end', { canceled: true, scores: { ...this.scores } });
      this._after(1200, () => this._royaleNextQuestion());
      return;
    }
    this.duel = { ...d, turn: d.a, dNum: 0 };
    this._duelQuestion();
  }

  async _duelQuestion() {
    const duel = this.duel;
    if (!duel) return;
    const diff = royaleDifficulty(this.qIndex, this.settings.ramp, this.settings.staticDiff);
    duel.q = await this._drawQuestion(diff);
    duel.qKey = `d-${this.qIndex}-${duel.dNum}`;
    this.emit('duel-q', {
      qKey: duel.qKey,
      q: duel.q,
      duel: { a: duel.a, b: duel.b, stake: duel.stake },
      turnId: duel.turn,
      dNum: duel.dNum,
    });
  }

  _hostOnDuelAnswer(playerId, { qKey, idx }) {
    const duel = this.duel;
    if (!duel || duel.qKey !== qKey || duel.turn !== playerId) return;
    const correct = idx === duel.q.correctIndex;
    this.emit('duel-verdict', { qKey, playerId, idx, correct });

    if (correct) {
      duel.turn = duel.turn === duel.a ? duel.b : duel.a;
      duel.dNum += 1;
      this._after(1600, () => this._duelQuestion());
      return;
    }

    // First miss loses. The stake moves; a stack too small to cover it
    // busts out entirely.
    const loserId = playerId;
    const winnerId = loserId === duel.a ? duel.b : duel.a;
    const pre = this.scores[loserId];
    const transfer = Math.min(duel.stake, pre);
    this.scores[loserId] -= transfer;
    this.scores[winnerId] += transfer;
    const eliminated = [];
    if (duel.stake > 0 && this.scores[loserId] <= 0) {
      this.scores[loserId] = 0;
      this.alive.delete(loserId);
      eliminated.push(loserId);
    }
    this.duel = null;
    this.emit('duel-end', {
      winnerId, loserId, stake: duel.stake, transfer, eliminated,
      scores: { ...this.scores },
    });
    this._after(REVEAL_MS, () => {
      if (this.alive.size <= 1) this._royaleGameEnd();
      else this._royaleNextQuestion();
    });
  }

  // Draw one question of the given difficulty from the endless pool,
  // refilling from the APIs as needed.
  async _drawQuestion(diff) {
    if (!this.qPool[diff].length) {
      const batch = await fetchDifficulty(10, diff, this.usedTexts);
      for (const q of batch) this.usedTexts.add(q.text);
      this.qPool[diff].push(...batch);
    } else if (this.qPool[diff].length < 3) {
      fetchDifficulty(10, diff, this.usedTexts).then((batch) => {
        for (const q of batch) this.usedTexts.add(q.text);
        this.qPool[diff].push(...batch);
      }).catch(() => { /* next draw retries synchronously */ });
    }
    return this.qPool[diff].shift();
  }

  _hostOnBuy(playerId, { qKey, type }) {
    const hq = this.hq;
    const def = POWERUPS[type];
    if (!def || !hq || hq.resolved || hq.qKey !== qKey || !hq.active.has(playerId)) return;
    if (this.phase !== 'answering' && this.phase !== 'countdown') return;
    if (hq.lockedOut.has(playerId) || hq.answers.has(playerId)) return;
    if (type === 'timewarp' && !(this.settings.timer > 0)) return;
    if (type === 'duel') return; // duels go through duel-request
    const mode = this.settings.mode;
    if (!MODE_POWERUPS[mode].includes(type)) return;
    const fx = this.fx[playerId] = this.fx[playerId] || {};
    fx.usedThisQ = fx.usedThisQ && fx.usedThisQKey === qKey ? fx.usedThisQ : new Set();
    fx.usedThisQKey = qKey;
    if (fx.usedThisQ.has(type)) return;
    if (type === 'double' && fx.double) return;

    // Co-op spends from the shared team score.
    const wallet = mode === 'coop' ? this.teamScore : this.scores[playerId];
    if (wallet < def.cost) return;

    if (type === 'revive') {
      // Needs a fallen teammate and no revive already brewing.
      if (this.pendingRevive || this.reviveQ) return;
      if (!this.roster.some((p) => !this.alive.has(p.id))) return;
      this.pendingRevive = { buyerId: playerId };
    }
    if (type === 'double') fx.double = true;
    fx.usedThisQ.add(type);
    if (mode === 'coop') this.teamScore -= def.cost;
    else this.scores[playerId] -= def.cost;

    this.emit('powerup-applied', {
      qKey, playerId, type, cost: def.cost,
      teamScore: this.teamScore, scores: { ...this.scores },
    });
  }

  // ---------------- host: co-op revive ----------------
  async _startRevive() {
    const r = this.pendingRevive;
    this.pendingRevive = null;
    // The buyer fell before their moment — refund the team.
    if (!r || !this.alive.has(r.buyerId)) {
      this.teamScore += POWERUPS.revive.cost;
      this.emit('revive-result', {
        canceled: true, buyerId: r && r.buyerId, correct: false,
        teamScore: this.teamScore,
      });
      this._after(1200, () => this._coopNextQuestion());
      return;
    }
    const diff = royaleDifficulty(this.qIndex, this.settings.ramp, this.settings.staticDiff);
    this.reviveQ = {
      buyerId: r.buyerId,
      q: await this._drawQuestion(diff),
      qKey: `v-${this.qIndex}`,
      awaitingPick: false,
    };
    this.emit('revive-q', {
      qKey: this.reviveQ.qKey, q: this.reviveQ.q, buyerId: r.buyerId,
    });
  }

  _hostOnReviveAnswer(playerId, { qKey, idx }) {
    const rq = this.reviveQ;
    if (!rq || rq.qKey !== qKey || rq.buyerId !== playerId || rq.awaitingPick) return;
    const correct = idx === rq.q.correctIndex;
    const deadIds = this.roster.filter((p) => !this.alive.has(p.id)).map((p) => p.id);
    this.emit('revive-result', {
      qKey, buyerId: playerId, idx, correct, deadIds, teamScore: this.teamScore,
    });
    if (!correct) {
      this.reviveQ = null;
      this._after(REVEAL_MS, () => this._coopNextQuestion());
      return;
    }
    if (deadIds.length === 1) {
      this._applyRevive(deadIds[0]);
    } else {
      // The buyer chooses; auto-pick if they dither.
      rq.awaitingPick = true;
      this._after(REVIVE_PICK_MS, () => {
        if (this.reviveQ === rq && rq.awaitingPick) this._applyRevive(deadIds[0]);
      });
    }
  }

  _hostOnRevivePick(playerId, { targetId }) {
    const rq = this.reviveQ;
    if (!rq || !rq.awaitingPick || rq.buyerId !== playerId) return;
    if (this.alive.has(targetId) || !this.roster.some((p) => p.id === targetId)) return;
    this._applyRevive(targetId);
  }

  _applyRevive(targetId) {
    this.reviveQ = null;
    this.livesMap[targetId] = COOP_REVIVE_LIVES;
    this.alive.add(targetId);
    this.emit('revive-done', { targetId, livesMap: { ...this.livesMap } });
    this._after(1800, () => this._coopNextQuestion());
  }

  hostNextRound() {
    if (!this.isHost || this.phase !== 'intermission') return;
    this.emit('next-round', {});
    this._after(400, () => this._nextQuestion());
  }

  // ---------------- player actions (all roles) ----------------
  answer(idx) {
    if (!this.currentQ) return;

    // Ghost last shot: an eliminated player answering inside the window.
    if (this.ghostShotQKey && this.ghostShotQKey === this.currentQ.qKey
        && this.eliminated.has(this.me.id)) {
      if (this.ghostAnswered) return;
      this.ghostAnswered = true;
      const payload = { qKey: this.currentQ.qKey, idx };
      this.ui('me-submitted', { idx });
      if (this.isHost) this._hostOnGhostAnswer(this.me.id, payload);
      else this.t.send('ghost-answer', payload);
      return;
    }

    if (this.eliminated.has(this.me.id)) return; // spectators watch, only

    // Duel questions: only the duelist whose turn it is may answer.
    if (this.currentQ.duel) {
      if (this.currentQ.turnId !== this.me.id) return;
      if (this.phase !== 'answering' || this.myAnswered) return;
      this.myAnswered = true;
      const payload = { qKey: this.currentQ.qKey, idx };
      this.ui('me-submitted', { idx });
      if (this.isHost) this._hostOnDuelAnswer(this.me.id, payload);
      else this.t.send('duel-answer', payload);
      return;
    }

    // Revive questions: only the buyer answers.
    if (this.currentQ.revive) {
      if (this.currentQ.buyerId !== this.me.id) return;
      if (this.phase !== 'answering' || this.myAnswered) return;
      this.myAnswered = true;
      const payload = { qKey: this.currentQ.qKey, idx };
      this.ui('me-submitted', { idx });
      if (this.isHost) this._hostOnReviveAnswer(this.me.id, payload);
      else this.t.send('revive-answer', payload);
      return;
    }

    if (this.phase !== 'answering' || this.myAnswered || this.myLockedOut) return;
    if (performance.now() < this.frozenUntil) return;
    this.myAnswered = true;
    const elapsed = Math.max(0, Math.round(performance.now() - this.goAt));
    const payload = { qKey: this.currentQ.qKey, idx, elapsed };
    this.ui('me-submitted', { idx });
    if (this.isHost) this._hostOnAnswer(this.me.id, payload);
    else this.t.send('answer', payload);
  }

  // Royale: challenge another living player to a duel.
  buyDuel(targetId, stake) {
    if (this.settings.mode !== 'royale') return;
    if (this.eliminated.has(this.me.id)) return;
    if (this.phase !== 'answering' || !this.currentQ || this.currentQ.duel) return;
    if (this.usedPowerupsThisQ.has('duel')) return;
    const payload = { qKey: this.currentQ.qKey, targetId, stake };
    if (this.isHost) this._hostOnDuelRequest(this.me.id, payload);
    else this.t.send('duel-request', payload);
  }

  timeup() {
    if (this.eliminated.has(this.me.id)) return;
    if (this.phase !== 'answering' || this.myAnswered || this.myLockedOut) return;
    this.myLockedOut = true;
    const payload = { qKey: this.currentQ.qKey };
    this.ui('me-locked', { reason: 'timeout' });
    if (this.isHost) this._hostOnTimeup(this.me.id, payload);
    else this.t.send('timeup', payload);
  }

  buy(type) {
    if (this.eliminated.has(this.me.id)) return;
    if (this.phase !== 'answering') return;
    if (!this.currentQ || this.currentQ.duel || this.currentQ.revive) return;
    if (this.myAnswered || this.myLockedOut) return;
    if (performance.now() < this.frozenUntil) return;
    if (this.usedPowerupsThisQ.has(type)) return;
    if (!MODE_POWERUPS[this.settings.mode].includes(type)) return;
    const def = POWERUPS[type];
    const wallet = this.settings.mode === 'coop' ? this.teamScore : (this.scores[this.me.id] || 0);
    if (!def || wallet < def.cost) return;
    const payload = { qKey: this.currentQ.qKey, type };
    if (this.isHost) this._hostOnBuy(this.me.id, payload);
    else this.t.send('buy', payload);
  }

  // Co-op: the revive buyer picks who returns.
  pickRevive(targetId) {
    const payload = { targetId };
    if (this.isHost) this._hostOnRevivePick(this.me.id, payload);
    else this.t.send('revive-pick', payload);
  }

  voteRematch() {
    if (this.phase !== 'gameover') return;
    this.emit('rematch-vote', {});
  }

  quit() {
    this.t.send('quit', {});
    this.destroy();
  }

  // ---------------- shared event handling ----------------
  _handle(type, from, data) {
    switch (type) {
      case 'lobby-state': {
        if (this.isHost) return;
        // Guest: adopt host's settings + roster; detect "room full".
        const meIn = data.players.some((p) => p.id === this.me.id);
        if (!meIn) {
          if (this.phase === 'lobby') this.ui('room-full', { inGame: data.inGame });
          return;
        }
        // Seated players ignore lobby broadcasts mid-game (the host may
        // re-send lobby-state to turn away late joiners).
        if (this.phase !== 'lobby') return;
        this.settings = data.settings;
        this.roster = data.players;
        this.ui('lobby-update', this.lobbyView());
        return;
      }

      case 'start-game': {
        this.settings = data.settings;
        this.roster = data.roster;
        this.scores = { ...data.scores };
        this.myDouble = false;
        this.pot = 0;
        this.teamScore = data.teamScore || 0;
        this.livesMap = { ...(data.livesMap || {}) };
        this.eliminated = new Set();
        this.ghostShotQKey = null;
        this.phase = 'countdown';
        this.ui('game-start', { settings: this.settings, roster: this.roster, scores: this.scores });
        return;
      }

      case 'royale-ante': {
        this.scores = { ...data.scores };
        this.pot = data.pot;
        for (const id of data.eliminated) this.eliminated.add(id);
        this.ui('ante', data);
        return;
      }

      case 'question': {
        this.currentQ = data;
        if (data.pot !== undefined) this.pot = data.pot;
        if (data.teamScore !== undefined) this.teamScore = data.teamScore;
        if (data.livesMap) this.livesMap = { ...data.livesMap };
        this.phase = 'countdown';
        this.myAnswered = false;
        this.myLockedOut = false;
        this.myDeadlineExtra = 0;
        this.usedPowerupsThisQ = new Set();
        this.ghostShotQKey = null;
        this.ghostAnswered = false;
        this.ui('question', data);
        // Shared 3-2-1 lead-in, then answers unlock.
        setTimeout(() => {
          if (!this.currentQ || this.currentQ.qKey !== data.qKey) return;
          this.phase = 'answering';
          this.goAt = performance.now();
          this.ui('answers-unlocked', {
            qKey: data.qKey,
            duration: data.duration,
          });
        }, COUNTDOWN_MS);
        return;
      }

      case 'answer': {
        if (this.isHost && from !== this.me.id) this._hostOnAnswer(from, data);
        return;
      }
      case 'timeup': {
        if (this.isHost && from !== this.me.id) this._hostOnTimeup(from, data);
        return;
      }
      case 'buy': {
        if (this.isHost && from !== this.me.id) this._hostOnBuy(from, data);
        return;
      }

      case 'verdict': {
        this.scores = { ...data.scores };
        if (data.livesMap) {
          this.livesMap = { ...data.livesMap };
          // Co-op: a heartless player is out (until revived).
          for (const [id, n] of Object.entries(this.livesMap)) {
            if (n === 0) this.eliminated.add(id);
          }
        }
        if (data.playerId === this.me.id) {
          this.myLockedOut = true;
        }
        this.ui('verdict', data);
        return;
      }

      case 'powerup-applied': {
        this.scores = { ...data.scores };
        if (data.teamScore !== undefined) this.teamScore = data.teamScore;
        if (data.playerId === this.me.id) {
          this.usedPowerupsThisQ.add(data.type);
          if (data.type === 'double') this.myDouble = true;
          if (data.type === 'timewarp') this.myDeadlineExtra += TIMEWARP_MS;
        } else if (data.type === 'freeze') {
          // Freeze hits every player except the buyer.
          this.frozenUntil = performance.now() + FREEZE_MS;
        }
        this.ui('powerup', data);
        return;
      }

      case 'q-end': {
        this.scores = { ...data.scores };
        this.phase = 'reveal';
        if (data.pot !== undefined) this.pot = data.pot;
        if (data.teamScore !== undefined) this.teamScore = data.teamScore;
        if (data.livesMap) this.livesMap = { ...data.livesMap };
        for (const id of data.ghostRevived || []) this.eliminated.delete(id);
        for (const id of data.eliminated || []) this.eliminated.add(id);
        this.ghostShotQKey = null;
        if (data.winnerId === this.me.id && data.doubled) this.myDouble = false;
        this.ui('q-end', data);
        return;
      }

      case 'duel-request': {
        if (this.isHost && from !== this.me.id) this._hostOnDuelRequest(from, data);
        return;
      }

      case 'duel-pending': {
        if (data.a === this.me.id) this.usedPowerupsThisQ.add('duel');
        this.ui('duel-pending', data);
        return;
      }

      case 'duel-q': {
        this.currentQ = { qKey: data.qKey, q: data.q, duel: data.duel, turnId: data.turnId };
        this.phase = 'countdown';
        this.myAnswered = false;
        this.myLockedOut = false;
        this.ui('duel-q', data);
        // Short "⚔️" splash, then the duelist is up. No timer.
        setTimeout(() => {
          if (!this.currentQ || this.currentQ.qKey !== data.qKey) return;
          this.phase = 'answering';
          this.goAt = performance.now();
          this.ui('duel-unlocked', { qKey: data.qKey, turnId: data.turnId });
        }, 1100);
        return;
      }

      case 'duel-answer': {
        if (this.isHost && from !== this.me.id) this._hostOnDuelAnswer(from, data);
        return;
      }

      case 'duel-verdict': {
        this.ui('duel-verdict', data);
        return;
      }

      case 'duel-end': {
        if (data.scores) this.scores = { ...data.scores };
        for (const id of data.eliminated || []) this.eliminated.add(id);
        this.phase = 'reveal';
        this.ui('duel-end', data);
        return;
      }

      case 'ghost-shot': {
        this.ghostShotQKey = data.qKey;
        this.ghostAnswered = false;
        // Fresh clock for the revival window (the UI timer reads goAt).
        this.goAt = performance.now();
        this.myDeadlineExtra = 0;
        this.ui('ghost-shot', { ...data, mine: this.eliminated.has(this.me.id) });
        return;
      }

      case 'ghost-answer': {
        if (this.isHost && from !== this.me.id) this._hostOnGhostAnswer(from, data);
        return;
      }

      case 'revive-q': {
        this.currentQ = { qKey: data.qKey, q: data.q, revive: true, buyerId: data.buyerId };
        this.phase = 'countdown';
        this.myAnswered = false;
        this.myLockedOut = false;
        this.ui('revive-q', data);
        setTimeout(() => {
          if (!this.currentQ || this.currentQ.qKey !== data.qKey) return;
          this.phase = 'answering';
          this.goAt = performance.now();
          this.ui('revive-unlocked', { qKey: data.qKey, buyerId: data.buyerId });
        }, 1100);
        return;
      }

      case 'revive-answer': {
        if (this.isHost && from !== this.me.id) this._hostOnReviveAnswer(from, data);
        return;
      }

      case 'revive-result': {
        if (data.teamScore !== undefined) this.teamScore = data.teamScore;
        this.phase = 'reveal';
        this.ui('revive-result', data);
        return;
      }

      case 'revive-pick': {
        if (this.isHost && from !== this.me.id) this._hostOnRevivePick(from, data);
        return;
      }

      case 'revive-done': {
        this.livesMap = { ...data.livesMap };
        this.eliminated.delete(data.targetId);
        this.ui('revive-done', data);
        return;
      }

      case 'round-end': {
        this.phase = 'intermission';
        this.scores = { ...data.scores };
        this.ui('round-end', data);
        return;
      }

      case 'next-round': {
        this.ui('next-round', {});
        return;
      }

      case 'game-end': {
        this.phase = 'gameover';
        this.scores = { ...data.scores };
        this.ui('game-end', data);
        return;
      }

      case 'rematch-vote': {
        this.ui('rematch-vote', { from });
        if (this.isHost) {
          this.rematchVotes.add(from);
          if (this.rematchVotes.size >= this.roster.length) {
            this.rematchVotes.clear();
            this.start();
          }
        }
        return;
      }

      case 'player-left': {
        if (from !== this.me.id && !this.isHost) {
          this.roster = data.roster;
        }
        if (data.roster.length < 2) {
          this._clearHostTimers();
          this.ui('opponent-left', { name: data.name, fatal: true });
        } else {
          this.ui('player-left', { playerId: data.playerId, name: data.name });
        }
        return;
      }

      case 'quit': {
        if (from === this.me.id) return;
        if (this.isHost) {
          this._hostRemovePlayer(from);
        } else {
          const host = this.roster[0];
          if (host && from === host.id) {
            // Host left: the room is dead for everyone.
            this._clearHostTimers();
            this.ui('opponent-left', { name: host.name, fatal: true });
          }
          // Another guest quitting is announced by the host via player-left.
        }
        return;
      }
    }
  }
}
