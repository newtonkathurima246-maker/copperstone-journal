/* =========================================================
   COPPERSTONE TRADE JOURNAL — APPLICATION LOGIC
   ========================================================= */

const STORAGE_KEY = 'copperstoneTradeJournalData';
const SNAPSHOT_KEY = STORAGE_KEY + '_snapshots';
const PROFILE_KEY = 'copperstoneLocalProfile';
const SESSION_KEY = 'copperstoneSession';
const APP_VERSION = '2.0.0';
const SCHEMA_VERSION = 2;

/* Central place for things a hosted (multi-user) edition would configure.
   Nothing here is connected to a service in this local edition. */
const COPPERSTONE_CONFIG = {
  apiBaseUrl: null,          // e.g. 'https://api.example.com' once a backend exists
  edition: 'local',          // 'local' | 'cloud'
  features: { cloudSync: false, multiUser: false, subscriptions: false, adminDashboard: false }
};

/* ---- MT5 bridge (read-only) ----
   The frontend never talks to MetaTrader directly. It only calls the
   user's already-running local bridge over HTTP. No credentials are
   ever collected or transmitted by this app. */
const MT5_BRIDGE_URL = 'https://chrome-transmission-way-gourmet.trycloudflare.com';
const MT5_ENDPOINTS = {
  status: '/api/mt5/status',
  account: '/api/mt5/account',
  positions: '/api/mt5/positions',
  history: '/api/mt5/history'
};

let state = null;
let charts = {}; // named chart.js instances
let journalFilters = defaultJournalFilters();
let calendarViewDate = new Date();
let selectedCalendarDay = null;
let pendingConfirmAction = null;
let editingShots = { before: null, after: null };
let mt5AutoRefreshTimer = null;
let mt5IsSyncing = false;
let pendingImport = null;
let lastFocusedEl = null;

/* ============================================================
   UTILITIES
   ============================================================ */

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/* Local calendar date (YYYY-MM-DD). toISOString() would return the UTC date,
   which is the wrong day for anyone whose local time is near midnight. */
function toLocalDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function nowDateStr() {
  return toLocalDateStr(new Date());
}

/* Ids end up inside inline onclick attributes, so only safe characters are allowed. */
function safeId(id) {
  return String(id === null || id === undefined ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

function safeDiv(a, b) {
  if (!b || !isFinite(a / b)) return 0;
  return a / b;
}

function currencySymbol() {
  const map = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  return map[state?.settings?.currency] || '$';
}

function fmtMoney(v) {
  if (v === null || v === undefined || !isFinite(v)) return currencySymbol() + '0.00';
  const sign = v < 0 ? '-' : '';
  return sign + currencySymbol() + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(v, decimals = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '0';
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(v) {
  if (v === null || v === undefined || !isFinite(v)) return '0%';
  return v.toFixed(1) + '%';
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-');
  if (!y || !m || !d) return dateStr;
  const fmt = state?.settings?.dateFormat || 'MDY';
  if (fmt === 'DMY') return `${d}/${m}/${y}`;
  if (fmt === 'YMD') return `${y}-${m}-${d}`;
  return `${m}/${d}/${y}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================================================
   DATA: LOAD / SAVE / MIGRATE / SEED
   ============================================================ */

const EMOTIONS = ['Calm', 'Confident', 'Focused', 'Neutral', 'Excited', 'Anxious', 'Fearful', 'Greedy', 'Impatient', 'Frustrated', 'Bored', 'Tired'];
const TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];
const BEHAVIOUR_FLAGS = [
  { key: 'fomo', label: 'FOMO' },
  { key: 'revenge', label: 'Revenge trading' },
  { key: 'overtrading', label: 'Overtrading' },
  { key: 'fear', label: 'Fear' },
  { key: 'greed', label: 'Greed' },
  { key: 'ruleViolation', label: 'Rule violation' }
];

function defaultRiskRules() {
  return { dailyLossLimitPct: 3, maxTradesPerDay: 0, maxConsecutiveLosses: 3, maxDrawdownPct: 10 };
}

function defaultSettings() {
  return {
    currency: 'USD',
    defaultRiskPct: 1,
    defaultAccountId: null,
    dateFormat: 'MDY',
    theme: 'dark',
    compactMode: false,
    notificationsEnabled: true,
    activeAccountId: null,
    analyticsScope: 'active',
    risk: defaultRiskRules(),
    isDemo: false
  };
}

function defaultMT5State() {
  return {
    connected: false,
    lastSync: null,
    account: null,        // last known account snapshot from the bridge
    openPositions: [],     // last known open positions snapshot
    autoRefreshSeconds: 0, // 0 = off
    lastSyncResult: null,  // { imported, updated, skipped, errors }
    linkedAccountId: null  // local account id representing the MT5 account
  };
}

/* Thin storage adapter. A future cloud/API backend can replace this object
   (read/write/remove) without touching the rest of the application. */
const LocalStorageAdapter = {
  read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  write(key, value) { localStorage.setItem(key, value); },
  remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
};

function blankState() {
  return {
    meta: { schemaVersion: SCHEMA_VERSION, nextTradeNumber: 1 },
    settings: defaultSettings(),
    accounts: [],
    trades: [],
    goals: [],
    psychology: [],
    mt5: defaultMT5State()
  };
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Bring any trade (old save, backup file, MT5 import) up to the current
   shape. Existing values are never discarded; only missing fields are
   filled with defaults. Returns null when a record is unusable. */
function normalizeTrade(raw) {
  if (!isPlainObject(raw)) return null;
  const t = Object.assign({}, raw);
  t.id = safeId(t.id) || uid();
  t.accountId = safeId(t.accountId);
  t.source = t.source === 'MT5' ? 'MT5' : 'Manual';
  t.pair = String(t.pair || '').trim().toUpperCase();
  t.direction = t.direction === 'Sell' ? 'Sell' : (t.direction === 'Buy' ? 'Buy' : null);
  t.date = typeof t.date === 'string' && DATE_RE.test(t.date) ? t.date : null;
  ['entry', 'sl', 'tp', 'exit', 'pl', 'riskAmount', 'positionSize', 'pipValuePerLot', 'rMultiple', 'pips', 'spread'].forEach(k => { t[k] = numOrNull(t[k]); });
  t.riskPct = numOrNull(t.riskPct) ?? 0;
  if (!t.pair || !t.direction || !t.date || t.entry === null) return null;

  // Costs and gross/net split. `pl` has always meant NET P/L (MT5 imports
  // already include commission + swap), so older trades simply get
  // zero costs and gross = net.
  t.commission = numOrNull(t.commission) ?? 0;
  t.swap = numOrNull(t.swap) ?? 0;
  t.grossPL = numOrNull(t.grossPL);
  if (t.grossPL === null) t.grossPL = t.pl;

  ['strategy', 'session', 'setupQuality', 'marketCondition', 'timeframe', 'tradeSetup', 'tradeReason', 'entryReason', 'exitReason',
    'emotionBefore', 'emotionDuring', 'emotionAfter', 'mistakes', 'lessons', 'notes', 'openTime', 'closeTime'].forEach(k => {
    t[k] = typeof t[k] === 'string' ? t[k] : '';
  });
  ['confidence', 'discipline', 'patience'].forEach(k => {
    const v = numOrNull(t[k]);
    t[k] = v === null ? null : clamp(Math.round(v), 1, 10);
  });
  const f = isPlainObject(t.flags) ? t.flags : {};
  t.flags = {};
  BEHAVIOUR_FLAGS.forEach(fl => { t.flags[fl.key] = !!f[fl.key]; });
  t.tags = Array.isArray(t.tags) ? t.tags.map(x => String(x)).filter(Boolean) : [];
  ['shotBefore', 'shotAfter'].forEach(k => { t[k] = (typeof t[k] === 'string' && t[k].startsWith('data:image/')) ? t[k] : null; });
  t.tradeNumber = numOrNull(t.tradeNumber);
  return t;
}

function normalizeAccount(raw) {
  if (!isPlainObject(raw)) return null;
  const a = Object.assign({}, raw);
  a.id = safeId(a.id) || uid();
  a.name = String(a.name || 'Account');
  a.broker = typeof a.broker === 'string' ? a.broker : '';
  a.type = ['Demo', 'Live', 'Prop Firm'].includes(a.type) ? a.type : 'Live';
  a.currency = ['USD', 'EUR', 'GBP', 'JPY'].includes(a.currency) ? a.currency : 'USD';
  a.initialBalance = numOrNull(a.initialBalance) ?? 0;
  a.currentBalance = numOrNull(a.currentBalance) ?? a.initialBalance;
  a.notes = typeof a.notes === 'string' ? a.notes : '';
  a.isDefault = !!a.isDefault;
  return a;
}

function normalizeGoal(raw) {
  if (!isPlainObject(raw)) return null;
  const g = Object.assign({}, raw);
  g.id = safeId(g.id) || uid();
  g.name = String(g.name || 'Goal');
  g.type = String(g.type || 'Profit Target');
  g.target = numOrNull(g.target) ?? 0;
  g.current = numOrNull(g.current) ?? 0;
  g.startDate = typeof g.startDate === 'string' && DATE_RE.test(g.startDate) ? g.startDate : '';
  g.deadline = typeof g.deadline === 'string' && DATE_RE.test(g.deadline) ? g.deadline : '';
  g.period = typeof g.period === 'string' ? g.period : 'Monthly';
  g.notes = typeof g.notes === 'string' ? g.notes : '';
  return g;
}

function normalizePsych(raw) {
  if (!isPlainObject(raw)) return null;
  const p = Object.assign({}, raw);
  p.id = safeId(p.id) || uid();
  p.date = typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : nowDateStr();
  p.mood = typeof p.mood === 'string' ? p.mood : '';
  ['confidence', 'discipline', 'fear', 'greed', 'fomo', 'revenge', 'stress'].forEach(k => { p[k] = clamp(numOrNull(p[k]) ?? 5, 1, 10); });
  ['mistakes', 'lessons', 'notes'].forEach(k => { p[k] = typeof p[k] === 'string' ? p[k] : ''; });
  return p;
}

function chronoCompare(a, b) {
  return (a.date + (a.openTime || '')).localeCompare(b.date + (b.openTime || ''));
}

/* Single migration path used by load, import and restore. `report.dropped`
   receives the number of unusable trade records that were skipped. */
function normalizeState(parsed, report) {
  const p = isPlainObject(parsed) ? parsed : {};
  const settings = Object.assign(defaultSettings(), isPlainObject(p.settings) ? p.settings : {});
  settings.risk = Object.assign(defaultRiskRules(), isPlainObject(settings.risk) ? settings.risk : {});
  settings.activeAccountId = settings.activeAccountId ? safeId(settings.activeAccountId) : null;
  settings.defaultAccountId = settings.defaultAccountId ? safeId(settings.defaultAccountId) : null;
  if (!['dark', 'light'].includes(settings.theme)) settings.theme = 'dark';
  if (!['active', 'all'].includes(settings.analyticsScope)) settings.analyticsScope = 'active';

  const rawTrades = Array.isArray(p.trades) ? p.trades : [];
  const trades = rawTrades.map(normalizeTrade).filter(Boolean);
  if (report) report.dropped = rawTrades.length - trades.length;

  const out = {
    meta: Object.assign({ schemaVersion: 1, nextTradeNumber: 1 }, isPlainObject(p.meta) ? p.meta : {}),
    settings,
    accounts: (Array.isArray(p.accounts) ? p.accounts : []).map(normalizeAccount).filter(Boolean),
    trades,
    goals: (Array.isArray(p.goals) ? p.goals : []).map(normalizeGoal).filter(Boolean),
    psychology: (Array.isArray(p.psychology) ? p.psychology : []).map(normalizePsych).filter(Boolean),
    mt5: Object.assign(defaultMT5State(), isPlainObject(p.mt5) ? p.mt5 : {})
  };
  out.mt5.linkedAccountId = out.mt5.linkedAccountId ? safeId(out.mt5.linkedAccountId) : null;

  // De-duplicate ids that may collide inside a hand-edited file.
  const seen = new Set();
  out.trades.forEach(t => { while (seen.has(t.id)) t.id = uid(); seen.add(t.id); });

  // Sequential, human-friendly trade numbers for records that lack one.
  let maxNum = 0;
  out.trades.forEach(t => { if (t.tradeNumber) maxNum = Math.max(maxNum, t.tradeNumber); });
  out.trades.filter(t => !t.tradeNumber).sort(chronoCompare).forEach(t => { t.tradeNumber = ++maxNum; });
  out.meta.nextTradeNumber = Math.max(numOrNull(out.meta.nextTradeNumber) || 1, maxNum + 1);
  out.meta.schemaVersion = SCHEMA_VERSION;

  if (!out.accounts.some(a => a.id === out.settings.activeAccountId)) {
    out.settings.activeAccountId = out.accounts.length ? out.accounts[0].id : null;
  }
  return out;
}

function nextTradeNumber() {
  if (!state.meta) state.meta = { schemaVersion: SCHEMA_VERSION, nextTradeNumber: 1 };
  const n = state.meta.nextTradeNumber || 1;
  state.meta.nextTradeNumber = n + 1;
  return n;
}

function fmtTradeNumber(n) {
  return n ? 'CS-' + String(n).padStart(4, '0') : '—';
}

function loadData() {
  const raw = LocalStorageAdapter.read(STORAGE_KEY);

  if (!raw) {
    state = seedDemoData();
    saveData();
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    const report = {};
    const needsMigration = !parsed.meta || parsed.meta.schemaVersion !== SCHEMA_VERSION;
    if (needsMigration) {
      // Keep the untouched pre-upgrade copy once, so the migration can never
      // be the reason a journal is lost.
      try {
        if (!LocalStorageAdapter.read(STORAGE_KEY + '_pre_v2')) LocalStorageAdapter.write(STORAGE_KEY + '_pre_v2', raw);
      } catch (e) { console.warn('Could not store pre-migration copy', e); }
    }
    state = normalizeState(parsed, report);
    if (report.dropped) console.warn('Skipped ' + report.dropped + ' unreadable trade record(s) while loading.');
    if (needsMigration || report.dropped) saveData();
  } catch (e) {
    console.error('Failed to parse stored data.', e);
    // Never overwrite unreadable data silently: keep a copy first.
    try { LocalStorageAdapter.write(STORAGE_KEY + '_unreadable_' + Date.now(), raw); } catch (err) { /* storage full */ }
    state = seedDemoData();
    saveData();
    setTimeout(() => toast('Your saved journal could not be read. A copy of the unreadable data was kept in browser storage and demo data was loaded.', 'error'), 600);
  }
}

function saveData() {
  try {
    LocalStorageAdapter.write(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    console.error('Failed to save data', e);
    toast('Could not save data — browser storage may be full. Export a backup now.', 'error');
    return false;
  }
}

function seedDemoData() {
  const settings = defaultSettings();
  settings.isDemo = true;

  const accId = uid();
  const accounts = [{
    id: accId,
    name: 'Demo Live Account',
    broker: 'Copperstone Demo Broker',
    type: 'Live',
    currency: 'USD',
    initialBalance: 10000,
    currentBalance: 10000,
    notes: 'Sample account auto-generated so the dashboard is not empty.',
    isDefault: true
  }];
  settings.activeAccountId = accId;
  settings.defaultAccountId = accId;

  const pairs = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'GBPJPY'];
  const strategies = ['Breakout', 'Trend Pullback', 'Reversal', 'Range Scalp'];
  const sessions = ['Asian', 'London', 'New York', 'Overlap'];
  const setups = ['A+', 'A', 'B', 'C'];
  const conditions = ['Trending', 'Ranging', 'Volatile', 'Quiet'];
  const timeframes = ['M15', 'H1', 'H4', 'M5'];
  const emotionsBefore = ['Calm', 'Confident', 'Anxious', 'Excited'];

  const trades = [];
  let balance = 10000;
  const today = new Date();

  // deterministic-ish pseudo random pattern for pleasant demo curve
  const plPattern = [180, -90, 240, 130, -150, 300, -60, 90, 210, -200, 150, 80, -110, 260, 190, -70, 120, -180, 300, 100];

  for (let i = 0; i < 20; i++) {
    const daysAgo = (20 - i) * 2;
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = toLocalDateStr(d);

    const pair = pairs[i % pairs.length];
    const isJPY = pair.includes('JPY');
    const direction = i % 3 === 0 ? 'Sell' : 'Buy';
    const pl = plPattern[i];
    const riskPct = 1;
    const riskAmount = round2(balance * (riskPct / 100));
    const pipSize = isJPY ? 0.01 : 0.0001;
    const entry = isJPY ? 148 + (i % 5) : 1.1 + (i % 5) * 0.001;
    const slPips = 40 + (i % 3) * 10;
    const sl = direction === 'Buy' ? entry - slPips * pipSize : entry + slPips * pipSize;
    const rMultiple = round2(safeDiv(pl, riskAmount));
    const tpPips = slPips * 2;
    const tp = direction === 'Buy' ? entry + tpPips * pipSize : entry - tpPips * pipSize;
    const pips = round1(safeDiv(pl, 10)); // rough approximation for demo
    const exit = direction === 'Buy' ? entry + pips * pipSize : entry - pips * pipSize;
    const lost = pl < 0;

    trades.push({
      id: uid(),
      accountId: accId,
      pair,
      direction,
      entry: round5(entry),
      sl: round5(sl),
      tp: round5(tp),
      exit: round5(exit),
      riskPct,
      riskAmount,
      positionSize: round2(0.5 + (i % 4) * 0.25),
      pipValuePerLot: 10,
      pl,
      grossPL: pl,
      commission: 0,
      swap: 0,
      rMultiple,
      pips,
      strategy: strategies[i % strategies.length],
      session: sessions[i % sessions.length],
      timeframe: timeframes[i % timeframes.length],
      setupQuality: setups[i % setups.length],
      marketCondition: conditions[i % conditions.length],
      tradeSetup: 'Sample setup',
      entryReason: 'Sample: price reached a planned level with confirmation.',
      exitReason: lost ? 'Stopped out.' : 'Target reached.',
      emotionBefore: emotionsBefore[i % emotionsBefore.length],
      emotionAfter: lost ? 'Frustrated' : 'Confident',
      confidence: 4 + (i % 6),
      discipline: lost ? 5 : 8,
      flags: { fomo: lost && i % 3 === 1, revenge: lost && i % 4 === 1, ruleViolation: lost && i % 2 === 1 },
      source: 'Manual',
      tags: i % 2 === 0 ? ['news', 'high-conviction'] : ['routine'],
      mistakes: lost ? 'Entered slightly early before confirmation.' : '',
      lessons: lost ? 'Wait for full candle close on the trigger timeframe.' : 'Followed the plan and let the trade play out.',
      notes: 'Sample demo trade — replace with your own journal entries.',
      date: dateStr,
      openTime: '09:15',
      closeTime: '14:40',
      shotBefore: null,
      shotAfter: null
    });

    balance += pl;
  }

  accounts[0].currentBalance = round2(balance);

  const goals = [
    {
      id: uid(),
      name: 'Reach $1,000 monthly profit',
      type: 'Monthly Profit',
      target: 1000,
      current: Math.max(0, round2(balance - 10000)),
      startDate: nowDateStr(),
      deadline: '',
      period: 'Monthly',
      notes: 'Sample goal — edit or delete this.'
    }
  ];

  const psychology = [
    {
      id: uid(),
      date: nowDateStr(),
      mood: 'Confident',
      confidence: 7,
      discipline: 8,
      fear: 3,
      greed: 4,
      fomo: 2,
      revenge: 1,
      stress: 3,
      mistakes: '',
      lessons: 'Stuck to the trading plan all week.',
      notes: 'Sample psychology entry — this is demo data.'
    }
  ];

  return normalizeState({ settings, accounts, trades, goals, psychology, mt5: defaultMT5State() });
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round1(n) { return Math.round((n + Number.EPSILON) * 10) / 10; }
function round5(n) { return Math.round((n + Number.EPSILON) * 100000) / 100000; }

/* ============================================================
   TOASTS
   ============================================================ */

function toast(message, type = 'info') {
  // Errors are always shown, even when the user has muted routine toasts.
  if (type !== 'error' && !state?.settings?.notificationsEnabled) return;
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icon = type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info';
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escapeHtml(message)}</span>`;
  el.addEventListener('click', () => el.remove());
  stack.appendChild(el);
  const life = type === 'error' ? 6000 : 3200;
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s ease';
    setTimeout(() => el.remove(), 260);
  }, life);
}

/* ============================================================
   MODALS
   ============================================================ */

function openModal(id) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById(id);
  if (!modal) return;
  if (!overlay.classList.contains('open')) lastFocusedEl = document.activeElement;
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
  modal.classList.add('open');
  overlay.classList.add('open');
  modal.scrollTop = 0;
  const body = modal.querySelector('.modal-body');
  if (body) body.scrollTop = 0;
  setTimeout(() => { try { modal.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 20);
}

function closeModal(id) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
  overlay.classList.remove('open');
  restoreFocusAfterModal();
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('open'));
  document.getElementById('modalOverlay').classList.remove('open');
  restoreFocusAfterModal();
}

function restoreFocusAfterModal() {
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function' && document.contains(lastFocusedEl)) {
    try { lastFocusedEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
}

function setupModalAccessibility() {
  document.querySelectorAll('.modal').forEach(m => {
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('tabindex', '-1');
    const h = m.querySelector('.modal-head h2');
    if (h) {
      if (!h.id) h.id = m.id + 'Heading';
      m.setAttribute('aria-labelledby', h.id);
    }
  });
  document.querySelectorAll('.modal-close').forEach(b => b.setAttribute('aria-label', 'Close dialog'));
}

function handleModalKeydown(e) {
  const open = document.querySelector('.modal.open');
  if (!open) return;
  if (e.key === 'Escape') { e.preventDefault(); closeAllModals(); return; }
  if (e.key !== 'Tab') return;
  const focusables = [...open.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === open)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function askConfirm(title, message, onConfirm) {
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalMessage').textContent = message;
  pendingConfirmAction = onConfirm;
  openModal('confirmModal');
}

/* ============================================================
   NAVIGATION
   ============================================================ */

function setPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById('page-' + page);
  if (target) target.classList.add('active');

  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.mnb-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));

  closeMobileNav();
  renderPage(page);
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function renderPage(page) {
  try {
    switch (page) {
      case 'dashboard': renderDashboard(); break;
      case 'journal': renderJournal(); break;
      case 'analytics': renderAnalytics(); break;
      case 'strategies': renderStrategies(); break;
      case 'calendar': renderCalendar(); break;
      case 'risk': renderRiskPage(); break;
      case 'goals': renderGoals(); break;
      case 'psychology': renderPsychology(); break;
      case 'reports': renderReport(); break;
      case 'accounts': renderAccounts(); break;
      case 'mt5': renderMT5Page(); break;
      case 'settings': renderSettings(); break;
    }
  } catch (err) {
    console.error('Failed to render page:', page, err);
    toast('This page could not be displayed. Your data is safe — try reloading.', 'error');
  }
  try { renderMT5MiniCard(); } catch (err) { console.error(err); }
}

function openMobileNav() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('mobileNavOverlay').classList.add('open');
}
function closeMobileNav() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobileNavOverlay').classList.remove('open');
}

/* ============================================================
   ACCOUNT HELPERS
   ============================================================ */

function getActiveAccount() {
  if (!state.accounts.length) return null;
  return state.accounts.find(a => a.id === state.settings.activeAccountId) || state.accounts[0];
}

function getAccountById(id) {
  return state.accounts.find(a => a.id === id) || null;
}

function refreshAccountSelectors() {
  const acc = state.accounts;
  const selects = [
    document.getElementById('sidebarAccountSelect'),
    document.getElementById('filterAccount'),
    document.getElementById('tfAccount'),
    document.getElementById('setDefaultAccount')
  ];

  selects.forEach(sel => {
    if (!sel) return;
    const isFilter = sel.id === 'filterAccount';
    const prevValue = sel.value;
    sel.innerHTML = '';
    if (isFilter) {
      const opt = document.createElement('option');
      opt.value = 'all'; opt.textContent = 'All Accounts';
      sel.appendChild(opt);
    }
    if (!acc.length) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = 'No accounts yet';
      sel.appendChild(opt);
    }
    acc.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name + (a.isDefault ? ' (Default)' : '');
      sel.appendChild(opt);
    });
    if (sel.id === 'sidebarAccountSelect') {
      sel.value = state.settings.activeAccountId || (acc[0] ? acc[0].id : '');
    } else if (prevValue && [...sel.options].some(o => o.value === prevValue)) {
      sel.value = prevValue;
    }
  });

  const balEl = document.getElementById('sidebarBalance');
  const active = getActiveAccount();
  if (balEl) balEl.textContent = active ? fmtMoney(active.currentBalance) : fmtMoney(0);
}

/* ============================================================
   TRADE CALCULATIONS
   ============================================================ */

function getPipSize(pair) {
  if (!pair) return 0.0001;
  return pair.toUpperCase().includes('JPY') ? 0.01 : 0.0001;
}

function calcPipsFromPrices(entry, exit, direction, pipSize) {
  if (!entry || !exit || !pipSize) return 0;
  const diff = direction === 'Sell' ? entry - exit : exit - entry;
  return round1(diff / pipSize);
}

function calcRiskAmount(balance, riskPct) {
  return round2(balance * (riskPct / 100));
}

/* A trade counts as closed once it has a net P/L (from the exit price and
   size, or typed in directly). */
function isTradeClosed(t) {
  return t.pl !== null && t.pl !== undefined && isFinite(t.pl);
}

function tradePlannedRR(t) {
  if (t.entry === null || t.sl === null || t.tp === null || t.entry === undefined || t.sl === undefined || t.tp === undefined) return null;
  const risk = Math.abs(t.entry - t.sl), reward = Math.abs(t.tp - t.entry);
  return risk > 0 && reward > 0 ? reward / risk : null;
}

function tradeResult(t) {
  if (!isTradeClosed(t)) return 'Open';
  if (t.pl > 0) return 'Win';
  if (t.pl < 0) return 'Loss';
  return 'Breakeven';
}

/* ============================================================
   METRICS ENGINE
   ============================================================ */

function tradeSource(t) {
  return t.source === 'MT5' ? 'MT5' : 'Manual';
}

function getTradesForAccount(accountId) {
  if (accountId === 'all' || !accountId) return state.trades.slice();
  return state.trades.filter(t => t.accountId === accountId);
}

function computeMetrics(trades, account) {
  const closed = trades.filter(isTradeClosed).slice().sort((a, b) => (a.date + (a.closeTime || '')).localeCompare(b.date + (b.closeTime || '')));
  const wins = closed.filter(t => t.pl > 0);
  const losses = closed.filter(t => t.pl < 0);
  const breakevens = closed.filter(t => t.pl === 0);

  const grossProfit = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.pl, 0); // negative
  const netProfit = grossProfit + grossLoss;

  const winRate = closed.length ? safeDiv(wins.length, closed.length) * 100 : 0;
  const lossRate = closed.length ? safeDiv(losses.length, closed.length) * 100 : 0;
  const profitFactor = grossLoss !== 0 ? Math.abs(safeDiv(grossProfit, grossLoss)) : (grossProfit > 0 ? Infinity : 0);

  const avgWin = wins.length ? safeDiv(grossProfit, wins.length) : 0;
  const avgLoss = losses.length ? safeDiv(grossLoss, losses.length) : 0; // negative

  const rValues = closed.filter(t => t.rMultiple !== null && t.rMultiple !== undefined && isFinite(t.rMultiple)).map(t => t.rMultiple);
  const avgR = rValues.length ? safeDiv(rValues.reduce((s, v) => s + v, 0), rValues.length) : 0;

  const winProb = safeDiv(wins.length, closed.length || 1);
  const lossProb = safeDiv(losses.length, closed.length || 1);
  const expectancy = (avgWin * winProb) + (avgLoss * lossProb);

  const largestWin = wins.length ? Math.max(...wins.map(t => t.pl)) : 0;
  const largestLoss = losses.length ? Math.min(...losses.map(t => t.pl)) : 0;

  // Equity curve & drawdown
  const startBalance = account ? account.initialBalance : 10000;
  let running = startBalance;
  let peak = startBalance;
  let maxDrawdown = 0;
  let maxDrawdownAmount = 0;
  const equityCurve = [{ label: 'Start', value: running, date: null }];
  const drawdownCurve = [{ label: 'Start', value: 0, date: null }];

  closed.forEach(t => {
    running += t.pl;
    peak = Math.max(peak, running);
    const dd = peak > 0 ? safeDiv(peak - running, peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, dd);
    maxDrawdownAmount = Math.max(maxDrawdownAmount, peak - running);
    equityCurve.push({ label: t.date, value: round2(running), date: t.date });
    drawdownCurve.push({ label: t.date, value: round2(-dd), date: t.date });
  });

  const currentDrawdownAmount = Math.max(0, peak - running);
  const currentDrawdown = peak > 0 ? safeDiv(currentDrawdownAmount, peak) * 100 : 0;
  const plannedRRs = closed.map(tradePlannedRR).filter(v => v);
  const avgPlannedRR = plannedRRs.length ? safeDiv(plannedRRs.reduce((a, b) => a + b, 0), plannedRRs.length) : 0;
  const riskPcts = closed.filter(t => t.riskPct > 0).map(t => t.riskPct);
  const avgRiskPct = riskPcts.length ? safeDiv(riskPcts.reduce((a, b) => a + b, 0), riskPcts.length) : 0;
  const totalCommission = closed.reduce((sum, t) => sum + (t.commission || 0), 0);
  const totalSwap = closed.reduce((sum, t) => sum + (t.swap || 0), 0);

  // Streaks
  let currentStreak = 0, currentStreakType = null;
  let longestWinStreak = 0, longestLossStreak = 0, tempWin = 0, tempLoss = 0;
  closed.forEach(t => {
    const win = t.pl > 0;
    if (win) { tempWin++; tempLoss = 0; } else if (t.pl < 0) { tempLoss++; tempWin = 0; } else { tempWin = 0; tempLoss = 0; }
    longestWinStreak = Math.max(longestWinStreak, tempWin);
    longestLossStreak = Math.max(longestLossStreak, tempLoss);
  });
  for (let i = closed.length - 1; i >= 0; i--) {
    const t = closed[i];
    const type = t.pl > 0 ? 'win' : t.pl < 0 ? 'loss' : 'be';
    if (currentStreakType === null) { currentStreakType = type; }
    if (type !== currentStreakType) break;
    currentStreak++;
  }

  // Average holding time (minutes)
  let holdMinutesTotal = 0, holdCount = 0;
  closed.forEach(t => {
    if (t.openTime && t.closeTime) {
      const [oh, om] = t.openTime.split(':').map(Number);
      const [ch, cm] = t.closeTime.split(':').map(Number);
      if (isFinite(oh) && isFinite(ch)) {
        let mins = (ch * 60 + cm) - (oh * 60 + om);
        if (mins < 0) mins += 24 * 60;
        holdMinutesTotal += mins;
        holdCount++;
      }
    }
  });
  const avgHoldMinutes = holdCount ? safeDiv(holdMinutesTotal, holdCount) : 0;

  return {
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: trades.length - closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    breakevenTrades: breakevens.length,
    winRate, lossRate,
    netProfit, grossProfit, grossLoss,
    profitFactor,
    avgWin, avgLoss, avgR, expectancy,
    maxDrawdown, maxDrawdownAmount, currentDrawdown, currentDrawdownAmount,
    startBalance, endBalance: running,
    avgPlannedRR, avgRiskPct, totalCommission, totalSwap,
    largestWin, largestLoss,
    currentStreak, currentStreakType,
    longestWinStreak, longestLossStreak,
    avgHoldMinutes,
    equityCurve, drawdownCurve,
    closed
  };
}

/* ============================================================
   CHART HELPERS
   ============================================================ */

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

function chartColors() {
  return { copper: '#c47a44', copperLight: '#e0a16b', positive: '#35c98b', negative: '#ef6262', muted: '#8f99a6', grid: 'rgba(143,153,166,0.12)' };
}

function baseLineOptions(yPrefix) {
  const c = chartColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${yPrefix || ''}${fmtNum(ctx.parsed.y, 2)}` } } },
    scales: {
      x: { ticks: { color: c.muted, maxTicksLimit: 8 }, grid: { color: c.grid } },
      y: { ticks: { color: c.muted }, grid: { color: c.grid } }
    }
  };
}

function chartsAvailable(canvasId) {
  if (typeof Chart !== 'undefined') return true;
  setChartEmpty(canvasId, true, 'Charts could not be loaded. Check your internet connection and reload.');
  return false;
}

function setChartEmpty(canvasId, isEmpty, message) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.parentElement) return false;
  const wrap = canvas.parentElement;
  let el = wrap.querySelector('.chart-empty');
  if (isEmpty) {
    if (!el) { el = document.createElement('div'); el.className = 'chart-empty'; wrap.appendChild(el); }
    el.innerHTML = `<i class="fa-solid fa-chart-simple"></i><span>${escapeHtml(message || 'No data to chart yet')}</span>`;
    canvas.style.visibility = 'hidden';
  } else {
    if (el) el.remove();
    canvas.style.visibility = 'visible';
  }
  return isEmpty;
}

function renderLineChart(canvasId, key, labels, data, color, fill = true) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  destroyChart(key);
  if (!chartsAvailable(canvasId)) return;
  if (setChartEmpty(canvasId, data.length < 2, 'Close a trade to start this chart')) return;
  charts[key] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: color,
        backgroundColor: fill ? color + '22' : 'transparent',
        fill,
        tension: 0.3,
        pointRadius: labels.length > 30 ? 0 : 2,
        borderWidth: 2
      }]
    },
    options: baseLineOptions()
  });
}

function renderBarChart(canvasId, key, labels, data, colors, emptyMessage) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  destroyChart(key);
  if (!chartsAvailable(canvasId)) return;
  if (setChartEmpty(canvasId, !data.length, emptyMessage || 'No closed trades to chart yet')) return;
  const c = chartColors();
  charts[key] = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors || c.copper, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: c.muted, maxTicksLimit: 12 }, grid: { display: false } },
        y: { ticks: { color: c.muted }, grid: { color: c.grid } }
      }
    }
  });
}

function renderDoughnut(canvasId, key, labels, data, colors) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  destroyChart(key);
  if (!chartsAvailable(canvasId)) return;
  if (setChartEmpty(canvasId, !data.some(v => v > 0), 'No closed trades to chart yet')) return;
  const c = chartColors();
  charts[key] = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors || [c.copper, c.copperLight, c.positive, c.negative, c.muted], borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: c.muted, boxWidth: 12, font: { size: 11 } } } }
    }
  });
}

function labelCharts() {
  document.querySelectorAll('canvas').forEach(cv => {
    const card = cv.closest('.card');
    const h = card ? card.querySelector('h3') : null;
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', h ? h.textContent + ' chart' : 'Chart');
  });
}


/* ============================================================
   DASHBOARD
   ============================================================ */

function getAccountEquity(account) {
  // Equity = balance + floating P/L. Floating P/L is only known for the
  // account linked to a live MT5 bridge; otherwise equity equals balance and
  // the UI says so instead of pretending otherwise.
  const balance = account ? account.currentBalance : 0;
  if (account && state.mt5 && state.mt5.connected && state.mt5.account && account.id === state.mt5.linkedAccountId) {
    const eq = num(mt5AccountField(state.mt5.account, 'equity'), null);
    if (eq !== null) return { value: eq, live: true };
  }
  return { value: balance, live: false };
}

function renderDashboard() {
  const account = getActiveAccount();
  document.getElementById('demoBanner').style.display = state.settings.isDemo ? 'flex' : 'none';

  const trades = getTradesForAccount(account ? account.id : 'all');
  const m = computeMetrics(trades, account);

  // Empty state for a brand-new journal, shown above the (zeroed) KPIs.
  const kpi = document.getElementById('kpiGrid');
  let empty = document.getElementById('dashEmpty');
  if (!trades.length) {
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'dashEmpty';
      empty.className = 'card';
      kpi.parentNode.insertBefore(empty, kpi);
    }
    empty.innerHTML = state.accounts.length
      ? emptyState('fa-book-open', 'No trades recorded yet', 'Log your first trade to unlock your equity curve, statistics and analytics.',
        `<button class="btn btn-primary btn-sm" onclick="openTradeModal()"><i class="fa-solid fa-plus"></i> Add Your First Trade</button>`)
      : emptyState('fa-building-columns', 'Start by adding a trading account', 'Accounts hold your starting balance and trades. Add one to begin journaling.',
        `<button class="btn btn-primary btn-sm" onclick="openAccountModal()"><i class="fa-solid fa-plus"></i> Add Account</button>`);
  } else if (empty) {
    empty.remove();
  }

  renderKPIGrid(kpi, m, account);
  renderRiskStatusInto('dashRiskStatus');

  const eqLabels = m.equityCurve.map(p => p.label === 'Start' ? 'Start' : fmtDate(p.label));
  renderLineChart('chartEquity', 'dashEquity', eqLabels, m.equityCurve.map(p => p.value), '#c47a44');
  renderLineChart('chartDrawdown', 'dashDrawdown', m.drawdownCurve.map(p => p.label === 'Start' ? 'Start' : fmtDate(p.label)), m.drawdownCurve.map(p => p.value), '#ef6262');

  renderPerfSummary(trades);
  renderStatGrid(document.getElementById('dashStatsGrid'), m, account);
  renderPairPerformance(trades);
  renderStrategyPerformance(trades);
  renderRecentTrades(trades);
}

function kpiCard(icon, label, value, badge, valueClass, iconClass, sub) {
  return `
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-icon ${iconClass || ''}"><i class="fa-solid ${icon}"></i></div>
        ${badge ? `<div class="kpi-badge ${badge.cls}">${badge.text}</div>` : ''}
      </div>
      <div class="kpi-value ${valueClass || ''}">${value}</div>
      <div class="kpi-label">${label}</div>
      ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
    </div>`;
}

function fmtPF(pf) { return isFinite(pf) ? fmtNum(pf, 2) : '∞'; }

function renderKPIGrid(container, m, account) {
  if (!container) return;
  const balance = account ? account.currentBalance : 0;
  const startBal = account ? account.initialBalance : 0;
  const equity = getAccountEquity(account);
  const netCls = m.netProfit >= 0 ? 'pos' : 'neg';
  const streakLabel = m.currentStreak > 0
    ? `${m.currentStreak} ${m.currentStreakType === 'win' ? 'Win' : m.currentStreakType === 'loss' ? 'Loss' : 'BE'}`
    : 'None';

  container.innerHTML = [
    kpiCard('fa-wallet', 'Account Balance', fmtMoney(balance), null, '', '', 'Started at ' + fmtMoney(startBal)),
    kpiCard('fa-vault', 'Equity', fmtMoney(equity.value), null, '', '', equity.live ? 'Live from MT5 bridge (includes floating P/L)' : 'Equals balance — no open-position data'),
    kpiCard('fa-sack-dollar', 'Net Profit', fmtMoney(m.netProfit), { cls: netCls, text: m.netProfit >= 0 ? 'Profit' : 'Loss' }, netCls, netCls, `${fmtMoney(m.grossProfit)} won · ${fmtMoney(m.grossLoss)} lost`),
    kpiCard('fa-percent', 'Win Rate', fmtPct(m.winRate), null, '', '', `${m.winningTrades}W · ${m.losingTrades}L · ${m.breakevenTrades}BE`),
    kpiCard('fa-scale-balanced', 'Profit Factor', fmtPF(m.profitFactor), null, m.profitFactor >= 1 ? 'pos' : 'neg', m.profitFactor >= 1 ? 'pos' : 'neg', 'Gross profit ÷ gross loss'),
    kpiCard('fa-chart-line', 'Expectancy', fmtMoney(m.expectancy), null, m.expectancy >= 0 ? 'pos' : 'neg', m.expectancy >= 0 ? 'pos' : 'neg', 'Average result per trade'),
    kpiCard('fa-ruler', 'Average R', fmtNum(m.avgR, 2) + 'R', null, m.avgR >= 0 ? 'pos' : 'neg', m.avgR >= 0 ? 'pos' : 'neg', m.avgPlannedRR ? 'Planned R:R avg 1 : ' + fmtNum(m.avgPlannedRR, 2) : 'Realised, where risk is recorded'),
    kpiCard('fa-arrow-trend-down', 'Maximum Drawdown', fmtPct(m.maxDrawdown), null, 'neg', 'neg', fmtMoney(-m.maxDrawdownAmount) + ' peak to trough'),
    kpiCard('fa-triangle-exclamation', 'Current Drawdown', fmtPct(m.currentDrawdown), null, m.currentDrawdown > 0 ? 'neg' : '', m.currentDrawdown > 0 ? 'neg' : '', fmtMoney(-m.currentDrawdownAmount) + ' below peak'),
    kpiCard('fa-list-ol', 'Total Trades', String(m.totalTrades), null, '', '', `${m.closedTrades} closed · ${m.openTrades} open`),
    kpiCard('fa-fire', 'Current Streak', streakLabel, null, '', '', m.currentStreakType === 'win' ? 'Consecutive wins' : m.currentStreakType === 'loss' ? 'Consecutive losses' : ''),
    kpiCard('fa-trophy', 'Best / Worst Streak', `${m.longestWinStreak}W / ${m.longestLossStreak}L`, null, '', '', 'Longest win / loss run')
  ].join('');
}

function statTile(label, value, cls) {
  return `<div class="stat-tile"><div class="stat-value ${cls || ''}">${value}</div><div class="stat-label">${label}</div></div>`;
}

function renderStatGrid(container, m, account) {
  if (!container) return;
  const posNeg = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const equity = getAccountEquity(account);
  const tiles = [
    ['Total Trades', m.totalTrades], ['Closed Trades', m.closedTrades], ['Open / Unclosed', m.openTrades],
    ['Winning Trades', m.winningTrades, 'pos'], ['Losing Trades', m.losingTrades, 'neg'], ['Breakeven Trades', m.breakevenTrades],
    ['Win Rate', fmtPct(m.winRate)], ['Loss Rate', fmtPct(m.lossRate)], ['Profit Factor', fmtPF(m.profitFactor), m.profitFactor >= 1 ? 'pos' : 'neg'],
    ['Net Profit', fmtMoney(m.netProfit), posNeg(m.netProfit)], ['Total Profit (gross wins)', fmtMoney(m.grossProfit), 'pos'], ['Total Loss (gross losses)', fmtMoney(m.grossLoss), 'neg'],
    ['Average Win', fmtMoney(m.avgWin), 'pos'], ['Average Loss', fmtMoney(m.avgLoss), 'neg'], ['Expectancy / Trade', fmtMoney(m.expectancy), posNeg(m.expectancy)],
    ['Largest Win', fmtMoney(m.largestWin), 'pos'], ['Largest Loss', fmtMoney(m.largestLoss), 'neg'], ['Average R (realised)', fmtNum(m.avgR, 2) + 'R', posNeg(m.avgR)],
    ['Avg Planned R:R', m.avgPlannedRR ? '1 : ' + fmtNum(m.avgPlannedRR, 2) : '—'], ['Avg Risk per Trade', m.avgRiskPct ? fmtPct(m.avgRiskPct) : '—'], ['Avg Holding Time', m.avgHoldMinutes ? fmtNum(m.avgHoldMinutes / 60, 1) + ' hrs' : '—'],
    ['Starting Balance', fmtMoney(m.startBalance)], ['Current Balance', fmtMoney(account ? account.currentBalance : m.endBalance)], ['Equity', fmtMoney(equity.value)],
    ['Max Drawdown', fmtPct(m.maxDrawdown) + ' (' + fmtMoney(m.maxDrawdownAmount) + ')', 'neg'], ['Current Drawdown', fmtPct(m.currentDrawdown), m.currentDrawdown > 0 ? 'neg' : ''],
    ['Current Streak', m.currentStreak ? `${m.currentStreak} ${m.currentStreakType === 'win' ? 'win' : m.currentStreakType === 'loss' ? 'loss' : 'BE'}` : '—'],
    ['Best Winning Streak', m.longestWinStreak, 'pos'], ['Worst Losing Streak', m.longestLossStreak, 'neg'],
    ['Commission Paid', fmtMoney(m.totalCommission)], ['Net Swap', fmtMoney(m.totalSwap), posNeg(m.totalSwap)]
  ];
  container.innerHTML = tiles.map(([l, v, c]) => statTile(l, v, c)).join('');
}

function periodPL(trades, since, until) {
  return trades.filter(t => isTradeClosed(t) && t.date >= since && (!until || t.date <= until)).reduce((s, t) => s + t.pl, 0);
}

function renderPerfSummary(trades) {
  const el = document.getElementById('perfSummary');
  if (!el) return;
  const now = new Date();
  const todayStr = toLocalDateStr(now);
  const d7 = new Date(now); d7.setDate(d7.getDate() - 6);
  const monthStart = todayStr.slice(0, 8) + '01';
  const yearStart = todayStr.slice(0, 5) + '01-01';
  const allTime = trades.filter(isTradeClosed).reduce((s, t) => s + t.pl, 0);

  const cells = [
    ['Today', periodPL(trades, todayStr, todayStr)],
    ['Last 7 Days', periodPL(trades, toLocalDateStr(d7), todayStr)],
    ['This Month', periodPL(trades, monthStart, todayStr)],
    ['This Year', periodPL(trades, yearStart, todayStr)],
    ['All Time', allTime]
  ];
  el.innerHTML = cells.map(([label, val]) => `
    <div class="perf-cell">
      <div class="perf-cell-label">${label}</div>
      <div class="perf-cell-value ${val >= 0 ? 'pos' : 'neg'}">${fmtMoney(val)}</div>
    </div>`).join('');
}


function groupPerformance(trades, keyFn) {
  const map = {};
  trades.filter(isTradeClosed).forEach(t => {
    const key = keyFn(t) || 'Unspecified';
    if (!map[key]) map[key] = { pl: 0, count: 0, wins: 0 };
    map[key].pl += t.pl;
    map[key].count++;
    if (t.pl > 0) map[key].wins++;
  });
  return Object.entries(map).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.pl - a.pl);
}

function renderPerfListInto(elId, groups) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!groups.length) {
    el.innerHTML = emptyState('fa-chart-simple', 'No closed trades yet', 'Performance breakdown will appear once you log closed trades.');
    return;
  }
  const maxAbs = Math.max(...groups.map(g => Math.abs(g.pl)), 1);
  el.innerHTML = groups.map(g => {
    const pct = clamp(safeDiv(Math.abs(g.pl), maxAbs) * 100, 2, 100);
    return `
      <div class="perf-row">
        <div class="perf-row-name">${escapeHtml(g.name)}</div>
        <div class="perf-bar-track"><div class="perf-bar-fill ${g.pl >= 0 ? 'pos' : 'neg'}" style="width:${pct}%"></div></div>
        <div class="perf-row-pl ${g.pl >= 0 ? 'val-pos' : 'val-neg'}">${fmtMoney(g.pl)}</div>
        <div class="perf-row-count">${g.count} trades</div>
      </div>`;
  }).join('');
}

function renderPairPerformance(trades) {
  renderPerfListInto('pairPerformance', groupPerformance(trades, t => t.pair));
}
function renderStrategyPerformance(trades) {
  renderPerfListInto('strategyPerformance', groupPerformance(trades, t => t.strategy));
}

function emptyState(icon, title, sub, actionHtml) {
  return `
    <div class="empty-state">
      <i class="fa-solid ${icon}"></i>
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-sub">${sub}</div>
      ${actionHtml || ''}
    </div>`;
}

function renderRecentTrades(trades) {
  const wrap = document.getElementById('recentTradesWrap');
  if (!wrap) return;
  const sorted = trades.slice().sort((a, b) => (b.date + (b.closeTime || '')).localeCompare(a.date + (a.closeTime || ''))).slice(0, 6);
  if (!sorted.length) {
    wrap.innerHTML = emptyState('fa-inbox', 'No trades yet', 'Add your first trade to see it here.',
      `<button class="btn btn-primary btn-sm" onclick="openTradeModal()">Add Trade</button>`);
    return;
  }
  wrap.innerHTML = buildTradeTable(sorted);
  bindTradeRowClicks(wrap);
}

/* ============================================================
   TRADE TABLE BUILDERS (shared by dashboard + journal)
   ============================================================ */

function resultPillClass(result) {
  return result === 'Win' ? 'pill-win' : result === 'Loss' ? 'pill-loss' : 'pill-be';
}

function fmtOptPrice(v) { return v !== null && v !== undefined ? fmtNum(v, 5) : '—'; }

function buildTradeTable(trades, opts) {
  const full = !!(opts && opts.full);
  const sortKey = opts && opts.sort;
  const closedFmt = t => isTradeClosed(t) ? fmtMoney(t.pl) : '—';
  const rFmt = t => (isTradeClosed(t) && t.rMultiple !== null && t.rMultiple !== undefined) ? fmtNum(t.rMultiple, 2) + 'R' : '—';
  const plCls = t => (isTradeClosed(t) ? (t.pl >= 0 ? 'val-pos' : 'val-neg') : '');

  const rows = trades.map(t => {
    const result = tradeResult(t);
    const src = tradeSource(t);
    const actions = `
      <td>
        <div class="row-actions">
          <button title="Edit" aria-label="Edit trade" onclick="event.stopPropagation(); openTradeModal('${t.id}')"><i class="fa-solid fa-pen"></i></button>
          <button title="Delete" aria-label="Delete trade" onclick="event.stopPropagation(); requestDeleteTrade('${t.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>`;
    if (full) {
      return `
      <tr data-id="${t.id}" tabindex="0">
        <td class="mono-cell">${fmtTradeNumber(t.tradeNumber)}</td>
        <td>${fmtDate(t.date)}</td>
        <td>${escapeHtml(t.pair)}</td>
        <td><span class="pill ${t.direction === 'Buy' ? 'pill-buy' : 'pill-sell'}">${t.direction}</span></td>
        <td>${escapeHtml(t.strategy || '—')}</td>
        <td>${escapeHtml(t.timeframe || '—')}</td>
        <td>${fmtNum(t.entry, 5)}</td>
        <td>${fmtOptPrice(t.exit)}</td>
        <td>${t.pips !== null && t.pips !== undefined ? fmtNum(t.pips, 1) : '—'}</td>
        <td class="${plCls(t)}">${closedFmt(t)}</td>
        <td>${rFmt(t)}</td>
        <td><span class="pill ${resultPillClass(result)}">${result}</span></td>
        <td><span class="pill ${src === 'MT5' ? 'pill-mt5' : 'pill-manual'}">${src}</span></td>
        ${actions}
      </tr>`;
    }
    return `
      <tr data-id="${t.id}" tabindex="0">
        <td>${escapeHtml(t.pair)}</td>
        <td><span class="pill ${t.direction === 'Buy' ? 'pill-buy' : 'pill-sell'}">${t.direction}</span></td>
        <td>${fmtNum(t.entry, 5)}</td>
        <td>${fmtOptPrice(t.exit)}</td>
        <td class="${plCls(t)}">${closedFmt(t)}</td>
        <td>${rFmt(t)}</td>
        <td>${fmtDate(t.date)}</td>
        <td><span class="pill ${resultPillClass(result)}">${result}</span></td>
        <td><span class="pill ${src === 'MT5' ? 'pill-mt5' : 'pill-manual'}">${src}</span></td>
        ${actions}
      </tr>`;
  }).join('');

  const mobileCards = trades.map(t => {
    const result = tradeResult(t);
    const src = tradeSource(t);
    return `
      <div class="trade-card" data-id="${t.id}" tabindex="0">
        <div class="trade-card-top">
          <span class="trade-card-pair">${escapeHtml(t.pair)} <span class="pill ${t.direction === 'Buy' ? 'pill-buy' : 'pill-sell'}">${t.direction}</span></span>
          <span style="display:flex; gap:6px;">
            <span class="pill ${src === 'MT5' ? 'pill-mt5' : 'pill-manual'}">${src}</span>
            <span class="pill ${resultPillClass(result)}">${result}</span>
          </span>
        </div>
        <div class="trade-card-grid">
          <div>Entry: <b>${fmtNum(t.entry, 5)}</b></div>
          <div>Exit: <b>${fmtOptPrice(t.exit)}</b></div>
          <div>P/L: <b class="${plCls(t)}">${closedFmt(t)}</b></div>
          <div>R: <b>${rFmt(t)}</b></div>
          <div>Date: <b>${fmtDate(t.date)}</b></div>
          <div>Strategy: <b>${escapeHtml(t.strategy || '—')}</b></div>
          ${full ? `<div>Timeframe: <b>${escapeHtml(t.timeframe || '—')}</b></div><div>ID: <b>${fmtTradeNumber(t.tradeNumber)}</b></div>` : ''}
        </div>
      </div>`;
  }).join('');

  const th = (label, key) => {
    if (!full || !key) return `<th>${label}</th>`;
    const pair = SORT_PAIRS[key];
    const active = sortKey === pair[0] || sortKey === pair[1];
    const arrow = active ? (sortKey === pair[0] ? ' ▼' : ' ▲') : '';
    return `<th class="th-sort ${active ? 'active' : ''}" data-sort="${key}" tabindex="0" role="button" aria-label="Sort by ${label}">${label}${arrow}</th>`;
  };

  const head = full
    ? `<tr>${th('ID')}${th('Date', 'date')}${th('Pair', 'pair')}<th>Dir</th><th>Strategy</th><th>TF</th><th>Entry</th><th>Exit</th><th>Pips</th>${th('Net P/L', 'pl')}${th('R', 'r')}<th>Result</th><th>Source</th><th></th></tr>`
    : '<tr><th>Pair</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P/L</th><th>R</th><th>Date</th><th>Result</th><th>Source</th><th></th></tr>';

  return `
    <table class="data-table trade-table">
      <thead>${head}</thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="trade-cards">${mobileCards}</div>`;
}

const SORT_PAIRS = { date: ['newest', 'oldest'], pl: ['pl-high', 'pl-low'], r: ['r-high', 'r-low'], pair: ['pair', 'pair'] };

function bindTradeRowClicks(container) {
  container.querySelectorAll('tr[data-id], .trade-card[data-id]').forEach(el => {
    el.addEventListener('click', () => openTradeDetail(el.dataset.id));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTradeDetail(el.dataset.id); }
    });
  });
}


/* ============================================================
   TRADE JOURNAL
   ============================================================ */

const JOURNAL_CONTROLS = {
  searchTrades: 'search', filterAccount: 'account', filterPair: 'pair', filterDirection: 'direction', filterResult: 'result',
  filterStrategy: 'strategy', filterSession: 'session', filterTimeframe: 'timeframe', filterSource: 'source',
  filterDate: 'dateFrom', filterDateTo: 'dateTo', sortTrades: 'sort'
};

function defaultJournalFilters() {
  return { search: '', account: 'all', pair: 'all', direction: 'all', result: 'all', strategy: 'all', session: 'all', timeframe: 'all', source: 'all', dateFrom: '', dateTo: '', sort: 'newest' };
}

function refreshJournalFilterOptions() {
  const build = (id, values, allLabel) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = `<option value="all">${allLabel}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  };
  const uniq = fn => [...new Set(state.trades.map(fn).filter(Boolean))].sort();
  build('filterStrategy', uniq(t => t.strategy), 'All Strategies');
  build('filterSession', uniq(t => t.session), 'All Sessions');
  build('filterPair', uniq(t => t.pair), 'All Pairs');
  build('filterTimeframe', TIMEFRAMES.filter(tf => state.trades.some(t => t.timeframe === tf)), 'All Timeframes');
}

function syncFilterControls() {
  Object.entries(JOURNAL_CONTROLS).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === journalFilters[key])) {
      journalFilters[key] = key === 'sort' ? 'newest' : 'all';
    }
    if (el.value !== journalFilters[key]) el.value = journalFilters[key];
  });
}

function cmpNullsLast(a, b, desc) {
  const an = a === null || a === undefined, bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  return desc ? b - a : a - b;
}

function getFilteredJournalTrades() {
  let trades = state.trades.slice();
  const f = journalFilters;

  if (f.account !== 'all') trades = trades.filter(t => t.accountId === f.account);
  if (f.pair !== 'all') trades = trades.filter(t => t.pair === f.pair);
  if (f.direction !== 'all') trades = trades.filter(t => t.direction === f.direction);
  if (f.result !== 'all') trades = trades.filter(t => tradeResult(t) === f.result);
  if (f.strategy !== 'all') trades = trades.filter(t => t.strategy === f.strategy);
  if (f.session !== 'all') trades = trades.filter(t => t.session === f.session);
  if (f.timeframe !== 'all') trades = trades.filter(t => t.timeframe === f.timeframe);
  if (f.source !== 'all') trades = trades.filter(t => tradeSource(t) === f.source);
  if (f.dateFrom) trades = trades.filter(t => t.date >= f.dateFrom);
  if (f.dateTo) trades = trades.filter(t => t.date <= f.dateTo);
  if (f.search) {
    const q = f.search.toLowerCase();
    trades = trades.filter(t => [
      t.pair, t.strategy, t.notes, t.tags.join(' '), t.tradeSetup, t.tradeReason, t.entryReason, t.exitReason,
      t.mistakes, t.lessons, t.emotionBefore, t.emotionDuring, t.emotionAfter, t.timeframe, fmtTradeNumber(t.tradeNumber)
    ].some(v => (v || '').toLowerCase().includes(q)));
  }

  const when = t => t.date + (t.openTime || '');
  switch (f.sort) {
    case 'oldest': trades.sort((a, b) => when(a).localeCompare(when(b))); break;
    case 'pl-high': trades.sort((a, b) => cmpNullsLast(isTradeClosed(a) ? a.pl : null, isTradeClosed(b) ? b.pl : null, true)); break;
    case 'pl-low': trades.sort((a, b) => cmpNullsLast(isTradeClosed(a) ? a.pl : null, isTradeClosed(b) ? b.pl : null, false)); break;
    case 'r-high': trades.sort((a, b) => cmpNullsLast(a.rMultiple, b.rMultiple, true)); break;
    case 'r-low': trades.sort((a, b) => cmpNullsLast(a.rMultiple, b.rMultiple, false)); break;
    case 'pair': trades.sort((a, b) => a.pair.localeCompare(b.pair) || when(b).localeCompare(when(a))); break;
    default: trades.sort((a, b) => when(b).localeCompare(when(a)));
  }
  return trades;
}

function filtersAreActive() {
  const d = defaultJournalFilters();
  return Object.keys(d).some(k => k !== 'sort' && journalFilters[k] !== d[k]);
}

function renderJournal() {
  refreshJournalFilterOptions();
  syncFilterControls();
  const wrap = document.getElementById('journalTableWrap');
  const summary = document.getElementById('journalSummary');
  const trades = getFilteredJournalTrades();

  if (!state.trades.length) {
    if (summary) summary.textContent = '';
    wrap.innerHTML = emptyState('fa-book-open', 'No trades recorded yet', 'Your journal is empty. Record your first trade to start tracking performance.',
      `<button class="btn btn-primary btn-sm" onclick="openTradeModal()"><i class="fa-solid fa-plus"></i> Add Your First Trade</button>`);
    return;
  }

  const closed = trades.filter(isTradeClosed);
  const net = closed.reduce((s, t) => s + t.pl, 0);
  const wins = closed.filter(t => t.pl > 0).length;
  if (summary) {
    summary.innerHTML = `Showing <b>${trades.length}</b> of ${state.trades.length} trades` +
      (closed.length ? ` &middot; Net P/L <b class="${net >= 0 ? 'val-pos' : 'val-neg'}">${fmtMoney(net)}</b> &middot; Win rate <b>${fmtPct(safeDiv(wins, closed.length) * 100)}</b>` : '');
  }

  if (!trades.length) {
    wrap.innerHTML = emptyState('fa-magnifying-glass', 'No trades match your filters', 'Try clearing filters or widening the date range.',
      `<button class="btn btn-ghost btn-sm" onclick="resetJournalFilters()">Clear Filters</button>`);
    return;
  }
  wrap.innerHTML = buildTradeTable(trades, { full: true, sort: journalFilters.sort });
  bindTradeRowClicks(wrap);
  wrap.querySelectorAll('th[data-sort]').forEach(th => {
    const go = () => {
      const pair = SORT_PAIRS[th.dataset.sort];
      journalFilters.sort = journalFilters.sort === pair[0] ? pair[1] : pair[0];
      renderJournal();
    };
    th.addEventListener('click', go);
    th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

function resetJournalFilters() {
  journalFilters = defaultJournalFilters();
  renderJournal();
}

/* Open the journal pre-filtered (used by Strategies and Calendar). */
function openJournalWithFilters(partial) {
  journalFilters = Object.assign(defaultJournalFilters(), partial || {});
  setPage('journal');
}


/* ============================================================
   TRADE FORM (ADD / EDIT)
   ============================================================ */

function populateFormSelects() {
  const emo = '<option value="">—</option>' + EMOTIONS.map(e => `<option value="${e}">${e}</option>`).join('');
  document.querySelectorAll('.emo-select').forEach(s => { s.innerHTML = emo; });
  const rate = '<option value="">—</option>' + Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  document.querySelectorAll('.rate-select').forEach(s => { s.innerHTML = rate; });
}

function refreshStrategyDatalist() {
  const dl = document.getElementById('strategyList');
  if (!dl) return;
  const list = [...new Set(state.trades.map(t => t.strategy).filter(Boolean))].sort();
  dl.innerHTML = list.map(s => `<option value="${escapeHtml(s)}"></option>`).join('');
}

function clearFormErrors(form) {
  form.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
}

const FLAG_INPUT_IDS = { fomo: 'tfFlagFomo', revenge: 'tfFlagRevenge', overtrading: 'tfFlagOvertrading', fear: 'tfFlagFear', greed: 'tfFlagGreed', ruleViolation: 'tfFlagRule' };

function openTradeModal(id) {
  const form = document.getElementById('tradeForm');
  form.reset();
  clearFormErrors(form);
  editingShots = { before: null, after: null };
  document.getElementById('tfShotBeforePreview').style.display = 'none';
  document.getElementById('tfShotAfterPreview').style.display = 'none';
  document.getElementById('tradeId').value = '';

  if (!state.accounts.length) {
    toast('Add a trading account before logging a trade.', 'error');
    openModal('accountModal');
    return;
  }

  refreshStrategyDatalist();
  const $ = (x) => document.getElementById(x);

  if (id) {
    const t = state.trades.find(x => x.id === id);
    if (!t) return;
    $('tradeModalTitle').textContent = 'Edit Trade';
    $('tradeId').value = t.id;
    $('tfTradeNumber').textContent = fmtTradeNumber(t.tradeNumber);
    $('tfAccount').value = t.accountId;
    $('tfPair').value = t.pair;
    $('tfDirection').value = t.direction;
    $('tfDate').value = t.date;
    $('tfOpenTime').value = t.openTime || '';
    $('tfCloseTime').value = t.closeTime || '';
    $('tfEntry').value = t.entry;
    $('tfSL').value = t.sl ?? '';
    $('tfTP').value = t.tp ?? '';
    $('tfExit').value = t.exit ?? '';
    $('tfRiskPct').value = t.riskPct ?? state.settings.defaultRiskPct;
    $('tfPositionSize').value = t.positionSize ?? '';
    $('tfPipValue').value = t.pipValuePerLot ?? 10;
    $('tfPL').value = t.grossPL ?? t.pl ?? '';
    $('tfCommission').value = t.commission || '';
    $('tfSwap').value = t.swap || '';
    $('tfSpread').value = t.spread ?? '';
    $('tfStrategy').value = t.strategy || '';
    $('tfTimeframe').value = t.timeframe || '';
    $('tfSetup').value = t.tradeSetup || '';
    $('tfSession').value = t.session || '';
    $('tfSetupQuality').value = t.setupQuality || '';
    $('tfMarketCondition').value = t.marketCondition || '';
    $('tfTags').value = (t.tags || []).join(', ');
    $('tfReason').value = t.tradeReason || '';
    $('tfEntryReason').value = t.entryReason || '';
    $('tfExitReason').value = t.exitReason || '';
    $('tfEmoBefore').value = t.emotionBefore || '';
    $('tfEmoDuring').value = t.emotionDuring || '';
    $('tfEmoAfter').value = t.emotionAfter || '';
    $('tfConfidence').value = t.confidence ?? '';
    $('tfDiscipline').value = t.discipline ?? '';
    $('tfPatience').value = t.patience ?? '';
    BEHAVIOUR_FLAGS.forEach(f => { $(FLAG_INPUT_IDS[f.key]).checked = !!(t.flags && t.flags[f.key]); });
    $('tfMistakes').value = t.mistakes || '';
    $('tfLessons').value = t.lessons || '';
    $('tfNotes').value = t.notes || '';
    editingShots.before = t.shotBefore || null;
    editingShots.after = t.shotAfter || null;
    if (t.shotBefore) { $('tfShotBeforePreview').src = t.shotBefore; $('tfShotBeforePreview').style.display = 'block'; }
    if (t.shotAfter) { $('tfShotAfterPreview').src = t.shotAfter; $('tfShotAfterPreview').style.display = 'block'; }

    // If the stored gross P/L is exactly what the prices imply, leave the
    // field blank so it keeps tracking the exit price instead of freezing.
    if (t.exit !== null && t.positionSize && t.pipValuePerLot && (t.grossPL ?? t.pl) !== null) {
      const auto = round2(calcPipsFromPrices(t.entry, t.exit, t.direction, getPipSize(t.pair)) * t.pipValuePerLot * t.positionSize);
      if (Math.abs(auto - (t.grossPL ?? t.pl)) < 0.011) $('tfPL').value = '';
    }
  } else {
    $('tradeModalTitle').textContent = 'Add Trade';
    $('tfTradeNumber').textContent = fmtTradeNumber(state.meta.nextTradeNumber) + ' (assigned on save)';
    $('tfAccount').value = state.settings.activeAccountId || state.accounts[0].id;
    $('tfDate').value = nowDateStr();
    $('tfRiskPct').value = state.settings.defaultRiskPct || 1;
    $('tfPipValue').value = 10;
    $('tfSession').value = 'London';
    $('tfSetupQuality').value = 'A';
    $('tfMarketCondition').value = 'Trending';
  }
  $('tfTradeNumberLine').hidden = false;

  recalcTradeForm();
  openModal('tradeModal');
}

function recalcTradeForm() {
  const $ = (x) => document.getElementById(x);
  const account = getAccountById($('tfAccount').value);
  const balance = account ? account.currentBalance : 0;

  const pair = $('tfPair').value.trim();
  const direction = $('tfDirection').value;
  const entry = num($('tfEntry').value, null);
  const sl = num($('tfSL').value, null);
  const tp = num($('tfTP').value, null);
  const exit = $('tfExit').value === '' ? null : num($('tfExit').value, null);
  const riskPct = num($('tfRiskPct').value, 0);
  const pipValuePerLot = num($('tfPipValue').value, 10);
  const manualPL = $('tfPL').value;
  const commission = num($('tfCommission').value, 0);
  const swap = num($('tfSwap').value, 0);

  const pipSize = getPipSize(pair);
  const riskAmount = calcRiskAmount(balance, riskPct);
  $('tfRiskAmount').value = riskAmount ? riskAmount.toFixed(2) : '';

  // SL distance / pips
  let slPips = null;
  if (entry !== null && sl !== null && sl !== 0) slPips = Math.abs(entry - sl) / pipSize;
  let tpPips = null;
  if (entry !== null && tp !== null && tp !== 0) tpPips = Math.abs(tp - entry) / pipSize;

  // Planned R:R
  if (slPips && tpPips) {
    $('tfPlannedRR').value = `1 : ${safeDiv(tpPips, slPips).toFixed(2)}`;
  } else {
    $('tfPlannedRR').value = '';
  }

  // Position size suggestion (placeholder only — never overwrites input)
  const posSizeInput = $('tfPositionSize');
  if (!posSizeInput.value && riskAmount && slPips && pipValuePerLot) {
    const lots = safeDiv(riskAmount, slPips * pipValuePerLot);
    if (isFinite(lots) && lots > 0) posSizeInput.placeholder = lots.toFixed(2) + ' (suggested)';
  }

  // Pips realized (based on exit if present)
  let pipsRealized = null;
  if (entry !== null && exit !== null) {
    pipsRealized = calcPipsFromPrices(entry, exit, direction, pipSize);
    $('tfPips').value = pipsRealized;
  } else {
    $('tfPips').value = '';
  }

  // Gross P/L: typed value wins, otherwise pips x pip value x lots.
  let gross = null;
  if (manualPL !== '') {
    gross = num(manualPL, null);
  } else if (pipsRealized !== null && pipValuePerLot) {
    const positionSize = num(posSizeInput.value, null);
    if (positionSize) gross = round2(pipsRealized * pipValuePerLot * positionSize);
  }

  // Net P/L = gross - commission (cost) + swap (signed). Spread is already
  // reflected in the prices, so it is informational only.
  const net = gross !== null ? round2(gross - commission + swap) : null;
  $('tfNetPL').value = net !== null ? net.toFixed(2) : '';

  // R multiple (net result / amount risked)
  $('tfR').value = (net !== null && riskAmount) ? safeDiv(net, riskAmount).toFixed(2) : '';

  return { pl: net, gross, riskAmount, pipsRealized, pipSize, commission, swap };
}

function handleTradeFormSubmit(e) {
  e.preventDefault();
  const $ = (x) => document.getElementById(x);
  const form = $('tradeForm');
  clearFormErrors(form);
  const calc = recalcTradeForm();

  const id = $('tradeId').value;
  const accountId = $('tfAccount').value;
  if (!accountId) { toast('Please select an account.', 'error'); return; }

  const errors = [];
  const fail = (fid, msg) => errors.push({ fid, msg });
  const opt = (fid) => numOrNull($(fid).value);

  const pair = $('tfPair').value.trim().toUpperCase().replace(/[\/\s]/g, '');
  if (!/^[A-Z0-9._#-]{3,15}$/.test(pair)) fail('tfPair', 'Enter a valid symbol such as EURUSD.');
  const entry = opt('tfEntry');
  if (entry === null || entry <= 0) fail('tfEntry', 'Entry price must be greater than 0.');
  const sl = opt('tfSL'), tp = opt('tfTP'), exit = opt('tfExit');
  if ($('tfSL').value !== '' && (sl === null || sl <= 0)) fail('tfSL', 'Stop loss must be a positive price.');
  if ($('tfTP').value !== '' && (tp === null || tp <= 0)) fail('tfTP', 'Take profit must be a positive price.');
  if ($('tfExit').value !== '' && (exit === null || exit <= 0)) fail('tfExit', 'Exit price must be a positive price.');
  const riskPct = num($('tfRiskPct').value, 0);
  if (riskPct < 0 || riskPct > 100) fail('tfRiskPct', 'Risk % must be between 0 and 100.');
  const positionSize = opt('tfPositionSize');
  if ($('tfPositionSize').value !== '' && (positionSize === null || positionSize <= 0)) fail('tfPositionSize', 'Position size must be greater than 0.');
  if (!DATE_RE.test($('tfDate').value)) fail('tfDate', 'Choose a valid trade date.');
  if ($('tfPL').value !== '' && opt('tfPL') === null) fail('tfPL', 'P/L must be a number.');

  if (errors.length) {
    errors.forEach(er => $(er.fid).classList.add('input-error'));
    $(errors[0].fid).focus();
    toast(errors[0].msg, 'error');
    return;
  }

  const direction = $('tfDirection').value;
  const warnings = [];
  if (sl !== null && entry !== null && ((direction === 'Buy' && sl >= entry) || (direction === 'Sell' && sl <= entry))) warnings.push('Stop loss is on the profit side of entry — saved as entered (fine if it was a trailed stop).');
  if (tp !== null && entry !== null && ((direction === 'Buy' && tp <= entry) || (direction === 'Sell' && tp >= entry))) warnings.push('Take profit is on the loss side of entry — please double-check.');

  const manualPLraw = $('tfPL').value;
  const exitRaw = $('tfExit').value;
  const gross = manualPLraw !== '' ? num(manualPLraw, null) : calc.gross;
  const net = gross === null ? null : round2(gross - calc.commission + calc.swap);

  const existingTrade = id ? state.trades.find(t => t.id === id) : null;
  const fields = {
    accountId,
    pair,
    direction,
    entry,
    sl,
    tp,
    exit,
    riskPct,
    riskAmount: calc.riskAmount,
    positionSize,
    pipValuePerLot: num($('tfPipValue').value, 10),
    grossPL: gross,
    commission: calc.commission,
    swap: calc.swap,
    spread: opt('tfSpread'),
    pl: (exitRaw === '' && manualPLraw === '') ? null : net,
    rMultiple: (net !== null && calc.riskAmount) ? round2(safeDiv(net, calc.riskAmount)) : null,
    pips: calc.pipsRealized,
    strategy: $('tfStrategy').value.trim(),
    timeframe: $('tfTimeframe').value,
    tradeSetup: $('tfSetup').value.trim(),
    session: $('tfSession').value,
    setupQuality: $('tfSetupQuality').value,
    marketCondition: $('tfMarketCondition').value,
    tags: $('tfTags').value.split(',').map(s => s.trim()).filter(Boolean),
    tradeReason: $('tfReason').value.trim(),
    entryReason: $('tfEntryReason').value.trim(),
    exitReason: $('tfExitReason').value.trim(),
    emotionBefore: $('tfEmoBefore').value,
    emotionDuring: $('tfEmoDuring').value,
    emotionAfter: $('tfEmoAfter').value,
    confidence: opt('tfConfidence'),
    discipline: opt('tfDiscipline'),
    patience: opt('tfPatience'),
    flags: Object.fromEntries(BEHAVIOUR_FLAGS.map(f => [f.key, $(FLAG_INPUT_IDS[f.key]).checked])),
    mistakes: $('tfMistakes').value.trim(),
    lessons: $('tfLessons').value.trim(),
    notes: $('tfNotes').value.trim(),
    date: $('tfDate').value,
    openTime: $('tfOpenTime').value,
    closeTime: $('tfCloseTime').value,
    shotBefore: editingShots.before,
    shotAfter: editingShots.after
  };

  // Editing keeps every field the form does not own (MT5 ids, trade number…).
  const trade = existingTrade
    ? Object.assign({}, existingTrade, fields)
    : Object.assign({ id: uid(), source: 'Manual', tradeNumber: nextTradeNumber() }, fields);

  if (id) {
    const idx = state.trades.findIndex(t => t.id === id);
    if (idx > -1) state.trades[idx] = trade;
    toast('Trade updated', 'success');
  } else {
    state.trades.push(trade);
    toast('Trade added', 'success');
  }

  if (exitRaw !== '' && trade.pl === null) warnings.push('This trade has an exit price but no P/L, so it is not counted in statistics yet. Add a position size or a P/L amount.');
  warnings.forEach(w => toast(w, 'info'));

  recalcAccountBalance(accountId);
  saveData();
  closeModal('tradeModal');
  renderPage(currentPageName());
  refreshAccountSelectors();
  updateGoalsFromTrades();
}


function recalcAccountBalance(accountId) {
  const account = getAccountById(accountId);
  if (!account) return;
  const closedPL = state.trades.filter(t => t.accountId === accountId && isTradeClosed(t)).reduce((s, t) => s + t.pl, 0);
  account.currentBalance = round2(account.initialBalance + closedPL);
}

function recalcAllAccountBalances() {
  state.accounts.forEach(a => recalcAccountBalance(a.id));
}

function requestDeleteTrade(id) {
  askConfirm('Delete Trade', 'This will permanently delete this trade. This cannot be undone.', () => {
    const trade = state.trades.find(t => t.id === id);
    state.trades = state.trades.filter(t => t.id !== id);
    if (trade) recalcAccountBalance(trade.accountId);
    saveData();
    toast('Trade deleted', 'success');
    closeModal('tradeDetailModal');
    renderPage(currentPageName());
    refreshAccountSelectors();
  });
}

/* ============================================================
   TRADE DETAIL MODAL
   ============================================================ */

let currentDetailTradeId = null;

function detailBlock(label, text) {
  return text ? `<div class="detail-item detail-full" style="margin-top:10px;"><div class="detail-label">${label}</div><div class="detail-value">${escapeHtml(text)}</div></div>` : '';
}

function openTradeDetail(id) {
  const t = state.trades.find(x => x.id === id);
  if (!t) return;
  currentDetailTradeId = id;
  const account = getAccountById(t.accountId);
  const result = tradeResult(t);
  const closed = isTradeClosed(t);
  const dash = v => (v === null || v === undefined || v === '') ? '—' : v;
  const money = v => (v === null || v === undefined) ? '—' : fmtMoney(v);

  const items = [
    ['Trade ID', fmtTradeNumber(t.tradeNumber)],
    ['Account', account ? account.name : '—'],
    ['Source', tradeSource(t)],
    ['Pair', t.pair],
    ['Direction', t.direction],
    ['Result', result],
    ['Date', fmtDate(t.date)],
    ['Open / Close', `${t.openTime || '—'} → ${t.closeTime || '—'}`],
    ['Entry', fmtNum(t.entry, 5)],
    ['Stop Loss', fmtOptPrice(t.sl)],
    ['Take Profit', fmtOptPrice(t.tp)],
    ['Exit', fmtOptPrice(t.exit)],
    ['Planned R:R', tradePlannedRR(t) ? '1 : ' + fmtNum(tradePlannedRR(t), 2) : '—'],
    ['Risk %', (t.riskPct ?? 0) + '%'],
    ['Risk Amount', money(t.riskAmount)],
    ['Position Size', dash(t.positionSize)],
    ['Pips', dash(t.pips)],
    ['Gross P/L', closed ? money(t.grossPL) : '—'],
    ['Commission', fmtMoney(t.commission || 0)],
    ['Swap', fmtMoney(t.swap || 0)],
    ['Spread (pips)', dash(t.spread)],
    ['Net P/L', closed ? fmtMoney(t.pl) : '—'],
    ['R Multiple', closed && t.rMultiple !== null ? fmtNum(t.rMultiple, 2) + 'R' : '—'],
    ['Strategy', dash(t.strategy)],
    ['Timeframe', dash(t.timeframe)],
    ['Trade Setup', dash(t.tradeSetup)],
    ['Session', dash(t.session)],
    ['Setup Quality', dash(t.setupQuality)],
    ['Market Condition', dash(t.marketCondition)]
  ];

  let html = '<div class="detail-grid">' + items.map(([label, val]) => `
    <div class="detail-item"><div class="detail-label">${label}</div><div class="detail-value">${escapeHtml(String(val))}</div></div>
  `).join('') + '</div>';

  const psych = [
    ['Emotion before', t.emotionBefore], ['Emotion during', t.emotionDuring], ['Emotion after', t.emotionAfter],
    ['Confidence', t.confidence !== null ? t.confidence + '/10' : ''], ['Discipline', t.discipline !== null ? t.discipline + '/10' : ''], ['Patience', t.patience !== null ? t.patience + '/10' : '']
  ].filter(([, v]) => v);
  const flags = BEHAVIOUR_FLAGS.filter(f => t.flags && t.flags[f.key]).map(f => f.label);
  if (psych.length || flags.length) {
    html += '<div class="form-section-title" style="margin-top:18px;">Psychology</div><div class="detail-grid">' +
      psych.map(([l, v]) => `<div class="detail-item"><div class="detail-label">${l}</div><div class="detail-value">${escapeHtml(v)}</div></div>`).join('') + '</div>';
    if (flags.length) html += `<div class="detail-item detail-full" style="margin-top:10px;"><div class="detail-label">Behaviour flags</div><div class="detail-value">${flags.map(escapeHtml).join(', ')}</div></div>`;
  }

  if (t.tags && t.tags.length) {
    html += `<div class="detail-item detail-full" style="margin-top:14px;"><div class="detail-label">Tags</div><div class="detail-value">${t.tags.map(escapeHtml).join(', ')}</div></div>`;
  }
  html += detailBlock('Trade Reason', t.tradeReason);
  html += detailBlock('Entry Reason', t.entryReason);
  html += detailBlock('Exit Reason', t.exitReason);
  html += detailBlock('Mistakes', t.mistakes);
  html += detailBlock('Lessons Learned', t.lessons);
  html += detailBlock('Notes', t.notes);
  if (tradeSource(t) === 'MT5' && t.mt5PositionId) {
    html += detailBlock('MT5 Position ID', String(t.mt5PositionId));
  }

  const shot = (src, alt) => (src && String(src).startsWith('data:image/')) ? `<img src="${escapeHtml(src)}" alt="${alt}">` : '';
  if (t.shotBefore || t.shotAfter) {
    html += `<div class="detail-shots">${shot(t.shotBefore, 'Before trade')}${shot(t.shotAfter, 'After trade')}</div>`;
  }

  document.getElementById('tradeDetailBody').innerHTML = html;
  openModal('tradeDetailModal');
}


/* ============================================================
   ANALYTICS
   ============================================================ */

function getScopedContext(scope) {
  const active = getActiveAccount();
  if (scope === 'all' || !active) {
    const init = state.accounts.reduce((s, a) => s + a.initialBalance, 0);
    const cur = state.accounts.reduce((s, a) => s + a.currentBalance, 0);
    return {
      trades: state.trades.slice(),
      account: { id: 'all', name: 'All accounts', initialBalance: state.accounts.length ? init : 10000, currentBalance: state.accounts.length ? cur : 10000 },
      label: 'All accounts',
      isAll: true
    };
  }
  return { trades: getTradesForAccount(active.id), account: active, label: active.name, isAll: false };
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function weekdayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return WEEKDAYS[(d.getDay() + 6) % 7];
}

function renderAnalytics() {
  const scopeSel = document.getElementById('analyticsScope');
  if (scopeSel) scopeSel.value = state.settings.analyticsScope;
  const ctx = getScopedContext(state.settings.analyticsScope);
  const trades = ctx.trades;
  const m = computeMetrics(trades, ctx.account);

  renderStatGrid(document.getElementById('analyticsMetricsGrid'), m, ctx.account);

  renderLineChart('anEquity', 'anEquity', m.equityCurve.map(p => p.label === 'Start' ? 'Start' : fmtDate(p.label)), m.equityCurve.map(p => p.value), '#c47a44');
  renderLineChart('anDrawdown', 'anDrawdown', m.drawdownCurve.map(p => p.label === 'Start' ? 'Start' : fmtDate(p.label)), m.drawdownCurve.map(p => p.value), '#ef6262');

  renderDailyWeeklyMonthly(trades);
  const yearly = bucketPL(trades, t => t.date.slice(0, 4));
  renderBarChart('anYearly', 'anYearly', yearly.labels, yearly.values, yearly.values.map(v => v >= 0 ? '#35c98b' : '#ef6262'));

  const byDay = {};
  trades.filter(isTradeClosed).forEach(t => { const k = weekdayOf(t.date); byDay[k] = (byDay[k] || 0) + t.pl; });
  const dayLabels = WEEKDAYS.filter(d => byDay[d] !== undefined);
  renderBarChart('anWeekday', 'anWeekday', dayLabels, dayLabels.map(d => round2(byDay[d])), dayLabels.map(d => byDay[d] >= 0 ? '#35c98b' : '#ef6262'));

  renderGroupedBarChart('anPair', 'anPair', trades, t => t.pair);
  renderGroupedBarChart('anStrategy', 'anStrategy', trades, t => t.strategy);
  renderGroupedBarChart('anSession', 'anSession', trades, t => t.session);
  renderGroupedBarChart('anSetup', 'anSetup', trades, t => t.setupQuality);
  renderGroupedBarChart('anMarket', 'anMarket', trades, t => t.marketCondition);
  renderGroupedBarChart('anDirection', 'anDirection', trades, t => t.direction);
  renderGroupedBarChart('anTimeframe', 'anTimeframe', trades, t => t.timeframe);

  const closed = trades.filter(isTradeClosed);
  renderDoughnut('anBuySell', 'anBuySell', ['Buy', 'Sell'], [closed.filter(t => t.direction === 'Buy').length, closed.filter(t => t.direction === 'Sell').length], ['#c47a44', '#e0a16b']);
  renderDoughnut('anWinLoss', 'anWinLoss', ['Wins', 'Losses', 'Breakeven'], [m.winningTrades, m.losingTrades, m.breakevenTrades], ['#35c98b', '#ef6262', '#8f99a6']);
}

function renderGroupedBarChart(canvasId, key, trades, keyFn) {
  const groups = groupPerformance(trades, keyFn);
  renderBarChart(canvasId, key, groups.map(g => g.name), groups.map(g => round2(g.pl)), groups.map(g => g.pl >= 0 ? '#35c98b' : '#ef6262'));
}


function bucketPL(trades, bucketFn) {
  const map = {};
  trades.filter(isTradeClosed).forEach(t => {
    const key = bucketFn(t);
    map[key] = (map[key] || 0) + t.pl;
  });
  const keys = Object.keys(map).sort();
  return { labels: keys, values: keys.map(k => round2(map[k])) };
}

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNo = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function renderDailyWeeklyMonthly(trades) {
  const daily = bucketPL(trades, t => t.date);
  renderBarChart('anDaily', 'anDaily', daily.labels.map(fmtDate), daily.values, daily.values.map(v => v >= 0 ? '#35c98b' : '#ef6262'));

  const weekly = bucketPL(trades, t => getISOWeek(t.date));
  renderBarChart('anWeekly', 'anWeekly', weekly.labels, weekly.values, weekly.values.map(v => v >= 0 ? '#35c98b' : '#ef6262'));

  const monthly = bucketPL(trades, t => t.date.slice(0, 7));
  renderBarChart('anMonthly', 'anMonthly', monthly.labels, monthly.values, monthly.values.map(v => v >= 0 ? '#35c98b' : '#ef6262'));
}

/* ============================================================
   CALENDAR
   ============================================================ */

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const scopeSel = document.getElementById('calendarScope');
  if (scopeSel) scopeSel.value = state.settings.analyticsScope;

  document.getElementById('calMonthLabel').textContent = calendarViewDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  const scoped = getScopedContext(state.settings.analyticsScope).trades;
  const dayTotals = {};
  scoped.filter(isTradeClosed).forEach(t => {
    if (!dayTotals[t.date]) dayTotals[t.date] = { pl: 0, count: 0 };
    dayTotals[t.date].pl += t.pl;
    dayTotals[t.date].count++;
  });

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const monthDays = Object.entries(dayTotals).filter(([d]) => d.startsWith(monthPrefix));
  const monthPL = monthDays.reduce((s, [, v]) => s + v.pl, 0);
  const winDays = monthDays.filter(([, v]) => v.pl > 0).length;
  const loseDays = monthDays.filter(([, v]) => v.pl < 0).length;
  const best = monthDays.length ? monthDays.reduce((a, b) => (b[1].pl > a[1].pl ? b : a)) : null;
  const worst = monthDays.length ? monthDays.reduce((a, b) => (b[1].pl < a[1].pl ? b : a)) : null;
  const monthTrades = monthDays.reduce((s, [, v]) => s + v.count, 0);
  const cell = (label, value, cls) => `<div class="perf-cell"><div class="perf-cell-label">${label}</div><div class="perf-cell-value ${cls || ''}">${value}</div></div>`;
  document.getElementById('calendarSummary').innerHTML = [
    cell('Month P/L', fmtMoney(monthPL), monthPL >= 0 ? 'pos' : 'neg'),
    cell('Trading Days', monthDays.length),
    cell('Winning Days', winDays, 'pos'),
    cell('Losing Days', loseDays, 'neg'),
    cell('Trades', monthTrades),
    cell('Best Day', best ? fmtMoney(best[1].pl) : '—', best ? 'pos' : ''),
    cell('Worst Day', worst && worst[1].pl < 0 ? fmtMoney(worst[1].pl) : '—', worst && worst[1].pl < 0 ? 'neg' : '')
  ].join('');

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = nowDateStr();

  let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let i = 0; i < startOffset; i++) html += '<div class="cal-day empty"></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${monthPrefix}-${String(day).padStart(2, '0')}`;
    const data = dayTotals[dateStr];
    let cls = 'cal-day';
    if (dateStr === todayStr) cls += ' today';
    let inner = `<div class="cal-day-num">${day}</div>`;
    if (data) {
      if (data.pl > 0) cls += ' pos'; else if (data.pl < 0) cls += ' neg';
      inner += `<div class="cal-day-pl ${data.pl >= 0 ? 'val-pos' : 'val-neg'}">${fmtMoney(data.pl)}</div><div class="cal-day-count">${data.count} trade${data.count > 1 ? 's' : ''}</div>`;
    }
    html += `<div class="${cls}" data-date="${dateStr}" role="button" tabindex="0" aria-label="${dateStr}${data ? ', ' + data.count + ' trades, ' + fmtMoney(data.pl) : ', no trades'}">${inner}</div>`;
  }

  grid.innerHTML = html;
  grid.querySelectorAll('.cal-day:not(.empty)').forEach(el => {
    el.addEventListener('click', () => showCalendarDay(el.dataset.date));
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showCalendarDay(el.dataset.date); } });
  });

  if (selectedCalendarDay) showCalendarDay(selectedCalendarDay); else document.getElementById('calendarDayDetail').style.display = 'none';
}

function showCalendarDay(dateStr) {
  selectedCalendarDay = dateStr;
  const trades = getScopedContext(state.settings.analyticsScope).trades.filter(t => t.date === dateStr);
  const closed = trades.filter(isTradeClosed);
  const pl = closed.reduce((s, t) => s + t.pl, 0);
  const wins = closed.filter(t => t.pl > 0).length;
  const losses = closed.filter(t => t.pl < 0).length;

  document.getElementById('calendarDayDetail').style.display = 'block';
  document.getElementById('calendarDayTitle').textContent = `Trades on ${fmtDate(dateStr)}`;
  document.getElementById('calendarDayStats').innerHTML = `
    <div class="perf-cell"><div class="perf-cell-label">Net P/L</div><div class="perf-cell-value ${pl >= 0 ? 'pos' : 'neg'}">${fmtMoney(pl)}</div></div>
    <div class="perf-cell"><div class="perf-cell-label">Trades</div><div class="perf-cell-value">${trades.length}</div></div>
    <div class="perf-cell"><div class="perf-cell-label">Wins</div><div class="perf-cell-value pos">${wins}</div></div>
    <div class="perf-cell"><div class="perf-cell-label">Losses</div><div class="perf-cell-value neg">${losses}</div></div>`;

  const btn = document.getElementById('calDayJournalBtn');
  if (btn) btn.onclick = () => openJournalWithFilters({ dateFrom: dateStr, dateTo: dateStr });

  const wrap = document.getElementById('calendarDayTradesWrap');
  if (!trades.length) {
    wrap.innerHTML = emptyState('fa-calendar-xmark', 'No trades on this day', 'Pick another day to view trade history.');
  } else {
    wrap.innerHTML = buildTradeTable(trades);
    bindTradeRowClicks(wrap);
  }
}


/* ============================================================
   RISK CALCULATOR
   ============================================================ */

function computeRisk() {
  const balance = num(document.getElementById('rcBalance').value, null);
  const riskPct = num(document.getElementById('rcRiskPct').value, null);
  const pair = document.getElementById('rcPair').value.trim();
  const entry = num(document.getElementById('rcEntry').value, null);
  const sl = num(document.getElementById('rcSL').value, null);
  const tp = num(document.getElementById('rcTP').value, null);
  const pipValue = num(document.getElementById('rcPipValue').value, null);
  const slPipsInput = num(document.getElementById('rcSLPips').value, null);
  const useSLPips = slPipsInput !== null && slPipsInput > 0;

  const validationEl = document.getElementById('rcValidation');
  const resultsEl = document.getElementById('rcResults');

  const errors = [];
  if (balance === null || balance <= 0) errors.push('Enter a valid account balance greater than 0.');
  if (riskPct === null || riskPct <= 0) errors.push('Enter a valid risk percentage greater than 0.');
  else if (riskPct > 100) errors.push('Risk percentage cannot exceed 100.');
  if (!useSLPips) {
    if (entry === null || entry <= 0) errors.push('Enter a valid entry price (or a stop-loss distance in pips).');
    if (sl === null || sl <= 0) errors.push('Enter a valid stop loss price (or a stop-loss distance in pips).');
    if (entry !== null && sl !== null && entry === sl) errors.push('Entry price and stop loss cannot be equal.');
  }
  if (pipValue === null || pipValue <= 0) errors.push('Enter a valid pip value per lot.');

  if (errors.length) {
    validationEl.style.display = 'flex';
    validationEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(errors[0])}</span>`;
    resultsEl.innerHTML = emptyState('fa-calculator', 'Waiting for valid inputs', 'Fix the highlighted issue to see your position sizing results.');
    return;
  }
  validationEl.style.display = 'none';

  const pipSize = getPipSize(pair);
  const riskAmount = calcRiskAmount(balance, riskPct);
  const slPips = useSLPips ? slPipsInput : Math.abs(entry - sl) / pipSize;
  const tpPips = (entry !== null && entry > 0 && tp !== null && tp > 0) ? Math.abs(tp - entry) / pipSize : null;
  const rr = tpPips ? safeDiv(tpPips, slPips) : null;
  const lots = safeDiv(riskAmount, slPips * pipValue);
  const potentialLoss = -riskAmount;
  const potentialProfit = tpPips ? round2(tpPips * pipValue * lots) : null;

  const items = [
    ['Risk Percentage', fmtNum(riskPct, 2) + '%', ''],
    ['Risk Amount', fmtMoney(riskAmount), 'highlight'],
    ['Stop-Loss Distance', fmtNum(slPips, 1) + ' pips', ''],
    ['Take Profit Pips', tpPips !== null ? fmtNum(tpPips, 1) + ' pips' : '—', ''],
    ['Risk / Reward Ratio', rr !== null ? `1 : ${fmtNum(rr, 2)}` : '—', ''],
    ['Position Size', fmtNum(lots, 2) + ' lots', 'highlight'],
    ['Lot Size (units)', fmtNum(lots * 100000, 0) + ' units', ''],
    ['Reward Amount (if TP hit)', tpPips !== null ? fmtMoney(potentialProfit) : '—', tpPips !== null ? 'pos' : ''],
    ['Loss Amount (if SL hit)', fmtMoney(potentialLoss), 'neg']
  ];

  resultsEl.innerHTML = items.map(([label, value, cls]) => `
    <div class="rc-item ${cls === 'highlight' ? 'highlight' : ''}">
      <div class="rc-item-label">${label}</div>
      <div class="rc-item-value ${cls === 'pos' ? 'pos' : cls === 'neg' ? 'neg' : ''}">${value}</div>
    </div>`).join('') +
    (lots > 0 && lots < 0.01 ? '<div class="validation-msg" style="grid-column:1/-1;display:flex;"><i class="fa-solid fa-circle-info"></i><span>This size is below the usual 0.01 lot minimum — your broker may not allow it. Consider a smaller risk or a tighter stop.</span></div>' : '') +
    '<div class="hint-text" style="grid-column:1/-1;">Estimates based on the numbers entered; slippage, spread, gaps and your broker\'s contract specifications can change real outcomes.</div>';
}

function computeRiskStatus() {
  const account = getActiveAccount();
  if (!account) return null;
  const rules = Object.assign(defaultRiskRules(), state.settings.risk || {});
  const trades = getTradesForAccount(account.id);
  const today = nowDateStr();
  const todays = trades.filter(t => t.date === today);
  const todayPL = todays.filter(isTradeClosed).reduce((s, t) => s + t.pl, 0);
  const dayStartBalance = account.currentBalance - todayPL;
  const dailyLimitAmt = rules.dailyLossLimitPct > 0 && dayStartBalance > 0 ? dayStartBalance * rules.dailyLossLimitPct / 100 : 0;
  const lossToday = Math.max(0, -todayPL);
  const m = computeMetrics(trades, account);
  const consec = m.currentStreakType === 'loss' ? m.currentStreak : 0;
  return { account, rules, todayPL, todayCount: todays.length, dailyLimitAmt, lossToday, consec, currentDD: m.currentDrawdown, maxDD: m.maxDrawdown };
}

function riskMeter(label, valueText, pct, status, sub) {
  return `
    <div class="risk-meter ${status}">
      <div class="risk-meter-top"><span class="risk-meter-label">${label}</span><span class="risk-meter-val">${valueText}</span></div>
      <div class="risk-meter-track"><div class="risk-meter-fill" style="width:${clamp(pct, 0, 100)}%"></div></div>
      <div class="risk-meter-sub">${sub}</div>
    </div>`;
}

function statusFor(pct) { return pct >= 100 ? 'danger' : pct >= 75 ? 'warn' : 'ok'; }

function renderRiskStatusInto(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  const s = computeRiskStatus();
  if (!s) {
    el.innerHTML = emptyState('fa-shield-halved', 'No active account', 'Add an account to track your daily loss limit and drawdown.');
    return;
  }
  const r = s.rules;
  const alerts = [];
  const meters = [];

  if (r.dailyLossLimitPct > 0 && s.dailyLimitAmt > 0) {
    const pct = safeDiv(s.lossToday, s.dailyLimitAmt) * 100;
    const st = statusFor(pct);
    meters.push(riskMeter('Daily loss', `${fmtMoney(s.lossToday)} of ${fmtMoney(s.dailyLimitAmt)}`, pct, st, `${fmtPct(pct)} of your ${r.dailyLossLimitPct}% daily limit used`));
    if (st === 'danger') alerts.push('Daily loss limit reached. Your own rules say to stop trading for today.');
    else if (st === 'warn') alerts.push('You have used over 75% of your daily loss limit.');
  } else {
    meters.push(riskMeter('Daily loss', fmtMoney(s.lossToday), 0, 'ok', 'No daily loss limit set'));
  }

  if (r.maxTradesPerDay > 0) {
    const pct = safeDiv(s.todayCount, r.maxTradesPerDay) * 100;
    const st = s.todayCount > r.maxTradesPerDay ? 'danger' : s.todayCount === r.maxTradesPerDay ? 'warn' : 'ok';
    meters.push(riskMeter('Trades today', `${s.todayCount} of ${r.maxTradesPerDay}`, pct, st, st === 'danger' ? 'Over your daily trade cap' : 'Daily trade cap'));
    if (st === 'danger') alerts.push('You have exceeded your maximum trades per day.');
  } else {
    meters.push(riskMeter('Trades today', String(s.todayCount), 0, 'ok', 'No daily trade cap set'));
  }

  if (r.maxConsecutiveLosses > 0) {
    const pct = safeDiv(s.consec, r.maxConsecutiveLosses) * 100;
    const st = s.consec >= r.maxConsecutiveLosses ? 'danger' : (r.maxConsecutiveLosses > 1 && s.consec === r.maxConsecutiveLosses - 1) ? 'warn' : 'ok';
    meters.push(riskMeter('Consecutive losses', `${s.consec} of ${r.maxConsecutiveLosses}`, pct, st, 'Current losing streak'));
    if (st === 'danger') alerts.push('Consecutive-loss limit reached. Consider pausing to review your process.');
  } else {
    meters.push(riskMeter('Consecutive losses', String(s.consec), 0, 'ok', 'No limit set'));
  }

  if (r.maxDrawdownPct > 0) {
    const pct = safeDiv(s.currentDD, r.maxDrawdownPct) * 100;
    const st = statusFor(pct);
    meters.push(riskMeter('Drawdown', `${fmtPct(s.currentDD)} of ${fmtPct(r.maxDrawdownPct)}`, pct, st, `Worst so far: ${fmtPct(s.maxDD)}`));
    if (st === 'danger') alerts.push('Current drawdown has reached your maximum drawdown limit.');
  } else {
    meters.push(riskMeter('Drawdown', fmtPct(s.currentDD), 0, 'ok', `Worst so far: ${fmtPct(s.maxDD)}`));
  }

  el.innerHTML =
    (alerts.length ? alerts.map(a => `<div class="risk-alert"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(a)}</span></div>`).join('') : '') +
    `<div class="risk-meters">${meters.join('')}</div>`;
}

function renderRiskRulesUI() {
  const r = Object.assign(defaultRiskRules(), state.settings.risk || {});
  document.getElementById('rrDailyLoss').value = r.dailyLossLimitPct;
  document.getElementById('rrMaxTrades').value = r.maxTradesPerDay;
  document.getElementById('rrMaxConsec').value = r.maxConsecutiveLosses;
  document.getElementById('rrMaxDD').value = r.maxDrawdownPct;
}

function renderRiskPage() {
  renderRiskRulesUI();
  renderRiskStatusInto('riskStatusPanel');
  computeRisk();
}


function resetRiskCalculator() {
  document.getElementById('rcBalance').value = 10000;
  document.getElementById('rcRiskPct').value = 1;
  document.getElementById('rcPair').value = 'EURUSD';
  document.getElementById('rcEntry').value = 1.10000;
  document.getElementById('rcSL').value = 1.09500;
  document.getElementById('rcTP').value = 1.11000;
  document.getElementById('rcPipValue').value = 10;
  document.getElementById('rcSLPips').value = '';
  computeRisk();
}

/* ============================================================
   GOALS
   ============================================================ */

function computeGoalCurrentValue(goal) {
  const trades = state.trades.filter(isTradeClosed);
  const account = getActiveAccount();
  switch (goal.type) {
    case 'Profit Target':
      return round2(trades.filter(t => !goal.startDate || t.date >= goal.startDate).reduce((s, t) => s + t.pl, 0));
    case 'Monthly Profit': {
      const monthStart = nowDateStr().slice(0, 8) + '01';
      return round2(trades.filter(t => t.date >= monthStart).reduce((s, t) => s + t.pl, 0));
    }
    case 'Win Rate Target': {
      const relevant = goal.startDate ? trades.filter(t => t.date >= goal.startDate) : trades;
      if (!relevant.length) return 0;
      return round2(safeDiv(relevant.filter(t => t.pl > 0).length, relevant.length) * 100);
    }
    case 'Maximum Drawdown': {
      const m = computeMetrics(trades, account);
      return round2(m.maxDrawdown);
    }
    case 'Trade Count':
      return goal.startDate ? trades.filter(t => t.date >= goal.startDate).length : trades.length;
    case 'Average R Target': {
      const relevant = goal.startDate ? trades.filter(t => t.date >= goal.startDate) : trades;
      const rValues = relevant.filter(t => t.rMultiple !== null && t.rMultiple !== undefined && isFinite(t.rMultiple)).map(t => t.rMultiple);
      return rValues.length ? round2(safeDiv(rValues.reduce((s, v) => s + v, 0), rValues.length)) : 0;
    }
    case 'Monthly Trade Count': {
      const monthStart = nowDateStr().slice(0, 8) + '01';
      return state.trades.filter(t => t.date >= monthStart).length;
    }
    case 'Maximum Monthly Loss': {
      const monthStart = nowDateStr().slice(0, 8) + '01';
      const net = trades.filter(t => t.date >= monthStart).reduce((s, t) => s + t.pl, 0);
      return round2(Math.max(0, -net));
    }
    case 'Risk Compliance': {
      const relevant = trades.filter(t => (!goal.startDate || t.date >= goal.startDate) && t.riskPct > 0);
      if (!relevant.length) return 0;
      const limit = (state.settings.defaultRiskPct || 1) + 1e-9;
      return round2(safeDiv(relevant.filter(t => t.riskPct <= limit).length, relevant.length) * 100);
    }
    case 'Discipline Score': {
      const relevant = trades.filter(t => !goal.startDate || t.date >= goal.startDate);
      if (!relevant.length) return 0;
      return round2(safeDiv(relevant.filter(t => !(t.flags && t.flags.ruleViolation)).length, relevant.length) * 100);
    }
    default:
      return goal.current || 0;
  }
}

function updateGoalsFromTrades() {
  if (!state.goals.length) return;
  state.goals.forEach(g => { g.current = computeGoalCurrentValue(g); });
  saveData();
}

function goalMeta(type) {
  const money = ['Profit Target', 'Monthly Profit', 'Maximum Monthly Loss'].includes(type);
  const pct = ['Win Rate Target', 'Maximum Drawdown', 'Risk Compliance', 'Discipline Score'].includes(type);
  return {
    money,
    unit: pct ? '%' : type === 'Average R Target' ? 'R' : '',
    lowerIsBetter: type === 'Maximum Drawdown' || type === 'Maximum Monthly Loss'
  };
}

function goalValueText(type, v) {
  const meta = goalMeta(type);
  return meta.money ? fmtMoney(v) : fmtNum(v, 2) + meta.unit;
}

function renderGoals() {
  const grid = document.getElementById('goalsGrid');
  if (!state.goals.length) {
    grid.innerHTML = `<div class="card" style="grid-column: 1 / -1;">${emptyState('fa-bullseye', 'Create your first trading goal', 'Set a profit target, win rate, or drawdown limit to stay accountable.',
      `<button class="btn btn-primary btn-sm" onclick="openGoalModal()">Create Goal</button>`)}</div>`;
    return;
  }

  grid.innerHTML = state.goals.map(g => {
    const meta = goalMeta(g.type);
    let progressPct, badge = '', barClass = '';
    if (meta.lowerIsBetter) {
      // Limit-style goal: the bar shows how much of the allowed limit is used.
      progressPct = g.target > 0 ? clamp((g.current / g.target) * 100, 0, 100) : (g.current > 0 ? 100 : 0);
      const within = g.current <= g.target;
      badge = within ? '<span class="kpi-badge pos">Within limit</span>' : '<span class="kpi-badge neg">Limit exceeded</span>';
      barClass = !within ? 'danger' : progressPct >= 75 ? 'warn' : 'complete';
    } else {
      progressPct = g.target !== 0 ? clamp((g.current / g.target) * 100, 0, 100) : 0;
      if (progressPct >= 100) { badge = '<span class="kpi-badge pos">Complete</span>'; barClass = 'complete'; }
    }
    return `
      <div class="goal-card">
        <div class="goal-card-top">
          <div>
            <span class="goal-type-tag">${escapeHtml(g.type)}</span>
            <h3 class="goal-name" style="margin-top:8px;">${escapeHtml(g.name)}</h3>
          </div>
          ${badge}
        </div>
        <div class="goal-progress-row"><span>${goalValueText(g.type, g.current)} ${meta.lowerIsBetter ? 'of limit' : 'of'} ${goalValueText(g.type, g.target)}</span><span>${progressPct.toFixed(0)}%</span></div>
        <div class="goal-bar-track"><div class="goal-bar-fill ${barClass}" style="width:${progressPct}%"></div></div>
        <div class="goal-meta">
          <span>${escapeHtml(g.period || 'Ongoing')}</span>
          <span>${g.deadline ? 'Due ' + fmtDate(g.deadline) : 'No deadline'}</span>
        </div>
        ${g.notes ? `<div class="goal-notes">${escapeHtml(g.notes)}</div>` : ''}
        <div class="goal-card-actions">
          <button class="btn btn-ghost btn-sm" aria-label="Edit goal" onclick="openGoalModal('${g.id}')"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-danger btn-sm" aria-label="Delete goal" onclick="requestDeleteGoal('${g.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
  }).join('');
}


function openGoalModal(id) {
  const form = document.getElementById('goalForm');
  form.reset();
  document.getElementById('goalId').value = '';
  if (id) {
    const g = state.goals.find(x => x.id === id);
    if (!g) return;
    document.getElementById('goalModalTitle').textContent = 'Edit Goal';
    document.getElementById('goalId').value = g.id;
    document.getElementById('gfName').value = g.name;
    document.getElementById('gfType').value = g.type;
    document.getElementById('gfTarget').value = g.target;
    document.getElementById('gfCurrent').value = g.current;
    document.getElementById('gfStart').value = g.startDate || '';
    document.getElementById('gfDeadline').value = g.deadline || '';
    document.getElementById('gfPeriod').value = g.period || 'Monthly';
    document.getElementById('gfNotes').value = g.notes || '';
  } else {
    document.getElementById('goalModalTitle').textContent = 'Create Goal';
    document.getElementById('gfStart').value = nowDateStr();
    document.getElementById('gfCurrent').value = 0;
  }
  openModal('goalModal');
}

function handleGoalFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('goalId').value;
  const goal = {
    id: id || uid(),
    name: document.getElementById('gfName').value.trim(),
    type: document.getElementById('gfType').value,
    target: num(document.getElementById('gfTarget').value, 0),
    current: num(document.getElementById('gfCurrent').value, 0),
    startDate: document.getElementById('gfStart').value,
    deadline: document.getElementById('gfDeadline').value,
    period: document.getElementById('gfPeriod').value,
    notes: document.getElementById('gfNotes').value.trim()
  };
  if (!goal.name || !goal.target) { toast('Please fill in the goal name and target.', 'error'); return; }

  goal.current = computeGoalCurrentValue(goal);

  if (id) {
    const idx = state.goals.findIndex(g => g.id === id);
    if (idx > -1) state.goals[idx] = goal;
    toast('Goal updated', 'success');
  } else {
    state.goals.push(goal);
    toast('Goal added', 'success');
  }
  saveData();
  closeModal('goalModal');
  renderGoals();
}

function requestDeleteGoal(id) {
  askConfirm('Delete Goal', 'This goal will be permanently removed.', () => {
    state.goals = state.goals.filter(g => g.id !== id);
    saveData();
    toast('Goal deleted', 'success');
    renderGoals();
  });
}

/* ============================================================
   PSYCHOLOGY
   ============================================================ */

function renderPsychology() {
  renderPsychTradeAnalytics();
  const entries = state.psychology.slice().sort((a, b) => b.date.localeCompare(a.date));
  const gridEl = document.getElementById('psychStatsGrid');

  if (!entries.length) {
    gridEl.innerHTML = '';
    document.getElementById('psychEntries').innerHTML = emptyState('fa-brain', 'No psychology entries yet', 'Log how you feel before or after trading to spot behavioral patterns.',
      `<button class="btn btn-primary btn-sm" onclick="openModal('psychModal')">Add Entry</button>`);
    return;
  }

  const avg = (field) => round1(safeDiv(entries.reduce((s, e) => s + (e[field] || 0), 0), entries.length));
  const fomoFreq = round1(safeDiv(entries.filter(e => e.fomo >= 6).length, entries.length) * 100);
  const revengeFreq = round1(safeDiv(entries.filter(e => e.revenge >= 6).length, entries.length) * 100);

  gridEl.innerHTML = [
    kpiCard('fa-face-smile', 'Average Confidence', avg('confidence') + '/10', null, '', ''),
    kpiCard('fa-shield-halved', 'Average Discipline', avg('discipline') + '/10', null, '', ''),
    kpiCard('fa-heart-crack', 'Average Stress', avg('stress') + '/10', null, '', ''),
    kpiCard('fa-bolt', 'FOMO Frequency', fomoFreq + '%', null, fomoFreq > 30 ? 'neg' : '', fomoFreq > 30 ? 'neg' : ''),
    kpiCard('fa-fire-flame-curved', 'Revenge Trading Frequency', revengeFreq + '%', null, revengeFreq > 20 ? 'neg' : '', revengeFreq > 20 ? 'neg' : '')
  ].join('');

  document.getElementById('psychEntries').innerHTML = entries.slice(0, 15).map(e => `
    <div class="psych-entry">
      <div class="psych-entry-top">
        <span class="psych-entry-date">${fmtDate(e.date)} · ${escapeHtml(e.mood || '')}</span>
        <button class="btn btn-ghost btn-sm" onclick="requestDeletePsych('${e.id}')"><i class="fa-solid fa-trash"></i></button>
      </div>
      <div class="psych-tags">
        <span class="psych-tag">Confidence ${e.confidence}/10</span>
        <span class="psych-tag">Discipline ${e.discipline}/10</span>
        <span class="psych-tag">Fear ${e.fear}/10</span>
        <span class="psych-tag">Greed ${e.greed}/10</span>
        <span class="psych-tag">FOMO ${e.fomo}/10</span>
        <span class="psych-tag">Revenge ${e.revenge}/10</span>
        <span class="psych-tag">Stress ${e.stress}/10</span>
      </div>
      ${e.mistakes ? `<div class="psych-entry-notes"><b>Mistakes:</b> ${escapeHtml(e.mistakes)}</div>` : ''}
      ${e.lessons ? `<div class="psych-entry-notes"><b>Lessons:</b> ${escapeHtml(e.lessons)}</div>` : ''}
      ${e.notes ? `<div class="psych-entry-notes">${escapeHtml(e.notes)}</div>` : ''}
    </div>`).join('');
}

function handlePsychFormSubmit(e) {
  e.preventDefault();
  const entry = {
    id: uid(),
    date: document.getElementById('pfDate').value || nowDateStr(),
    mood: document.getElementById('pfMood').value,
    confidence: num(document.getElementById('pfConfidence').value, 5),
    discipline: num(document.getElementById('pfDiscipline').value, 5),
    fear: num(document.getElementById('pfFear').value, 5),
    greed: num(document.getElementById('pfGreed').value, 5),
    fomo: num(document.getElementById('pfFomo').value, 5),
    revenge: num(document.getElementById('pfRevenge').value, 5),
    stress: num(document.getElementById('pfStress').value, 5),
    mistakes: document.getElementById('pfMistakes').value.trim(),
    lessons: document.getElementById('pfLessons').value.trim(),
    notes: document.getElementById('pfNotes').value.trim()
  };
  state.psychology.push(entry);
  saveData();
  toast('Psychology entry saved', 'success');
  closeModal('psychModal');
  renderPsychology();
}

function requestDeletePsych(id) {
  askConfirm('Delete Entry', 'This psychology entry will be permanently removed.', () => {
    state.psychology = state.psychology.filter(p => p.id !== id);
    saveData();
    toast('Entry deleted', 'success');
    renderPsychology();
  });
}

/* ============================================================
   STRATEGIES
   ============================================================ */

/* Aggregate closed trades per strategy (drawdown is measured on the
   strategy's own cumulative P/L, in account currency). */
function strategyStats(trades) {
  const groups = {};
  trades.filter(isTradeClosed).slice().sort(chronoCompare).forEach(t => {
    const key = t.strategy || 'Unspecified';
    (groups[key] = groups[key] || []).push(t);
  });
  return Object.entries(groups).map(([name, list]) => {
    const wins = list.filter(t => t.pl > 0), losses = list.filter(t => t.pl < 0);
    const gp = wins.reduce((s, t) => s + t.pl, 0), gl = losses.reduce((s, t) => s + t.pl, 0);
    let run = 0, peak = 0, dd = 0;
    list.forEach(t => { run += t.pl; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); });
    const rs = list.filter(t => t.rMultiple !== null && isFinite(t.rMultiple)).map(t => t.rMultiple);
    const rrs = list.map(tradePlannedRR).filter(v => v);
    return {
      name, trades: list.length, wins: wins.length, losses: losses.length,
      winRate: safeDiv(wins.length, list.length) * 100,
      net: gp + gl,
      profitFactor: gl !== 0 ? Math.abs(gp / gl) : (gp > 0 ? Infinity : 0),
      avgProfit: wins.length ? gp / wins.length : 0,
      avgLoss: losses.length ? gl / losses.length : 0,
      maxDD: dd,
      avgR: rs.length ? safeDiv(rs.reduce((a, b) => a + b, 0), rs.length) : null,
      avgPlannedRR: rrs.length ? safeDiv(rrs.reduce((a, b) => a + b, 0), rrs.length) : null
    };
  }).sort((a, b) => b.net - a.net);
}

function renderStrategies() {
  const wrap = document.getElementById('strategyTableWrap');
  const stats = strategyStats(state.trades);
  if (!stats.length) {
    wrap.innerHTML = emptyState('fa-chess', 'No strategy data yet', 'Give your trades a strategy name and close them to compare how each one performs.',
      `<button class="btn btn-primary btn-sm" onclick="openTradeModal()"><i class="fa-solid fa-plus"></i> Add Trade</button>`);
    renderBarChart('stratChart', 'stratChart', [], [], null, 'No strategy data yet');
    return;
  }
  const rows = stats.map(s => `
    <tr ${s.name !== 'Unspecified' ? `class="row-link" data-strategy="${escapeHtml(s.name)}" tabindex="0"` : ''}>
      <td><b>${escapeHtml(s.name)}</b></td>
      <td>${s.trades}</td><td class="val-pos">${s.wins}</td><td class="val-neg">${s.losses}</td>
      <td>${fmtPct(s.winRate)}</td>
      <td class="${s.net >= 0 ? 'val-pos' : 'val-neg'}">${fmtMoney(s.net)}</td>
      <td>${fmtPF(s.profitFactor)}</td>
      <td class="val-pos">${fmtMoney(s.avgProfit)}</td><td class="val-neg">${fmtMoney(s.avgLoss)}</td>
      <td class="val-neg">${s.maxDD ? fmtMoney(-s.maxDD) : fmtMoney(0)}</td>
      <td>${s.avgR !== null ? fmtNum(s.avgR, 2) + 'R' : '—'}</td>
      <td>${s.avgPlannedRR ? '1 : ' + fmtNum(s.avgPlannedRR, 2) : '—'}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Strategy</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win Rate</th><th>Net Profit</th><th>Profit Factor</th><th>Avg Profit</th><th>Avg Loss</th><th>Max DD</th><th>Avg R</th><th>Avg R:R (plan)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint-text">Statistics describe the trades you recorded. Small samples (under ~30 trades) are noisy, and past results do not guarantee future performance.</p>`;
  wrap.querySelectorAll('tr[data-strategy]').forEach(tr => {
    const go = () => openJournalWithFilters({ strategy: tr.dataset.strategy });
    tr.addEventListener('click', go);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
  renderBarChart('stratChart', 'stratChart', stats.map(s => s.name), stats.map(s => round2(s.net)), stats.map(s => s.net >= 0 ? '#35c98b' : '#ef6262'));
}


/* ============================================================
   PSYCHOLOGY VS PERFORMANCE (TRADE-LEVEL)
   ============================================================ */

function listStats(list) {
  const n = list.length;
  const wins = list.filter(t => t.pl > 0).length;
  const net = list.reduce((s, t) => s + t.pl, 0);
  return { n, winRate: n ? safeDiv(wins, n) * 100 : null, avg: n ? net / n : null, net };
}

function renderPsychTradeAnalytics() {
  const el = document.getElementById('psychTradeAnalytics');
  if (!el) return;
  const closed = state.trades.filter(isTradeClosed);
  const hasData = closed.some(t => t.emotionBefore || t.confidence !== null || t.discipline !== null || BEHAVIOUR_FLAGS.some(f => t.flags[f.key]));
  if (!hasData) {
    el.innerHTML = emptyState('fa-brain', 'No trade psychology data yet', 'Record emotions, confidence and behaviour flags on your trades to see how they relate to results.',
      `<button class="btn btn-primary btn-sm" onclick="openTradeModal()"><i class="fa-solid fa-plus"></i> Add Trade</button>`);
    renderBarChart('psEmotion', 'psEmotion', [], [], null, 'Log emotions on trades to see this');
    renderBarChart('psConfidence', 'psConfidence', [], [], null, 'Log confidence on trades to see this');
    return;
  }

  const fmtWR = v => v === null ? '—' : fmtPct(v);
  const fmtAvg = v => v === null ? '—' : fmtMoney(v);
  const rows = BEHAVIOUR_FLAGS.map(f => {
    const a = listStats(closed.filter(t => t.flags[f.key]));
    const b = listStats(closed.filter(t => !t.flags[f.key]));
    return `<tr><td><b>${f.label}</b></td><td>${a.n}</td><td>${fmtWR(a.winRate)}</td><td class="${a.avg !== null && a.avg < 0 ? 'val-neg' : ''}">${fmtAvg(a.avg)}</td><td>${fmtWR(b.winRate)}</td><td>${fmtAvg(b.avg)}</td></tr>`;
  }).join('');

  const violations = closed.filter(t => t.flags.ruleViolation).length;
  const disciplineScore = closed.length ? (1 - violations / closed.length) * 100 : 0;
  const ratedDisc = closed.filter(t => t.discipline !== null);
  const avgDisc = ratedDisc.length ? safeDiv(ratedDisc.reduce((s, t) => s + t.discipline, 0), ratedDisc.length) : null;

  el.innerHTML = `
    <div class="perf-summary" style="margin-bottom:16px;">
      <div class="perf-cell"><div class="perf-cell-label">Rule-following trades</div><div class="perf-cell-value ${disciplineScore >= 80 ? 'pos' : 'neg'}">${fmtPct(disciplineScore)}</div></div>
      <div class="perf-cell"><div class="perf-cell-label">Rule violations</div><div class="perf-cell-value">${violations}</div></div>
      <div class="perf-cell"><div class="perf-cell-label">Avg discipline rating</div><div class="perf-cell-value">${avgDisc !== null ? fmtNum(avgDisc, 1) + '/10' : '—'}</div></div>
    </div>
    <div class="scroll-wrap">
      <table class="data-table">
        <thead><tr><th>Behaviour</th><th>Trades flagged</th><th>Win rate (flagged)</th><th>Avg P/L (flagged)</th><th>Win rate (not flagged)</th><th>Avg P/L (not flagged)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const emo = groupPerformance(closed.filter(t => t.emotionBefore), t => t.emotionBefore);
  renderBarChart('psEmotion', 'psEmotion', emo.map(g => `${g.name} (${g.count})`), emo.map(g => round2(g.pl)), emo.map(g => g.pl >= 0 ? '#35c98b' : '#ef6262'), 'Log “emotion before trade” to see this');

  const buckets = [['Low (1–3)', 1, 3], ['Medium (4–6)', 4, 6], ['High (7–10)', 7, 10]]
    .map(([label, lo, hi]) => ({ label, s: listStats(closed.filter(t => t.confidence !== null && t.confidence >= lo && t.confidence <= hi)) }))
    .filter(b => b.s.n);
  renderBarChart('psConfidence', 'psConfidence', buckets.map(b => `${b.label} · ${b.s.n}`), buckets.map(b => round1(b.s.winRate)), buckets.map(() => '#c47a44'), 'Log confidence on trades to see this');
}


/* ============================================================
   REPORTS
   ============================================================ */

const reportState = { period: 'all', from: '', to: '', scope: 'active' };

function reportRange() {
  const now = new Date();
  const today = toLocalDateStr(now);
  switch (reportState.period) {
    case 'month': return { from: today.slice(0, 8) + '01', to: today };
    case '30': { const d = new Date(now); d.setDate(d.getDate() - 29); return { from: toLocalDateStr(d), to: today }; }
    case '90': { const d = new Date(now); d.setDate(d.getDate() - 89); return { from: toLocalDateStr(d), to: today }; }
    case 'year': return { from: today.slice(0, 5) + '01-01', to: today };
    case 'custom': return { from: reportState.from, to: reportState.to };
    default: return { from: '', to: '' };
  }
}

function svgEquity(values) {
  if (values.length < 2) return '';
  const w = 720, h = 170, pad = 8;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(pad + i * (w - 2 * pad) / (values.length - 1)).toFixed(1)},${(h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)}`).join(' ');
  return `<svg class="report-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Equity curve"><polyline fill="none" stroke="#c47a44" stroke-width="2" points="${pts}"/></svg>`;
}

function buildReportModel() {
  const ctx = getScopedContext(reportState.scope);
  const { from, to } = reportRange();
  const inRange = t => (!from || t.date >= from) && (!to || t.date <= to);
  const trades = ctx.trades.filter(inRange);
  const priorPL = from ? ctx.trades.filter(t => isTradeClosed(t) && t.date < from).reduce((s, t) => s + t.pl, 0) : 0;
  const account = { id: ctx.account.id, name: ctx.account.name, initialBalance: ctx.account.initialBalance + priorPL, currentBalance: ctx.account.currentBalance };
  const m = computeMetrics(trades, account);
  const closed = m.closed;

  // Days that breached the daily loss limit (measured against running balance).
  const rules = Object.assign(defaultRiskRules(), state.settings.risk || {});
  const byDay = {};
  closed.forEach(t => { byDay[t.date] = (byDay[t.date] || 0) + t.pl; });
  let bal = account.initialBalance, breaches = 0;
  Object.keys(byDay).sort().forEach(d => {
    if (rules.dailyLossLimitPct > 0 && byDay[d] < 0 && -byDay[d] > bal * rules.dailyLossLimitPct / 100) breaches++;
    bal += byDay[d];
  });

  const months = {};
  closed.forEach(t => { const k = t.date.slice(0, 7); (months[k] = months[k] || []).push(t); });
  const monthly = Object.keys(months).sort().map(k => Object.assign({ month: k }, listStats(months[k])));

  const riskVals = closed.filter(t => t.riskPct > 0).map(t => t.riskPct);
  const flagsSummary = BEHAVIOUR_FLAGS.map(f => Object.assign({ key: f.key, label: f.label }, listStats(closed.filter(t => t.flags[f.key]))));
  const dailyPsych = state.psychology.filter(p => (!from || p.date >= from) && (!to || p.date <= to));

  return { ctx, from, to, trades, account, m, strategies: strategyStats(trades), pairs: groupPerformance(trades, t => t.pair), monthly, breaches, rules,
    avgRiskPct: riskVals.length ? safeDiv(riskVals.reduce((a, b) => a + b, 0), riskVals.length) : null,
    flagsSummary, dailyPsych, closed };
}

function renderReport() {
  const body = document.getElementById('reportBody');
  if (!body) return;
  document.getElementById('reportPeriod').value = reportState.period;
  document.getElementById('reportScope').value = reportState.scope;
  document.getElementById('reportFrom').value = reportState.from;
  document.getElementById('reportTo').value = reportState.to;
  const custom = reportState.period === 'custom';
  document.getElementById('reportFromWrap').style.display = custom ? '' : 'none';
  document.getElementById('reportToWrap').style.display = custom ? '' : 'none';

  const r = buildReportModel();
  const m = r.m;
  if (!r.trades.length) {
    body.innerHTML = `<div class="card">${emptyState('fa-file-lines', 'No trades in this report', 'Record trades or widen the period to generate a report.',
      `<button class="btn btn-primary btn-sm" onclick="openTradeModal()"><i class="fa-solid fa-plus"></i> Add Trade</button>`)}</div>`;
    return;
  }
  const periodLabel = (r.from || r.to) ? `${r.from ? fmtDate(r.from) : 'Start'} – ${r.to ? fmtDate(r.to) : 'Today'}` : 'All time';
  const kv = (label, value, cls) => `<div class="report-kv"><span>${label}</span><b class="${cls || ''}">${value}</b></div>`;
  const pn = v => (v > 0 ? 'val-pos' : v < 0 ? 'val-neg' : '');
  const retPct = r.account.initialBalance ? safeDiv(m.netProfit, r.account.initialBalance) * 100 : 0;

  const stratRows = r.strategies.map(s => `<tr><td>${escapeHtml(s.name)}</td><td>${s.trades}</td><td>${fmtPct(s.winRate)}</td><td class="${pn(s.net)}">${fmtMoney(s.net)}</td><td>${fmtPF(s.profitFactor)}</td><td>${s.avgR !== null ? fmtNum(s.avgR, 2) + 'R' : '—'}</td></tr>`).join('');
  const pairRows = r.pairs.slice(0, 10).map(g => `<tr><td>${escapeHtml(g.name)}</td><td>${g.count}</td><td>${fmtPct(safeDiv(g.wins, g.count) * 100)}</td><td class="${pn(g.pl)}">${fmtMoney(g.pl)}</td></tr>`).join('');
  const monthRows = r.monthly.map(x => `<tr><td>${x.month}</td><td>${x.n}</td><td>${fmtPct(x.winRate)}</td><td class="${pn(x.net)}">${fmtMoney(x.net)}</td></tr>`).join('');
  const flagRows = r.flagsSummary.map(f => `<tr><td>${f.label}</td><td>${f.n}</td><td>${f.winRate === null ? '—' : fmtPct(f.winRate)}</td><td>${f.avg === null ? '—' : fmtMoney(f.avg)}</td></tr>`).join('');
  const avgOf = k => r.dailyPsych.length ? fmtNum(safeDiv(r.dailyPsych.reduce((s, p) => s + p[k], 0), r.dailyPsych.length), 1) + '/10' : '—';

  body.innerHTML = `
    <div class="report-header card">
      <div>
        <div class="report-title">Copperstone Performance Report</div>
        <div class="report-meta">${escapeHtml(r.ctx.label)} &middot; ${periodLabel} &middot; Generated ${new Date().toLocaleString()}</div>
      </div>
    </div>

    <div class="card"><h3 class="report-h">Performance Summary</h3>
      <div class="report-grid">
        ${kv('Net profit', fmtMoney(m.netProfit), pn(m.netProfit))}
        ${kv('Return on period start balance', fmtPct(retPct), pn(retPct))}
        ${kv('Starting balance (period)', fmtMoney(r.account.initialBalance))}
        ${kv('Ending balance', fmtMoney(m.endBalance))}
        ${kv('Win rate', fmtPct(m.winRate))}
        ${kv('Profit factor', fmtPF(m.profitFactor))}
        ${kv('Expectancy / trade', fmtMoney(m.expectancy), pn(m.expectancy))}
        ${kv('Max drawdown', fmtPct(m.maxDrawdown) + ' (' + fmtMoney(m.maxDrawdownAmount) + ')', 'val-neg')}
      </div>
      ${svgEquity(m.equityCurve.map(p => p.value))}
    </div>

    <div class="card"><h3 class="report-h">Trade Statistics</h3>
      <div class="report-grid">
        ${kv('Total trades', m.totalTrades)}${kv('Closed / open', m.closedTrades + ' / ' + m.openTrades)}
        ${kv('Wins / losses / breakeven', m.winningTrades + ' / ' + m.losingTrades + ' / ' + m.breakevenTrades)}
        ${kv('Gross profit', fmtMoney(m.grossProfit), 'val-pos')}${kv('Gross loss', fmtMoney(m.grossLoss), 'val-neg')}
        ${kv('Average win', fmtMoney(m.avgWin), 'val-pos')}${kv('Average loss', fmtMoney(m.avgLoss), 'val-neg')}
        ${kv('Largest win', fmtMoney(m.largestWin), 'val-pos')}${kv('Largest loss', fmtMoney(m.largestLoss), 'val-neg')}
        ${kv('Average R (realised)', fmtNum(m.avgR, 2) + 'R')}${kv('Average planned R:R', m.avgPlannedRR ? '1 : ' + fmtNum(m.avgPlannedRR, 2) : '—')}
        ${kv('Best win streak', m.longestWinStreak)}${kv('Worst loss streak', m.longestLossStreak)}
        ${kv('Commission', fmtMoney(m.totalCommission))}${kv('Swap', fmtMoney(m.totalSwap), pn(m.totalSwap))}
      </div>
    </div>

    <div class="card"><h3 class="report-h">Strategy Performance</h3>
      <div class="scroll-wrap"><table class="data-table"><thead><tr><th>Strategy</th><th>Trades</th><th>Win rate</th><th>Net profit</th><th>Profit factor</th><th>Avg R</th></tr></thead><tbody>${stratRows || '<tr><td colspan="6">No closed trades</td></tr>'}</tbody></table></div>
    </div>

    <div class="card"><h3 class="report-h">Pair Performance (top 10)</h3>
      <div class="scroll-wrap"><table class="data-table"><thead><tr><th>Pair</th><th>Trades</th><th>Win rate</th><th>Net profit</th></tr></thead><tbody>${pairRows || '<tr><td colspan="4">No closed trades</td></tr>'}</tbody></table></div>
    </div>

    <div class="card"><h3 class="report-h">Risk Statistics</h3>
      <div class="report-grid">
        ${kv('Average risk per trade', r.avgRiskPct !== null ? fmtPct(r.avgRiskPct) : 'Not recorded')}
        ${kv('Largest single loss', fmtMoney(m.largestLoss), 'val-neg')}
        ${kv('Max consecutive losses', m.longestLossStreak)}
        ${kv('Max drawdown', fmtPct(m.maxDrawdown))}
        ${kv('Current drawdown', fmtPct(m.currentDrawdown))}
        ${kv('Days over daily loss limit (' + r.rules.dailyLossLimitPct + '%)', r.breaches, r.breaches ? 'val-neg' : '')}
      </div>
    </div>

    <div class="card"><h3 class="report-h">Psychology Summary</h3>
      <div class="report-grid">
        ${kv('Daily entries logged', r.dailyPsych.length)}
        ${kv('Avg confidence', avgOf('confidence'))}${kv('Avg discipline', avgOf('discipline'))}
        ${kv('Avg stress', avgOf('stress'))}${kv('Avg FOMO', avgOf('fomo'))}${kv('Avg revenge urge', avgOf('revenge'))}
      </div>
      <div class="scroll-wrap"><table class="data-table"><thead><tr><th>Behaviour flag</th><th>Trades</th><th>Win rate</th><th>Avg P/L</th></tr></thead><tbody>${flagRows}</tbody></table></div>
    </div>

    <div class="card"><h3 class="report-h">Monthly Performance</h3>
      <div class="scroll-wrap"><table class="data-table"><thead><tr><th>Month</th><th>Trades</th><th>Win rate</th><th>Net profit</th></tr></thead><tbody>${monthRows || '<tr><td colspan="4">No closed trades</td></tr>'}</tbody></table></div>
    </div>

    <p class="report-disclaimer">This report summarises trades you recorded in Copperstone. It is a record of past activity, not financial advice, and past performance does not guarantee future results. Figures depend on the accuracy of the data entered.</p>`;
}

function exportReportJSON() {
  const r = buildReportModel();
  const m = r.m;
  const slim = Object.assign({}, m); delete slim.equityCurve; delete slim.drawdownCurve; delete slim.closed;
  const out = {
    generatedAt: new Date().toISOString(), app: 'Copperstone Trade Journal', scope: r.ctx.label, from: r.from || null, to: r.to || null,
    metrics: slim, strategies: r.strategies, pairs: r.pairs, monthly: r.monthly, risk: { avgRiskPct: r.avgRiskPct, dailyLossLimitBreaches: r.breaches, rules: r.rules }, behaviourFlags: r.flagsSummary
  };
  downloadFile(JSON.stringify(out, (k, v) => (v === Infinity ? 'Infinity' : v), 2), 'copperstone-report.json', 'application/json');
  toast('Report exported as JSON', 'success');
}

function bindReportEvents() {
  const $ = (id) => document.getElementById(id);
  $('reportPeriod').addEventListener('change', e => { reportState.period = e.target.value; renderReport(); });
  $('reportFrom').addEventListener('change', e => { reportState.from = e.target.value; renderReport(); });
  $('reportTo').addEventListener('change', e => { reportState.to = e.target.value; renderReport(); });
  $('reportScope').addEventListener('change', e => { reportState.scope = e.target.value; renderReport(); });
  $('reportPrint').addEventListener('click', () => { renderReport(); window.print(); });
  $('reportJSON').addEventListener('click', exportReportJSON);
  $('reportCSV').addEventListener('click', () => exportCSV(buildReportModel().trades, 'copperstone-report-trades.csv'));
}


/* ============================================================
   ACCOUNTS
   ============================================================ */

function renderAccounts() {
  const grid = document.getElementById('accountsGrid');
  if (!state.accounts.length) {
    grid.innerHTML = `<div class="card" style="grid-column: 1 / -1;">${emptyState('fa-building-columns', 'No trading accounts yet', 'Add your first account to start journaling trades.',
      `<button class="btn btn-primary btn-sm" onclick="openAccountModal()">Add Account</button>`)}</div>`;
    return;
  }

  grid.innerHTML = state.accounts.map(a => {
    const isActive = a.id === state.settings.activeAccountId;
    const pl = round2(a.currentBalance - a.initialBalance);
    return `
      <div class="account-card ${isActive ? 'is-active' : ''}">
        <div class="account-card-top">
          <div>
            <h3 class="account-name">${escapeHtml(a.name)}</h3>
            <div class="account-broker">${escapeHtml(a.broker || 'No broker set')}</div>
          </div>
          <span class="account-type-tag">${escapeHtml(a.type)}</span>
        </div>
        <div class="account-balance">${fmtMoney(a.currentBalance)}</div>
        <div class="account-balance-sub ${pl >= 0 ? 'val-pos' : 'val-neg'}">${pl >= 0 ? '+' : ''}${fmtMoney(pl)} since opening</div>
        ${a.isDefault ? '<span class="default-badge">Default Account</span>' : ''}
        ${a.mt5Login ? '<span class="default-badge" style="color:var(--copper-light);background:var(--copper-dim);">MT5 Linked</span>' : ''}
        ${a.notes ? `<div class="goal-notes">${escapeHtml(a.notes)}</div>` : ''}
        <div class="account-card-actions">
          ${!isActive ? `<button class="btn btn-secondary btn-sm" onclick="setActiveAccount('${a.id}')">Switch To</button>` : '<span class="kpi-badge pos" style="align-self:center;">Active</span>'}
          <button class="btn btn-ghost btn-sm" onclick="openAccountModal('${a.id}')"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-danger btn-sm" onclick="requestDeleteAccount('${a.id}')"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
  }).join('');
}

function setActiveAccount(id) {
  state.settings.activeAccountId = id;
  saveData();
  refreshAccountSelectors();
  renderAccounts();
  toast('Active account switched', 'success');
}

function openAccountModal(id) {
  const form = document.getElementById('accountForm');
  form.reset();
  document.getElementById('accountId').value = '';
  if (id) {
    const a = state.accounts.find(x => x.id === id);
    if (!a) return;
    document.getElementById('accountModalTitle').textContent = 'Edit Account';
    document.getElementById('accountId').value = a.id;
    document.getElementById('afName').value = a.name;
    document.getElementById('afBroker').value = a.broker || '';
    document.getElementById('afType').value = a.type;
    document.getElementById('afCurrency').value = a.currency;
    document.getElementById('afInitialBalance').value = a.initialBalance;
    document.getElementById('afCurrentBalance').value = a.currentBalance;
    document.getElementById('afDefault').checked = !!a.isDefault;
    document.getElementById('afNotes').value = a.notes || '';
  } else {
    document.getElementById('accountModalTitle').textContent = 'Add Account';
    document.getElementById('afInitialBalance').value = 10000;
  }
  openModal('accountModal');
}

function handleAccountFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('accountId').value;
  const initialBalance = num(document.getElementById('afInitialBalance').value, 0);
  const currentBalanceRaw = document.getElementById('afCurrentBalance').value;

  const account = {
    id: id || uid(),
    name: document.getElementById('afName').value.trim(),
    broker: document.getElementById('afBroker').value.trim(),
    type: document.getElementById('afType').value,
    currency: document.getElementById('afCurrency').value,
    initialBalance,
    currentBalance: currentBalanceRaw !== '' ? num(currentBalanceRaw) : initialBalance,
    notes: document.getElementById('afNotes').value.trim(),
    isDefault: document.getElementById('afDefault').checked
  };

  if (!account.name) { toast('Please enter an account name.', 'error'); return; }

  if (account.isDefault) {
    state.accounts.forEach(a => { a.isDefault = false; });
  }

  if (id) {
    const idx = state.accounts.findIndex(a => a.id === id);
    if (idx > -1) state.accounts[idx] = Object.assign({}, state.accounts[idx], account); // keeps mt5Login etc.
    toast('Account updated', 'success');
  } else {
    state.accounts.push(account);
    if (!state.settings.activeAccountId) state.settings.activeAccountId = account.id;
    toast('Account added', 'success');
  }
  if (account.isDefault) state.settings.defaultAccountId = account.id;

  recalcAccountBalance(account.id);
  saveData();
  closeModal('accountModal');
  refreshAccountSelectors();
  renderAccounts();
}

function requestDeleteAccount(id) {
  const tradeCount = state.trades.filter(t => t.accountId === id).length;
  const msg = tradeCount
    ? `This account has ${tradeCount} associated trade(s), which will also be deleted. This cannot be undone.`
    : 'This account will be permanently deleted. This cannot be undone.';
  askConfirm('Delete Account', msg, () => {
    takeSnapshot('before deleting an account');
    if (state.mt5.linkedAccountId === id) state.mt5.linkedAccountId = null;
    state.trades = state.trades.filter(t => t.accountId !== id);
    state.accounts = state.accounts.filter(a => a.id !== id);
    if (state.settings.activeAccountId === id) {
      state.settings.activeAccountId = state.accounts[0] ? state.accounts[0].id : null;
    }
    saveData();
    toast('Account deleted', 'success');
    refreshAccountSelectors();
    renderAccounts();
  });
}

/* ============================================================
   MT5 INTEGRATION (READ-ONLY)

   The app only ever calls the user's own local bridge at
   MT5_BRIDGE_URL. It never asks for MT5 credentials and never
   attempts to open, close, or modify trades — it only reads
   account info, open positions, and historical deals, then
   turns completed positions into journal trades.
   ============================================================ */

async function mt5Fetch(path, params) {
  let url = MT5_BRIDGE_URL + path;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
    if (!res.ok) throw new Error('MT5 bridge responded with status ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function setMT5Status(status, message) {
  state.mt5.connected = (status === 'connected');
  saveData();
  renderMT5StatusUI(status, message);
  renderMT5MiniCard();
}

function renderMT5StatusUI(status, message) {
  const dot = document.getElementById('mt5StatusDot');
  const label = document.getElementById('mt5StatusLabel');
  const msgEl = document.getElementById('mt5StatusMessage');
  if (!dot || !label) return; // MT5 page not currently rendered

  const labels = { checking: 'Checking…', connected: 'Connected', disconnected: 'Disconnected', error: 'Connection Error' };
  dot.className = 'mt5-status-dot ' + status;
  label.textContent = labels[status] || 'Unknown';

  if (message) {
    msgEl.style.display = 'flex';
    msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(message)}</span>`;
  } else {
    msgEl.style.display = 'none';
  }

  const lastSyncEl = document.getElementById('mt5LastSync');
  if (lastSyncEl) {
    lastSyncEl.textContent = state.mt5.lastSync ? 'Last synced ' + new Date(state.mt5.lastSync).toLocaleString() : 'Never synced';
  }
}

function friendlyBridgeOfflineMessage() {
  return 'MT5 bridge is not running. Start the Copperstone MT5 bridge and try again.';
}

async function mt5TestConnection(silent) {
  if (!silent) renderMT5StatusUI('checking');
  try {
    const status = await mt5Fetch(MT5_ENDPOINTS.status);
    const ok = !!(status && (status.connected || status.status === 'connected' || status.ok));
    if (ok) {
      setMT5Status('connected');
      if (!silent) toast('MT5 connected successfully.', 'success');
    } else {
      setMT5Status('disconnected', 'The bridge is running but MetaTrader 5 is not connected yet.');
    }
    return ok;
  } catch (err) {
    console.warn('MT5 status check failed (bridge offline?):', err.message);
    setMT5Status('disconnected', friendlyBridgeOfflineMessage());
    return false;
  }
}

function mt5AccountField(account, ...keys) {
  for (const k of keys) {
    if (account && account[k] !== undefined && account[k] !== null) return account[k];
  }
  return null;
}

async function mt5RefreshAccount(silent = false) {
  try {
    const response = await mt5Fetch(MT5_ENDPOINTS.account);

    // The bridge returns:
    // { success: true, account: { ... } }
    // Extract the actual account object.
    const account = response?.account || response;

    if (!account || account.login === undefined) {
      throw new Error('MT5 account data was not returned correctly.');
    }

    state.mt5.account = account;
    state.mt5.connected = true;

    // Link/update the local Copperstone account.
    ensureMT5LinkedAccount(account);

    saveData();

    // Update the MT5 page.
    renderMT5AccountUI(account);
    renderMT5MiniCard();
    renderMT5StatusUI('connected');

    if (!silent) {
      toast('MT5 account refreshed successfully.', 'success');
    }

    return account;

  } catch (e) {
    console.error('MT5 account refresh failed:', e);

    setMT5Status(
      'disconnected',
      friendlyBridgeOfflineMessage()
    );

    if (!silent) {
      toast('Could not refresh MT5 account.', 'error');
    }

    return null;
  }
}
function renderMT5AccountUI(account) {
  const grid = document.getElementById('mt5AccountGrid');
  if (!grid) return;
  if (!account) {
    grid.innerHTML = emptyState('fa-plug-circle-xmark', 'No account data yet', 'Test the connection or refresh to load your MT5 account.');
    return;
  }
  const login = mt5AccountField(account, 'login', 'account_login', 'id');
  const name = mt5AccountField(account, 'name', 'account_name', 'owner');
  const server = mt5AccountField(account, 'server', 'broker', 'company');
  const currency = mt5AccountField(account, 'currency') || 'USD';
  const balance = num(mt5AccountField(account, 'balance'), null);
  const equity = num(mt5AccountField(account, 'equity'), null);
  const profit = num(mt5AccountField(account, 'profit', 'floating_profit'), null);
  const freeMargin = num(mt5AccountField(account, 'free_margin', 'margin_free'), null);
  const marginLevel = num(mt5AccountField(account, 'margin_level'), null);
  const leverage = mt5AccountField(account, 'leverage');

  const items = [
    ['Login', login ?? '—'],
    ['Name', name ?? '—'],
    ['Broker / Server', server ?? '—'],
    ['Currency', currency],
    ['Balance', balance !== null ? fmtMoney(balance) : '—'],
    ['Equity', equity !== null ? fmtMoney(equity) : '—'],
    ['Floating Profit', profit !== null ? fmtMoney(profit) : '—', profit !== null ? (profit >= 0 ? 'pos' : 'neg') : ''],
    ['Free Margin', freeMargin !== null ? fmtMoney(freeMargin) : '—'],
    ['Margin Level', marginLevel !== null ? fmtPct(marginLevel) : '—'],
    ['Leverage', leverage ? '1:' + leverage : '—']
  ];

  grid.innerHTML = items.map(([label, value, cls]) => `
    <div class="rc-item">
      <div class="rc-item-label">${label}</div>
      <div class="rc-item-value ${cls || ''}">${escapeHtml(String(value))}</div>
    </div>`).join('');
}

function renderMT5PositionsUI(positions) {
  const wrap = document.getElementById('mt5PositionsWrap');
  if (!wrap) return;
  if (!positions || !positions.length) {
    wrap.innerHTML = emptyState('fa-layer-group', 'No open MT5 positions', 'Open positions from your MetaTrader 5 terminal will appear here.');
    return;
  }
  const rows = positions.map(p => {
    const symbol = mt5AccountField(p, 'symbol') || '—';
    const type = mt5AccountField(p, 'type');
    const direction = (type === 0 || type === '0' || type === 'buy' || type === 'BUY') ? 'Buy' : 'Sell';
    const volume = num(mt5AccountField(p, 'volume', 'lots'), 0);
    const priceOpen = num(mt5AccountField(p, 'price_open', 'open_price'), null);
    const priceCurrent = num(mt5AccountField(p, 'price_current', 'current_price'), null);
    const profit = num(mt5AccountField(p, 'profit'), 0);
    const sl = mt5AccountField(p, 'sl');
    const tp = mt5AccountField(p, 'tp');
    return `
      <tr>
        <td>${escapeHtml(symbol)}</td>
        <td><span class="pill ${direction === 'Buy' ? 'pill-buy' : 'pill-sell'}">${direction}</span></td>
        <td>${fmtNum(volume, 2)}</td>
        <td>${priceOpen !== null ? fmtNum(priceOpen, 5) : '—'}</td>
        <td>${priceCurrent !== null ? fmtNum(priceCurrent, 5) : '—'}</td>
        <td>${sl ? fmtNum(num(sl), 5) : '—'}</td>
        <td>${tp ? fmtNum(num(tp), 5) : '—'}</td>
        <td class="${profit >= 0 ? 'val-pos' : 'val-neg'}">${fmtMoney(profit)}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Symbol</th><th>Dir</th><th>Volume</th><th>Open Price</th><th>Current</th><th>SL</th><th>TP</th><th>Floating P/L</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderMT5SyncResultUI(result) {
  const el = document.getElementById('mt5SyncResult');
  if (!el) return;
  if (!result) {
    el.innerHTML = emptyState('fa-arrows-rotate', 'No sync yet', 'Click "Sync Now" to import trades from your MT5 history.');
    return;
  }
  const items = [
    ['Imported', result.imported, 'pos'],
    ['Updated', result.updated, ''],
    ['Skipped', result.skipped, ''],
    ['Errors', result.errors, result.errors > 0 ? 'neg' : ''],
    ['MT5 trades in journal', state.trades.filter(t => tradeSource(t) === 'MT5').length, '']
  ];
  el.innerHTML = items.map(([label, value, cls]) => `
    <div class="rc-item">
      <div class="rc-item-label">${label}</div>
      <div class="rc-item-value ${cls}">${value}</div>
    </div>`).join('');
}

function renderMT5MiniCard() {
  const dot = document.getElementById('mt5MiniDot');
  if (!dot) return;
  const connected = state.mt5 && state.mt5.connected;
  dot.className = 'mt5-status-dot ' + (connected ? 'connected' : 'disconnected');
  document.getElementById('mt5MiniTitle').textContent = connected ? 'MT5 bridge connected' : 'MT5 bridge not connected';
  const sub = document.getElementById('mt5MiniSub');
  sub.textContent = state.mt5.lastSync
    ? 'Last synced ' + new Date(state.mt5.lastSync).toLocaleString()
    : 'Connect your MetaTrader 5 bridge to sync trades automatically.';

  const figuresEl = document.getElementById('mt5MiniFigures');
  const account = state.mt5.account;
  if (connected && account) {
    const balance = num(mt5AccountField(account, 'balance'), null);
    const equity = num(mt5AccountField(account, 'equity'), null);
    figuresEl.style.display = 'flex';
    figuresEl.innerHTML = `
      ${balance !== null ? `<span>Balance <b>${fmtMoney(balance)}</b></span>` : ''}
      ${equity !== null ? `<span>Equity <b>${fmtMoney(equity)}</b></span>` : ''}`;
  } else {
    figuresEl.style.display = 'none';
  }
}

function renderMT5Page() {
  renderMT5StatusUI(state.mt5.connected ? 'connected' : 'disconnected');
  renderMT5AccountUI(state.mt5.account);
  renderMT5PositionsUI(state.mt5.openPositions);
  renderMT5SyncResultUI(state.mt5.lastSyncResult);
  const sel = document.getElementById('mt5AutoRefresh');
  if (sel) sel.value = String(state.mt5.autoRefreshSeconds || 0);
}

/* --- Ensure a local account exists to hold trades imported from MT5 --- */
function ensureMT5LinkedAccount(account) {
  const login = mt5AccountField(account, 'login', 'account_login', 'id');
  const balance = num(mt5AccountField(account, 'balance'), 0);
  const currency = mt5AccountField(account, 'currency') || 'USD';
  const server = mt5AccountField(account, 'server', 'broker', 'company') || 'MT5 Broker';
  const name = mt5AccountField(account, 'name') || ('MT5 Account' + (login ? ' ' + login : ''));

  let linked = state.accounts.find(a => a.id === state.mt5.linkedAccountId) ||
    state.accounts.find(a => a.mt5Login && String(a.mt5Login) === String(login));

  if (!linked) {
    linked = {
      id: uid(),
      name,
      broker: server,
      type: 'Live',
      currency,
      initialBalance: balance,
      currentBalance: balance,
      notes: 'Auto-created for MT5 sync. Trades imported from MetaTrader 5 are attached to this account.',
      isDefault: false,
      mt5Login: login
    };
    state.accounts.push(linked);
    if (!state.settings.activeAccountId) state.settings.activeAccountId = linked.id;
  }
  state.mt5.linkedAccountId = linked.id;
  return linked;
}

/* --- Normalize a raw deal object from the bridge into a consistent shape --- */
function mt5ParseTime(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    // Treat values above ~1e12 as milliseconds, otherwise seconds.
    const ms = v > 2e10 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function mt5NormalizeDeal(d) {
  const time = mt5ParseTime(d.time ?? d.time_msc ?? d.datetime);
  return {
    ticket: d.ticket ?? d.deal ?? d.id ?? null,
    time,
    symbol: d.symbol || '',
    type: d.type,
    entry: d.entry,
    positionId: d.position_id ?? d.positionId ?? d.position ?? null,
    volume: num(d.volume ?? d.lots, 0),
    price: num(d.price, 0),
    commission: num(d.commission, 0),
    swap: num(d.swap, 0),
    profit: num(d.profit, 0),
    fee: num(d.fee, 0),
    sl: (d.sl !== undefined && d.sl !== null && d.sl !== 0) ? num(d.sl) : null,
    tp: (d.tp !== undefined && d.tp !== null && d.tp !== 0) ? num(d.tp) : null
  };
}

/* --- Group deals by position and turn completed positions into trades --- */
function mt5ProcessHistoryDeals(deals, accountId) {
  const result = { imported: 0, updated: 0, skipped: 0, errors: 0 };
  const groups = {};

  deals.forEach(raw => {
    const d = mt5NormalizeDeal(raw);
    // Only real buy/sell trade deals are relevant; ignore balance/credit/etc.
    if (d.type !== 0 && d.type !== 1) return;
    if (d.positionId === null || !d.symbol) return;
    if (!groups[d.positionId]) groups[d.positionId] = [];
    groups[d.positionId].push(d);
  });

  Object.entries(groups).forEach(([positionId, deals]) => {
    try {
      const entryDeals = deals.filter(d => d.entry === 0);
      const exitDeals = deals.filter(d => d.entry === 1 || d.entry === 3);

      if (!entryDeals.length) { result.errors++; return; }

      const entryVolume = entryDeals.reduce((s, d) => s + d.volume, 0);
      const exitVolume = exitDeals.reduce((s, d) => s + d.volume, 0);

      // Position still open (not fully closed) — do not import as a
      // completed trade. It will show under "Open MT5 Positions" instead.
      if (!exitDeals.length || exitVolume < entryVolume - 0.0001) return;

      const weightedPrice = (list) => {
        const vol = list.reduce((s, d) => s + d.volume, 0);
        if (!vol) return null;
        return safeDiv(list.reduce((s, d) => s + d.price * d.volume, 0), vol);
      };

      const entryPrice = weightedPrice(entryDeals);
      const exitPrice = weightedPrice(exitDeals);
      const symbol = entryDeals[0].symbol.toUpperCase();
      const direction = entryDeals[0].type === 0 ? 'Buy' : 'Sell';

      if (entryPrice === null || exitPrice === null) { result.errors++; return; }

      const openTime = entryDeals.reduce((min, d) => (d.time && (!min || d.time < min)) ? d.time : min, null);
      const closeTime = exitDeals.reduce((max, d) => (d.time && (!max || d.time > max)) ? d.time : max, null);

      const netProfit = round2(deals.reduce((s, d) => s + d.profit + d.commission + d.swap + d.fee, 0));
      const grossProfitMT5 = round2(deals.reduce((s, d) => s + d.profit, 0));
      const commissionCost = round2(-deals.reduce((s, d) => s + d.commission + d.fee, 0)); // cost shown as a positive number
      const swapTotal = round2(deals.reduce((s, d) => s + d.swap, 0));
      const pipSize = getPipSize(symbol);
      const pips = calcPipsFromPrices(entryPrice, exitPrice, direction, pipSize);
      const sl = entryDeals.find(d => d.sl !== null)?.sl ?? null;
      const tp = entryDeals.find(d => d.tp !== null)?.tp ?? null;
      const entryTicket = entryDeals[0].ticket;
      const exitTicket = exitDeals[exitDeals.length - 1].ticket;

      const dateStr = toLocalDateStr(closeTime || openTime || new Date());
      const openTimeStr = openTime ? openTime.toTimeString().slice(0, 5) : '';
      const closeTimeStr = closeTime ? closeTime.toTimeString().slice(0, 5) : '';

      const computed = {
        accountId,
        pair: symbol,
        direction,
        entry: round5(entryPrice),
        sl: sl !== null ? round5(sl) : null,
        tp: tp !== null ? round5(tp) : null,
        exit: round5(exitPrice),
        positionSize: round2(entryVolume),
        pl: netProfit,
        grossPL: grossProfitMT5,
        commission: commissionCost,
        swap: swapTotal,
        pips,
        date: dateStr,
        openTime: openTimeStr,
        closeTime: closeTimeStr,
        source: 'MT5',
        mt5PositionId: String(positionId),
        mt5EntryTicket: entryTicket,
        mt5ExitTicket: exitTicket
      };

      const existing = state.trades.find(t => t.mt5PositionId === String(positionId));

      if (!existing) {
        state.trades.push(normalizeTrade(Object.assign({
          id: uid(),
          tradeNumber: nextTradeNumber(),
          riskPct: 0,
          riskAmount: null,
          pipValuePerLot: null,
          rMultiple: null,
          strategy: '', session: '', setupQuality: '', marketCondition: '',
          tags: [], mistakes: '', lessons: '', notes: 'Imported from MT5.',
          shotBefore: null, shotAfter: null
        }, computed)));
        result.imported++;
      } else {
        const changed = existing.exit !== computed.exit || existing.pl !== computed.pl ||
          existing.closeTime !== computed.closeTime || existing.entry !== computed.entry ||
          existing.positionSize !== computed.positionSize;
        // Preserve user-editable annotation fields; only refresh the
        // fields that come from the MT5 bridge itself.
        Object.assign(existing, computed);
        if (changed) result.updated++; else result.skipped++;
      }
    } catch (err) {
      console.error('Failed to process MT5 position', positionId, err);
      result.errors++;
    }
  });

  return result;
}

async function mt5SyncNow() {
  if (mt5IsSyncing) return;
  mt5IsSyncing = true;
  const syncBtn = document.getElementById('mt5SyncBtn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.classList.add('btn-loading'); }

  try {
    const ok = await mt5TestConnection(true);
    if (!ok) {
      toast(friendlyBridgeOfflineMessage(), 'error');
      renderMT5Page();
      return;
    }

    const account = await mt5RefreshAccount(true);
    if (!account) {
      toast(friendlyBridgeOfflineMessage(), 'error');
      return;
    }
    const linkedAccount = ensureMT5LinkedAccount(account);

    let positions = [];
    try { positions = await mt5Fetch(MT5_ENDPOINTS.positions); } catch (err) { console.error('MT5 positions fetch failed:', err); }
    state.mt5.openPositions = Array.isArray(positions) ? positions : (positions?.positions || []);

    let history = [];
    try { history = await mt5Fetch(MT5_ENDPOINTS.history, { days: 90 }); } catch (err) { console.error('MT5 history fetch failed:', err); }
    const deals = Array.isArray(history) ? history : (history?.deals || history?.history || []);

    const result = mt5ProcessHistoryDeals(deals, linkedAccount.id);

    // Use the bridge's authoritative balance for the linked account, while
    // keeping the equity-curve math consistent with locally tracked trades.
    const closedPL = state.trades.filter(t => t.accountId === linkedAccount.id && isTradeClosed(t)).reduce((s, t) => s + t.pl, 0);
    const liveBalance = num(mt5AccountField(account, 'balance'), linkedAccount.currentBalance);
    linkedAccount.currentBalance = round2(liveBalance);
    linkedAccount.initialBalance = round2(liveBalance - closedPL);

    state.mt5.lastSync = new Date().toISOString();
    state.mt5.lastSyncResult = result;
    saveData();

    renderMT5Page();
    renderMT5MiniCard();
    refreshAccountSelectors();
    updateGoalsFromTrades();
    renderPage(currentPageName());

    toast(`MT5 sync complete — Imported: ${result.imported}, Updated: ${result.updated}, Skipped: ${result.skipped}, Errors: ${result.errors}`, result.errors ? 'error' : 'success');
  } catch (err) {
    console.error('MT5 sync failed:', err);
    setMT5Status('error', friendlyBridgeOfflineMessage());
    toast('MT5 synchronization could not be completed.', 'error');
  } finally {
    mt5IsSyncing = false;
    if (syncBtn) { syncBtn.disabled = false; syncBtn.classList.remove('btn-loading'); }
  }
}

function mt5SetAutoRefresh(seconds) {
  state.mt5.autoRefreshSeconds = seconds;
  saveData();
  if (mt5AutoRefreshTimer) { clearInterval(mt5AutoRefreshTimer); mt5AutoRefreshTimer = null; }
  if (seconds > 0) {
    mt5AutoRefreshTimer = setInterval(() => { mt5RefreshAccount(true); }, seconds * 1000);
  }
}

function restartMT5Timer() {
  if (mt5AutoRefreshTimer) { clearInterval(mt5AutoRefreshTimer); mt5AutoRefreshTimer = null; }
  if (state.mt5 && state.mt5.autoRefreshSeconds > 0) {
    mt5AutoRefreshTimer = setInterval(() => { mt5RefreshAccount(true); }, state.mt5.autoRefreshSeconds * 1000);
  }
}

function bindMT5Events() {
  const testBtn = document.getElementById('mt5TestBtn');
  const refreshBtn = document.getElementById('mt5RefreshBtn');
  const syncBtn = document.getElementById('mt5SyncBtn');
  const autoSel = document.getElementById('mt5AutoRefresh');
  if (testBtn) testBtn.addEventListener('click', () => mt5TestConnection(false));
  if (refreshBtn) refreshBtn.addEventListener('click', () => mt5RefreshAccount(false));
  if (syncBtn) syncBtn.addEventListener('click', () => mt5SyncNow());
  if (autoSel) autoSel.addEventListener('change', (e) => mt5SetAutoRefresh(num(e.target.value, 0)));

  if (state.mt5 && state.mt5.autoRefreshSeconds) mt5SetAutoRefresh(state.mt5.autoRefreshSeconds);
}

/* ============================================================
   SETTINGS
   ============================================================ */

function renderSettings() {
  document.getElementById('setCurrency').value = state.settings.currency;
  document.getElementById('setDefaultRisk').value = state.settings.defaultRiskPct;
  document.getElementById('setDateFormat').value = state.settings.dateFormat;
  document.getElementById('setTheme').value = state.settings.theme;
  document.getElementById('setCompactMode').checked = !!state.settings.compactMode;
  document.getElementById('setNotifications').checked = !!state.settings.notificationsEnabled;
  refreshAccountSelectors();
  if (state.settings.defaultAccountId) document.getElementById('setDefaultAccount').value = state.settings.defaultAccountId;
  renderProfileCard();
  renderSnapshots();
  renderAbout();
}

function applyAppearance() {
  document.body.setAttribute('data-theme', state.settings.theme);
  document.body.classList.toggle('compact', !!state.settings.compactMode);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.settings.theme === 'light' ? '#f3efe9' : '#0b0d10');
  const tg = document.getElementById('themeToggle');
  if (tg) {
    tg.innerHTML = `<i class="fa-solid ${state.settings.theme === 'light' ? 'fa-moon' : 'fa-sun'}"></i>`;
    tg.setAttribute('aria-label', state.settings.theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  }
}

function renderAbout() {
  const el = document.getElementById('aboutBody');
  if (!el) return;
  const item = (label, value) => `<div class="about-item"><span>${label}</span><b>${value}</b></div>`;
  el.innerHTML =
    item('Version', APP_VERSION) +
    item('Storage', 'This browser (localStorage)') +
    item('Account system', 'Local profile (this device only)') +
    item('MT5 bridge URL', escapeHtml(MT5_BRIDGE_URL)) +
    `<div class="about-note"><b>Not available in this local edition (needs a backend / external service):</b>
      cloud database &amp; cross-device sync, real multi-user authentication with data isolation, subscription plans &amp; payments,
      admin dashboard, server-side backups, scheduled broker sync without a local bridge, and any AI analysis or live market prices.
      Nothing in the interface simulates these.</div>`;
}

function bindSettingsEvents() {
  document.getElementById('setCurrency').addEventListener('change', e => { state.settings.currency = e.target.value; saveData(); renderPage(currentPageName()); refreshAccountSelectors(); });
  document.getElementById('setDefaultRisk').addEventListener('change', e => { state.settings.defaultRiskPct = num(e.target.value, 1); saveData(); });
  document.getElementById('setDefaultAccount').addEventListener('change', e => {
    state.settings.defaultAccountId = e.target.value;
    state.accounts.forEach(a => a.isDefault = (a.id === e.target.value));
    saveData();
    renderAccounts();
  });
  document.getElementById('setDateFormat').addEventListener('change', e => { state.settings.dateFormat = e.target.value; saveData(); renderPage(currentPageName()); });
  document.getElementById('setTheme').addEventListener('change', e => { state.settings.theme = e.target.value; saveData(); applyAppearance(); });
  document.getElementById('setCompactMode').addEventListener('change', e => { state.settings.compactMode = e.target.checked; saveData(); applyAppearance(); });
  document.getElementById('setNotifications').addEventListener('change', e => { state.settings.notificationsEnabled = e.target.checked; saveData(); });

  document.getElementById('setExportCSV').addEventListener('click', () => exportCSV());
  document.getElementById('setExportJSON').addEventListener('click', exportBackup);
  document.getElementById('setImportJSON').addEventListener('change', importBackup);
  document.getElementById('setResetData').addEventListener('click', () => {
    askConfirm('Reset to Demo Data', 'This replaces ALL your accounts, trades, goals and psychology entries with sample demo data. A safety snapshot and a backup file are created first, but you should export a backup yourself if unsure.', () => {
      preserveBeforeDestructive('before reset to demo');
      LocalStorageAdapter.remove(STORAGE_KEY);
      loadData();
      afterStateReplaced();
      toast('Demo data loaded', 'success');
    });
  });
  document.getElementById('setStartFresh').addEventListener('click', () => {
    askConfirm('Start Fresh', 'This deletes ALL accounts, trades, goals and psychology entries and leaves you with an empty journal. A safety snapshot and a backup file are created first.', () => startFresh());
  });
  document.getElementById('demoClearBtn').addEventListener('click', () => {
    askConfirm('Clear Demo Data', 'Remove the sample account, trades, goal and entry so you can start your own journal?', () => startFresh());
  });
  document.getElementById('snapshotList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-restore]');
    if (btn) requestRestoreSnapshot(btn.dataset.restore);
  });
}

function afterStateReplaced() {
  applyAppearance();
  refreshAccountSelectors();
  restartMT5Timer();
  updateGoalsFromTrades();
  renderPage(currentPageName());
  updateUserChip();
}

function startFresh() {
  preserveBeforeDestructive('before start fresh');
  state = blankState();
  saveData();
  afterStateReplaced();
  toast('Empty journal ready — add your first account.', 'success');
  openAccountModal();
}

/* ============================================================
   SNAPSHOTS (automatic local safety copies)
   ============================================================ */

function getSnapshots() {
  try { const l = JSON.parse(LocalStorageAdapter.read(SNAPSHOT_KEY) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}

function takeSnapshot(label) {
  try {
    const slim = JSON.parse(JSON.stringify(state));
    slim.trades.forEach(t => { t.shotBefore = null; t.shotAfter = null; });
    const list = getSnapshots();
    list.unshift({ id: safeId(uid()), label, at: new Date().toISOString(), trades: slim.trades.length, data: slim });
    LocalStorageAdapter.write(SNAPSHOT_KEY, JSON.stringify(list.slice(0, 3)));
    return true;
  } catch (e) {
    console.warn('Could not store a local snapshot (storage may be full).', e);
    return false;
  }
}

/* Before anything destructive: local snapshot + a downloadable file copy
   (skipped when there is nothing of the user's to lose). */
function preserveBeforeDestructive(label) {
  if (state.settings.isDemo || (!state.trades.length && !state.accounts.length && !state.goals.length && !state.psychology.length)) return;
  takeSnapshot(label);
  try { downloadFile(JSON.stringify(state, null, 2), `copperstone-safety-backup-${nowDateStr()}.json`, 'application/json'); } catch (e) { console.warn(e); }
}

function renderSnapshots() {
  const el = document.getElementById('snapshotList');
  if (!el) return;
  const list = getSnapshots();
  if (!list.length) {
    el.innerHTML = emptyState('fa-clock-rotate-left', 'No snapshots yet', 'One is created automatically before imports that replace data, resets and clearing the journal.');
    return;
  }
  el.innerHTML = list.map(s => `
    <div class="snapshot-row">
      <div><b>${escapeHtml(s.label)}</b><div class="hint-text" style="margin:0;">${escapeHtml(new Date(s.at).toLocaleString())} &middot; ${Number(s.trades) || 0} trades</div></div>
      <button class="btn btn-secondary btn-sm" data-restore="${escapeHtml(s.id)}">Restore</button>
    </div>`).join('');
}

function requestRestoreSnapshot(id) {
  const snap = getSnapshots().find(s => s.id === id);
  if (!snap) { toast('That snapshot no longer exists.', 'error'); return; }
  askConfirm('Restore Snapshot', 'Restore this snapshot? Your current data is snapshotted first. Screenshots are not included in snapshots.', () => {
    takeSnapshot('before restoring a snapshot');
    state = normalizeState(snap.data);
    saveData();
    afterStateReplaced();
    toast('Snapshot restored', 'success');
  });
}

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  let str = String(val);
  // Neutralise spreadsheet formula injection for free-text cells.
  if (typeof val === 'string' && /^[=+\-@\t\r]/.test(str)) str = "'" + str;
  if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function exportCSV(trades, filename) {
  const list = Array.isArray(trades) ? trades : state.trades;
  const headers = ['Date', 'Account', 'Pair', 'Direction', 'Entry', 'Exit', 'Stop Loss', 'Take Profit', 'Risk %', 'Risk Amount', 'Position Size', 'P/L', 'R', 'Pips', 'Strategy', 'Session', 'Setup Quality', 'Market Condition', 'Source', 'Notes',
    'Trade ID', 'Open Time', 'Close Time', 'Timeframe', 'Gross P/L', 'Commission', 'Swap', 'Spread', 'Trade Setup', 'Trade Reason', 'Entry Reason', 'Exit Reason', 'Emotion Before', 'Emotion During', 'Emotion After', 'Confidence', 'Discipline', 'Patience', 'Flags', 'Mistakes', 'Lessons', 'Tags'];
  const rows = list.map(t => {
    const account = getAccountById(t.accountId);
    return [
      t.date, account ? account.name : '', t.pair, t.direction, t.entry, t.exit ?? '', t.sl ?? '', t.tp ?? '',
      t.riskPct, t.riskAmount, t.positionSize ?? '', t.pl ?? '', t.rMultiple ?? '', t.pips ?? '',
      t.strategy, t.session, t.setupQuality, t.marketCondition, tradeSource(t), t.notes,
      fmtTradeNumber(t.tradeNumber), t.openTime, t.closeTime, t.timeframe, t.grossPL ?? '', t.commission, t.swap, t.spread ?? '', t.tradeSetup, t.tradeReason, t.entryReason, t.exitReason,
      t.emotionBefore, t.emotionDuring, t.emotionAfter, t.confidence ?? '', t.discipline ?? '', t.patience ?? '',
      BEHAVIOUR_FLAGS.filter(f => t.flags[f.key]).map(f => f.label).join('; '), t.mistakes, t.lessons, t.tags.join('; ')
    ].map(csvEscape).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\r\n');
  downloadFile('\uFEFF' + csv, filename || 'copperstone-trades.csv', 'text/csv;charset=utf-8');
  toast(`${list.length} trade${list.length === 1 ? '' : 's'} exported as CSV`, 'success');
}

function exportBackup() {
  const out = JSON.parse(JSON.stringify(state));
  out.meta = Object.assign({}, out.meta, { app: 'Copperstone Trade Journal', appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString() });
  downloadFile(JSON.stringify(out, null, 2), `copperstone-backup-${nowDateStr()}.json`, 'application/json');
  toast('Full backup exported', 'success');
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const input = e.target;
  if (file.size > 30 * 1024 * 1024) { toast('That file is too large to be a Copperstone backup.', 'error'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!isPlainObject(parsed) || (!Array.isArray(parsed.trades) && !Array.isArray(parsed.accounts))) throw new Error('Missing trades/accounts');
      const report = {};
      const incoming = normalizeState(parsed, report);
      pendingImport = { incoming, dropped: report.dropped || 0 };
      const isDemo = !!state.settings.isDemo;
      document.getElementById('importSummary').innerHTML =
        `This backup contains <b>${incoming.trades.length}</b> trades, <b>${incoming.accounts.length}</b> accounts, <b>${incoming.goals.length}</b> goals and <b>${incoming.psychology.length}</b> psychology entries.` +
        (report.dropped ? ` <span class="val-neg">${report.dropped} unreadable trade record(s) will be skipped.</span>` : '') +
        (isDemo ? ' Your journal currently holds demo data, so importing will replace it.' : '');
      document.getElementById('importMergeBtn').style.display = isDemo ? 'none' : '';
      openModal('importModal');
    } catch (err) {
      console.warn('Backup import rejected:', err.message);
      toast('Import failed — the file is not a valid Copperstone backup.', 'error');
    } finally {
      input.value = '';
    }
  };
  reader.onerror = () => { toast('Could not read the selected file.', 'error'); input.value = ''; };
  reader.readAsText(file);
}

function mergeIncoming(incoming) {
  const res = { trades: 0, accounts: 0, goals: 0, psychology: 0, skipped: 0 };
  const acctMap = {};
  incoming.accounts.forEach(a => {
    const existing = state.accounts.find(x => x.id === a.id) ||
      (a.mt5Login && state.accounts.find(x => x.mt5Login && String(x.mt5Login) === String(a.mt5Login)));
    if (existing) { acctMap[a.id] = existing.id; } else { state.accounts.push(a); acctMap[a.id] = a.id; res.accounts++; }
  });
  incoming.trades.forEach(t => {
    const dup = state.trades.some(x => x.id === t.id || (t.mt5PositionId && x.mt5PositionId === t.mt5PositionId));
    if (dup || !acctMap[t.accountId]) { res.skipped++; return; }
    t.accountId = acctMap[t.accountId];
    t.tradeNumber = nextTradeNumber();
    state.trades.push(t);
    res.trades++;
  });
  incoming.goals.forEach(g => { if (!state.goals.some(x => x.id === g.id)) { state.goals.push(g); res.goals++; } });
  incoming.psychology.forEach(p => { if (!state.psychology.some(x => x.id === p.id)) { state.psychology.push(p); res.psychology++; } });
  if (!state.settings.activeAccountId && state.accounts.length) state.settings.activeAccountId = state.accounts[0].id;
  return res;
}

function applyImport(mode) {
  if (!pendingImport) return;
  const { incoming } = pendingImport;
  pendingImport = null;
  closeModal('importModal');
  try {
    if (mode === 'merge' && !state.settings.isDemo) {
      takeSnapshot('before merge import');
      const res = mergeIncoming(incoming);
      recalcAllAccountBalances();
      saveData();
      afterStateReplaced();
      toast(`Merged: ${res.trades} trades, ${res.accounts} accounts added; ${res.skipped} duplicates skipped.`, 'success');
    } else {
      preserveBeforeDestructive('before import (replace)');
      state = incoming;
      state.settings.isDemo = false;
      recalcAllAccountBalances();
      saveData();
      afterStateReplaced();
      toast('Backup imported successfully', 'success');
    }
  } catch (err) {
    console.error(err);
    toast('Import failed part-way. Your previous data is available under Local Snapshots.', 'error');
  }
}


/* ============================================================
   PAGE STATE HELPER
   ============================================================ */

function currentPageName() {
  const active = document.querySelector('.page.active');
  return active ? active.id.replace('page-', '') : 'dashboard';
}

/* ============================================================
   EVENT BINDING
   ============================================================ */

function bindNavEvents() {
  document.querySelectorAll('.nav-item, .mnb-item').forEach(btn => {
    btn.addEventListener('click', () => setPage(btn.dataset.page));
  });
  document.querySelectorAll('[data-page-link]').forEach(btn => {
    btn.addEventListener('click', () => setPage(btn.dataset.pageLink));
  });
  document.getElementById('mobileMenuBtn').addEventListener('click', openMobileNav);
  document.getElementById('mobileNavOverlay').addEventListener('click', closeMobileNav);
  document.getElementById('mobileAddTradeBtn').addEventListener('click', () => openTradeModal());
}

function bindModalEvents() {
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeAllModals();
  });
  document.getElementById('confirmModalConfirmBtn').addEventListener('click', () => {
    if (typeof pendingConfirmAction === 'function') pendingConfirmAction();
    pendingConfirmAction = null;
    closeModal('confirmModal');
  });
}

function bindQuickActions() {
  ['qaAddTrade', 'qaAddTrade2', 'openAddTradeBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => openTradeModal());
  });
  const risk = document.getElementById('qaRisk');
  if (risk) risk.addEventListener('click', () => setPage('risk'));
  const goal = document.getElementById('qaGoal');
  if (goal) goal.addEventListener('click', () => openGoalModal());
  const acc = document.getElementById('qaAccount');
  if (acc) acc.addEventListener('click', () => openAccountModal());
  ['qaExport', 'qaExport2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', exportBackup);
  });
  const openGoal = document.getElementById('openAddGoalBtn');
  if (openGoal) openGoal.addEventListener('click', () => openGoalModal());
  const openPsych = document.getElementById('openAddPsychBtn');
  if (openPsych) openPsych.addEventListener('click', () => {
    document.getElementById('psychForm').reset();
    document.getElementById('pfDate').value = nowDateStr();
    ['Confidence', 'Discipline', 'Fear', 'Greed', 'Fomo', 'Revenge', 'Stress'].forEach(f => {
      document.getElementById('pf' + f).value = 5;
      document.getElementById('pf' + f + 'Val').textContent = '5';
    });
    openModal('psychModal');
  });
  const openAcc = document.getElementById('openAddAccountBtn');
  if (openAcc) openAcc.addEventListener('click', () => openAccountModal());
}

function bindFormEvents() {
  document.getElementById('tradeForm').addEventListener('submit', handleTradeFormSubmit);
  ['tfAccount', 'tfPair', 'tfDirection', 'tfEntry', 'tfSL', 'tfTP', 'tfExit', 'tfRiskPct', 'tfPipValue', 'tfPositionSize', 'tfPL', 'tfCommission', 'tfSwap'].forEach(id => {
    document.getElementById(id).addEventListener('input', recalcTradeForm);
    document.getElementById(id).addEventListener('change', recalcTradeForm);
  });
  document.getElementById('tradeForm').addEventListener('input', e => e.target.classList.remove('input-error'));

  document.getElementById('tfShotBefore').addEventListener('change', (e) => handleShotUpload(e, 'before'));
  document.getElementById('tfShotAfter').addEventListener('change', (e) => handleShotUpload(e, 'after'));

  document.getElementById('tradeDetailEditBtn').addEventListener('click', () => {
    closeModal('tradeDetailModal');
    if (currentDetailTradeId) openTradeModal(currentDetailTradeId);
  });
  document.getElementById('tradeDetailDeleteBtn').addEventListener('click', () => {
    if (currentDetailTradeId) requestDeleteTrade(currentDetailTradeId);
  });

  document.getElementById('goalForm').addEventListener('submit', handleGoalFormSubmit);
  document.getElementById('psychForm').addEventListener('submit', handlePsychFormSubmit);
  document.getElementById('accountForm').addEventListener('submit', handleAccountFormSubmit);
  document.getElementById('importMergeBtn').addEventListener('click', () => applyImport('merge'));
  document.getElementById('importReplaceBtn').addEventListener('click', () => applyImport('replace'));

  ['Confidence', 'Discipline', 'Fear', 'Greed', 'Fomo', 'Revenge', 'Stress'].forEach(f => {
    document.getElementById('pf' + f).addEventListener('input', (e) => {
      document.getElementById('pf' + f + 'Val').textContent = e.target.value;
    });
  });
}

/* Screenshots are downscaled and re-encoded so they cannot exhaust the
   ~5 MB localStorage quota on their own. */
function handleShotUpload(e, which) {
  const input = e.target;
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please upload an image file.', 'error'); input.value = ''; return; }
  if (file.size > 10 * 1024 * 1024) { toast('That image is larger than 10 MB.', 'error'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1100 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.72);
      editingShots[which] = data;
      const preview = document.getElementById(which === 'before' ? 'tfShotBeforePreview' : 'tfShotAfterPreview');
      preview.src = data;
      preview.style.display = 'block';
    };
    img.onerror = () => toast('Could not read that image.', 'error');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Could not read that image.', 'error');
  reader.readAsDataURL(file);
}

function bindJournalFilterEvents() {
  Object.entries(JOURNAL_CONTROLS).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(el.type === 'text' ? 'input' : 'change', e => { journalFilters[key] = e.target.value; renderJournal(); });
  });
  document.getElementById('clearFiltersBtn').addEventListener('click', resetJournalFilters);
  document.getElementById('journalExportBtn').addEventListener('click', () => exportCSV(getFilteredJournalTrades(), 'copperstone-journal-filtered.csv'));
}

function bindRiskCalculatorEvents() {
  ['rcBalance', 'rcRiskPct', 'rcPair', 'rcEntry', 'rcSL', 'rcTP', 'rcPipValue', 'rcSLPips'].forEach(id => {
    document.getElementById(id).addEventListener('input', computeRisk);
  });
  document.getElementById('rcResetBtn').addEventListener('click', resetRiskCalculator);

  [['rrDailyLoss', 'dailyLossLimitPct'], ['rrMaxTrades', 'maxTradesPerDay'], ['rrMaxConsec', 'maxConsecutiveLosses'], ['rrMaxDD', 'maxDrawdownPct']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('change', e => {
      const v = Math.max(0, num(e.target.value, defaultRiskRules()[key]));
      state.settings.risk = Object.assign(defaultRiskRules(), state.settings.risk || {}, { [key]: v });
      e.target.value = v;
      saveData();
      renderRiskStatusInto('riskStatusPanel');
      renderRiskStatusInto('dashRiskStatus');
    });
  });
}

function bindScopeEvents() {
  ['analyticsScope', 'calendarScope'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', e => {
      state.settings.analyticsScope = e.target.value === 'all' ? 'all' : 'active';
      saveData();
      renderPage(currentPageName());
    });
  });
}

function bindCalendarEvents() {
  document.getElementById('calPrevBtn').addEventListener('click', () => {
    calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
    selectedCalendarDay = null;
    renderCalendar();
  });
  document.getElementById('calNextBtn').addEventListener('click', () => {
    calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
    selectedCalendarDay = null;
    renderCalendar();
  });
  document.getElementById('calTodayBtn').addEventListener('click', () => {
    calendarViewDate = new Date();
    selectedCalendarDay = nowDateStr();
    renderCalendar();
  });
}

/* ============================================================
   LOCAL PROFILE (NOT production authentication)

   This is a convenience lock for a single browser. The password is
   never stored; a salted PBKDF2 hash is. Anyone with access to the
   browser profile can still read localStorage, and nothing here syncs
   between devices. `AuthService` is the seam where a real backend
   (server sessions / OAuth, per-user data isolation) would plug in.
   ============================================================ */

const COMMON_PASSWORDS = ['password', '123456', '12345678', 'qwerty', 'letmein', 'admin', 'welcome', 'iloveyou', 'abc123', 'copperstone'];

function validateEmail(email) {
  const e = String(email || '').trim();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function passwordStrength(pw) {
  const len = pw.length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  const common = COMMON_PASSWORDS.some(c => pw.toLowerCase().includes(c));
  const issues = [];
  if (len < 10) issues.push('at least 10 characters');
  if (classes < 3) issues.push('3 of: lowercase, uppercase, number, symbol');
  if (common) issues.push('nothing obvious like "password"');
  let score = 0;
  if (len >= 10) score++;
  if (len >= 14) score++;
  if (classes >= 3) score++;
  if (classes === 4 && len >= 12) score++;
  if (common || !len) score = Math.min(score, 1);
  if (!len) score = 0;
  return { score, label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score], ok: issues.length === 0, issues };
}

function bytesToB64(bytes) { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); }
function b64ToBytes(b64) { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

async function hashPassword(password, saltB64, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash: 'SHA-256' }, key, 256);
  return bytesToB64(new Uint8Array(bits));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const AuthService = {
  ITERATIONS: 210000,
  failures: 0,
  lockedUntil: 0,

  supported() { return !!(window.crypto && window.crypto.subtle && window.TextEncoder); },
  getProfile() {
    try { const p = JSON.parse(LocalStorageAdapter.read(PROFILE_KEY) || 'null'); return isPlainObject(p) && p.email && p.hash ? p : null; } catch (e) { return null; }
  },
  hasProfile() { return !!this.getProfile(); },
  isLoggedIn() { try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch (e) { return false; } },
  setSession(on) { try { if (on) sessionStorage.setItem(SESSION_KEY, '1'); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } },

  async signUp({ fullName, email, password }) {
    if (!this.supported()) throw new Error('This browser or page context does not support secure password hashing. Open the app over https or localhost.');
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, salt, this.ITERATIONS);
    const profile = { id: uid(), fullName: fullName.trim(), email: email.trim().toLowerCase(), salt, hash, iterations: this.ITERATIONS, createdAt: new Date().toISOString() };
    LocalStorageAdapter.write(PROFILE_KEY, JSON.stringify(profile));
    this.setSession(true);
    return profile;
  },

  async logIn(email, password) {
    const wait = this.lockedUntil - Date.now();
    if (wait > 0) throw new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`);
    const p = this.getProfile();
    let ok = false;
    if (p && p.email === String(email).trim().toLowerCase() && this.supported()) {
      ok = safeEqual(await hashPassword(password, p.salt, p.iterations || this.ITERATIONS), p.hash);
    }
    if (!ok) {
      this.failures++;
      if (this.failures >= 5) { this.lockedUntil = Date.now() + 30000; this.failures = 0; }
      throw new Error('Incorrect email or password.');
    }
    this.failures = 0;
    this.setSession(true);
    return p;
  },

  logOut() { this.setSession(false); },

  updateProfile({ fullName, email }) {
    const p = this.getProfile();
    if (!p) throw new Error('No profile.');
    p.fullName = fullName.trim();
    p.email = email.trim().toLowerCase();
    LocalStorageAdapter.write(PROFILE_KEY, JSON.stringify(p));
    return p;
  },

  async changePassword(current, next) {
    const p = this.getProfile();
    if (!p) throw new Error('No profile.');
    const ok = safeEqual(await hashPassword(current, p.salt, p.iterations || this.ITERATIONS), p.hash);
    if (!ok) throw new Error('Current password is incorrect.');
    p.salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    p.iterations = this.ITERATIONS;
    p.hash = await hashPassword(next, p.salt, p.iterations);
    LocalStorageAdapter.write(PROFILE_KEY, JSON.stringify(p));
  },

  deleteProfile() { LocalStorageAdapter.remove(PROFILE_KEY); this.setSession(false); }
};

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '')[0] || '').toUpperCase() + ((parts.length > 1 ? parts[parts.length - 1][0] : '') || '').toUpperCase();
}

function updateUserChip() {
  const p = AuthService.getProfile();
  const logged = p && AuthService.isLoggedIn();
  document.getElementById('userChipName').textContent = logged ? p.fullName : 'Guest';
  document.getElementById('userChipSub').textContent = logged ? p.email : 'No local profile';
  document.getElementById('userAvatar').innerHTML = logged && initialsOf(p.fullName) ? escapeHtml(initialsOf(p.fullName)) : '<i class="fa-solid fa-user"></i>';
  const lo = document.getElementById('logoutBtn');
  if (lo) lo.hidden = !logged;
}

function setFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
  const input = el && el.previousElementSibling && el.previousElementSibling.tagName === 'INPUT' ? el.previousElementSibling : null;
  if (input) input.classList.toggle('input-error', !!msg);
}

function setFormAlert(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || '';
}

function setAuthMode(mode) {
  const login = mode === 'login';
  document.getElementById('loginForm').hidden = !login;
  document.getElementById('signupForm').hidden = login;
  document.getElementById('authTabLogin').classList.toggle('active', login);
  document.getElementById('authTabSignup').classList.toggle('active', !login);
  document.getElementById('authTitle').textContent = login ? 'Welcome back' : 'Create your local profile';
  document.getElementById('authSub').textContent = login ? 'Sign in to your local Copperstone profile.' : 'Set up a name and password for this device.';
  // Guests can only reach Log In once a profile exists.
  document.getElementById('authTabLogin').hidden = !AuthService.hasProfile();
  document.getElementById('authTabSignup').hidden = AuthService.hasProfile();
  document.getElementById('continueGuestBtn').hidden = AuthService.hasProfile() && !AuthService.isLoggedIn();
  ['loginEmailErr', 'loginPasswordErr', 'signupNameErr', 'signupEmailErr', 'signupPasswordErr', 'signupConfirmErr'].forEach(i => setFieldError(i, ''));
  setFormAlert('loginAlert', ''); setFormAlert('signupAlert', '');
}

function showAuthScreen(mode) {
  document.body.classList.add('locked');
  document.getElementById('authScreen').hidden = false;
  setAuthMode(mode);
  setTimeout(() => { const f = document.getElementById(mode === 'login' ? 'loginEmail' : 'signupName'); if (f) f.focus(); }, 30);
}

function hideAuthScreen() {
  document.getElementById('authScreen').hidden = true;
  document.body.classList.remove('locked');
}

function onAuthenticated() {
  hideAuthScreen();
  if (!appBooted) bootApp();
  updateUserChip();
  if (currentPageName() === 'settings') renderProfileCard();
}

function lockApp() {
  closeAllModals();
  AuthService.logOut();
  updateUserChip();
  showAuthScreen('login');
}

function bindAuthEvents() {
  const $ = (id) => document.getElementById(id);
  document.querySelectorAll('[data-auth-tab]').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.authTab)));

  $('signupPassword').addEventListener('input', e => {
    const s = passwordStrength(e.target.value);
    const bar = $('pwMeterBar');
    bar.style.width = (e.target.value ? (s.score + 1) * 20 : 0) + '%';
    bar.className = 'pw-' + s.score;
    $('pwStrengthLabel').textContent = e.target.value ? `${s.label}${s.ok ? '' : ' — needs ' + s.issues.join('; ')}` : 'Use 10+ characters with upper & lower case, a number and a symbol.';
  });

  $('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('signupName').value.trim(), email = $('signupEmail').value.trim(), pw = $('signupPassword').value, pw2 = $('signupConfirm').value;
    let bad = false;
    setFormAlert('signupAlert', '');
    if (name.length < 2) { setFieldError('signupNameErr', 'Enter your full name.'); bad = true; } else setFieldError('signupNameErr', '');
    if (!validateEmail(email)) { setFieldError('signupEmailErr', 'Enter a valid email address.'); bad = true; } else setFieldError('signupEmailErr', '');
    const st = passwordStrength(pw);
    if (!st.ok) { setFieldError('signupPasswordErr', 'Password needs: ' + st.issues.join('; ') + '.'); bad = true; } else setFieldError('signupPasswordErr', '');
    if (pw !== pw2) { setFieldError('signupConfirmErr', 'Passwords do not match.'); bad = true; } else setFieldError('signupConfirmErr', '');
    if (bad) return;
    const btn = $('signupSubmit'); btn.disabled = true; btn.classList.add('btn-loading');
    try {
      await AuthService.signUp({ fullName: name, email, password: pw });
      $('signupForm').reset(); $('pwMeterBar').style.width = '0';
      onAuthenticated();
      toast('Local profile created. Your existing journal data was kept.', 'success');
    } catch (err) {
      setFormAlert('signupAlert', err.message || 'Could not create the profile.');
    } finally { btn.disabled = false; btn.classList.remove('btn-loading'); }
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('loginEmail').value.trim(), pw = $('loginPassword').value;
    setFormAlert('loginAlert', '');
    setFieldError('loginEmailErr', email ? '' : 'Enter your email.');
    setFieldError('loginPasswordErr', pw ? '' : 'Enter your password.');
    if (!email || !pw) return;
    const btn = $('loginSubmit'); btn.disabled = true; btn.classList.add('btn-loading');
    try {
      await AuthService.logIn(email, pw);
      $('loginForm').reset();
      onAuthenticated();
      toast('Signed in', 'success');
    } catch (err) {
      setFormAlert('loginAlert', err.message || 'Could not sign in.');
    } finally { btn.disabled = false; btn.classList.remove('btn-loading'); }
  });

  let forgotArmed = false;
  $('forgotPasswordBtn').addEventListener('click', () => {
    if (!forgotArmed) {
      forgotArmed = true;
      setFormAlert('loginAlert', 'A local profile has no email recovery. Click "Confirm reset" to remove the profile (name, email, password) from this device. Your journal data is NOT deleted.');
      $('forgotPasswordBtn').textContent = 'Confirm reset';
      return;
    }
    forgotArmed = false;
    $('forgotPasswordBtn').textContent = 'Forgot password?';
    AuthService.deleteProfile();
    updateUserChip();
    setAuthMode('signup');
    toast('Local profile removed. Create a new one to continue — your journal data is untouched.', 'info');
  });

  $('continueGuestBtn').addEventListener('click', () => {
    hideAuthScreen();
    if (!appBooted) bootApp();
  });
}

function renderProfileCard() {
  const el = document.getElementById('profileBody');
  if (!el) return;
  const p = AuthService.getProfile();
  if (!p || !AuthService.isLoggedIn()) {
    el.innerHTML = `
      <p class="hint-text">You are using Copperstone without a profile. A local profile adds a name and a password prompt on this device. It is a convenience lock, <b>not</b> secure authentication, and it does not sync to other devices.</p>
      <button class="btn btn-secondary" id="profCreateBtn" type="button"><i class="fa-solid fa-user-plus"></i> Create Local Profile</button>`;
    return;
  }
  el.innerHTML = `
    <div class="about-grid">
      <div class="about-item"><span>Name</span><b>${escapeHtml(p.fullName)}</b></div>
      <div class="about-item"><span>Email</span><b>${escapeHtml(p.email)}</b></div>
      <div class="about-item"><span>Created</span><b>${escapeHtml(new Date(p.createdAt).toLocaleDateString())}</b></div>
    </div>
    <form id="profileForm" class="form-grid" novalidate style="margin-top:16px;">
      <div class="field"><label for="profName">Full name</label><input type="text" id="profName" value="${escapeHtml(p.fullName)}"></div>
      <div class="field"><label for="profEmail">Email</label><input type="email" id="profEmail" value="${escapeHtml(p.email)}"></div>
      <div class="form-actions" style="grid-column:1/-1;"><button class="btn btn-secondary" type="submit">Save Profile</button></div>
    </form>
    <form id="passwordForm" class="form-grid" novalidate style="margin-top:16px;">
      <div class="field"><label for="profCurPw">Current password</label><input type="password" id="profCurPw" autocomplete="current-password"></div>
      <div class="field"><label for="profNewPw">New password</label><input type="password" id="profNewPw" autocomplete="new-password"></div>
      <div class="field"><label for="profNewPw2">Confirm new password</label><input type="password" id="profNewPw2" autocomplete="new-password"></div>
      <div class="form-actions" style="grid-column:1/-1;"><button class="btn btn-secondary" type="submit">Change Password</button></div>
    </form>
    <div class="data-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" id="profLogoutBtn" type="button"><i class="fa-solid fa-right-from-bracket"></i> Log Out</button>
      <button class="btn btn-danger" id="profDeleteBtn" type="button"><i class="fa-solid fa-user-slash"></i> Delete Local Profile</button>
    </div>
    <p class="hint-text">Deleting the profile removes only the name, email and password hash from this browser. Your journal data is not touched.</p>`;
}

function bindProfileEvents() {
  const body = document.getElementById('profileBody');
  body.addEventListener('click', (e) => {
    if (e.target.closest('#profCreateBtn')) showAuthScreen('signup');
    if (e.target.closest('#profLogoutBtn')) lockApp();
    if (e.target.closest('#profDeleteBtn')) {
      askConfirm('Delete Local Profile', 'Remove the profile from this browser? Your journal data stays; the password prompt goes away.', () => {
        AuthService.deleteProfile(); updateUserChip(); renderProfileCard(); toast('Local profile deleted', 'success');
      });
    }
  });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id === 'profileForm') {
      const name = document.getElementById('profName').value.trim(), email = document.getElementById('profEmail').value.trim();
      if (name.length < 2) { toast('Enter your full name.', 'error'); return; }
      if (!validateEmail(email)) { toast('Enter a valid email address.', 'error'); return; }
      AuthService.updateProfile({ fullName: name, email });
      updateUserChip(); renderProfileCard(); toast('Profile saved', 'success');
    } else if (e.target.id === 'passwordForm') {
      const cur = document.getElementById('profCurPw').value, n1 = document.getElementById('profNewPw').value, n2 = document.getElementById('profNewPw2').value;
      const st = passwordStrength(n1);
      if (!cur) { toast('Enter your current password.', 'error'); return; }
      if (!st.ok) { toast('New password needs: ' + st.issues.join('; ') + '.', 'error'); return; }
      if (n1 !== n2) { toast('New passwords do not match.', 'error'); return; }
      try { await AuthService.changePassword(cur, n1); renderProfileCard(); toast('Password changed', 'success'); }
      catch (err) { toast(err.message || 'Could not change the password.', 'error'); }
    }
  });
  document.getElementById('userChip').addEventListener('click', () => {
    if (AuthService.hasProfile() && AuthService.isLoggedIn()) { setPage('settings'); const c = document.getElementById('profileCard'); if (c) c.scrollIntoView({ behavior: 'smooth' }); }
    else showAuthScreen(AuthService.hasProfile() ? 'login' : 'signup');
  });
  document.getElementById('logoutBtn').addEventListener('click', lockApp);
  document.getElementById('themeToggle').addEventListener('click', () => {
    state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
    saveData(); applyAppearance();
    const sel = document.getElementById('setTheme'); if (sel) sel.value = state.settings.theme;
  });
}


/* ============================================================
   INIT
   ============================================================ */

let appBooted = false;
let lastErrorToastAt = 0;

function bindGlobalHandlers() {
  const report = (msg, err) => {
    console.error(msg, err);
    const now = Date.now();
    if (now - lastErrorToastAt > 5000) {
      lastErrorToastAt = now;
      toast('Something went wrong. If it keeps happening, export a backup and reload the page.', 'error');
    }
  };
  window.addEventListener('error', ev => report('Unhandled error', ev.error || ev.message));
  window.addEventListener('unhandledrejection', ev => report('Unhandled promise rejection', ev.reason));
  document.addEventListener('keydown', handleModalKeydown);
}

function bootApp() {
  if (appBooted) return;
  appBooted = true;

  populateFormSelects();
  setupModalAccessibility();
  labelCharts();
  refreshAccountSelectors();

  bindNavEvents();
  bindModalEvents();
  bindQuickActions();
  bindFormEvents();
  bindJournalFilterEvents();
  bindRiskCalculatorEvents();
  bindCalendarEvents();
  bindSettingsEvents();
  bindScopeEvents();
  bindReportEvents();
  bindProfileEvents();
  bindMT5Events();

  document.getElementById('sidebarAccountSelect').addEventListener('change', (e) => setActiveAccount(e.target.value));

  updateUserChip();
  updateGoalsFromTrades();
  renderPage('dashboard');
  renderRiskRulesUI();
  computeRisk();

  // Passive, silent check on load so the dashboard mini-card reflects
  // reality immediately — never blocks the UI and never throws.
  mt5TestConnection(true).then(ok => { if (ok) mt5RefreshAccount(true); });
}

function init() {
  bindGlobalHandlers();
  bindAuthEvents();
  loadData();
  applyAppearance();
  if (AuthService.hasProfile() && !AuthService.isLoggedIn()) {
    showAuthScreen('login');   // the app boots after a successful sign-in
    return;
  }
  bootApp();
}

document.addEventListener('DOMContentLoaded', init);
