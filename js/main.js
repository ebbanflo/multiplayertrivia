// Entry point: title screen, matchmaking, and session bootstrap.

import { CODE_ALPHABET, CODE_LENGTH, DEBUG } from './config.js';
import { createTransport } from './net.js';
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
  setTimeout(() => el.classList.remove('show'), 4000);
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

async function hostGame() {
  const btn = $('#btn-host');
  btn.disabled = true;
  try {
    await startSession('host', makeCode());
    session.engine.ui('lobby-update', session.engine.lobbyView());
    sfx.join();
  } catch (err) {
    showError($('#title-error'), `Couldn't connect: ${err.message}`);
    if (session) session.engine.destroy();
    session = null;
  } finally {
    btn.disabled = false;
  }
}

async function joinGame(code) {
  const btn = $('#btn-join-go');
  btn.disabled = true;
  try {
    await startSession('guest', code);
    // Wait briefly for the host to show up in presence.
    const found = await new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(false), 4500);
      const check = () => {
        if (session.engine.opponent) { clearTimeout(deadline); resolve(true); }
        else setTimeout(check, 120);
      };
      check();
    });
    if (!found) {
      session.engine.destroy();
      session = null;
      showError($('#join-error'), 'Room not found! Check the code with your host.');
      return;
    }
    sfx.join();
  } catch (err) {
    showError($('#join-error'), `Couldn't connect: ${err.message}`);
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

  $('#btn-host').addEventListener('click', () => { sfx.click(); hostGame(); });
  $('#btn-join').addEventListener('click', () => {
    sfx.click();
    showScreen('screen-join');
    $$('.code-box').forEach((b) => { b.value = ''; });
    $$('.code-box')[0].focus();
  });
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
