// ---- Local-day helpers -----------------------------------------------------------------------
// The real NYT Wordle picks the day's puzzle from each player's own device calendar date, not a
// globally synchronized timezone -- so this mirrors that: everyone sees the same word for a given
// calendar date, but rolls over to the next one at their own local midnight. The server-side
// scraper caches a small rolling window of dates (data/answers.json) so whichever local date a
// visitor is on, it's very likely already cached.

function todayKeyLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function secondsUntilLocalMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return Math.round((next - now) / 1000);
}

// ---- Game constants -----------------------------------------------------------------------

const WORD_LENGTH = 5;
const MAX_TRIES = 6;

const KEY_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['Enter', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'Backspace'],
];

// ---- DOM ------------------------------------------------------------------------------------

const dayNumberEl = document.getElementById('day-number');
const boardEl = document.getElementById('board');
const keyboardEl = document.getElementById('keyboard');
const toastEl = document.getElementById('toast');
const resultPanel = document.getElementById('result-panel');
const resultTitle = document.getElementById('result-title');
const resultDetail = document.getElementById('result-detail');
const shareText = document.getElementById('share-text');
const copyBtn = document.getElementById('copy-btn');
const copyConfirm = document.getElementById('copy-confirm');
const countdownEl = document.getElementById('countdown');
const authStatus = document.getElementById('auth-status');
const authOpenBtn = document.getElementById('auth-open-btn');
const authLogoutBtn = document.getElementById('auth-logout-btn');
const authModal = document.getElementById('auth-modal');
const authTabs = document.querySelectorAll('.auth-tab');
const authForm = document.getElementById('auth-form');
const authUsernameInput = document.getElementById('auth-username');
const authPasswordInput = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authCloseBtn = document.getElementById('auth-close-btn');
const statsBlock = document.getElementById('stats-block');
const statsPrompt = document.getElementById('stats-prompt');
const statsLoginBtn = document.getElementById('stats-login-btn');
const personalHistogram = document.getElementById('personal-histogram');
const todayHistogram = document.getElementById('today-histogram');

// Same Cloudflare Quick Tunnel backend as angle-rip-off -- see that repo's script.js for the
// stability caveat (URL only changes if the tunnel process itself restarts).
const BACKEND_URL = 'https://sorry-bear-tops-desire.trycloudflare.com';

// ---- Board / keyboard construction -----------------------------------------------------------

function buildBoard() {
  boardEl.innerHTML = '';
  for (let r = 0; r < MAX_TRIES; r++) {
    const row = document.createElement('div');
    row.className = 'tile-row';
    row.id = `row-${r}`;
    for (let c = 0; c < WORD_LENGTH; c++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.id = `tile-${r}-${c}`;
      row.appendChild(tile);
    }
    boardEl.appendChild(row);
  }
}

function buildKeyboard() {
  keyboardEl.innerHTML = '';
  KEY_ROWS.forEach((keys) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    keys.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isWide = key === 'Enter' || key === 'Backspace';
      btn.className = isWide ? 'key wide' : 'key';
      btn.dataset.key = key;
      btn.textContent = key === 'Backspace' ? 'del' : key;
      btn.addEventListener('click', () => handleKey(key));
      row.appendChild(btn);
    });
    keyboardEl.appendChild(row);
  });
}

let toastTimer = null;
function showToast(message, duration = 1300) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, duration);
}

// ---- Scoring: standard two-pass Wordle algorithm, correct handling of duplicate letters ------

function evaluateGuess(guess, solution) {
  const result = new Array(WORD_LENGTH).fill('absent');
  const solChars = solution.split('');
  const counts = {};
  for (const ch of solChars) counts[ch] = (counts[ch] || 0) + 1;

  for (let i = 0; i < WORD_LENGTH; i++) {
    if (guess[i] === solChars[i]) {
      result[i] = 'correct';
      counts[guess[i]] -= 1;
    }
  }
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === 'correct') continue;
    const ch = guess[i];
    if (counts[ch] > 0) {
      result[i] = 'present';
      counts[ch] -= 1;
    }
  }
  return result;
}

const KEY_PRIORITY = { absent: 0, present: 1, correct: 2 };

function updateKeyboardState(guess, result) {
  for (let i = 0; i < WORD_LENGTH; i++) {
    const ch = guess[i];
    const status = result[i];
    const current = keyStatus[ch];
    if (!current || KEY_PRIORITY[status] > KEY_PRIORITY[current]) {
      keyStatus[ch] = status;
      const btn = keyboardEl.querySelector(`[data-key="${ch}"]`);
      if (btn) {
        btn.classList.remove('correct', 'present', 'absent');
        btn.classList.add(status);
      }
    }
  }
}

// ---- Auth -----------------------------------------------------------------------------------

const AUTH_KEY = 'wordle-rip-off:auth';

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAuth(next) {
  if (next) localStorage.setItem(AUTH_KEY, JSON.stringify(next));
  else localStorage.removeItem(AUTH_KEY);
}

let auth = loadAuth(); // { token, username } | null
let authMode = 'login';

function updateAuthUI() {
  if (auth) {
    authStatus.hidden = false;
    authStatus.textContent = `logged in as ${auth.username}`;
    authOpenBtn.hidden = true;
    authLogoutBtn.hidden = false;
  } else {
    authStatus.hidden = true;
    authOpenBtn.hidden = false;
    authLogoutBtn.hidden = true;
  }
}

function setAuthMode(mode) {
  authMode = mode;
  authTabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === mode));
  authSubmitBtn.textContent = mode === 'login' ? 'log in' : 'sign up';
  authPasswordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authError.hidden = true;
}

function openAuthModal() {
  authModal.hidden = false;
  authError.hidden = true;
  authUsernameInput.focus();
}

function closeAuthModal() {
  authModal.hidden = true;
  authForm.reset();
}

authOpenBtn.addEventListener('click', openAuthModal);
statsLoginBtn.addEventListener('click', openAuthModal);
authCloseBtn.addEventListener('click', closeAuthModal);
authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });
authTabs.forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.tab)));

authLogoutBtn.addEventListener('click', () => {
  auth = null;
  saveAuth(null);
  updateAuthUI();
  statsBlock.hidden = true;
  statsPrompt.hidden = state.status === 'playing';
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = authUsernameInput.value.trim();
  const password = authPasswordInput.value;
  authError.hidden = true;
  authSubmitBtn.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/api/wordle/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      authError.textContent = data.error || 'something went wrong';
      authError.hidden = false;
      return;
    }
    auth = { token: data.token, username: data.username };
    saveAuth(auth);
    updateAuthUI();
    closeAuthModal();
    if (state.status !== 'playing') {
      submitResult();
      loadStats();
    }
  } catch {
    authError.textContent = 'network error -- try again';
    authError.hidden = false;
  } finally {
    authSubmitBtn.disabled = false;
  }
});

// ---- Stats: personal guess-distribution histogram + today's cohort comparison ----------------

const HIST_LABELS = ['1', '2', '3', '4', '5', '6', 'X'];

function renderHistogram(container, distribution, fails, highlightLabel) {
  container.innerHTML = '';
  const counts = ['1', '2', '3', '4', '5', '6'].map((k) => distribution[k] || 0).concat([fails || 0]);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    const p = document.createElement('p');
    p.className = 'stats-empty';
    p.textContent = 'no games recorded yet.';
    container.appendChild(p);
    return;
  }
  const max = Math.max(...counts);
  HIST_LABELS.forEach((label, i) => {
    const count = counts[i];
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'hist-row';
    if (label === highlightLabel) row.classList.add('highlight');
    row.innerHTML = `
      <span class="hist-label">${label}</span>
      <div class="hist-track"><div class="hist-bar" style="width:${pct}%"></div></div>
      <span class="hist-count">${count}</span>
    `;
    container.appendChild(row);
  });
}

async function loadStats() {
  if (!auth || state.status === 'playing') return;
  const highlightLabel = state.status === 'won' ? String(state.guesses.length) : 'X';
  try {
    const [statsRes, todayRes] = await Promise.all([
      fetch(`${BACKEND_URL}/api/wordle/stats`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      }),
      fetch(`${BACKEND_URL}/api/wordle/today-comparison?day=${answerData.print_date}`),
    ]);
    if (!statsRes.ok || !todayRes.ok) throw new Error('stats fetch failed');
    const stats = await statsRes.json();
    const today = await todayRes.json();

    statsPrompt.hidden = true;
    statsBlock.hidden = false;
    renderHistogram(personalHistogram, stats.distribution, stats.fails, highlightLabel);
    renderHistogram(todayHistogram, today.distribution, today.fails, highlightLabel);
  } catch {
    // Backend unreachable -- leave the login prompt/stats block as-is rather than erroring out.
  }
}

async function submitResult() {
  if (!auth || state.resultSubmitted || state.status === 'playing') return;
  try {
    const res = await fetch(`${BACKEND_URL}/api/wordle/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({
        day: answerData.print_date,
        won: state.status === 'won',
        tries: state.status === 'won' ? state.guesses.length : null,
      }),
    });
    if (res.ok) {
      state.resultSubmitted = true;
      saveState();
    }
  } catch {
    // Result just won't count toward stats this time -- the game itself already finished fine.
  }
}

// ---- Game state ------------------------------------------------------------------------------

let answerData = null; // { id, solution, print_date, days_since_launch }
let validWords = null; // Set<string>
let keyStatus = {};
let state = { guesses: [], status: 'playing' }; // guesses: [{ word, result }]
let storageKey = null;

function loadState(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { guesses: [], status: 'playing' };
    return JSON.parse(raw);
  } catch {
    return { guesses: [], status: 'playing' };
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

// ---- Rendering --------------------------------------------------------------------------------

let currentGuess = '';

function renderCurrentRow() {
  const rowIndex = state.guesses.length;
  if (rowIndex >= MAX_TRIES) return;
  for (let c = 0; c < WORD_LENGTH; c++) {
    const tile = document.getElementById(`tile-${rowIndex}-${c}`);
    const ch = currentGuess[c] || '';
    tile.textContent = ch;
    tile.classList.toggle('filled', ch !== '');
  }
}

function renderSubmittedRows() {
  state.guesses.forEach((g, r) => {
    for (let c = 0; c < WORD_LENGTH; c++) {
      const tile = document.getElementById(`tile-${r}-${c}`);
      tile.textContent = g.word[c];
      tile.classList.add('filled', g.result[c]);
    }
    updateKeyboardState(g.word, g.result);
  });
}

function animateReveal(rowIndex, guess, result, onDone) {
  const FLIP_MS = 350;
  const STAGGER = FLIP_MS / 1.6;
  for (let c = 0; c < WORD_LENGTH; c++) {
    const tile = document.getElementById(`tile-${rowIndex}-${c}`);
    setTimeout(() => {
      tile.classList.add('flip');
      setTimeout(() => {
        tile.textContent = guess[c];
        tile.classList.add('filled', result[c]);
        tile.classList.remove('flip');
      }, FLIP_MS / 2);
    }, c * STAGGER);
  }
  setTimeout(onDone, (WORD_LENGTH - 1) * STAGGER + FLIP_MS + 100);
}

// ---- Share text, matching the real NYT Wordle share format exactly ---------------------------

function buildShareText() {
  const puzzleNum = answerData.days_since_launch.toLocaleString('en-US');
  const tries = state.status === 'won' ? `${state.guesses.length}/${MAX_TRIES}` : `X/${MAX_TRIES}`;
  const grid = state.guesses
    .map((g) => g.result.map((r) => (r === 'correct' ? '\u{1F7E9}' : r === 'present' ? '\u{1F7E8}' : '\u{2B1B}')).join(''))
    .join('\n');
  return `Wordle ${puzzleNum} ${tries}\n\n${grid}\n\nhttps://v8537.github.io/wordle-rip-off/`;
}

function renderResult() {
  resultPanel.hidden = false;
  const won = state.status === 'won';
  resultTitle.textContent = won ? `solved in ${state.guesses.length}/${MAX_TRIES}` : 'not this time';
  resultDetail.textContent = won
    ? `the word was ${answerData.solution.toUpperCase()}.`
    : `the word was ${answerData.solution.toUpperCase()}.`;
  shareText.textContent = buildShareText();

  if (auth) {
    statsPrompt.hidden = true;
    submitResult();
    loadStats();
  } else {
    statsBlock.hidden = true;
    statsPrompt.hidden = false;
  }
}

// ---- Input handling ----------------------------------------------------------------------------

function handleKey(key) {
  if (state.status !== 'playing') return;
  if (key === 'Enter') {
    submitGuess();
  } else if (key === 'Backspace') {
    currentGuess = currentGuess.slice(0, -1);
    renderCurrentRow();
  } else if (/^[a-z]$/.test(key)) {
    if (currentGuess.length < WORD_LENGTH) {
      currentGuess += key;
      renderCurrentRow();
    }
  }
}

function submitGuess() {
  const rowIndex = state.guesses.length;
  if (currentGuess.length < WORD_LENGTH) {
    showToast('not enough letters');
    shakeRow(rowIndex);
    return;
  }
  if (!validWords.has(currentGuess) && currentGuess !== answerData.solution) {
    showToast('not in word list');
    shakeRow(rowIndex);
    return;
  }

  const guess = currentGuess;
  const result = evaluateGuess(guess, answerData.solution);
  state.guesses.push({ word: guess, result });
  currentGuess = '';

  animateReveal(rowIndex, guess, result, () => {
    updateKeyboardState(guess, result);

    if (guess === answerData.solution) {
      state.status = 'won';
    } else if (state.guesses.length >= MAX_TRIES) {
      state.status = 'lost';
    }
    saveState();

    if (state.status !== 'playing') {
      renderResult();
    }
  });
}

function shakeRow(rowIndex) {
  const row = document.getElementById(`row-${rowIndex}`);
  row.classList.add('shake');
  setTimeout(() => row.classList.remove('shake'), 400);
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Enter') { handleKey('Enter'); return; }
  if (e.key === 'Backspace') { handleKey('Backspace'); return; }
  const k = e.key.toLowerCase();
  if (/^[a-z]$/.test(k)) handleKey(k);
});

copyBtn.addEventListener('click', async () => {
  const text = buildShareText();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copyConfirm.hidden = false;
  setTimeout(() => { copyConfirm.hidden = true; }, 1800);
});

function tickCountdown() {
  let secs = secondsUntilLocalMidnight();
  if (secs < 0) secs = 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  countdownEl.textContent =
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---- Boot ---------------------------------------------------------------------------------------

function showUnavailable() {
  boardEl.innerHTML = '';
  keyboardEl.innerHTML = '';
  dayNumberEl.textContent = 'wordle rip-off';
  resultPanel.hidden = false;
  resultTitle.textContent = "today's word isn't ready yet";
  resultDetail.textContent = 'the daily scrape hasn’t run yet -- check back in a bit.';
  document.getElementById('share-text').parentElement.hidden = true;
}

async function boot() {
  const localKey = todayKeyLocal();
  let data;
  try {
    const res = await fetch(`data/answers.json?d=${localKey}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch failed');
    const answers = await res.json();
    data = answers[localKey];
    if (!data) throw new Error('no answer cached for today');
  } catch {
    showUnavailable();
    tickCountdown();
    setInterval(tickCountdown, 1000);
    return;
  }

  answerData = data;
  answerData.solution = answerData.solution.toLowerCase();

  try {
    const wordsRes = await fetch('words/valid-guesses.txt');
    const text = await wordsRes.text();
    validWords = new Set(text.split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean));
  } catch {
    validWords = new Set();
  }

  storageKey = `wordle-rip-off:${answerData.print_date}`;
  state = loadState(storageKey);
  keyStatus = {};

  dayNumberEl.textContent = `wordle rip-off #${answerData.days_since_launch.toLocaleString('en-US')}`;

  buildBoard();
  buildKeyboard();
  renderSubmittedRows();
  updateAuthUI();

  if (state.status !== 'playing') {
    renderResult();
  }

  tickCountdown();
  setInterval(tickCountdown, 1000);
}

boot();
