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
  ROYALE_START, ROYALE_ANTE,
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
      ramp: 3, staticDiff: 'medium',
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
    this.myShield = false;           // mirrored badges (host holds the truth)
    this.myDouble = false;

    // Royale mode client state (mirrored from host events)
    this.pot = 0;
    this.eliminated = new Set();     // playerIds knocked out this game

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
      'game-end', 'rematch-vote', 'player-left', 'quit',
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
    if (!this.isHost || this.roster.length < 2) return;
    const royale = this.settings.mode === 'royale';
    this.ui('loading', { on: true });
    try {
      if (royale) {
        // Endless mode: pre-warm the pool for the opening difficulty;
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
    this.alive = new Set(this.roster.map((p) => p.id));
    for (const p of this.roster) {
      this.scores[p.id] = royale ? ROYALE_START : 0;
      this.fx[p.id] = {};
    }
    this.rematchVotes.clear();
    this.emit('start-game', { settings: this.settings, roster: this.roster, scores: this.scores });
    this._after(600, () => (royale ? this._royaleNextQuestion() : this._nextQuestion()));
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

  // ---------------- host: royale flow ----------------
  async _royaleNextQuestion() {
    this.qIndex += 1;

    // Ante phase: every surviving player pays into the pot. Running dry
    // on the ante alone is a legitimate (slow, ignoble) way to go out.
    const anteEliminated = [];
    for (const id of this.alive) {
      const paid = Math.min(ROYALE_ANTE, this.scores[id]);
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

    // Draw a question at the ramp dial's difficulty, refilling the pool
    // from the APIs as needed (reveal pauses hide the fetch time).
    const diff = royaleDifficulty(this.qIndex, this.settings.ramp, this.settings.staticDiff);
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
    const q = this.qPool[diff].shift();

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
      const fx = this.fx[playerId] || {};
      let delta = SCORE_WRONG;
      let shielded = false;
      if (fx.shield) { delta = 0; shielded = true; fx.shield = false; }
      this.scores[playerId] += delta;
      if (this.settings.mode === 'royale' && this.scores[playerId] < 0) {
        this.scores[playerId] = 0;
      }
      this.emit('verdict', {
        qKey, playerId, idx, correct: false, shielded, delta, scores: { ...this.scores },
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
      this.scores[winnerId] += winDelta;
    }

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
      eliminated,
      scores: { ...this.scores },
    });

    this._after(REVEAL_MS, () => {
      if (royale) {
        if (this.alive.size <= 1) this._royaleGameEnd();
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

  _hostOnBuy(playerId, { qKey, type }) {
    const hq = this.hq;
    const def = POWERUPS[type];
    if (!def || !hq || hq.resolved || hq.qKey !== qKey || !hq.active.has(playerId)) return;
    if (this.phase !== 'answering' && this.phase !== 'countdown') return;
    if (hq.lockedOut.has(playerId) || hq.answers.has(playerId)) return;
    if (type === 'timewarp' && !(this.settings.timer > 0)) return;
    const fx = this.fx[playerId] = this.fx[playerId] || {};
    fx.usedThisQ = fx.usedThisQ && fx.usedThisQKey === qKey ? fx.usedThisQ : new Set();
    fx.usedThisQKey = qKey;
    if (fx.usedThisQ.has(type)) return;
    if ((type === 'shield' && fx.shield) || (type === 'double' && fx.double)) return;
    if (this.scores[playerId] < def.cost) return;

    this.scores[playerId] -= def.cost;
    fx.usedThisQ.add(type);
    if (type === 'shield') fx.shield = true;
    if (type === 'double') fx.double = true;

    this.emit('powerup-applied', {
      qKey, playerId, type, cost: def.cost, scores: { ...this.scores },
    });
  }

  hostNextRound() {
    if (!this.isHost || this.phase !== 'intermission') return;
    this.emit('next-round', {});
    this._after(400, () => this._nextQuestion());
  }

  // ---------------- player actions (all roles) ----------------
  answer(idx) {
    if (this.eliminated.has(this.me.id)) return; // spectators watch, only
    if (this.phase !== 'answering' || this.myAnswered || this.myLockedOut) return;
    if (performance.now() < this.frozenUntil) return;
    this.myAnswered = true;
    const elapsed = Math.max(0, Math.round(performance.now() - this.goAt));
    const payload = { qKey: this.currentQ.qKey, idx, elapsed };
    this.ui('me-submitted', { idx });
    if (this.isHost) this._hostOnAnswer(this.me.id, payload);
    else this.t.send('answer', payload);
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
    if (this.myAnswered || this.myLockedOut) return;
    if (performance.now() < this.frozenUntil) return;
    if (this.usedPowerupsThisQ.has(type)) return;
    const def = POWERUPS[type];
    if (!def || (this.scores[this.me.id] || 0) < def.cost) return;
    const payload = { qKey: this.currentQ.qKey, type };
    if (this.isHost) this._hostOnBuy(this.me.id, payload);
    else this.t.send('buy', payload);
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
        this.myShield = false;
        this.myDouble = false;
        this.pot = 0;
        this.eliminated = new Set();
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
        this.phase = 'countdown';
        this.myAnswered = false;
        this.myLockedOut = false;
        this.myDeadlineExtra = 0;
        this.usedPowerupsThisQ = new Set();
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
        if (data.playerId === this.me.id) {
          this.myLockedOut = true;
          if (data.shielded) this.myShield = false;
        }
        this.ui('verdict', data);
        return;
      }

      case 'powerup-applied': {
        this.scores = { ...data.scores };
        if (data.playerId === this.me.id) {
          this.usedPowerupsThisQ.add(data.type);
          if (data.type === 'shield') this.myShield = true;
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
        for (const id of data.eliminated || []) this.eliminated.add(id);
        if (data.winnerId === this.me.id && data.doubled) this.myDouble = false;
        this.ui('q-end', data);
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
