// Question sourcing: pulls from two public trivia APIs in parallel,
// normalizes both formats, and falls back to a bundled offline bank if
// the network lets us down. Only the HOST fetches; questions are then
// broadcast so both players see exactly the same thing.

import { FALLBACK_BANK } from './data/fallback-questions.js';
import { QUESTIONS_PER_ROUND } from './config.js';

const OPENTDB_URL = 'https://opentdb.com/api.php';
const TRIVIA_API_URL = 'https://the-trivia-api.com/v2/questions';
const FETCH_TIMEOUT_MS = 8000;

// OpenTDB returns HTML-entity-encoded strings ("&quot;", "&#039;"...).
const entityDecoder = document.createElement('textarea');
function decodeEntities(s) {
  entityDecoder.innerHTML = s;
  return entityDecoder.value;
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(text, category, difficulty, correct, incorrect, source) {
  const answers = shuffle([correct, ...incorrect.slice(0, 3)]);
  return {
    text,
    category,
    difficulty,
    answers,
    correctIndex: answers.indexOf(correct),
    source,
  };
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenTDB(count, difficulty) {
  const url = `${OPENTDB_URL}?amount=${count}&difficulty=${difficulty}&type=multiple`;
  const json = await fetchWithTimeout(url);
  if (json.response_code !== 0 || !Array.isArray(json.results)) {
    throw new Error(`OpenTDB response_code ${json.response_code}`);
  }
  return json.results.map((r) => normalize(
    decodeEntities(r.question),
    decodeEntities(r.category),
    difficulty,
    decodeEntities(r.correct_answer),
    r.incorrect_answers.map(decodeEntities),
    'opentdb',
  ));
}

async function fetchTriviaAPI(count, difficulty) {
  const url = `${TRIVIA_API_URL}?limit=${count}&difficulties=${difficulty}&types=text_choice`;
  const json = await fetchWithTimeout(url);
  if (!Array.isArray(json)) throw new Error('Trivia API: unexpected payload');
  return json
    .filter((q) => q.incorrectAnswers && q.incorrectAnswers.length >= 3)
    .map((q) => normalize(
      typeof q.question === 'object' ? q.question.text : q.question,
      (q.category || 'general').replace(/_/g, ' '),
      difficulty,
      q.correctAnswer,
      q.incorrectAnswers,
      'the-trivia-api',
    ));
}

function fromFallback(count, difficulty, exclude) {
  const pool = shuffle(FALLBACK_BANK.filter(
    (q) => q.difficulty === difficulty && !exclude.has(q.text),
  ));
  const picked = pool.slice(0, count);
  // Bank exhausted (long games) — allow reuse rather than breaking the game.
  if (picked.length < count) {
    const extra = shuffle(FALLBACK_BANK.filter((q) => q.difficulty === difficulty));
    while (picked.length < count && extra.length) picked.push(extra.pop());
  }
  return picked.map((q) => normalize(q.text, q.category, difficulty, q.correct, q.incorrect, 'bank'));
}

// Fetch `count` questions of one difficulty, drawing from both APIs at
// once and topping up from whichever succeeded / the offline bank.
async function fetchDifficulty(count, difficulty, exclude) {
  const half = Math.ceil(count / 2);
  const settled = await Promise.allSettled([
    fetchOpenTDB(half, difficulty),
    fetchTriviaAPI(count - half > 0 ? count - half : half, difficulty),
  ]);
  let pool = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') pool = pool.concat(s.value);
  }
  // Dedupe by text, drop anything already used in a previous round/rematch.
  const seen = new Set();
  pool = pool.filter((q) => {
    const key = q.text.toLowerCase();
    if (seen.has(key) || exclude.has(q.text)) return false;
    seen.add(key);
    return true;
  });
  pool = shuffle(pool);
  if (pool.length < count) {
    pool = pool.concat(fromFallback(count - pool.length, difficulty, exclude));
  }
  return pool.slice(0, count);
}

// difficulty mode: 'easy' | 'medium' | 'hard' | 'increasing'
// Returns a flat list of rounds*10 questions. In 'increasing' mode the
// difficulty ramps easy → medium → hard across the whole game.
export async function buildQuestionSet(mode, rounds, usedTexts = new Set()) {
  const total = rounds * QUESTIONS_PER_ROUND;
  let plan; // list of [difficulty, count]
  if (mode === 'increasing') {
    const easy = Math.round(total / 3);
    const hard = Math.round(total / 3);
    plan = [['easy', easy], ['medium', total - easy - hard], ['hard', hard]];
  } else {
    plan = [[mode, total]];
  }

  const chunks = await Promise.all(
    plan.map(([diff, count]) => (count > 0 ? fetchDifficulty(count, diff, usedTexts) : [])),
  );

  let questions;
  if (mode === 'increasing') {
    // Keep the ramp order: easy block, then medium, then hard —
    // shuffled *within* each block.
    questions = chunks.flatMap((c) => shuffle(c));
  } else {
    questions = shuffle(chunks.flat());
  }
  for (const q of questions) usedTexts.add(q.text);
  return questions.slice(0, total);
}
