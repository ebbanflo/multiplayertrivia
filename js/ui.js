// UI layer: renders engine events into the DOM. All game logic lives in
// game.js; this file only reads engine state and paints.

import { POWERUPS, FREEZE_MS, QUESTIONS_PER_ROUND } from './config.js';
import { sfx } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

export function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

export function modal(msg, btnLabel = 'OK') {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    $('#modal-text').textContent = msg;
    $('#modal-cancel').hidden = true;
    const btn = $('#modal-btn');
    btn.textContent = btnLabel;
    btn.onclick = () => { dlg.close(); resolve(); };
    dlg.oncancel = () => resolve();
    dlg.showModal();
  });
}

// Two-button variant; resolves true on OK, false on cancel/Esc.
export function confirmModal(msg, okLabel = 'YES') {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    $('#modal-text').textContent = msg;
    const ok = $('#modal-btn');
    const cancel = $('#modal-cancel');
    cancel.hidden = false;
    ok.textContent = okLabel;
    ok.onclick = () => { dlg.close(); resolve(true); };
    cancel.onclick = () => { dlg.close(); resolve(false); };
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

function scorePop(anchorEl, delta) {
  const r = anchorEl.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = `score-pop ${delta >= 0 ? 'plus' : 'minus'}`;
  el.textContent = `${delta >= 0 ? '+' : ''}${delta}`;
  el.style.left = `${r.left + r.width / 2 - 20}px`;
  el.style.top = `${r.top}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

function bumpScore(el, up) {
  el.classList.remove('bump-up', 'bump-down');
  void el.offsetWidth; // restart animation
  el.classList.add(up ? 'bump-up' : 'bump-down');
}

export class GameUI {
  constructor(engine) {
    this.g = engine;
    this.timerRaf = null;
    this.timerDuration = null;
    this.lastTickSecond = null;
    this.countdownTimers = [];
    this._bindDom();
    this._bindEngine();
  }

  // ---------- static DOM bindings ----------
  _bindDom() {
    // lobby settings chips (host only — guest gets .readonly)
    $$('#settings-panel .setting-options').forEach((group) => {
      group.addEventListener('click', (ev) => {
        const chip = ev.target.closest('.chip');
        if (!chip) return;
        sfx.click();
        const key = group.dataset.setting;
        const raw = chip.dataset.value;
        const value = key === 'difficulty' ? raw : parseInt(raw, 10);
        this.g.updateSetting(key === 'timer' ? 'timer' : key, value);
      });
    });

    $('#btn-copy-code').addEventListener('click', async () => {
      sfx.click();
      try {
        await navigator.clipboard.writeText(this.g.t.code);
        toast('CODE COPIED!');
      } catch {
        toast(`CODE: ${this.g.t.code}`);
      }
    });

    $('#btn-start').addEventListener('click', () => { sfx.go(); this.g.start(); });
    $('#btn-next-round').addEventListener('click', () => { sfx.click(); this.g.hostNextRound(); });
    $('#btn-rematch').addEventListener('click', () => {
      sfx.click();
      this.g.voteRematch();
      $('#btn-rematch').disabled = true;
      $('#gameover-status').textContent = 'Waiting for your opponent to accept…';
    });
    $('#btn-exit').addEventListener('click', () => this._leave());
    $('#btn-lobby-leave').addEventListener('click', () => this._leave());

    // Quit to main menu mid-match (game screen + intermission), with a
    // confirm so a stray click doesn't end the battle.
    const quitWithConfirm = async () => {
      sfx.click();
      if (await confirmModal('Quit to the main menu? This ends the battle for both players!', 'QUIT')) {
        this._leave();
      }
    };
    $('#btn-quit-game').addEventListener('click', quitWithConfirm);
    $('#btn-quit-intermission').addEventListener('click', quitWithConfirm);

    $$('.answer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        sfx.click();
        this.g.answer(idx);
      });
    });

    // keyboard: A/B/C/D or 1-4 answer, number keys handy on desktop
    document.addEventListener('keydown', (ev) => {
      if (this.g.phase !== 'answering') return;
      const map = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 };
      const idx = map[ev.key.toLowerCase()];
      if (idx !== undefined && !$$('.answer-btn')[idx].disabled) {
        sfx.click();
        this.g.answer(idx);
      }
    });

    this._renderShop();
  }

  _leave() {
    this.g.quit();
    // Full reset, keeping query params (transport mode etc.)
    location.href = location.pathname + location.search;
  }

  // ---------- engine event bindings ----------
  _bindEngine() {
    const g = this.g;

    g.onUI('lobby-update', (v) => this._renderLobby(v));

    g.onUI('loading', ({ on }) => {
      $('#lobby-status').textContent = on ? 'Fetching questions from the trivia mines…' : '';
      $('#btn-start').disabled = on || !g.opponent;
    });

    g.onUI('room-full', ({ inGame }) => {
      modal(inGame ? 'That room is mid-battle. Try another code!' : 'That room is full! Two clay warriors max.')
        .then(() => this._leave());
    });

    g.onUI('game-start', () => {
      $('#hud-me-name').textContent = g.me.name.toUpperCase();
      $('#hud-them-name').textContent = (g.opponent?.name || 'THEM').toUpperCase();
      this._setScores();
      $('#hud-me-effects').innerHTML = '';
      $('#hud-them-effects').innerHTML = '';
      showScreen('screen-game');
      sfx.go();
    });

    g.onUI('question', (data) => this._renderQuestion(data));

    g.onUI('answers-unlocked', ({ duration }) => {
      $('#countdown-overlay').classList.remove('show');
      this._setAnswersEnabled(true);
      this._refreshShop();
      this._startTimer(duration);
      sfx.go();
    });

    g.onUI('me-submitted', ({ idx }) => {
      const btn = $$('.answer-btn')[idx];
      btn.classList.add('picked');
      this._setAnswersEnabled(false);
    });

    g.onUI('me-locked', () => {
      this._setAnswersEnabled(false);
    });

    g.onUI('verdict', (data) => {
      const mine = data.playerId === g.me.id;
      this._setScores(data.delta ? { [data.playerId]: data.delta } : null);
      if (mine) {
        sfx.wrong();
        const btn = $$('.answer-btn')[data.idx];
        if (btn) btn.classList.add('wrong-reveal');
        this._banner(data.shielded ? '🛡️ SHIELDED!' : 'WRONG!', data.shielded ? 'info' : 'bad');
        this._setAnswersEnabled(false);
        if (data.shielded) this._refreshFxBadges();
      } else {
        // Show exactly which answer the opponent whiffed on.
        sfx.steal();
        this._stampAnswer(data.idx, g.opponent?.name, 'wrong');
        toast(`${(g.opponent?.name || 'THEM').toUpperCase()} WHIFFED! ${data.shielded ? '(shielded)' : ''}`);
      }
      this._refreshShop();
    });

    g.onUI('powerup', (data) => {
      const mine = data.playerId === g.me.id;
      const def = POWERUPS[data.type];
      this._setScores();
      this._refreshShop();
      this._refreshFxBadges();
      if (mine) {
        sfx.powerup();
        toast(`${def.icon} ${def.name} ACTIVATED!`);
        if (data.type === 'fifty') this._applyFifty();
        if (data.type === 'timewarp') toast('⏰ +15 SECONDS!');
      } else {
        if (data.type === 'freeze') {
          sfx.freeze();
          this._showFreeze();
        } else {
          toast(`${(g.opponent?.name || 'THEM').toUpperCase()} bought ${def.icon} ${def.name}!`);
        }
      }
    });

    g.onUI('q-end', (data) => this._renderQEnd(data));

    g.onUI('round-end', ({ round, scores }) => {
      this._stopTimer();
      $('#intermission-heading').textContent = `ROUND ${round} DONE!`;
      this._renderBoard($('#intermission-board'), scores);
      const isHost = g.isHost;
      $('#btn-next-round').style.display = isHost ? '' : 'none';
      $('#intermission-status').textContent = isHost
        ? 'Take a breath, then hit it!'
        : `Waiting for ${(g.opponent?.name || 'the host').toUpperCase()} to start the next round…`;
      showScreen('screen-intermission');
    });

    g.onUI('next-round', () => {
      showScreen('screen-game');
    });

    g.onUI('game-end', ({ scores, winnerId }) => {
      this._stopTimer();
      const won = winnerId === g.me.id;
      const tie = winnerId === null;
      $('#gameover-title').textContent = tie ? "IT'S A TIE?!" : (won ? 'YOU WIN!' : 'SQUASHED!');
      this._renderBoard($('#final-board'), scores, winnerId);
      $('#btn-rematch').disabled = false;
      $('#gameover-status').textContent = tie ? 'Great minds squish alike.' : (won ? 'Absolute trivia titan.' : 'Avenge yourself with a rematch!');
      showScreen('screen-gameover');
      if (won) { sfx.fanfare(); this._confetti(); } else if (tie) { sfx.join(); } else { sfx.womp(); }
    });

    g.onUI('rematch-vote', ({ from }) => {
      if (from !== g.me.id) toast(`${(g.opponent?.name || 'THEM').toUpperCase()} WANTS A REMATCH!`);
    });

    g.onUI('opponent-left', ({ name }) => {
      this._stopTimer();
      modal(`${(name || 'Your opponent').toUpperCase()} left the game!`).then(() => this._leave());
    });
  }

  // ---------- lobby ----------
  _renderLobby(v) {
    showScreen('screen-lobby');
    $('#room-code').textContent = v.code;
    $('#lobby-p1-name').textContent = (v.me.role === 'host' ? v.me.name : v.opponent?.name || '…').toUpperCase();
    const p2 = v.me.role === 'host' ? v.opponent : v.me;
    $('#lobby-p2-name').textContent = p2 ? p2.name.toUpperCase() : 'waiting…';
    $('#lobby-p2-avatar').classList.toggle('waiting', !p2);
    $('#lobby-p2-avatar .avatar-face').textContent = p2 ? '·‿·' : 'z_z';

    $('#settings-panel').classList.toggle('readonly', !v.canStart && v.me.role !== 'host');
    $$('#settings-panel .setting-options').forEach((group) => {
      const key = group.dataset.setting;
      const current = String(v.settings[key]);
      group.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.toggle('selected', chip.dataset.value === current);
      });
    });

    if (v.me.role === 'host') {
      $('#btn-start').style.display = '';
      $('#btn-start').disabled = !v.opponent;
      $('#lobby-status').textContent = v.opponent
        ? 'Opponent locked in. START WHEN READY!'
        : 'Share the code with your opponent!';
    } else {
      $('#btn-start').style.display = 'none';
      $('#lobby-status').textContent = `Waiting for ${(v.opponent?.name || 'the host').toUpperCase()} to start…`;
    }
  }

  // ---------- question flow ----------
  _renderQuestion({ qKey, round, qIndex, totalRounds, q, duration }) {
    this._stopTimer();
    $('#verdict-banner').className = 'verdict-banner';
    $('#hud-round').textContent = `R${round}/${totalRounds} · Q${qIndex + 1}/${QUESTIONS_PER_ROUND}`;
    $('#q-category').textContent = q.category;
    const diffEl = $('#q-difficulty');
    diffEl.textContent = q.difficulty.toUpperCase();
    diffEl.dataset.diff = q.difficulty;
    $('#q-text').textContent = q.text;

    const card = $('#question-card');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';

    $$('.answer-btn').forEach((btn, i) => {
      btn.className = 'answer-btn';
      btn.querySelector('.answer-text').textContent = q.answers[i] ?? '';
      btn.querySelectorAll('.answer-stamp').forEach((s) => s.remove());
      btn.disabled = true;
    });

    this._renderTimerIdle(duration);
    this._refreshShop();
    this._refreshFxBadges();

    // 3..2..1 countdown
    this.countdownTimers.forEach(clearTimeout);
    this.countdownTimers = [];
    const overlay = $('#countdown-overlay');
    const num = $('#countdown-num');
    overlay.classList.add('show');
    [3, 2, 1].forEach((n, i) => {
      this.countdownTimers.push(setTimeout(() => {
        num.textContent = n;
        num.style.animation = 'none';
        void num.offsetWidth;
        num.style.animation = '';
        sfx.countdown();
      }, i * 1000));
    });
  }

  _setAnswersEnabled(on) {
    $$('.answer-btn').forEach((btn) => {
      if (on && (btn.classList.contains('zapped') || btn.classList.contains('picked'))) return;
      btn.disabled = !on;
    });
  }

  _applyFifty() {
    const correct = this.g.currentQ.q.correctIndex;
    const wrong = [0, 1, 2, 3].filter((i) => i !== correct);
    // zap two random wrong answers
    wrong.sort(() => Math.random() - 0.5);
    wrong.slice(0, 2).forEach((i) => {
      const btn = $$('.answer-btn')[i];
      btn.classList.add('zapped');
      btn.disabled = true;
    });
  }

  // Pin the opponent's name to the answer they chose, with a wobble-in
  // animation — red-tinted shake for a miss, teal pop for a win.
  _stampAnswer(idx, name, kind) {
    const btn = $$('.answer-btn')[idx];
    if (!btn || btn.querySelector('.answer-stamp')) return;
    const stamp = document.createElement('span');
    stamp.className = `answer-stamp ${kind}`;
    stamp.textContent = `${kind === 'wrong' ? '✖' : '★'} ${(name || 'THEM').toUpperCase()}`;
    btn.appendChild(stamp);
    if (kind === 'wrong') btn.classList.add('them-wrong');
  }

  _showFreeze() {
    const overlay = $('#freeze-overlay');
    overlay.classList.add('show');
    this._setAnswersEnabled(false);
    setTimeout(() => {
      overlay.classList.remove('show');
      if (this.g.phase === 'answering' && !this.g.myAnswered && !this.g.myLockedOut) {
        this._setAnswersEnabled(true);
      }
    }, FREEZE_MS);
  }

  _banner(text, kind) {
    const b = $('#verdict-banner');
    b.textContent = text;
    b.className = `verdict-banner ${kind}`;
    void b.offsetWidth;
    b.classList.add('show');
  }

  _renderQEnd(data) {
    this._stopTimer();
    this._setAnswersEnabled(false);
    $('#countdown-overlay').classList.remove('show');
    $('#freeze-overlay').classList.remove('show');

    const btns = $$('.answer-btn');
    const correctBtn = btns[data.correctIndex];
    if (correctBtn) {
      correctBtn.classList.remove('zapped', 'dimmed');
      correctBtn.classList.add('correct-reveal');
    }
    btns.forEach((b, i) => { if (i !== data.correctIndex) b.classList.add('dimmed'); });

    this._setScores(data.winnerId && data.winDelta ? { [data.winnerId]: data.winDelta } : null);
    this._refreshFxBadges();

    if (data.winnerId === this.g.me.id) {
      sfx.correct();
      this._banner(data.doubled ? `✖️2 +${data.winDelta}!!` : `+${data.winDelta}!`, 'good');
    } else if (data.winnerId) {
      sfx.steal();
      this._stampAnswer(data.correctIndex, this.g.opponent?.name, 'correct');
      this._banner(`${(this.g.opponent?.name || 'THEM').toUpperCase()} GOT IT!`, 'bad');
    } else {
      sfx.womp();
      this._banner(data.reason === 'timeout' ? "TIME'S UP!" : 'NOBODY GOT IT!', 'info');
    }
  }

  // ---------- timer ----------
  _renderTimerIdle(duration) {
    const wrap = $('#timer-wrap');
    wrap.classList.remove('low');
    wrap.classList.toggle('no-timer', !duration);
    $('#timer-bar').style.transform = 'scaleX(1)';
    $('#timer-num').textContent = duration ? Math.round(duration / 1000) : '∞';
  }

  _startTimer(duration) {
    this._stopTimer();
    if (!duration) return; // no-timer mode
    const g = this.g;
    const wrap = $('#timer-wrap');
    const bar = $('#timer-bar');
    const num = $('#timer-num');
    this.lastTickSecond = null;

    const frame = () => {
      const total = duration + g.myDeadlineExtra;
      const left = Math.max(0, total - (performance.now() - g.goAt));
      bar.style.transform = `scaleX(${left / total})`;
      const secs = Math.ceil(left / 1000);
      num.textContent = secs;
      wrap.classList.toggle('low', left < 10000 && left > 0);
      if (left < 6000 && secs !== this.lastTickSecond && g.phase === 'answering' && !g.myAnswered && !g.myLockedOut) {
        this.lastTickSecond = secs;
        if (left > 0) sfx.tick();
      }
      if (left <= 0) {
        g.timeup();
        this.timerRaf = null;
        return;
      }
      this.timerRaf = requestAnimationFrame(frame);
    };
    this.timerRaf = requestAnimationFrame(frame);
  }

  _stopTimer() {
    if (this.timerRaf) cancelAnimationFrame(this.timerRaf);
    this.timerRaf = null;
  }

  // ---------- scores / badges / shop ----------
  _setScores(deltas) {
    const g = this.g;
    const meEl = $('#hud-me-score');
    const themEl = $('#hud-them-score');
    meEl.textContent = g.scores[g.me.id] ?? 0;
    themEl.textContent = (g.opponent && g.scores[g.opponent.id]) ?? 0;
    if (deltas) {
      for (const [pid, d] of Object.entries(deltas)) {
        const el = pid === g.me.id ? meEl : themEl;
        bumpScore(el, d >= 0);
        scorePop(el, d);
      }
    }
  }

  _refreshFxBadges() {
    const g = this.g;
    const mine = [];
    if (g.myShield) mine.push('🛡️');
    if (g.myDouble) mine.push('✖️2');
    $('#hud-me-effects').innerHTML = mine.map((x) => `<span>${x}</span>`).join('');
  }

  _renderShop() {
    const wrap = $('#shop-items');
    wrap.innerHTML = '';
    for (const [key, def] of Object.entries(POWERUPS)) {
      const btn = document.createElement('button');
      btn.className = 'powerup-btn';
      btn.dataset.type = key;
      btn.innerHTML = `
        <span class="pu-icon">${def.icon}</span>
        <span class="pu-info">
          <span class="pu-name">${def.name}</span>
          <span class="pu-desc">${def.desc}</span>
        </span>
        <span class="pu-cost">${def.cost}</span>`;
      btn.addEventListener('click', () => { this.g.buy(key); });
      wrap.appendChild(btn);
    }
  }

  _refreshShop() {
    const g = this.g;
    const myScore = g.scores[g.me.id] ?? 0;
    $$('.powerup-btn').forEach((btn) => {
      const type = btn.dataset.type;
      const def = POWERUPS[type];
      const used = g.usedPowerupsThisQ.has(type);
      const timerless = type === 'timewarp' && !(g.settings.timer > 0);
      const stacked = (type === 'shield' && g.myShield) || (type === 'double' && g.myDouble);
      btn.classList.toggle('used', used);
      btn.disabled = used || stacked || timerless
        || myScore < def.cost
        || g.phase !== 'answering'
        || g.myAnswered || g.myLockedOut;
    });
  }

  // ---------- scoreboard / confetti ----------
  _renderBoard(el, scores, winnerId) {
    const g = this.g;
    el.innerHTML = '';
    const entries = [
      { id: g.me.id, name: g.me.name, score: scores[g.me.id] ?? 0 },
      ...(g.opponent ? [{ id: g.opponent.id, name: g.opponent.name, score: scores[g.opponent.id] ?? 0 }] : []),
    ].sort((a, b) => b.score - a.score);
    const top = entries[0]?.score;
    for (const e of entries) {
      const card = document.createElement('div');
      const isLeader = e.score === top && entries.length > 1 && entries[0].score !== entries[1].score;
      card.className = `score-card${isLeader ? ' leader' : ''}`;
      card.innerHTML = `
        ${isLeader || winnerId === e.id ? '<span class="sc-crown">👑</span>' : ''}
        <span class="sc-name">${e.name}</span>
        <span class="sc-points">${e.score}</span>`;
      el.appendChild(card);
    }
  }

  _confetti() {
    const layer = $('#confetti-layer');
    layer.innerHTML = '';
    const colors = ['#ff4fa3', '#23c4b2', '#ffd93d', '#7b5be6', '#7fe348', '#ff8a3d'];
    for (let i = 0; i < 90; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}%`;
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = `${2 + Math.random() * 2.5}s`;
      c.style.animationDelay = `${Math.random() * 1.2}s`;
      c.style.borderRadius = Math.random() > 0.5 ? '50%' : '20%';
      layer.appendChild(c);
    }
  }
}
