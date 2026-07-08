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

    // ---- Q5: host buys shield, answers wrong — no penalty ----
    await waitForAnswering(host, '1-4');
    await waitForAnswering(guest, '1-4');
    const beforeShield = (await engineState(host)).myScore - 75; // cost deducted on buy
    await host.click('.powerup-btn[data-type="shield"]');
    await clickAnswer(host, { correct: false });
    await expect(host.locator('#verdict-banner')).toHaveText(/SHIELDED/);
    expect((await engineState(host)).myScore).toBe(beforeShield); // no -50
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
