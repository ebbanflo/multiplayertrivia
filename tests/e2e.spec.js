// @ts-check
// Two-player end-to-end tests. Both players run in one browser context
// using the local BroadcastChannel transport (?t=local) — the exact
// same engine/UI code paths as production, minus the Supabase wire.
// Trivia APIs are stubbed with deterministic fixtures so the API
// fetching + normalization code is exercised too.

import { test, expect } from '@playwright/test';

const APP = '/?t=local&debug=1';

function opentdbFixture(count) {
  return {
    response_code: 0,
    results: Array.from({ length: count }, (_, i) => ({
      category: 'Stub &amp; Testing',
      question: `OTDB question #${i}: what is the right answer?`,
      correct_answer: `RIGHT-O${i}`,
      incorrect_answers: [`wrong-a${i}`, `wrong-b${i}`, `wrong-c${i}`],
    })),
  };
}

function triviaApiFixture(count) {
  return Array.from({ length: count }, (_, i) => ({
    category: 'stub_testing',
    question: { text: `TrivAPI question #${i}: pick the winner!` },
    correctAnswer: `RIGHT-T${i}`,
    incorrectAnswers: [`nope-a${i}`, `nope-b${i}`, `nope-c${i}`],
  }));
}

async function stubApis(context) {
  await context.route('**/opentdb.com/**', (route) => {
    const url = new URL(route.request().url());
    const amount = parseInt(url.searchParams.get('amount') || '10', 10);
    route.fulfill({ json: opentdbFixture(amount) });
  });
  await context.route('**/the-trivia-api.com/**', (route) => {
    const url = new URL(route.request().url());
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    route.fulfill({ json: triviaApiFixture(limit) });
  });
}

const engineState = (page) => page.evaluate(() => {
  const e = window.__HMMM.engine;
  return {
    phase: e.phase,
    qKey: e.currentQ && e.currentQ.qKey,
    myScore: e.scores[e.me.id] ?? 0,
    scores: { ...e.scores },
    rosterNames: e.roster.map((p) => p.name),
    correctIndex: e.currentQ && e.currentQ.q.correctIndex,
    pot: e.pot,
    meEliminated: e.eliminated.has(e.me.id),
    eliminatedCount: e.eliminated.size,
    ghostShot: e.ghostShotQKey,
    teamScore: e.teamScore,
    myLives: e.livesMap ? e.livesMap[e.me.id] : null,
  };
});

async function waitForAnswering(page, qKey) {
  await page.waitForFunction((key) => {
    const e = window.__HMMM && window.__HMMM.engine;
    return e && e.phase === 'answering' && e.currentQ && e.currentQ.qKey === key;
  }, qKey, { timeout: 30_000 });
}

async function clickAnswer(page, { correct }) {
  const s = await engineState(page);
  const idx = correct ? s.correctIndex : (s.correctIndex + 1) % 4;
  await page.click(`.answer-btn[data-idx="${idx}"]`);
}

async function waitForReveal(page) {
  await page.waitForFunction(() => {
    const e = window.__HMMM.engine;
    return ['reveal', 'intermission', 'gameover'].includes(e.phase);
  }, undefined, { timeout: 45_000 });
}

async function joinAs(context, code, name) {
  const page = await context.newPage();
  await page.goto(APP);
  await page.fill('#player-name', name);
  await page.click('#btn-join');
  const boxes = page.locator('.code-box');
  for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
  await page.click('#btn-join-go');
  return page;
}

async function setupMatch(context, { timer = '30' } = {}) {
  const host = await context.newPage();
  await host.goto(APP);
  await host.fill('#player-name', 'HOSTY');
  await host.click('#btn-host');
  await expect(host.locator('#screen-lobby')).toBeVisible();
  const code = (await host.locator('#room-code').textContent())?.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}$/);

  const guest = await joinAs(context, code, 'GUESTO');
  await expect(guest.locator('#screen-lobby')).toBeVisible();

  // Both lobbies show both names
  await expect(host.locator('#lobby-players')).toContainText('GUESTO');
  await expect(guest.locator('#lobby-players')).toContainText('HOSTY');

  // Host picks the timer mode
  await host.click(`[data-setting="timer"] .chip[data-value="${timer}"]`);
  return { host, guest, code };
}

test.describe('HMMM? two-player battle', () => {

  test('full match: lockout duel, power-ups, timeout, game over, rematch', async ({ context }) => {
    await stubApis(context);
    const { host, guest } = await setupMatch(context, { timer: '30' });

    // Guest sees host's setting change mirrored
    await expect(guest.locator('[data-setting="timer"] .chip[data-value="30"]')).toHaveClass(/selected/);

    await host.click('#btn-start');
    await expect(host.locator('#screen-game')).toBeVisible();
    await expect(guest.locator('#screen-game')).toBeVisible();

    // ---- Q1: same question on both screens; host wins ----
    await waitForAnswering(host, '1-0');
    await waitForAnswering(guest, '1-0');
    const hostQ = await host.locator('#q-text').textContent();
    const guestQ = await guest.locator('#q-text').textContent();
    expect(hostQ).toBe(guestQ);

    await clickAnswer(host, { correct: true });
    await waitForReveal(host);
    let hs = await engineState(host);
    expect(hs.myScore).toBeGreaterThanOrEqual(100); // base + speed bonus
    const scoreAfterQ1 = hs.myScore;
    await expect(guest.locator('#verdict-banner')).toHaveText(/HOSTY GOT IT!/);
    // guest sees the winner's stamp on the correct answer
    await expect(guest.locator('.answer-stamp.correct')).toHaveText(/HOSTY/);

    // ---- Q2: guest answers wrong (-50 + lockout), host steals ----
    await waitForAnswering(host, '1-1');
    await waitForAnswering(guest, '1-1');
    await clickAnswer(guest, { correct: false });
    await expect
      .poll(async () => (await engineState(guest)).myScore, { timeout: 10_000 })
      .toBe(-50);
    // guest is locked out: all answer buttons disabled
    const enabledCount = await guest.locator('.answer-btn:enabled').count();
    expect(enabledCount).toBe(0);
    // host sees exactly which answer the guest whiffed on
    await expect(host.locator('.answer-stamp.wrong')).toHaveText(/GUESTO/);
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);
    hs = await engineState(host);
    expect(hs.myScore).toBeGreaterThan(scoreAfterQ1);

    // ---- Q3: host buys 50/50 → two answers zapped, then wins ----
    await waitForAnswering(host, '1-2');
    await host.click('.powerup-btn[data-type="fifty"]');
    await expect(host.locator('.answer-btn.zapped')).toHaveCount(2);
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);

    // ---- Q4: host freezes guest ----
    await waitForAnswering(host, '1-3');
    await waitForAnswering(guest, '1-3');
    await host.click('.powerup-btn[data-type="freeze"]');
    await expect(guest.locator('#freeze-overlay')).toHaveClass(/show/);
    // Frozen guest input is ignored by the engine. (Probe directly —
    // a DOM click would be deferred by Playwright's auto-waiting until
    // the freeze overlay clears, and then land as a real answer.)
    await guest.evaluate(() => {
      const e = window.__HMMM.engine;
      e.answer(e.currentQ.q.correctIndex);
    });
    expect(await guest.evaluate(() => window.__HMMM.engine.myAnswered)).toBe(false);
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);

    // ---- Q5: host whiffs for real (-50), guest steals ----
    await waitForAnswering(host, '1-4');
    await waitForAnswering(guest, '1-4');
    const beforeMiss = (await engineState(host)).myScore;
    await clickAnswer(host, { correct: false });
    await expect
      .poll(async () => (await engineState(host)).myScore, { timeout: 10_000 })
      .toBe(beforeMiss - 50);
    await clickAnswer(guest, { correct: true });
    await waitForReveal(guest);
    let gs = await engineState(guest);
    expect(gs.myScore).toBeGreaterThanOrEqual(50); // -50 earlier, then won ≥100

    // ---- Q6: host buys DOUBLE DOWN, wins with 2x points ----
    await waitForAnswering(host, '1-5');
    const beforeDouble = (await engineState(host)).myScore - 100;
    await host.click('.powerup-btn[data-type="double"]');
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);
    hs = await engineState(host);
    expect(hs.myScore - beforeDouble).toBeGreaterThanOrEqual(200); // (100+bonus)*2

    // ---- Q7: both wrong → nobody scores ----
    await waitForAnswering(host, '1-6');
    await waitForAnswering(guest, '1-6');
    await clickAnswer(host, { correct: false });
    await clickAnswer(guest, { correct: false });
    await waitForReveal(host);
    await expect(host.locator('#verdict-banner')).toHaveText(/NOBODY GOT IT!/);

    // ---- Q8: nobody answers → 30s timeout ----
    await waitForAnswering(host, '1-7');
    await expect(host.locator('#verdict-banner')).toHaveText(/TIME'S UP!/, { timeout: 40_000 });

    // ---- Q9 & Q10: guest takes both ----
    for (const qk of ['1-8', '1-9']) {
      await waitForAnswering(guest, qk);
      await clickAnswer(guest, { correct: true });
      await waitForReveal(guest);
    }

    // ---- game over: host should be the winner ----
    await expect(host.locator('#screen-gameover')).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('#screen-gameover')).toBeVisible();
    await expect(host.locator('#gameover-title')).toHaveText('YOU WIN!');
    await expect(guest.locator('#gameover-title')).toHaveText('SQUASHED!');
    hs = await engineState(host);
    gs = await engineState(guest);
    expect(hs.myScore).toBeGreaterThan(gs.myScore);

    // ---- rematch: both vote, fresh game starts with reset scores ----
    await host.click('#btn-rematch');
    await guest.click('#btn-rematch');
    await waitForAnswering(host, '1-0');
    hs = await engineState(host);
    expect(Object.values(hs.scores).every((s) => s === 0)).toBe(true);
    await expect(guest.locator('#screen-game')).toBeVisible();
  });

  test('multi-round: intermission between rounds, host advances', async ({ context }) => {
    await stubApis(context);
    const { host, guest } = await setupMatch(context, { timer: '30' });
    await host.click('[data-setting="rounds"] .chip[data-value="2"]');
    await host.click('#btn-start');

    // Blitz round 1: host answers everything correctly
    for (let i = 0; i < 10; i++) {
      await waitForAnswering(host, `1-${i}`);
      await clickAnswer(host, { correct: true });
      await waitForReveal(host);
    }
    await expect(host.locator('#screen-intermission')).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('#screen-intermission')).toBeVisible();
    await expect(host.locator('#intermission-heading')).toHaveText('ROUND 1 DONE!');
    // guest has no next-round button
    await expect(guest.locator('#btn-next-round')).toBeHidden();

    await host.click('#btn-next-round');
    await waitForAnswering(host, '2-0');
    await expect(guest.locator('#hud-round')).toHaveText(/R2\/2 · Q1\/10/);
  });

  test('either player can quit to the menu mid-game', async ({ context }) => {
    await stubApis(context);
    const { host, guest } = await setupMatch(context, { timer: '30' });
    await host.click('#btn-start');
    await waitForAnswering(host, '1-0');
    await waitForAnswering(guest, '1-0');

    // The sound toggle lives on the title screen only
    await expect(host.locator('#btn-mute')).toBeHidden();

    // Pause hides the battlefield locally; resume brings it back
    await host.click('#btn-pause');
    await expect(host.locator('#pause-overlay')).toBeVisible();
    await expect(host.locator('#pause-overlay')).toContainText('PAUSED');
    await host.click('#btn-resume');
    await expect(host.locator('#pause-overlay')).toBeHidden();

    // Cancel keeps the battle going
    await guest.click('#btn-quit-game');
    await expect(guest.locator('#modal')).toBeVisible();
    await guest.click('#modal-cancel');
    expect((await engineState(guest)).phase).toBe('answering');

    // Confirm quits: guest returns to the title, host is told
    await guest.click('#btn-quit-game');
    await guest.click('#modal-btn');
    await expect(guest.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
    await expect(host.locator('#modal')).toBeVisible({ timeout: 10_000 });
    await expect(host.locator('#modal-text')).toHaveText(/GUESTO left the game/i);
    await host.click('#modal-btn');
    await expect(host.locator('#screen-title')).toBeVisible({ timeout: 10_000 });

    // And the other direction: host quits, guest is told
    const m2 = await setupMatch(context, { timer: '30' });
    await m2.host.click('#btn-start');
    await waitForAnswering(m2.host, '1-0');
    await m2.host.click('#btn-quit-game');
    await m2.host.click('#modal-btn');
    await expect(m2.host.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
    await expect(m2.guest.locator('#modal')).toBeVisible({ timeout: 10_000 });
    await expect(m2.guest.locator('#modal-text')).toHaveText(/HOSTY left the game/i);
  });

  test('share links join in one tap; help overlay opens', async ({ context }) => {
    await stubApis(context);
    const host = await context.newPage();
    await host.goto(APP);
    await host.fill('#player-name', 'HOSTY');
    await host.click('#btn-host');
    await expect(host.locator('#room-code')).toHaveText(/^[A-Z0-9]{4}$/);
    const code = (await host.locator('#room-code').textContent())?.trim();

    // friend opens the shared link: host button gone, one-tap join
    const friend = await context.newPage();
    await friend.goto(`${APP}&join=${code}`);
    await expect(friend.locator('#btn-host')).toBeHidden();
    await expect(friend.locator('#btn-join')).toHaveText(`JOIN ROOM ${code}`);
    await expect(friend.locator('#btn-mute')).toBeVisible(); // sound toggle on title

    // help overlay lists the rules and power-ups
    await friend.click('#btn-help');
    await expect(friend.locator('#help-modal')).toBeVisible();
    await expect(friend.locator('#help-powerups')).toContainText('DOUBLE DOWN');
    await friend.click('#btn-help-close');
    await expect(friend.locator('#help-modal')).toBeHidden();

    await friend.fill('#player-name', 'LINKY');
    await friend.click('#btn-join');
    await expect(friend.locator('#screen-lobby')).toBeVisible({ timeout: 10_000 });
    await expect(host.locator('#lobby-players')).toContainText('LINKY');

    // a dead link shows the error on the title screen
    const lost = await context.newPage();
    await lost.goto(`${APP}&join=ZZZZ`);
    await lost.click('#btn-join');
    await expect(lost.locator('#title-error')).toHaveText(/Room not found/, { timeout: 10_000 });
  });

  test('10-second timer mode runs the clock at 10s', async ({ context }) => {
    await stubApis(context);
    const { host, guest } = await setupMatch(context, { timer: '10' });
    await expect(guest.locator('[data-setting="timer"] .chip[data-value="10"]')).toHaveClass(/selected/);
    await host.click('#btn-start');
    await waitForAnswering(host, '1-0');
    expect(await host.evaluate(() => window.__HMMM.engine.currentQ.duration)).toBe(10_000);
    // nobody answers: the 10s clock expires the question quickly
    await expect(host.locator('#verdict-banner')).toHaveText(/TIME'S UP!/, { timeout: 18_000 });
  });

  test('solo run: 3 lives, untimed, endless, play again', async ({ context }) => {
    await stubApis(context);
    const page = await context.newPage();
    await page.goto(APP);
    await page.fill('#player-name', 'LONER');
    await page.click('#btn-solo');

    // straight into the game — no lobby, no shop, hearts up top
    await waitForAnswering(page, 's-0');
    await expect(page.locator('#hud-round')).toHaveText('SOLO ∞ · Q1');
    await expect(page.locator('#hud-lives')).toHaveText('❤️❤️❤️');
    await expect(page.locator('.powerup-btn').first()).toBeHidden();
    await expect(page.locator('#timer-num')).toHaveText('∞');

    // correct answer banks points, keeps hearts
    await clickAnswer(page, { correct: true });
    await waitForReveal(page);
    expect((await engineState(page)).myScore).toBeGreaterThanOrEqual(100);

    // three misses burn the three hearts
    for (let i = 1; i <= 3; i++) {
      await waitForAnswering(page, `s-${i}`);
      await clickAnswer(page, { correct: false });
      await expect(page.locator('#hud-lives')).toHaveText('❤️'.repeat(3 - i) + '🖤'.repeat(i));
      if (i < 3) await waitForReveal(page);
    }

    await expect(page.locator('#screen-gameover')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#gameover-title')).toHaveText('RUN OVER!');
    await expect(page.locator('#gameover-status')).toHaveText(/survived 4 questions/);
    await expect(page.locator('#btn-rematch')).toHaveText('PLAY AGAIN!');

    // play again: fresh run, full hearts, zero score
    await page.click('#btn-rematch');
    await waitForAnswering(page, 's-0');
    await expect(page.locator('#hud-lives')).toHaveText('❤️❤️❤️');
    expect((await engineState(page)).myScore).toBe(0);
  });

  test('joining a nonexistent room shows an error', async ({ context }) => {
    await stubApis(context);
    const page = await context.newPage();
    await page.goto(APP);
    await page.click('#btn-join');
    const boxes = page.locator('.code-box');
    const code = 'ZZZZ';
    for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
    await page.click('#btn-join-go');
    await expect(page.locator('#join-error')).toHaveText(/Room not found/, { timeout: 10_000 });
  });

  test('royale: antes, pot steals, rollover, eliminations, spectating, last one standing', async ({ context }) => {
    await stubApis(context);

    // Small starting stacks (debug-only) so eliminations come fast.
    const host = await context.newPage();
    await host.goto(`${APP}&rstart=125`);
    await host.fill('#player-name', 'HOSTY');
    await host.click('#btn-host');
    await expect(host.locator('#room-code')).toHaveText(/^[A-Z0-9]{4}$/);
    const code = (await host.locator('#room-code').textContent())?.trim();

    const joinRoyale = async (name) => {
      const p = await context.newPage();
      await p.goto(`${APP}&rstart=125`);
      await p.fill('#player-name', name);
      await p.click('#btn-join');
      const boxes = p.locator('.code-box');
      for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
      await p.click('#btn-join-go');
      await expect(p.locator('#screen-lobby')).toBeVisible();
      return p;
    };
    const guest = await joinRoyale('GUESTO');
    const p3 = await joinRoyale('BLOBBY');
    await expect(host.locator('#lobby-players')).toContainText('BLOBBY');

    // Royale lobby: rounds/difficulty hidden, ramp dial shown, no-timer gone
    await host.click('[data-setting="mode"] .chip[data-value="royale"]');
    await expect(host.locator('[data-group="rounds"]')).toBeHidden();
    await expect(host.locator('[data-group="difficulty"]')).toBeHidden();
    await expect(host.locator('[data-group="ramp"]')).toBeVisible();
    await expect(host.locator('[data-setting="timer"] .chip[data-value="0"]')).toBeHidden();
    // dial 1 exposes the static difficulty picker; dial 5 hides it again
    await host.click('[data-setting="ramp"] .chip[data-value="1"]');
    await expect(host.locator('[data-group="staticDiff"]')).toBeVisible();
    await host.click('[data-setting="ramp"] .chip[data-value="5"]');
    await expect(host.locator('[data-group="staticDiff"]')).toBeHidden();
    // guests see the royale settings mirrored
    await expect(guest.locator('[data-group="ramp"]')).toBeVisible();

    await host.click('[data-setting="timer"] .chip[data-value="30"]');
    await host.click('#btn-start');
    const everyone = [host, guest, p3];

    // ---- Q1: ante 25 each (100 left, pot 75); host takes the pot ----
    for (const p of everyone) await waitForAnswering(p, 'r-0');
    await expect(host.locator('#hud-round')).toHaveText(/ROYALE ∞ · Q1 · 💰75/);
    let s = await engineState(host);
    expect(s.pot).toBe(75);
    expect(s.myScore).toBe(100);
    await clickAnswer(p3, { correct: false });    // 50
    await clickAnswer(guest, { correct: false }); // 50
    await clickAnswer(host, { correct: true });   // takes 75 -> 175
    await waitForReveal(host);
    await expect(host.locator('#verdict-banner')).toHaveText(/\+75 POT!/);
    s = await engineState(host);
    expect(s.myScore).toBe(175);
    expect(s.pot).toBe(0);

    // ---- Q2: ante (host 150, others 25, pot 75); BLOBBY busts, GUESTO steals ----
    for (const p of everyone) await waitForAnswering(p, 'r-1');
    await clickAnswer(p3, { correct: false });    // 25 - 50 -> eliminated at reveal
    await clickAnswer(guest, { correct: true });  // takes 75 -> 100
    await waitForReveal(host);
    await expect(guest.locator('#verdict-banner')).toHaveText(/\+75 POT!/);
    await expect.poll(async () => (await engineState(p3)).meEliminated).toBe(true);

    // ---- Q3: BLOBBY spectates (input dead); GUESTO whiffs; host takes pot ----
    for (const p of everyone) await waitForAnswering(p, 'r-2');
    // spectator: engine refuses input, answer buttons stay disabled
    await p3.evaluate(() => {
      const e = window.__HMMM.engine;
      e.answer(e.currentQ.q.correctIndex);
    });
    expect(await p3.evaluate(() => window.__HMMM.engine.myAnswered)).toBe(false);
    expect(await p3.locator('.answer-btn:enabled').count()).toBe(0);
    await clickAnswer(guest, { correct: false }); // 75 - 50 -> 25
    await clickAnswer(host, { correct: true });   // takes 75 -> 200
    await waitForReveal(host);

    // ---- Q4: GUESTO's stack dies on the ante -> host is last standing ----
    await expect(host.locator('#screen-gameover')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('#gameover-title')).toHaveText('LAST ONE STANDING!');
    await expect(guest.locator('#gameover-title')).toHaveText('SQUASHED!');
    await expect(p3.locator('#gameover-title')).toHaveText('SQUASHED!');
    await expect(host.locator('#final-board .score-card')).toHaveCount(3);
  });

  test('royale: host-set ante drives the pot; rollover when everyone whiffs', async ({ context }) => {
    await stubApis(context);
    const { host, guest } = await setupMatch(context, { timer: '30' });
    await host.click('[data-setting="mode"] .chip[data-value="royale"]');
    // ante picker appears in royale; crank it to 100
    await expect(host.locator('[data-group="ante"]')).toBeVisible();
    await host.click('[data-setting="ante"] .chip[data-value="100"]');
    await expect(guest.locator('[data-setting="ante"] .chip[data-value="100"]')).toHaveClass(/selected/);
    await host.click('#btn-start');

    await waitForAnswering(host, 'r-0');
    await waitForAnswering(guest, 'r-0');
    expect((await engineState(host)).pot).toBe(200); // 100 x 2 players
    await clickAnswer(host, { correct: false });
    await clickAnswer(guest, { correct: false });
    await waitForReveal(host);
    await expect(host.locator('#verdict-banner')).toHaveText(/POT ROLLS OVER! 💰200/);

    // next question: rolled pot + fresh antes
    await waitForAnswering(host, 'r-1');
    expect((await engineState(host)).pot).toBe(400);
    await expect(host.locator('#hud-round')).toHaveText(/Q2 · 💰400/);
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);
    // two antes (-200), one wrong answer (-50), one giant pot (+400)
    expect((await engineState(host)).myScore).toBe(1150);
  });

  test('royale duel: alternating solo questions, loser pays or busts', async ({ context }) => {
    await stubApis(context);
    const host = await context.newPage();
    await host.goto(`${APP}&rstart=150`);
    await host.fill('#player-name', 'HOSTY');
    await host.click('#btn-host');
    await expect(host.locator('#room-code')).toHaveText(/^[A-Z0-9]{4}$/);
    const code = (await host.locator('#room-code').textContent())?.trim();
    const guest = await context.newPage();
    await guest.goto(`${APP}&rstart=150`);
    await guest.fill('#player-name', 'GUESTO');
    await guest.click('#btn-join');
    const boxes = guest.locator('.code-box');
    for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
    await guest.click('#btn-join-go');
    await expect(host.locator('#lobby-players')).toContainText('GUESTO');
    await host.click('[data-setting="mode"] .chip[data-value="royale"]');
    await host.click('[data-setting="timer"] .chip[data-value="30"]');
    await host.click('#btn-start');

    // r-0: both at 125 after ante. Host challenges for a 200 stake.
    await waitForAnswering(host, 'r-0');
    await waitForAnswering(guest, 'r-0');
    await host.click('.powerup-btn[data-type="duel"]');
    await expect(host.locator('#duel-modal')).toBeVisible();
    // single opponent: no target picker shown
    await expect(host.locator('#duel-targets')).toBeHidden();
    await host.locator('#duel-stake').evaluate((el) => {
      el.value = '200';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(host.locator('#duel-stake-val')).toHaveText('200');
    await host.click('#btn-duel-go');
    await expect(guest.locator('#toast-stack')).toContainText(/CHALLENGES/);

    // the main question still plays out first
    await clickAnswer(host, { correct: true }); // host takes pot -> 175
    await waitForReveal(host);

    // duel question 1: host's turn; guest can't touch anything
    await waitForAnswering(host, 'd-0-0');
    await waitForAnswering(guest, 'd-0-0');
    expect(await guest.locator('.answer-btn:enabled').count()).toBe(0);
    await expect(guest.locator('#hud-round')).toHaveText(/⚔️ .*HOSTY'S TURN/);
    await clickAnswer(host, { correct: true });
    await expect(host.locator('#verdict-banner')).toHaveText(/NAILS IT/);

    // duel question 2: guest's turn; guest misses -> can't cover 200 -> busts
    await waitForAnswering(guest, 'd-0-1');
    expect(await host.locator('.answer-btn:enabled').count()).toBe(0);
    await clickAnswer(guest, { correct: false });
    await expect(host.locator('#verdict-banner')).toHaveText(/DUEL WON! \+125/);
    await expect(host.locator('#screen-gameover')).toBeVisible({ timeout: 15_000 });
    await expect(host.locator('#gameover-title')).toHaveText('LAST ONE STANDING!');
    expect((await engineState(host)).myScore).toBe(300); // 175 + guest's whole 125
    expect((await engineState(guest)).meEliminated).toBe(true);
  });

  test('royale ghost shot: the fallen rise on a question everyone misses', async ({ context }) => {
    await stubApis(context);
    const host = await context.newPage();
    await host.goto(`${APP}&rstart=125`);
    await host.fill('#player-name', 'HOSTY');
    await host.click('#btn-host');
    await expect(host.locator('#room-code')).toHaveText(/^[A-Z0-9]{4}$/);
    const code = (await host.locator('#room-code').textContent())?.trim();
    const join = async (name) => {
      const p = await context.newPage();
      await p.goto(`${APP}&rstart=125`);
      await p.fill('#player-name', name);
      await p.click('#btn-join');
      const boxes = p.locator('.code-box');
      for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
      await p.click('#btn-join-go');
      return p;
    };
    const guest = await join('GUESTO');
    const p3 = await join('BLOBBY');
    await expect(host.locator('#lobby-players')).toContainText('BLOBBY');
    await host.click('[data-setting="mode"] .chip[data-value="royale"]');
    await host.click('[data-setting="timer"] .chip[data-value="30"]');
    await host.click('#btn-start');
    const everyone = [host, guest, p3];

    // r-0: BLOBBY whiffs (50), host takes the pot (175)
    for (const p of everyone) await waitForAnswering(p, 'r-0');
    await clickAnswer(p3, { correct: false });
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);

    // r-1: BLOBBY (25 after ante) whiffs to 0 -> eliminated
    for (const p of everyone) await waitForAnswering(p, 'r-1');
    await clickAnswer(p3, { correct: false });
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);
    await expect.poll(async () => (await engineState(p3)).meEliminated).toBe(true);

    // r-2: BOTH live players whiff -> ghost shot opens for BLOBBY
    for (const p of [host, guest]) await waitForAnswering(p, 'r-2');
    await clickAnswer(host, { correct: false });
    await clickAnswer(guest, { correct: false });
    await p3.waitForFunction(() => window.__HMMM.engine.ghostShotQKey === 'r-2', undefined, { timeout: 10_000 });
    await expect(p3.locator('#verdict-banner')).toHaveText(/LAST SHOT/);
    expect(await p3.locator('.answer-btn:enabled').count()).toBeGreaterThan(0);
    await clickAnswer(p3, { correct: true });

    // BLOBBY rises with 100; the guest's busted stack stays dead
    await expect.poll(async () => (await engineState(p3)).meEliminated, { timeout: 10_000 }).toBe(false);
    expect((await engineState(p3)).myScore).toBe(100);
    await expect.poll(async () => (await engineState(guest)).meEliminated).toBe(true);

    // the game rolls on with host + revived BLOBBY anteing up
    await waitForAnswering(p3, 'r-3');
    expect(await p3.locator('.answer-btn:enabled').count()).toBe(4);
    const s = await engineState(p3);
    expect(s.myScore).toBe(75); // 100 - 25 ante
    expect(s.pot).toBe(100);    // r-2's unclaimed pot rolled into fresh antes
  });

  test('co-op: team score, hearts, revive, goal victory', async ({ context }) => {
    await stubApis(context);
    const { host, guest, code } = await setupMatch(context, { timer: '30' });
    const p3 = await joinAs(context, code, 'BLOBBY');
    await expect(host.locator('#lobby-players')).toContainText('BLOBBY');

    // co-op lobby: goal + ramp shown; rounds/difficulty/ante hidden
    await host.click('[data-setting="mode"] .chip[data-value="coop"]');
    await expect(host.locator('[data-group="goal"]')).toBeVisible();
    await expect(host.locator('[data-group="ramp"]')).toBeVisible();
    await expect(host.locator('[data-group="rounds"]')).toBeHidden();
    await expect(host.locator('[data-group="ante"]')).toBeHidden();
    await host.click('[data-setting="goal"] .chip[data-value="1000"]');
    await expect(guest.locator('[data-setting="goal"] .chip[data-value="1000"]')).toHaveClass(/selected/);
    await host.click('#btn-start');
    const everyone = [host, guest, p3];

    // shared header + hearts; shop pruned to 50/50, double, revive
    for (const p of everyone) await waitForAnswering(p, 'c-0');
    await expect(host.locator('#hud-round')).toHaveText(/CO-OP 🤝 · Q1 · ⭐0\/1000/);
    await expect(host.locator('#hud-me-score')).toHaveText('❤️❤️❤️');
    await expect(host.locator('.powerup-btn[data-type="freeze"]')).toBeHidden();
    await expect(host.locator('.powerup-btn[data-type="duel"]')).toBeHidden();
    await expect(host.locator('.powerup-btn[data-type="revive"]')).toBeVisible();

    // c-0..c-2: BLOBBY burns three hearts; host banks three wins
    for (let i = 0; i <= 2; i++) {
      await clickAnswer(p3, { correct: false });
      await expect.poll(async () => (await engineState(p3)).myLives).toBe(2 - i);
      await clickAnswer(host, { correct: true });
      await waitForReveal(host);
      if (i < 2) for (const p of everyone) await waitForAnswering(p, `c-${i + 1}`);
    }
    await expect.poll(async () => (await engineState(p3)).meEliminated).toBe(true);
    let s = await engineState(host);
    expect(s.teamScore).toBeGreaterThanOrEqual(550);

    // c-3: guest buys REVIVE from the team wallet, then wins the question
    for (const p of everyone) await waitForAnswering(p, 'c-3');
    const beforeBuy = (await engineState(guest)).teamScore;
    await guest.click('.powerup-btn[data-type="revive"]');
    await expect.poll(async () => (await engineState(guest)).teamScore).toBe(beforeBuy - 200);
    await clickAnswer(guest, { correct: true });
    await waitForReveal(guest);

    // revive question: only the buyer may answer; success auto-revives BLOBBY
    await waitForAnswering(guest, 'v-3');
    expect(await host.locator('.answer-btn:enabled').count()).toBe(0);
    await expect(host.locator('#hud-round')).toHaveText(/💚 REVIVE · GUESTO'S REDEMPTION/);
    await clickAnswer(guest, { correct: true });
    await expect.poll(async () => (await engineState(p3)).meEliminated, { timeout: 10_000 }).toBe(false);
    expect((await engineState(p3)).myLives).toBe(2);

    // revived BLOBBY is back in the fight
    for (const p of everyone) await waitForAnswering(p, 'c-4');
    expect(await p3.locator('.answer-btn:enabled').count()).toBe(4);

    // grind to the 1000 goal — everyone celebrates
    for (let i = 4; i <= 8; i++) {
      const st = await engineState(host);
      if (st.phase === 'gameover') break;
      await waitForAnswering(host, `c-${i}`).catch(() => {});
      const now = await engineState(host);
      if (now.phase === 'gameover') break;
      if (now.qKey !== `c-${i}`) continue;
      await clickAnswer(host, { correct: true });
      await waitForReveal(host);
    }
    for (const p of everyone) {
      await expect(p.locator('#gameover-title')).toHaveText('GOAL SMASHED!', { timeout: 20_000 });
    }
    await expect(host.locator('#final-board')).toContainText('THE TEAM');
    await expect(host.locator('#btn-rematch')).toHaveText('GO AGAIN!');
  });

  test('co-op: a timed-out question costs everyone a heart, and can wipe the team', async ({ context }) => {
    await stubApis(context);
    const { host, guest } = await setupMatch(context, { timer: '10' });
    await host.click('[data-setting="mode"] .chip[data-value="coop"]');
    await host.click('[data-setting="goal"] .chip[data-value="0"]'); // endless
    await host.click('#btn-start');

    // Three questions of silence: hearts burn 3 -> 2 -> 1 -> 0
    for (let i = 0; i <= 2; i++) {
      await waitForAnswering(host, `c-${i}`);
      await waitForAnswering(guest, `c-${i}`);
      // nobody answers; the 10s clock does its work
      await expect
        .poll(async () => (await engineState(host)).myLives, { timeout: 25_000 })
        .toBe(2 - i);
      expect((await engineState(guest)).myLives).toBe(2 - i);
      if (i === 0) await expect(host.locator('#verdict-banner')).toHaveText(/TIME'S UP! -1 ❤️/);
    }

    // full wipe by stalling: TEAM SQUASHED for everyone
    await expect(host.locator('#gameover-title')).toHaveText('TEAM SQUASHED!', { timeout: 20_000 });
    await expect(guest.locator('#gameover-title')).toHaveText('TEAM SQUASHED!');
  });

  test('four-player battle: multi-stamps, freeze-all, dropout, fifth rejected', async ({ context }) => {
    await stubApis(context);
    const { host, guest, code } = await setupMatch(context, { timer: '30' });

    const b1 = guest; // GUESTO — seated by setupMatch
    const b2 = await joinAs(context, code, 'BLOBB');
    const b3 = await joinAs(context, code, 'BLOBC');
    await expect(host.locator('#lobby-players')).toContainText('BLOBC');
    for (const page of [b1, b2, b3]) {
      await expect(page.locator('#lobby-players')).toContainText('HOSTY');
    }

    // A fifth player is turned away from the full lobby.
    const late = await joinAs(context, code, 'LATEY');
    await expect(late.locator('#modal')).toBeVisible({ timeout: 10_000 });
    await expect(late.locator('#modal-text')).toHaveText(/full|mid-battle/);
    await late.click('#modal-btn');

    await host.click('#btn-start');
    const everyone = [host, b1, b2, b3];

    // ---- Q1: two players whiff (both stamps visible), BLOBC steals ----
    for (const page of everyone) await waitForAnswering(page, '1-0');
    const q1 = await host.locator('#q-text').textContent();
    for (const page of [b1, b2, b3]) {
      expect(await page.locator('#q-text').textContent()).toBe(q1);
    }
    await clickAnswer(b1, { correct: false });
    await clickAnswer(b2, { correct: false });
    await expect(host.locator('.answer-stamp.wrong')).toHaveCount(2);
    await expect(host.locator('.answer-stamp.wrong').first()).toContainText(/GUESTO|BLOB/);
    await clickAnswer(b3, { correct: true });
    await waitForReveal(host);
    await expect(host.locator('#verdict-banner')).toHaveText(/BLOBC GOT IT!/);
    await expect(host.locator('.answer-stamp.correct')).toContainText('BLOBC');
    let s = await engineState(host);
    expect(Object.values(s.scores).filter((x) => x === -50)).toHaveLength(2);

    // ---- Q2: BLOBC freezes EVERYONE else ----
    for (const page of everyone) await waitForAnswering(page, '1-1');
    await b3.click('.powerup-btn[data-type="freeze"]');
    for (const page of [host, b1, b2]) {
      await expect(page.locator('#freeze-overlay')).toHaveClass(/show/);
    }
    await expect(b3.locator('#freeze-overlay')).not.toHaveClass(/show/);
    await clickAnswer(b3, { correct: true });
    await waitForReveal(host);

    // ---- Q3: BLOBA quits mid-question; the battle continues with 3 ----
    for (const page of everyone) await waitForAnswering(page, '1-2');
    await b1.click('#btn-quit-game');
    await b1.click('#modal-btn');
    await expect(b1.locator('#screen-title')).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await engineState(host)).rosterNames.length, { timeout: 10_000 }).toBe(3);
    await clickAnswer(host, { correct: true });
    await waitForReveal(host);

    // ---- host takes the rest ----
    for (let i = 3; i < 10; i++) {
      await waitForAnswering(host, `1-${i}`);
      await clickAnswer(host, { correct: true });
      await waitForReveal(host);
    }

    await expect(host.locator('#screen-gameover')).toBeVisible({ timeout: 15_000 });
    await expect(host.locator('#gameover-title')).toHaveText('YOU WIN!');
    await expect(b2.locator('#gameover-title')).toHaveText('SQUASHED!');
    await expect(b3.locator('#gameover-title')).toHaveText('SQUASHED!');
    // final board shows the 3 remaining players on every screen
    await expect(host.locator('#final-board .score-card')).toHaveCount(3);
    await expect(b3.locator('#final-board .score-card')).toHaveCount(3);
  });
});
