// UI layer: renders engine events into the DOM. All game logic lives in
// game.js; this file only reads engine state and paints.
//
// Player colors are assigned by roster slot (host = 0), so every player
// sees the same color for the same person.

import { POWERUPS, MODE_POWERUPS, FREEZE_MS, QUESTIONS_PER_ROUND, MAX_PLAYERS } from './config.js';
import { sfx } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const FACES = ['·‿·', '•ᴗ•', '˙ᵕ˙', '·o·'];

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

// Haptic feedback on phones; a no-op elsewhere.
function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not worth crashing over */ }
}

// Keep phone screens awake during a match. Browsers silently release
// the lock when the tab is hidden, so we re-acquire on return.
let wakeLock = null;
let wantWakeLock = false;
async function acquireWakeLock() {
  wantWakeLock = true;
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* low battery / unsupported — fine */ }
}
function releaseWakeLock() {
  wantWakeLock = false;
  try { wakeLock?.release(); } catch { /* already gone */ }
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) acquireWakeLock();
});

export class GameUI {
  constructor(engine) {
    this.g = engine;
    this.timerRaf = null;
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
        const stringKeys = ['difficulty', 'mode', 'staticDiff'];
        const value = stringKeys.includes(key) ? raw : parseInt(raw, 10);
        this.g.updateSetting(key, value);
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

    // Shareable link: friends land on a one-tap "JOIN ROOM XXXX" button.
    $('#btn-copy-link').addEventListener('click', async () => {
      sfx.click();
      const params = new URLSearchParams(location.search);
      params.set('join', this.g.t.code);
      const link = `${location.origin}${location.pathname}?${params}`;
      try {
        await navigator.clipboard.writeText(link);
        toast('LINK COPIED! Paste it to your friends.');
      } catch {
        toast(link);
      }
    });

    $('#btn-start').addEventListener('click', () => { sfx.go(); this.g.start(); });
    $('#btn-next-round').addEventListener('click', () => { sfx.click(); this.g.hostNextRound(); });
    $('#btn-rematch').addEventListener('click', () => {
      sfx.click();
      this.g.voteRematch();
      $('#btn-rematch').disabled = true;
      if (this.g.settings.mode !== 'solo') {
        $('#gameover-status').textContent = 'Waiting for the other players to accept…';
      }
    });
    $('#btn-exit').addEventListener('click', () => this._leave());
    $('#btn-lobby-leave').addEventListener('click', () => this._leave());

    // Quit to main menu mid-match (game screen + intermission), with a
    // confirm so a stray click doesn't end the battle.
    const quitWithConfirm = async () => {
      sfx.click();
      if (await confirmModal('Quit to the main menu? You leave the battle for good!', 'QUIT')) {
        this._leave();
      }
    };
    $('#btn-quit-game').addEventListener('click', quitWithConfirm);
    $('#btn-quit-intermission').addEventListener('click', quitWithConfirm);

    // Privacy pause: hides this screen only — the match keeps running.
    $('#btn-pause').addEventListener('click', () => {
      sfx.click();
      $('#pause-overlay').hidden = false;
    });
    $('#btn-resume').addEventListener('click', () => {
      sfx.go();
      $('#pause-overlay').hidden = true;
    });

    // duel challenge dialog
    const stakeInput = $('#duel-stake');
    stakeInput.addEventListener('input', () => {
      $('#duel-stake-val').textContent = stakeInput.value;
    });
    $('#btn-duel-cancel').addEventListener('click', () => { sfx.click(); $('#duel-modal').close(); });
    $('#btn-revive-pick').addEventListener('click', () => {
      const sel = $('#revive-targets .chip.selected');
      if (!sel) return;
      sfx.go();
      this.g.pickRevive(sel.dataset.pid);
      $('#revive-modal').close();
    });
    $('#btn-duel-go').addEventListener('click', () => {
      const sel = $('#duel-targets .chip.selected');
      if (!sel) return;
      sfx.go();
      this.g.buyDuel(sel.dataset.pid, parseInt(stakeInput.value, 10));
      $('#duel-modal').close();
    });

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
    releaseWakeLock();
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
      $('#btn-start').disabled = on || g.roster.length < 2;
    });

    g.onUI('room-full', ({ inGame }) => {
      modal(inGame ? 'That room is mid-battle. Try another code!' : `That room is full! ${MAX_PLAYERS} clay warriors max.`)
        .then(() => this._leave());
    });

    g.onUI('game-start', () => {
      const solo = g.settings.mode === 'solo';
      $('#hud-me-name').textContent = g.me.name.toUpperCase();
      const meAvatar = $('#hud-me-avatar');
      meAvatar.className = `clay-avatar small pcolor-${g.playerSlot(g.me.id)}`;
      $('#shop').classList.toggle('solo', solo); // no shop in solo — pure survival
      if (solo) this._renderLives();
      else this._renderOthersHud();
      this._setScores();
      this._refreshShop();
      this._renderDeadMarks();
      $('#hud-me-effects').innerHTML = '';
      $('#pause-overlay').hidden = true;
      showScreen('screen-game');
      acquireWakeLock();
      sfx.go();
    });

    g.onUI('question', (data) => this._renderQuestion(data));

    g.onUI('answers-unlocked', ({ duration }) => {
      $('#countdown-overlay').classList.remove('show');
      if (!g.eliminated.has(g.me.id)) this._setAnswersEnabled(true);
      this._refreshShop();
      this._startTimer(duration);
      sfx.go();
    });

    // Royale: the pre-question ante — pot swells, stacks shrink, and the
    // slow bleed can finish someone off before the question even shows.
    g.onUI('ante', ({ eliminated }) => {
      this._setScores();
      this._renderDeadMarks();
      for (const id of eliminated) {
        if (id === g.me.id) {
          sfx.womp();
          this._banner('💀 YOU\'RE OUT!', 'bad');
          toast('Your stack ran dry — spectating from the clay beyond.');
        } else {
          toast(`💀 ${g.playerName(id).toUpperCase()} IS OUT!`);
        }
      }
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
        buzz([70, 50, 70]);
        const btn = $$('.answer-btn')[data.idx];
        if (btn) btn.classList.add('wrong-reveal');
        if (g.settings.mode === 'solo') {
          this._renderLives();
          this._banner(g.lives > 0 ? `OUCH! ${g.lives} ❤️ LEFT` : '💀 OUT OF LIVES!', 'bad');
        } else if (g.settings.mode === 'coop') {
          const left = g.livesMap[g.me.id] ?? 0;
          this._banner(left > 0 ? `OUCH! ${left} ❤️ LEFT` : "💀 YOU'RE DOWN!", 'bad');
          this._setScores();
          this._renderDeadMarks();
        } else {
          this._banner('WRONG!', 'bad');
        }
        this._setAnswersEnabled(false);
      } else {
        // Show exactly which answer they whiffed on.
        sfx.steal();
        this._stampAnswer(data.idx, data.playerId, 'wrong');
        if (g.settings.mode === 'coop') {
          const left = g.livesMap[data.playerId] ?? 0;
          toast(`${g.playerName(data.playerId).toUpperCase()} ${left > 0 ? `WHIFFED! ${left} ❤️ left` : 'IS DOWN! 💀'}`);
          this._setScores();
          this._renderDeadMarks();
        } else {
          toast(`${g.playerName(data.playerId).toUpperCase()} WHIFFED!`);
        }
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
          buzz(250);
          this._showFreeze();
        } else {
          toast(`${g.playerName(data.playerId).toUpperCase()} bought ${def.icon} ${def.name}!`);
        }
      }
    });

    g.onUI('q-end', (data) => this._renderQEnd(data));

    // ---- duels ----
    g.onUI('duel-pending', ({ a, b, stake }) => {
      sfx.powerup();
      toast(`⚔️ ${g.playerName(a).toUpperCase()} CHALLENGES ${g.playerName(b).toUpperCase()} — ${stake} ON THE LINE!`);
      this._refreshShop();
    });

    g.onUI('duel-q', (data) => this._renderDuelQuestion(data));

    g.onUI('duel-unlocked', ({ turnId }) => {
      $('#countdown-overlay').classList.remove('show');
      if (turnId === g.me.id) {
        this._setAnswersEnabled(true);
        sfx.go();
      }
    });

    g.onUI('duel-verdict', (data) => {
      this._setAnswersEnabled(false);
      const name = g.playerName(data.playerId).toUpperCase();
      if (data.correct) {
        sfx.correct();
        this._stampAnswer(data.idx, data.playerId, 'correct');
        this._banner(`${name} NAILS IT!`, 'good');
      } else {
        sfx.wrong();
        if (data.playerId === g.me.id) buzz([70, 50, 70]);
        const btns = $$('.answer-btn');
        const correctIdx = g.currentQ.q.correctIndex;
        if (btns[data.idx]) btns[data.idx].classList.add('wrong-reveal');
        btns[correctIdx].classList.add('correct-reveal');
        btns.forEach((b, i) => { if (i !== correctIdx) b.classList.add('dimmed'); });
      }
    });

    g.onUI('duel-end', (data) => {
      if (data.canceled) {
        toast('⚔️ DUEL CALLED OFF!');
        return;
      }
      const winner = g.playerName(data.winnerId).toUpperCase();
      const loser = g.playerName(data.loserId).toUpperCase();
      if (data.transfer > 0) {
        this._setScores({ [data.winnerId]: data.transfer, [data.loserId]: -data.transfer });
      } else {
        this._setScores();
      }
      if (data.winnerId === g.me.id) {
        sfx.fanfare();
        this._banner(`⚔️ DUEL WON! +${data.transfer}`, 'good');
      } else if (data.loserId === g.me.id) {
        sfx.womp();
        buzz(250);
        this._banner(`⚔️ DUELED DOWN! -${data.transfer}`, 'bad');
      } else {
        sfx.steal();
        this._banner(`⚔️ ${winner} BEATS ${loser}!`, 'info');
      }
      for (const id of data.eliminated || []) {
        toast(id === g.me.id
          ? '💀 The duel broke your stack. Spectating…'
          : `💀 ${g.playerName(id).toUpperCase()} IS OUT!`);
      }
      this._renderDeadMarks();
      this._refreshShop();
    });

    // ---- co-op revive ----
    g.onUI('revive-q', (data) => this._renderReviveQuestion(data));

    g.onUI('revive-unlocked', ({ buyerId }) => {
      $('#countdown-overlay').classList.remove('show');
      if (buyerId === g.me.id) {
        this._setAnswersEnabled(true);
        sfx.go();
      }
    });

    g.onUI('revive-result', (data) => {
      this._setAnswersEnabled(false);
      if (data.canceled) {
        toast('💚 Revive called off — 200 refunded to the team.');
        return;
      }
      const btns = $$('.answer-btn');
      const correctIdx = g.currentQ && g.currentQ.q ? g.currentQ.q.correctIndex : null;
      if (data.correct) {
        sfx.correct();
        if (correctIdx !== null) btns[correctIdx].classList.add('correct-reveal');
        this._banner('💚 REVIVE EARNED!', 'good');
        if (data.buyerId === g.me.id && data.deadIds.length > 1) {
          this._openRevivePicker(data.deadIds);
        }
      } else {
        sfx.wrong();
        if (btns[data.idx]) btns[data.idx].classList.add('wrong-reveal');
        if (correctIdx !== null) {
          btns[correctIdx].classList.add('correct-reveal');
          btns.forEach((b, i) => { if (i !== correctIdx) b.classList.add('dimmed'); });
        }
        this._banner('💔 REVIVE FAILED!', 'bad');
      }
    });

    g.onUI('revive-done', ({ targetId }) => {
      sfx.fanfare();
      toast(`💚 ${g.playerName(targetId).toUpperCase()} IS BACK WITH 2 ❤️!`);
      if (targetId === g.me.id) this._banner('💚 YOU LIVE AGAIN!', 'good');
      this._setScores();
      this._renderDeadMarks();
    });

    // ---- ghost last shot ----
    g.onUI('ghost-shot', (data) => {
      if (data.mine) {
        sfx.go();
        buzz([100, 60, 100]);
        this._banner('👻 LAST SHOT! Answer right to RISE!', 'info');
        this._setAnswersEnabled(true);
        this._startTimer(data.duration);
      } else {
        this._banner('👻 GHOST SHOT!', 'info');
        toast('The fallen get one chance to rise from the clay…');
      }
    });

    g.onUI('round-end', ({ round, scores }) => {
      this._stopTimer();
      $('#intermission-heading').textContent = `ROUND ${round} DONE!`;
      this._renderBoard($('#intermission-board'), scores);
      const isHost = g.isHost;
      $('#btn-next-round').style.display = isHost ? '' : 'none';
      $('#intermission-status').textContent = isHost
        ? 'Take a breath, then hit it!'
        : `Waiting for ${g.roster[0] ? g.roster[0].name.toUpperCase() : 'the host'} to start the next round…`;
      showScreen('screen-intermission');
    });

    g.onUI('next-round', () => {
      showScreen('screen-game');
    });

    g.onUI('game-end', (data) => {
      this._stopTimer();
      releaseWakeLock();
      const { scores, winnerIds } = data;
      $('#btn-rematch').disabled = false;
      if (g.settings.mode === 'solo') {
        const survived = data.solo ? data.solo.questions : 0;
        const banked = scores[g.me.id] ?? 0;
        $('#gameover-title').textContent = 'RUN OVER!';
        $('#gameover-status').textContent = `You survived ${survived} question${survived === 1 ? '' : 's'} and banked ${banked} points!`;
        $('#btn-rematch').textContent = 'PLAY AGAIN!';
        this._renderBoard($('#final-board'), scores, []);
        showScreen('screen-gameover');
        sfx.womp();
        return;
      }
      if (g.settings.mode === 'coop') {
        const victory = data.coop && data.coop.victory;
        const questions = data.coop ? data.coop.questions : 0;
        $('#gameover-title').textContent = victory ? 'GOAL SMASHED!' : 'TEAM SQUASHED!';
        $('#gameover-status').textContent =
          `The team banked ⭐${data.teamScore} over ${questions} question${questions === 1 ? '' : 's'}!`;
        $('#btn-rematch').textContent = 'GO AGAIN!';
        $('#final-board').innerHTML = `
          <div class="score-card${victory ? ' leader' : ''}">
            <span class="sc-crown">${victory ? '👑' : '💀'}</span>
            <span class="sc-name">THE TEAM</span>
            <span class="sc-points">⭐${data.teamScore}</span>
          </div>`;
        showScreen('screen-gameover');
        if (victory) { sfx.fanfare(); this._confetti(); } else { sfx.womp(); }
        return;
      }
      $('#btn-rematch').textContent = 'REMATCH!';
      const won = winnerIds.includes(g.me.id);
      const tie = winnerIds.length > 1;
      const royale = g.settings.mode === 'royale';
      $('#gameover-title').textContent = tie ? "IT'S A TIE?!"
        : (won ? (royale ? 'LAST ONE STANDING!' : 'YOU WIN!') : 'SQUASHED!');
      this._renderBoard($('#final-board'), scores, winnerIds);
      $('#gameover-status').textContent = tie
        ? 'Great minds squish alike.'
        : (won ? 'Absolute trivia titan.' : 'Avenge yourself with a rematch!');
      showScreen('screen-gameover');
      if (won && !tie) { sfx.fanfare(); this._confetti(); } else if (tie) { sfx.join(); } else { sfx.womp(); }
    });

    g.onUI('rematch-vote', ({ from }) => {
      if (from !== g.me.id) toast(`${g.playerName(from).toUpperCase()} WANTS A REMATCH!`);
    });

    g.onUI('player-left', ({ name }) => {
      toast(`${(name || 'A PLAYER').toUpperCase()} BAILED! THE BATTLE RAGES ON.`);
      this._renderOthersHud();
      this._setScores();
    });

    g.onUI('opponent-left', ({ name }) => {
      this._stopTimer();
      releaseWakeLock();
      modal(`${(name || 'Your opponent').toUpperCase()} left the game!`).then(() => this._leave());
    });
  }

  // ---------- lobby ----------
  _renderLobby(v) {
    showScreen('screen-lobby');
    $('#room-code').textContent = v.code;

    const wrap = $('#lobby-players');
    wrap.innerHTML = '';
    v.roster.forEach((p, slot) => {
      const el = document.createElement('div');
      el.className = 'lobby-player';
      el.innerHTML = `
        <div class="clay-avatar pcolor-${slot}"><span class="avatar-face">${FACES[slot % FACES.length]}</span></div>
        <span class="lobby-player-name">${p.name.toUpperCase()}${p.id === v.me.id ? ' (YOU)' : ''}</span>`;
      wrap.appendChild(el);
    });
    if (v.roster.length < v.maxPlayers) {
      const el = document.createElement('div');
      el.className = 'lobby-player';
      el.innerHTML = `
        <div class="clay-avatar waiting"><span class="avatar-face">z_z</span></div>
        <span class="lobby-player-name">waiting…</span>`;
      wrap.appendChild(el);
    }

    $('#settings-panel').classList.toggle('readonly', v.me.role !== 'host');
    const royale = v.settings.mode === 'royale';
    const coop = v.settings.mode === 'coop';
    const groupVisible = {
      mode: true,
      difficulty: !royale && !coop,
      rounds: !royale && !coop,
      ramp: royale || coop,
      staticDiff: (royale || coop) && v.settings.ramp === 1,
      ante: royale,
      goal: coop,
      timer: true,
    };
    $$('#settings-panel .setting-group').forEach((group) => {
      group.hidden = !groupVisible[group.dataset.group];
    });
    // Royale needs a clock — hide the NO TIMER chip there.
    const noTimerChip = $('[data-setting="timer"] .chip[data-value="0"]');
    if (noTimerChip) noTimerChip.hidden = royale;

    $$('#settings-panel .setting-options').forEach((group) => {
      const key = group.dataset.setting;
      const current = String(v.settings[key]);
      group.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.toggle('selected', chip.dataset.value === current);
      });
    });

    if (v.me.role === 'host') {
      $('#btn-start').style.display = '';
      $('#btn-start').disabled = !v.canStart;
      $('#lobby-status').textContent = v.canStart
        ? `${v.roster.length}/${v.maxPlayers} players in. START WHEN READY!`
        : 'Share the code with 1-3 opponents!';
    } else {
      $('#btn-start').style.display = 'none';
      $('#lobby-status').textContent = `${v.roster.length}/${v.maxPlayers} players in. Waiting for ${v.roster[0] ? v.roster[0].name.toUpperCase() : 'the host'} to start…`;
    }
  }

  // ---------- HUD ----------
  _coopHeader(qNum) {
    const g = this.g;
    const goal = g.settings.goal > 0 ? `/${g.settings.goal}` : ' · ENDLESS';
    return `CO-OP 🤝 · Q${qNum ?? this.lastQNum ?? 1} · ⭐${g.teamScore}${goal}`;
  }

  _hearts(n) {
    return '❤️'.repeat(Math.max(0, n)) + '🖤'.repeat(Math.max(0, 3 - n));
  }

  // Solo: opponents' spot shows your hearts instead.
  _renderLives() {
    const lives = Math.max(0, this.g.lives);
    $('#hud-others').innerHTML =
      `<div class="hud-lives" id="hud-lives">${'❤️'.repeat(lives)}${'🖤'.repeat(Math.max(0, 3 - lives))}</div>`;
  }

  _renderOthersHud() {
    const g = this.g;
    const wrap = $('#hud-others');
    wrap.innerHTML = '';
    for (const p of g.others()) {
      const slot = g.playerSlot(p.id);
      const el = document.createElement('div');
      el.className = 'hud-mini';
      el.dataset.pid = p.id;
      el.innerHTML = `
        <div class="clay-avatar tiny pcolor-${slot}"><span class="avatar-face">${FACES[slot % FACES.length]}</span></div>
        <div class="hud-player-info">
          <span class="hud-name">${p.name.toUpperCase()}</span>
          <span class="hud-score" data-score>0</span>
        </div>`;
      wrap.appendChild(el);
    }
  }

  // ---------- question flow ----------
  _renderQuestion({ qKey, round, qIndex, totalRounds, q, duration, mode, qNum, pot }) {
    this._stopTimer();
    $('#verdict-banner').className = 'verdict-banner';
    $('#hud-round').textContent = mode === 'royale'
      ? `ROYALE ∞ · Q${qNum} · 💰${pot}`
      : mode === 'coop'
        ? this._coopHeader(qNum)
        : mode === 'solo'
          ? `SOLO ∞ · Q${qNum}`
          : `R${round}/${totalRounds} · Q${qIndex + 1}/${QUESTIONS_PER_ROUND}`;
    if (mode === 'coop') this.lastQNum = qNum;
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
      btn.querySelectorAll('.stamp-rail').forEach((s) => s.remove());
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

  // A duel question: same card, special chrome, only the duelist whose
  // turn it is may answer, no timer.
  _renderDuelQuestion({ q, duel, turnId, dNum }) {
    const g = this.g;
    this._stopTimer();
    $('#verdict-banner').className = 'verdict-banner';
    const turnName = g.playerName(turnId).toUpperCase();
    $('#hud-round').textContent =
      `⚔️ ${g.playerName(duel.a).toUpperCase()} vs ${g.playerName(duel.b).toUpperCase()} · 💰${duel.stake} · ${turnName}'S TURN`;
    $('#q-category').textContent = q.category;
    const diffEl = $('#q-difficulty');
    diffEl.textContent = q.difficulty.toUpperCase();
    diffEl.dataset.diff = q.difficulty;
    $('#q-text').textContent = q.text;

    $$('.answer-btn').forEach((btn, i) => {
      btn.className = 'answer-btn';
      btn.querySelector('.answer-text').textContent = q.answers[i] ?? '';
      btn.querySelectorAll('.stamp-rail').forEach((s) => s.remove());
      btn.disabled = true;
    });

    this._renderTimerIdle(null);
    this._refreshShop();

    if (turnId !== g.me.id && dNum === 0) {
      toast(`⚔️ ${turnName} STEPS UP FIRST…`);
    }
    // Quick ⚔️ splash instead of the full 3-2-1.
    this.countdownTimers.forEach(clearTimeout);
    this.countdownTimers = [];
    const overlay = $('#countdown-overlay');
    const num = $('#countdown-num');
    num.textContent = '⚔️';
    num.style.animation = 'none';
    void num.offsetWidth;
    num.style.animation = '';
    overlay.classList.add('show');
    sfx.countdown();
  }

  // Co-op revive question: buyer answers alone, untimed, all watch.
  _renderReviveQuestion({ q, buyerId }) {
    const g = this.g;
    this._stopTimer();
    $('#verdict-banner').className = 'verdict-banner';
    $('#hud-round').textContent = `💚 REVIVE · ${g.playerName(buyerId).toUpperCase()}'S REDEMPTION`;
    $('#q-category').textContent = q.category;
    const diffEl = $('#q-difficulty');
    diffEl.textContent = q.difficulty.toUpperCase();
    diffEl.dataset.diff = q.difficulty;
    $('#q-text').textContent = q.text;
    $$('.answer-btn').forEach((btn, i) => {
      btn.className = 'answer-btn';
      btn.querySelector('.answer-text').textContent = q.answers[i] ?? '';
      btn.querySelectorAll('.stamp-rail').forEach((s) => s.remove());
      btn.disabled = true;
    });
    this._renderTimerIdle(null);
    this._refreshShop();
    if (buyerId !== g.me.id) toast(`💚 ${g.playerName(buyerId).toUpperCase()} ANSWERS FOR A LIFE…`);
    this.countdownTimers.forEach(clearTimeout);
    this.countdownTimers = [];
    const overlay = $('#countdown-overlay');
    const num = $('#countdown-num');
    num.textContent = '💚';
    num.style.animation = 'none';
    void num.offsetWidth;
    num.style.animation = '';
    overlay.classList.add('show');
    sfx.countdown();
  }

  _openRevivePicker(deadIds) {
    const g = this.g;
    const wrap = $('#revive-targets');
    wrap.innerHTML = '';
    deadIds.forEach((id, i) => {
      const chip = document.createElement('button');
      chip.className = `chip${i === 0 ? ' selected' : ''}`;
      chip.dataset.pid = id;
      chip.textContent = g.playerName(id).toUpperCase();
      chip.addEventListener('click', () => {
        wrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        sfx.click();
      });
      wrap.appendChild(chip);
    });
    $('#revive-modal').showModal();
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

  // Pin a player's name to the answer they chose, in their color —
  // red-edged shake for a miss, starred pop for the winning pick.
  // Stamps stack in a rail so several players can mark the same answer.
  _stampAnswer(idx, playerId, kind) {
    const g = this.g;
    const btn = $$('.answer-btn')[idx];
    if (!btn) return;
    let rail = btn.querySelector('.stamp-rail');
    if (!rail) {
      rail = document.createElement('span');
      rail.className = 'stamp-rail';
      btn.appendChild(rail);
    }
    if (rail.querySelector(`[data-pid="${playerId}"]`)) return;
    const stamp = document.createElement('span');
    stamp.className = `answer-stamp ${kind} pcolor-${g.playerSlot(playerId)}`;
    stamp.dataset.pid = playerId;
    stamp.textContent = `${kind === 'wrong' ? '✖' : '★'} ${g.playerName(playerId).toUpperCase()}`;
    rail.appendChild(stamp);
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
    const royale = this.g.settings.mode === 'royale';

    if (this.g.settings.mode === 'coop' && data.winnerId) {
      // Any teammate's win is everyone's win.
      sfx.correct();
      this._stampAnswer(data.correctIndex, data.winnerId, 'correct');
      const who = data.winnerId === this.g.me.id ? 'YOU' : this.g.playerName(data.winnerId).toUpperCase();
      this._banner(`${who} +${data.winDelta} TEAM ⭐!`, 'good');
      this._setScores({ team: data.winDelta });
    } else if (data.winnerId === this.g.me.id) {
      sfx.correct();
      const label = royale ? `💰 +${data.winDelta} POT!` : `+${data.winDelta}!`;
      this._banner(data.doubled ? `✖️2 ${label}!` : label, 'good');
    } else if (data.winnerId) {
      sfx.steal();
      this._stampAnswer(data.correctIndex, data.winnerId, 'correct');
      const name = this.g.playerName(data.winnerId).toUpperCase();
      this._banner(royale ? `${name} TAKES THE POT!` : `${name} GOT IT!`, 'bad');
    } else if (this.g.settings.mode === 'solo') {
      // the verdict banner already delivered the bad news; keep the
      // hearts current through the reveal
      this._renderLives();
    } else if (royale) {
      sfx.womp();
      this._banner(`POT ROLLS OVER! 💰${data.pot}`, 'info');
    } else {
      sfx.womp();
      this._banner(data.reason === 'timeout' ? "TIME'S UP!" : 'NOBODY GOT IT!', 'info');
    }

    // Ghost last-shot outcomes: stamp each ghost's attempt, celebrate
    // the risen.
    for (const [pid, idx] of Object.entries(data.ghostAnswers || {})) {
      const kind = (data.ghostRevived || []).includes(pid) ? 'correct' : 'wrong';
      this._stampAnswer(idx, pid, kind);
    }
    for (const id of data.ghostRevived || []) {
      if (id === this.g.me.id) {
        sfx.fanfare();
        this._banner('👻 YOU RISE! +100', 'good');
      } else {
        toast(`👻 ${this.g.playerName(id).toUpperCase()} RISES FROM THE CLAY! +100`);
      }
    }

    for (const id of data.eliminated || []) {
      if (id === this.g.me.id) {
        sfx.womp();
        toast('💀 You\'re out! Spectating from the clay beyond.');
      } else {
        toast(`💀 ${this.g.playerName(id).toUpperCase()} IS OUT!`);
      }
    }
    this._renderDeadMarks();
  }

  // Skull-out eliminated players' HUD cards (Royale).
  _renderDeadMarks() {
    const g = this.g;
    const mark = (el, dead) => {
      el.classList.toggle('dead', dead);
      const face = el.querySelector('.avatar-face');
      if (face) face.textContent = dead ? 'x_x' : '·‿·';
    };
    mark($('#hud-me'), g.eliminated.has(g.me.id));
    for (const chip of $$('#hud-others .hud-mini')) {
      mark(chip, g.eliminated.has(chip.dataset.pid));
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
    const coop = g.settings.mode === 'coop';
    const meEl = $('#hud-me-score');
    // Co-op: player cards show hearts, the shared score lives in the header.
    meEl.textContent = coop ? this._hearts(g.livesMap[g.me.id] ?? 0) : (g.scores[g.me.id] ?? 0);
    const anchors = { [g.me.id]: meEl };
    for (const chip of $$('#hud-others .hud-mini')) {
      const scoreEl = chip.querySelector('[data-score]');
      scoreEl.textContent = coop
        ? this._hearts(g.livesMap[chip.dataset.pid] ?? 0)
        : (g.scores[chip.dataset.pid] ?? 0);
      anchors[chip.dataset.pid] = scoreEl;
    }
    if (coop) $('#hud-round').textContent = this._coopHeader();
    if (deltas) {
      for (const [pid, d] of Object.entries(deltas)) {
        const el = coop ? $('#hud-round') : anchors[pid];
        if (!el) continue;
        if (!coop) bumpScore(el, d >= 0);
        scorePop(el, d);
      }
    }
  }

  _refreshFxBadges() {
    const g = this.g;
    const mine = [];
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
        <span class="pu-cost">${def.costLabel ?? def.cost}</span>`;
      btn.addEventListener('click', () => {
        if (key === 'duel') this._openDuelModal();
        else this.g.buy(key);
      });
      wrap.appendChild(btn);
    }
  }

  _refreshShop() {
    const g = this.g;
    const mode = g.settings.mode;
    const wallet = mode === 'coop' ? g.teamScore : (g.scores[g.me.id] ?? 0);
    const inSideQuest = !!(g.currentQ && (g.currentQ.duel || g.currentQ.revive));
    const hasFallen = g.roster.some((p) => g.eliminated.has(p.id));
    $$('.powerup-btn').forEach((btn) => {
      const type = btn.dataset.type;
      const def = POWERUPS[type];
      btn.style.display = MODE_POWERUPS[mode].includes(type) ? '' : 'none';
      const used = g.usedPowerupsThisQ.has(type);
      const timerless = type === 'timewarp' && !(g.settings.timer > 0);
      const stacked = type === 'double' && g.myDouble;
      const noTarget = type === 'revive' && !hasFallen;
      btn.classList.toggle('used', used);
      btn.disabled = used || stacked || timerless || inSideQuest || noTarget
        || wallet < def.cost
        || g.phase !== 'answering'
        || g.myAnswered || g.myLockedOut
        || g.eliminated.has(g.me.id);
    });
  }

  // ---------- duel ----------
  _openDuelModal() {
    const g = this.g;
    const foes = g.others().filter((p) => !g.eliminated.has(p.id));
    if (!foes.length) return;
    const wrap = $('#duel-targets');
    wrap.innerHTML = '';
    foes.forEach((p, i) => {
      const chip = document.createElement('button');
      chip.className = `chip duel-target${i === 0 ? ' selected' : ''}`;
      chip.dataset.pid = p.id;
      chip.textContent = p.name.toUpperCase();
      chip.addEventListener('click', () => {
        wrap.querySelectorAll('.chip').forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
        sfx.click();
      });
      wrap.appendChild(chip);
    });
    // With a single opponent there's nothing to choose.
    wrap.style.display = foes.length > 1 ? '' : 'none';
    $('#duel-modal').showModal();
  }

  // ---------- scoreboard / confetti ----------
  _renderBoard(el, scores, winnerIds = []) {
    const g = this.g;
    el.innerHTML = '';
    const entries = g.roster
      .map((p) => ({ ...p, slot: g.playerSlot(p.id), score: scores[p.id] ?? 0 }))
      .sort((a, b) => b.score - a.score);
    const top = entries[0]?.score;
    for (const e of entries) {
      const card = document.createElement('div');
      const crowned = winnerIds.includes(e.id)
        || (!winnerIds.length && e.score === top
            && entries.filter((x) => x.score === top).length < entries.length);
      card.className = `score-card${crowned ? ' leader' : ''}`;
      card.innerHTML = `
        ${crowned ? '<span class="sc-crown">👑</span>' : ''}
        <div class="clay-avatar tiny pcolor-${e.slot}"><span class="avatar-face">${FACES[e.slot % FACES.length]}</span></div>
        <span class="sc-name">${e.name}${e.id === g.me.id ? ' (you)' : ''}</span>
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
