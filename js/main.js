// Entry point: title screen, matchmaking, and session bootstrap.

import { CODE_ALPHABET, CODE_LENGTH, DEBUG, TRANSPORT, POWERUPS } from './config.js';
import { createTransport, createSoloTransport } from './net.js';
import { Game } from './game.js';
import { GameUI, showScreen, toast } from './ui.js';
import { sfx, isMuted, toggleMute } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const CLAY_NAMES = [
  'GOOPY', 'SQUISH', 'BLOBBO', 'WIGGLE', 'NOODLE', 'ZAPPY', 'MUNCH',
  'SPLAT', 'DOINK', 'WOBBLE', 'GLORP', 'BONK', 'FUZZY', 'PLOP', 'BLINKY', 'SMUDGE',
];

function randomName() {
  return CLAY_NAMES[Math.floor(Math.random() * CLAY_NAMES.length)];
}

function makeCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function playerId() {
  return `p-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 6000);
}

// Free-tier Supabase projects doze off after a quiet week; a connection
// failure is far more likely to be that than anything the player can fix.
function connectFailMessage(err) {
  if (TRANSPORT !== 'supabase') return `Couldn't connect: ${err.message}`;
  return "Couldn't connect! The game server may be napping — it dozes off after a quiet week. The game's owner can wake it at supabase.com.";
}

let session = null; // { transport, engine, ui }

async function startSession(role, code) {
  const name = ($('#player-name').value.trim() || randomName()).toUpperCase().slice(0, 12);
  const self = { id: playerId(), name, role };
  const transport = createTransport(code, self);
  const engine = new Game(transport, self);
  const ui = new GameUI(engine);
  session = { transport, engine, ui };
  if (DEBUG) window.__HMMM = session;

  await transport.join();
  return session;
}

// Solo run: no lobby, no network — straight into the question mines.
async function soloGame() {
  const btn = $('#btn-solo');
  btn.disabled = true;
  try {
    const name = ($('#player-name').value.trim() || randomName()).toUpperCase().slice(0, 12);
    const self = { id: playerId(), name, role: 'host' };
    const transport = createSoloTransport(self);
    const engine = new Game(transport, self);
    engine.settings.mode = 'solo';
    engine.settings.timer = 0; // untimed — speed bonus uses the virtual window
    const ui = new GameUI(engine);
    session = { transport, engine, ui };
    if (DEBUG) window.__HMMM = session;
    await transport.join();
    sfx.go();
    await engine.start();
  } catch (err) {
    showError($('#title-error'), `Couldn't start: ${err.message}`);
    if (session) session.engine.destroy();
    session = null;
  } finally {
    btn.disabled = false;
  }
}

async function hostGame() {
  const btn = $('#btn-host');
  btn.disabled = true;
  try {
    await startSession('host', makeCode());
    session.engine.ui('lobby-update', session.engine.lobbyView());
    sfx.join();
  } catch (err) {
    showError($('#title-error'), connectFailMessage(err));
    if (session) session.engine.destroy();
    session = null;
  } finally {
    btn.disabled = false;
  }
}

// errEl: where failures surface — the join screen normally, the title
// screen when arriving through a shared ?join= link.
async function joinGame(code, errEl = $('#join-error')) {
  const btn = $('#btn-join-go');
  btn.disabled = true;
  try {
    await startSession('guest', code);
    // Wait briefly for the host to show up in presence.
    const found = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 4500);
      const check = () => {
        if (session.engine.hostPresent) { clearTimeout(deadline); resolve(true); }
        else setTimeout(check, 120);
      };
      check();
    });
    if (!found) {
      session.engine.destroy();
      session = null;
      showError(errEl, 'Room not found! Check the code with your host.');
      return;
    }
    sfx.join();
  } catch (err) {
    showError(errEl, connectFailMessage(err));
    if (session) session.engine.destroy();
    session = null;
  } finally {
    btn.disabled = false;
  }
}

// ---------------- title & join screens ----------------
function initTitle() {
  $('#player-name').value = randomName();
  $('#btn-reroll-name').addEventListener('click', () => {
    sfx.click();
    $('#player-name').value = randomName();
  });

  // Arriving through a shared link (?join=CODE): one big button straight
  // into the friend's room — no code to type.
  const linkCode = (new URLSearchParams(location.search).get('join') || '').toUpperCase();
  const hasLinkCode = new RegExp(`^[A-Z0-9]{${CODE_LENGTH}}$`).test(linkCode);
  if (hasLinkCode) {
    $('#btn-host').style.display = 'none';
    $('#btn-solo').style.display = 'none';
    $('#btn-join').textContent = `JOIN ROOM ${linkCode}`;
  }

  $('#btn-host').addEventListener('click', () => { sfx.click(); hostGame(); });
  $('#btn-solo').addEventListener('click', () => { sfx.click(); soloGame(); });
  $('#btn-join').addEventListener('click', () => {
    sfx.click();
    if (hasLinkCode) {
      joinGame(linkCode, $('#title-error'));
      return;
    }
    showScreen('screen-join');
    $$('.code-box').forEach((b) => { b.value = ''; });
    $$('.code-box')[0].focus();
  });

  // How-to-play overlay
  const helpDlg = $('#help-modal');
  $('#help-powerups').innerHTML = Object.values(POWERUPS)
    .map((p) => `<li>${p.icon} <b>${p.name}</b> (${p.cost} pts) — ${p.desc.toLowerCase()}</li>`)
    .join('');
  $('#btn-help').addEventListener('click', () => { sfx.click(); helpDlg.showModal(); });
  $('#btn-help-close').addEventListener('click', () => { sfx.click(); helpDlg.close(); });
  $('#btn-join-back').addEventListener('click', () => { sfx.click(); showScreen('screen-title'); });

  // code boxes: auto-advance, backspace, paste
  const boxes = $$('.code-box');
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      sfx.hover();
    });
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
      if (ev.key === 'Enter') submitJoin();
    });
    box.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const text = (ev.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      text.slice(0, CODE_LENGTH).split('').forEach((ch, j) => { if (boxes[j]) boxes[j].value = ch; });
      boxes[Math.min(text.length, CODE_LENGTH - 1)].focus();
    });
  });

  function submitJoin() {
    const code = boxes.map((b) => b.value).join('');
    if (code.length !== CODE_LENGTH) {
      showError($('#join-error'), `Codes are ${CODE_LENGTH} characters!`);
      return;
    }
    joinGame(code);
  }
  $('#btn-join-go').addEventListener('click', () => { sfx.click(); submitJoin(); });

  // mute button
  const muteBtn = $('#btn-mute');
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.addEventListener('click', () => {
    muteBtn.textContent = toggleMute() ? '🔇' : '🔊';
  });

  // Leaving the page = leaving the match.
  window.addEventListener('beforeunload', () => {
    if (session) session.transport.send('quit', {});
  });
}

initTitle();
