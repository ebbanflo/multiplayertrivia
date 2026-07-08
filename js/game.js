// Game engine. The HOST is authoritative: it owns the question list,
// scores, answer arbitration and power-up validation, and broadcasts
// every state change. The GUEST mirrors state from host events. Both
// roles run the same engine; host-only logic is guarded by this.isHost.
//
// UI code subscribes with engine.onUI(event, fn) and never touches the
// network directly.

import {
  QUESTIONS_PER_ROUND, COUNTDOWN_MS, REVEAL_MS, RESOLVE_GRACE_MS,
  SCORE_BASE, SCORE_SPEED_MAX, SCORE_WRONG,
  POWERUPS, FREEZE_MS, TIMEWARP_MS,
} from './config.js';
import { buildQuestionSet } from './questions.js';

export class Game {
  constructor(transport, self) {
    this.t = transport;
    this.me = self;                  // { id, name, role: 'host' | 'guest' }
    this.isHost = self.role === 'host';
    this.opponent = null;            // { id, name }
    this.settings = { difficulty: 'medium', timer: 60, rounds: 1 };
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

    // Host-only state
    this.questions = [];
    this.qIndex = -1;
    this.usedTexts = new Set();
    this.hq = null;                  // per-question arbitration state
    this.fx = {};                    // playerId -> { shield, double }
    this.rematchVotes = new Set();
    this.hostTimers = [];

    this._wire();
  }

  // ---------------- UI plumbing ----------------
  onUI(event, fn) {
    if (!this.uiHandlers.has(event)) this.uiHandlers.set(event, []);
    this.uiHandlers.get(event).push(fn);
  }
  ui(event, data) {
    for (const fn of this.uiHandlers.get(event) || []) fn(data);
  }

  // Broadcast to the peer AND handle locally (transports never echo).
  emit(type, data) {
    this.t.send(type, data);
    this._handle(type, this.me.id, data);
  }

  // ---------------- lifecycle ----------------
  _wire() {
    const types = [
      'lobby-state', 'start-game', 'question', 'answer', 'timeup', 'buy',
      'powerup-applied', 'verdict', 'q-end', 'round-end', 'next-round',
      'game-end', 'rematch-vote', 'quit',
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
    const others = members.filter((m) => m.id !== this.me.id);
    if (this.isHost) {
      const guests = others.filter((m) => m.role === 'guest');
      const guest = this.opponent
        ? guests.find((m) => m.id === this.opponent.id)
        : guests[0];
      if (guest && !this.opponent) {
        this.opponent = { id: guest.id, name: guest.name };
        this.scores = { [this.me.id]: 0, [this.opponent.id]: 0 };
        this._broadcastLobby();
        this.ui('lobby-update', this.lobbyView());
      } else if (!guest && this.opponent) {
        const left = this.opponent;
        this.opponent = null;
        if (this.phase === 'lobby') {
          this.ui('lobby-update', this.lobbyView());
        } else {
          this._clearHostTimers();
          this.ui('opponent-left', { name: left.name });
        }
      }
      // Any extra guest beyond our opponent: re-broadcast the lobby so
      // they learn the room is taken and bow out.
      if (this.opponent && guests.some((m) => m.id !== this.opponent.id)) {
        this._broadcastLobby();
      }
    } else {
      const host = others.find((m) => m.role === 'host');
      if (host && !this.opponent) {
        this.opponent = { id: host.id, name: host.name };
        this.ui('lobby-update', this.lobbyView());
      } else if (!host && this.opponent && this.phase !== 'gameover') {
        this.ui('opponent-left', { name: this.opponent.name });
      }
    }
  }

  lobbyView() {
    return {
      code: this.t.code,
      me: this.me,
      opponent: this.opponent,
      settings: this.settings,
      canStart: this.isHost && !!this.opponent,
    };
  }

  _broadcastLobby() {
    if (!this.isHost) return;
    this.t.send('lobby-state', {
      settings: this.settings,
      players: [
        { id: this.me.id, name: this.me.name, role: 'host' },
        ...(this.opponent ? [{ id: this.opponent.id, name: this.opponent.name, role: 'guest' }] : []),
      ],
      inGame: this.phase !== 'lobby',
    });
  }

  // Host lobby controls
  updateSetting(key, value) {
    if (!this.isHost || this.phase !== 'lobby') return;
    this.settings[key] = value;
    this._broadcastLobby();
    this.ui('lobby-update', this.lobbyView());
  }

  // ---------------- host: game flow ----------------
  async start() {
    if (!this.isHost || !this.opponent) return;
    this.ui('loading', { on: true });
    try {
      this.questions = await buildQuestionSet(
        this.settings.difficulty, this.settings.rounds, this.usedTexts,
      );
    } finally {
      this.ui('loading', { on: false });
    }
    this.qIndex = -1;
    this.scores = { [this.me.id]: 0, [this.opponent.id]: 0 };
    this.fx = { [this.me.id]: {}, [this.opponent.id]: {} };
    this.rematchVotes.clear();
    this.emit('start-game', { settings: this.settings, scores: this.scores });
    this._after(600, () => this._nextQuestion());
  }

  _nextQuestion() {
    this.qIndex += 1;
    const q = this.questions[this.qIndex];
    const round = Math.floor(this.qIndex / QUESTIONS_PER_ROUND) + 1;
    const qKey = `${round}-${this.qIndex % QUESTIONS_PER_ROUND}`;
    this.hq = {
      qKey,
      q,
      answers: new Map(),
      lockedOut: new Set(),
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

  _speedBonus(elapsedMs, durationMs) {
    if (durationMs) {
      const remaining = Math.max(0, durationMs - elapsedMs);
      return Math.round(SCORE_SPEED_MAX * (remaining / durationMs));
    }
    // No-timer mode: bonus decays over a virtual 60s window.
    return Math.max(10, SCORE_SPEED_MAX - Math.floor(elapsedMs / 600));
  }

  _hostOnAnswer(playerId, { qKey, idx, elapsed }) {
    const hq = this.hq;
    if (!hq || hq.resolved || hq.qKey !== qKey) return;
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
      this.emit('verdict', {
        qKey, playerId, idx, correct: false, shielded, delta, scores: { ...this.scores },
      });
      if (hq.lockedOut.size >= 2) {
        this._resolveOrEnd('locked');
      } else if (hq.candidates.length) {
        // The other player already answered correctly — no contest left.
        this._resolveOrEnd('correct');
      }
      return;
    }

    hq.candidates.push({ playerId, elapsed, idx });
    const opponentDone = hq.lockedOut.has(this._other(playerId)) || hq.answers.has(this._other(playerId));
    if (opponentDone) {
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
    if (!hq || hq.resolved || hq.qKey !== qKey) return;
    if (hq.answers.has(playerId) || hq.lockedOut.has(playerId)) return;
    hq.lockedOut.add(playerId);
    if (hq.candidates.length) {
      this._resolveOrEnd('correct');
    } else if (hq.lockedOut.size >= 2) {
      this._resolveOrEnd('timeout');
    }
  }

  _other(playerId) {
    return playerId === this.me.id ? (this.opponent && this.opponent.id) : this.me.id;
  }

  _resolveOrEnd(reason) {
    const hq = this.hq;
    if (!hq || hq.resolved) return;
    hq.resolved = true;
    if (hq.graceTimer) clearTimeout(hq.graceTimer);

    let winnerId = null;
    let winDelta = 0;
    let doubled = false;
    if (hq.candidates.length) {
      hq.candidates.sort((a, b) => a.elapsed - b.elapsed);
      const w = hq.candidates[0];
      winnerId = w.playerId;
      const duration = this.settings.timer > 0 ? this.settings.timer * 1000 : null;
      winDelta = SCORE_BASE + this._speedBonus(w.elapsed, duration);
      const fx = this.fx[winnerId] || {};
      if (fx.double) { winDelta *= 2; doubled = true; fx.double = false; }
      this.scores[winnerId] += winDelta;
    }

    const isLastInRound = (this.qIndex % QUESTIONS_PER_ROUND) === QUESTIONS_PER_ROUND - 1;
    const isLastQuestion = this.qIndex === this.questions.length - 1;

    this.emit('q-end', {
      qKey: hq.qKey,
      correctIndex: hq.q.correctIndex,
      winnerId,
      winDelta,
      doubled,
      reason,
      scores: { ...this.scores },
    });

    this._after(REVEAL_MS, () => {
      if (isLastQuestion) {
        const [a, b] = [this.me.id, this.opponent && this.opponent.id];
        const winner = this.scores[a] === this.scores[b] ? null
          : (this.scores[a] > this.scores[b] ? a : b);
        this.phase = 'gameover';
        this.emit('game-end', { scores: { ...this.scores }, winnerId: winner });
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
    if (!def || !hq || hq.resolved || hq.qKey !== qKey) return;
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

  // ---------------- player actions (both roles) ----------------
  answer(idx) {
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
    if (this.phase !== 'answering' || this.myAnswered || this.myLockedOut) return;
    this.myLockedOut = true;
    const payload = { qKey: this.currentQ.qKey };
    this.ui('me-locked', { reason: 'timeout' });
    if (this.isHost) this._hostOnTimeup(this.me.id, payload);
    else this.t.send('timeup', payload);
  }

  buy(type) {
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
        // Guest: adopt host's settings; detect "room full".
        const meIn = data.players.some((p) => p.id === this.me.id);
        if (!meIn) {
          this.ui('room-full', { inGame: data.inGame });
          return;
        }
        this.settings = data.settings;
        const host = data.players.find((p) => p.role === 'host');
        if (host) this.opponent = { id: host.id, name: host.name };
        this.ui('lobby-update', this.lobbyView());
        return;
      }

      case 'start-game': {
        this.settings = data.settings;
        this.scores = { ...data.scores };
        this.myShield = false;
        this.myDouble = false;
        this.phase = 'countdown';
        this.ui('game-start', { settings: this.settings, scores: this.scores });
        return;
      }

      case 'question': {
        this.currentQ = data;
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
          this.frozenUntil = performance.now() + FREEZE_MS;
        }
        this.ui('powerup', data);
        return;
      }

      case 'q-end': {
        this.scores = { ...data.scores };
        this.phase = 'reveal';
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
          if (this.rematchVotes.size >= 2) {
            this.rematchVotes.clear();
            this.start();
          }
        }
        return;
      }

      case 'quit': {
        if (from !== this.me.id) {
          this._clearHostTimers();
          this.ui('opponent-left', { name: this.opponent ? this.opponent.name : 'opponent' });
        }
        return;
      }
    }
  }
}
