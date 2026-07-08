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
    theirScore: (e.opponent && e.scores[e.opponent.id]) ?? 0,
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

async function setupMatch(context, { timer = '30' } = {}) {
  const host = await context.newPage();
  await host.goto(APP);
  await host.fill('#player-name', 'HOSTY');
  await host.click('#btn-host');
  await expect(host.locator('#screen-lobby')).toBeVisible();
  const code = (await host.locator('#room-code').textContent())?.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}$/);

  const guest = await context.newPage();
  await guest.goto(APP);
  await guest.fill('#player-name', 'GUESTO');
  await guest.click('#btn-join');
  const boxes = guest.locator('.code-box');
  for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
  await guest.click('#btn-join-go');
  await expect(guest.locator('#screen-lobby')).toBeVisible();

  // Both lobbies show both names
  await expect(host.locator('#lobby-p2-name')).toHaveText('GUESTO');
  await expect(guest.locator('#lobby-p1-name')).toHaveText('HOSTY');

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

    // ---- Q1: same question on both screens; cursor sharing; host wins ----
    await waitForAnswering(host, '1-0');
    await waitForAnswering(guest, '1-0');
    const hostQ = await host.locator('#q-text').textContent();
    const guestQ = await guest.locator('#q-text').textContent();
    expect(hostQ).toBe(guestQ);

    // cursors: host moves; guest sees the clay cursor appear
    await host.mouse.move(400, 400);
    await host.mouse.move(600, 500, { steps: 10 });
    await expect(guest.locator('#cursor-them')).toHaveClass(/visible/, { timeout: 5000 });
    await expect(guest.locator('#cursor-them-tag')).toHaveText('HOSTY');

    await clickAnswer(host, { correct: true });
    await waitForReveal(host);
    let hs = await engineState(host);
    expect(hs.myScore).toBeGreaterThanOrEqual(100); // base + speed bonus
    const scoreAfterQ1 = hs.myScore;
    await expect(guest.locator('#verdict-banner')).toHaveText(/HOSTY GOT IT!/);

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
    // frozen guest clicks are ignored by the engine
    await clickAnswer(guest, { correct: true });
    const gsFrozen = await engineState(guest);
    expect(gsFrozen.phase).toBe('answering'); // nothing happened
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
    expect(hs.myScore).toBe(0);
    expect(hs.theirScore).toBe(0);
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

  test('a third player is turned away from a full room', async ({ context }) => {
    await stubApis(context);
    const { code } = await setupMatch(context);

    const third = await context.newPage();
    await third.goto(APP);
    await third.fill('#player-name', 'CROWDY');
    await third.click('#btn-join');
    const boxes = third.locator('.code-box');
    for (let i = 0; i < 4; i++) await boxes.nth(i).fill(code[i]);
    await third.click('#btn-join-go');
    await expect(third.locator('#modal')).toBeVisible({ timeout: 10_000 });
    await expect(third.locator('#modal-text')).toHaveText(/full|mid-battle/);
  });
});
