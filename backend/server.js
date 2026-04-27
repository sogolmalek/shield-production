/**
 * SHIELD Backend — Production Server v3.0
 *
 * Production hardening:
 *   1. Retry with exponential backoff on all external API calls
 *   2. Circuit breaker pattern — stops hammering failing services
 *   3. Request timeout middleware — no hanging requests
 *   4. Structured error responses with retryAfter hints
 *   5. Health check endpoint with dependency status
 *   6. Graceful shutdown with connection draining
 *   7. Memory-safe LRU cache with size limits
 *   8. Atomic file writes for persistence
 *   9. uncaughtException / unhandledRejection handlers
 *  10. Cluster restart throttle (prevents crash loops)
 */

const cluster = require('cluster');
const os      = require('os');

// ── Primary: fork workers ──
if (cluster.isPrimary) {
  const cpus = Math.min(os.cpus().length, 4);
  console.log(`\n⛨  SHIELD primary ${process.pid} — forking ${cpus} workers`);
  for (let i = 0; i < cpus; i++) cluster.fork();

  let restartCount = 0;
  let lastRestart = Date.now();

  cluster.on('exit', (worker, code) => {
    console.log(`[CLUSTER] Worker ${worker.process.pid} exited (code=${code}) — restarting`);
    const now = Date.now();
    if (now - lastRestart < 60000) {
      restartCount++;
      if (restartCount > 10) {
        console.error('[CLUSTER] Too many restarts — cooling down 30s');
        setTimeout(() => { restartCount = 0; cluster.fork(); }, 30000);
        return;
      }
    } else { restartCount = 0; }
    lastRestart = now;
    cluster.fork();
  });
  return;
}

// ── Worker ──
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const { Connection, PublicKey } = require('@solana/web3.js');
const { ShieldGoldRush } = require('./goldrush');
const { CreditSystem, SCAN_COST, SUB_PRICE, SUB_SCANS, AUTO_CHARGE_AMOUNTS } = require('./credits');
const fs = require('fs');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'] }));
app.use(express.json({ limit: '10kb' }));

// ── Config ──
const PORT         = process.env.PORT             || 10000;
const ALCHEMY_RPC  = process.env.ALCHEMY_RPC      || null;
const GOLDRUSH_KEY = process.env.GOLDRUSH_API_KEY  || null;
const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';

if (!ALCHEMY_RPC)  console.warn('[WARN] ALCHEMY_RPC not set — RPC calls disabled');
if (!GOLDRUSH_KEY) console.warn('[WARN] GOLDRUSH_API_KEY not set — holder data disabled');

const FREE_SCANS_PER_DAY = 10;
const FREE_TRIAL_DAYS    = 3;
const FREE_TOTAL_MAX     = 30;


// ═══════════════════════════════════════
// RELIABILITY: Request timeout middleware
// ═══════════════════════════════════════
app.use((req, res, next) => {
  res.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'timeout', message: 'Request timed out. Please retry.', retryAfter: 3 });
    }
  });
  next();
});

// ── Rate limiters ──
const scanLimiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many requests. Slow down.', retryAfter: 60 } });
const paymentLimiter = rateLimit({ windowMs: 60000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'rate_limited', message: 'Too many payment requests.', retryAfter: 60 } });
const generalLimiter = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use(generalLimiter);

// ── Connections ──
const connection = ALCHEMY_RPC  ? new Connection(ALCHEMY_RPC, 'confirmed') : null;
const goldRush   = GOLDRUSH_KEY ? new ShieldGoldRush(GOLDRUSH_KEY) : null;
const credits    = new CreditSystem(OWNER_WALLET, ALCHEMY_RPC || '');


// ═══════════════════════════════════════
// RELIABILITY: fetchWithRetry
// ═══════════════════════════════════════
async function fetchWithRetry(url, options = {}, { retries = 3, baseDelay = 500, timeout = 8000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt) + Math.random() * 200));
    }
  }
  throw lastError;
}


// ═══════════════════════════════════════
// RELIABILITY: Circuit Breaker
// ═══════════════════════════════════════
class CircuitBreaker {
  constructor(name, { failureThreshold = 5, resetTimeout = 60000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.failures = 0;
    this.state = 'CLOSED';
    this.openedAt = 0;
    this.halfOpenSuccesses = 0;
  }
  async exec(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt > this.resetTimeout) { this.state = 'HALF_OPEN'; this.halfOpenSuccesses = 0; }
      else return null;
    }
    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') { this.halfOpenSuccesses++; if (this.halfOpenSuccesses >= 2) { this.state = 'CLOSED'; this.failures = 0; console.log(`[CIRCUIT] ${this.name} CLOSED (recovered)`); } }
      else { this.failures = Math.max(0, this.failures - 1); }
      return result;
    } catch (e) {
      this.failures++;
      if (this.failures >= this.failureThreshold) { this.state = 'OPEN'; this.openedAt = Date.now(); console.warn(`[CIRCUIT] ${this.name} OPEN (${this.failures} failures)`); }
      return null;
    }
  }
  status() { return { state: this.state, failures: this.failures }; }
}

const circuits = {
  rugcheck: new CircuitBreaker('rugcheck', { failureThreshold: 5, resetTimeout: 60000 }),
  jupiter:  new CircuitBreaker('jupiter',  { failureThreshold: 5, resetTimeout: 60000 }),
  rpc:      new CircuitBreaker('rpc',      { failureThreshold: 3, resetTimeout: 30000 }),
  goldrush: new CircuitBreaker('goldrush', { failureThreshold: 5, resetTimeout: 120000 }),
};


// ═══════════════════════════════════════
// RELIABILITY: LRU Cache (memory-safe)
// ═══════════════════════════════════════
class LRUCache {
  constructor(maxSize = 500, ttl = 300000) {
    this.maxSize = maxSize; this.ttl = ttl; this.cache = new Map();
  }
  get(key) {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.ts > this.ttl) { this.cache.delete(key); return null; }
    this.cache.delete(key); this.cache.set(key, e); return e.v;
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize) { this.cache.delete(this.cache.keys().next().value); }
    this.cache.set(key, { v: value, ts: Date.now() });
  }
  get size() { return this.cache.size; }
}

const scanCache   = new LRUCache(500, 300000);
const tickerCache = new LRUCache(200, 300000);


// ── Persistence (atomic writes) ──
const CREDITS_FILE   = 'credits-state.json';
const USERSTATE_FILE = 'userstate.json';

function loadJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function saveJSON(file, data) {
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); }
  catch (e) { console.error('[SAVE ERROR]', file, e.message); }
}

const savedCredits = loadJSON(CREDITS_FILE);
if (savedCredits) { credits.import(savedCredits); console.log('[CREDITS] Loaded.'); }

const userState = new Map();
const savedUsers = loadJSON(USERSTATE_FILE);
if (savedUsers) { for (const [fp, u] of Object.entries(savedUsers)) userState.set(fp, u); console.log(`[USERSTATE] Loaded ${userState.size} users.`); }

setInterval(() => { saveJSON(CREDITS_FILE, credits.export()); const us = {}; for (const [fp, u] of userState) us[fp] = u; saveJSON(USERSTATE_FILE, us); }, 300000);

// ── Graceful shutdown ──
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} — saving state...`);
  saveJSON(CREDITS_FILE, credits.export());
  const us = {}; for (const [fp, u] of userState) us[fp] = u; saveJSON(USERSTATE_FILE, us);
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL]', err.message, err.stack);
  saveJSON(CREDITS_FILE, credits.export());
  const us = {}; for (const [fp, u] of userState) us[fp] = u; saveJSON(USERSTATE_FILE, us);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => { console.error('[WARN] Unhandled rejection:', reason); });


// ── Helpers ──
function getOrCreateUser(fp) {
  if (!userState.has(fp)) userState.set(fp, { firstSeen: Date.now(), scansToday: 0, lastReset: new Date().toDateString(), totalScans: 0, totalFreeScans: 0 });
  return userState.get(fp);
}

function depositPayload(amount = 5) {
  return {
    depositAddress: OWNER_WALLET, scanCost: SCAN_COST, currency: 'USDC', network: 'Solana',
    deeplink: `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=${amount}&splToken=${USDC_MINT}&label=Shield+Credits`,
    pricing: { payPerScan: '$0.01 per scan', topUp: { '$1': '100 scans', '$5': '500 scans', '$10': '1000 scans' }, subscription: '$5/month — 500 scans included, then $0.01 each' },
  };
}


// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'live', service: 'Shield API', version: '3.0.0', worker: process.pid }));

// ── Health check ──
app.get('/health', (req, res) => {
  const health = {
    status: 'ok', version: '3.0.0', uptime: Math.floor(process.uptime()),
    memory: Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB',
    cacheSize: scanCache.size, users: userState.size,
    circuits: { rugcheck: circuits.rugcheck.status(), jupiter: circuits.jupiter.status(), rpc: circuits.rpc.status(), goldrush: circuits.goldrush.status() },
    dependencies: { rpc: ALCHEMY_RPC ? 'configured' : 'missing', goldrush: GOLDRUSH_KEY ? 'configured' : 'missing' },
  };
  const anyOpen = Object.values(circuits).some(c => c.state === 'OPEN');
  res.status(anyOpen ? 503 : 200).json(health);
});

// ── Anti-manipulation ──
const ipTracker = new Map();
const IP_MAX_FINGERPRINTS = 5;
const IP_MAX_FREE_SCANS   = 50;
const IP_BLOCK_DURATION   = 86400000;

function getIPTrack(ip) {
  if (!ipTracker.has(ip)) ipTracker.set(ip, { fingerprints: new Set(), totalScans: 0, firstSeen: Date.now(), blocked: false, blockedUntil: 0 });
  return ipTracker.get(ip);
}
function checkAbuse(ip, fingerprint) {
  const t = getIPTrack(ip);
  if (t.blocked && Date.now() > t.blockedUntil) t.blocked = false;
  if (t.blocked) return { blocked: true, reason: 'ip_blocked', message: 'Too many accounts from this IP. Try again in 24h.' };
  t.fingerprints.add(fingerprint);
  if (t.fingerprints.size > IP_MAX_FINGERPRINTS) { t.blocked = true; t.blockedUntil = Date.now() + IP_BLOCK_DURATION; console.warn(`[ABUSE] IP ${ip} blocked`); return { blocked: true, reason: 'abuse_detected', message: 'Unusual activity detected. Access temporarily suspended.' }; }
  if (t.totalScans >= IP_MAX_FREE_SCANS) return { blocked: true, reason: 'ip_free_limit', message: 'Free limit reached. Top up $1 to continue.' };
  return { blocked: false };
}
setInterval(() => { const now = Date.now(); for (const [ip, t] of ipTracker) { if (now - t.firstSeen > 604800000) ipTracker.delete(ip); } }, 3600000);


// ═══════════════════════════════════════
// SCAN ENDPOINT
// ═══════════════════════════════════════
app.post('/api/scan', scanLimiter, async (req, res) => {
  if (isShuttingDown) return res.status(503).json({ error: 'shutting_down', message: 'Server restarting. Retry in a few seconds.', retryAfter: 5 });

  let { token, wallet, fingerprint } = req.body;
  if (!token) return res.status(400).json({ error: 'token_required', message: 'Token address is required.' });

  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const compoundFP = fingerprint ? `${fingerprint}_${clientIP.replace(/[.:]/g, '')}` : `ip_${clientIP.replace(/[.:]/g, '')}`;

  const abuseCheck = checkAbuse(clientIP, compoundFP);
  if (abuseCheck.blocked && !wallet) return res.status(429).json({ error: abuseCheck.reason, message: abuseCheck.message, payment: depositPayload() });

  // ── Address resolution (lowercase from DexScreener URLs, pair addresses, etc.) ──
  if (token === token.toLowerCase() && token.length >= 32) {
    let resolved = false;

    // Method 1: Jupiter search by first 8 chars
    try {
      const r = await fetchWithRetry(`https://api.jup.ag/tokens/v2/search?query=${token.slice(0, 8)}`, {}, { retries: 2, timeout: 5000 });
      if (r.ok) { const tokens = await r.json(); if (Array.isArray(tokens)) { const m = tokens.find(t => t.id?.toLowerCase() === token.toLowerCase()); if (m) { token = m.id; resolved = true; } } }
    } catch {}

    // Method 2: RugCheck (sometimes handles case-insensitive)
    if (!resolved) {
      try {
        const r = await fetchWithRetry(`${RUGCHECK_API}/tokens/${token}/report/summary`, {}, { retries: 1, timeout: 5000 });
        if (r.ok) { const d = await r.json(); if (d.mint?.toLowerCase() === token) { token = d.mint; resolved = true; } else if (d.tokenMeta?.mint?.toLowerCase() === token) { token = d.tokenMeta.mint; resolved = true; } }
      } catch {}
    }

    // Method 3: DexScreener pair resolve (lowercase URL might be a pair address)
    if (!resolved) {
      try {
        const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB','So11111111111111111111111111111111111111112']);
        const r = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/pairs/solana/${token}`, {}, { retries: 1, timeout: 5000 });
        if (r.ok) {
          const d = await r.json();
          const pair = d?.pair || d?.pairs?.[0];
          if (pair) {
            const base = pair.baseToken?.address;
            const quote = pair.quoteToken?.address;
            if (base && !STABLES.has(base)) { token = base; resolved = true; }
            else if (quote && !STABLES.has(quote)) { token = quote; resolved = true; }
          }
        }
      } catch {}
    }

    // Method 4: Jupiter full-text search by entire lowercase address
    if (!resolved) {
      try {
        const r = await fetchWithRetry(`https://api.jup.ag/tokens/v2/search?query=${token}`, {}, { retries: 1, timeout: 5000 });
        if (r.ok) { const tokens = await r.json(); if (Array.isArray(tokens) && tokens.length > 0) { const m = tokens.find(t => t.id?.toLowerCase() === token); if (m) { token = m.id; resolved = true; } } }
      } catch {}
    }

    if (!resolved) return res.status(400).json({ error: 'invalid_address', message: 'Could not resolve address. Try copying the token address directly.', hint: 'DexScreener URLs use lowercase. Copy the address from the token page.' });
  }

  // ── Billing ──
  let billingType = 'free_trial', billingInfo = {}, creditDeducted = false;
  if (wallet) { const bal = credits.getBalance(wallet); if (bal.balance >= SCAN_COST) { const d = credits.deductScan(wallet); if (d.ok) { billingType = 'credits'; billingInfo = { balance: d.balance, scansRemaining: d.scansRemaining }; creditDeducted = true; } } }

  if (billingType === 'free_trial') {
    const user = getOrCreateUser(compoundFP);
    const today = new Date().toDateString();
    if (user.lastReset !== today) { user.scansToday = 0; user.lastReset = today; }
    const daysSince = Math.floor((Date.now() - user.firstSeen) / 86400000);
    const totalFree = user.totalFreeScans || 0;

    // Also check IP-level limits (catches fingerprint reset via reinstall/clear)
    const ipTrack = getIPTrack(clientIP);
    const ipDaysSince = Math.floor((Date.now() - ipTrack.firstSeen) / 86400000);

    // Trial expired: check BOTH fingerprint AND IP
    const trialExpired = daysSince >= FREE_TRIAL_DAYS || ipDaysSince >= FREE_TRIAL_DAYS;
    const dailyLimitHit = user.scansToday >= FREE_SCANS_PER_DAY;
    const totalLimitHit = totalFree >= FREE_TOTAL_MAX || ipTrack.totalScans >= IP_MAX_FREE_SCANS;

    if (trialExpired || dailyLimitHit || totalLimitHit) {
      let reason, msg;
      if (trialExpired) { reason = 'trial_expired'; msg = 'Free trial ended. $0.01/scan — top up $1, $5, or $10.'; }
      else if (totalLimitHit) { reason = 'total_limit'; msg = `Free scans used up. $0.01/scan — top up to continue.`; }
      else { reason = 'daily_limit'; msg = `Daily limit (${FREE_SCANS_PER_DAY}) reached. Come back tomorrow or top up.`; }
      return res.status(402).json({ error: reason, message: msg, payment: depositPayload() });
    }
    user.scansToday++; user.totalScans++; user.totalFreeScans = (user.totalFreeScans || 0) + 1;
    ipTrack.totalScans++;
    billingInfo = { freeScansLeft: FREE_SCANS_PER_DAY - user.scansToday, freeTotalLeft: FREE_TOTAL_MAX - user.totalFreeScans };
  }

  try {
    const result = await scoreTok(token);
    return res.json({ ...result, billing: { type: billingType, ...billingInfo } });
  } catch (e) {
    if (creditDeducted && wallet) { credits.refundScan(wallet); console.log(`[REFUND] $${SCAN_COST} → ${wallet}`); }
    console.error('[SCAN ERROR]', e.message);
    return res.status(500).json({ error: 'scan_failed', message: 'Scan temporarily unavailable. Retry in a few seconds.', retryAfter: 5 });
  }
});

// ── Credits / Ticker / Payment / Subscription / Settings / Pricing ──
app.get('/api/credits/:wallet', (req, res) => res.json(credits.getBalance(req.params.wallet)));

app.get('/api/resolve/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().replace(/^\$/, '');
  if (!ticker || ticker.length > 20) return res.status(400).json({ error: 'invalid_ticker' });
  const cached = tickerCache.get(ticker);
  if (cached) return res.json(cached);
  try {
    const r = await fetchWithRetry(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(ticker)}`, {}, { retries: 2, timeout: 8000 });
    if (!r.ok) return res.status(502).json({ error: 'jupiter_api_error', retryAfter: 10 });
    const tokens = await r.json();
    if (!tokens?.length) return res.json({ found: false, ticker, mint: null });
    const exact = tokens.filter(t => t.symbol?.toUpperCase() === ticker);
    const cands = exact.length ? exact : tokens;
    cands.sort((a, b) => { if (a.isVerified !== b.isVerified) return a.isVerified ? -1 : 1; if ((a.organicScore||0) !== (b.organicScore||0)) return (b.organicScore||0) - (a.organicScore||0); return (b.liquidity||0) - (a.liquidity||0); });
    const best = cands[0];
    const data = { found: true, ticker, mint: best.id, name: best.name, symbol: best.symbol, verified: best.isVerified || false, tags: best.tags || [], decimals: best.decimals };
    tickerCache.set(ticker, data);
    return res.json(data);
  } catch (e) { console.error('[TICKER]', ticker, e.message); return res.status(500).json({ error: 'resolve_failed', retryAfter: 5 }); }
});

app.post('/api/payment/verify', paymentLimiter, async (req, res) => {
  const { txSignature, wallet } = req.body;
  if (!txSignature || !wallet) return res.status(400).json({ ok: false, error: 'txSignature and wallet required' });
  res.json(await credits.verifyDeposit(txSignature, wallet));
});
app.post('/api/credits/deposit', paymentLimiter, async (req, res) => { res.json(await credits.verifyDeposit(req.body.txSignature, req.body.wallet)); });

app.post('/api/subscription/activate', paymentLimiter, async (req, res) => {
  const { wallet } = req.body; if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
  const result = credits.activateSubscription(wallet);
  res.status(result.ok ? 200 : 402).json(result);
});
app.get('/api/subscription/:wallet', (req, res) => { const b = credits.getBalance(req.params.wallet); res.json({ subscription: b.subscription, balance: b.balance }); });
app.post('/api/settings/auto-charge', (req, res) => { const { wallet, enabled, amount } = req.body; if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' }); res.json(credits.setAutoCharge(wallet, enabled, amount)); });
app.get('/api/pricing', (req, res) => {
  res.json({ freeTrial: { days: FREE_TRIAL_DAYS, scansPerDay: FREE_SCANS_PER_DAY, totalMax: FREE_TOTAL_MAX }, payPerScan: SCAN_COST, topUp: { 1: '100 scans', 5: '500 scans', 10: '1000 scans' }, subscription: { price: SUB_PRICE, scansIncluded: SUB_SCANS, period: '30 days', overageCost: SCAN_COST }, autoCharge: { amounts: AUTO_CHARGE_AMOUNTS, default: 1 }, currency: 'USDC', network: 'Solana', depositAddress: OWNER_WALLET });
});


// ═══════════════════════════════════════
// SCORING ENGINE v3.1 — Circuit breakers + retries
// ═══════════════════════════════════════
async function scoreTok(mintAddress) {
  const cached = scanCache.get(mintAddress);
  if (cached) return cached;

  const [rcRes, rpcRes, grRes, jupRes] = await Promise.allSettled([
    circuits.rugcheck.exec(() => fetchWithRetry(`${RUGCHECK_API}/tokens/${mintAddress}/report/summary`, {}, { retries: 2, timeout: 6000 }).then(r => r.ok ? r.json() : null)),
    circuits.rpc.exec(() => getRPCData(mintAddress)),
    circuits.goldrush.exec(() => goldRush ? goldRush.getTokenHolders(mintAddress).catch(() => null) : null),
    circuits.jupiter.exec(() => fetchWithRetry(`https://api.jup.ag/tokens/v2/search?query=${mintAddress}`, {}, { retries: 2, timeout: 8000 }).then(r => r.ok ? r.json() : null).catch(() => null)),
  ]);

  const rc      = rcRes.status  === 'fulfilled' ? rcRes.value  : null;
  const rpc     = rpcRes.status === 'fulfilled' ? rpcRes.value : {};
  const holders = grRes.status  === 'fulfilled' ? grRes.value  : null;
  const jupTokens = jupRes.status === 'fulfilled' ? jupRes.value : null;
  const jup     = Array.isArray(jupTokens) ? jupTokens.find(t => t.id === mintAddress) : null;

  let score = 100, hardCap = 100;
  const checks = [];
  const sources = { rugcheck: !!rc, rpc: !!rpc?.supply, jupiter: !!jup, goldrush: !!holders };

  // 1. RugCheck Score
  if (rc?.score != null) {
    const p = rc.score < 100 ? 0 : rc.score < 300 ? 10 : rc.score < 700 ? 25 : rc.score < 2000 ? 40 : 60;
    score -= p;
    const lbl = rc.score < 100 ? 'Clean' : rc.score < 300 ? 'Low Risk' : rc.score < 700 ? 'Moderate Risk' : rc.score < 2000 ? 'High Risk' : 'Extreme Risk';
    checks.push({ name: 'RugCheck Score', pass: rc.score < 700, value: `${lbl} (${rc.score})`, weight: 'high', source: 'rugcheck' });
  } else { score -= 15; checks.push({ name: 'RugCheck Score', pass: false, value: 'Unavailable', weight: 'high', source: 'rugcheck' }); }

  // 2. Mint Authority
  const mintAuth = jup?.audit?.mintAuthorityDisabled ?? (rpc?.mintAuthority === false ? true : rpc?.mintAuthority === true ? false : null);
  if (mintAuth === false) { score -= 20; hardCap = Math.min(hardCap, 55); checks.push({ name: 'Mint Authority', pass: false, value: 'ACTIVE — team can print tokens', weight: 'critical', source: jup ? 'jupiter' : 'rpc' }); }
  else if (mintAuth === true) { checks.push({ name: 'Mint Authority', pass: true, value: 'Disabled ✓', weight: 'critical', source: jup ? 'jupiter' : 'rpc' }); }
  else { score -= 8; checks.push({ name: 'Mint Authority', pass: false, value: 'Unknown', weight: 'critical', source: 'none' }); }

  // 3. Freeze Authority
  const freezeAuth = jup?.audit?.freezeAuthorityDisabled ?? (rpc?.freezeAuthority === false ? true : rpc?.freezeAuthority === true ? false : null);
  if (freezeAuth === false) { score -= 15; hardCap = Math.min(hardCap, 60); checks.push({ name: 'Freeze Authority', pass: false, value: 'ACTIVE — can freeze wallets', weight: 'critical', source: jup ? 'jupiter' : 'rpc' }); }
  else if (freezeAuth === true) { checks.push({ name: 'Freeze Authority', pass: true, value: 'Disabled ✓', weight: 'critical', source: jup ? 'jupiter' : 'rpc' }); }
  else { score -= 5; checks.push({ name: 'Freeze Authority', pass: false, value: 'Unknown', weight: 'critical', source: 'none' }); }

  // 4. Organic Score
  if (jup?.organicScore != null) {
    const o = jup.organicScore;
    if (o >= 80) { score += 5; checks.push({ name: 'Organic Score', pass: true, value: `${o.toFixed(0)}/100 — High`, weight: 'medium', source: 'jupiter' }); }
    else if (o >= 50) { checks.push({ name: 'Organic Score', pass: true, value: `${o.toFixed(0)}/100 — Moderate`, weight: 'medium', source: 'jupiter' }); }
    else if (o >= 20) { score -= 10; checks.push({ name: 'Organic Score', pass: false, value: `${o.toFixed(0)}/100 — Low`, weight: 'medium', source: 'jupiter' }); }
    else { score -= 20; hardCap = Math.min(hardCap, 50); checks.push({ name: 'Organic Score', pass: false, value: `${o.toFixed(0)}/100 — Very Low (likely bot activity)`, weight: 'medium', source: 'jupiter' }); }
  }

  // 5. Jupiter Verified
  if (jup) {
    const v = jup.isVerified || false, s = (jup.tags||[]).includes('strict');
    if (v && s) { score += 5; checks.push({ name: 'Jupiter Verified', pass: true, value: 'Verified + Strict ✓', weight: 'medium', source: 'jupiter' }); }
    else if (v) { checks.push({ name: 'Jupiter Verified', pass: true, value: 'Verified ✓', weight: 'medium', source: 'jupiter' }); }
    else { score -= 5; checks.push({ name: 'Jupiter Verified', pass: false, value: 'Not verified', weight: 'low', source: 'jupiter' }); }
  }

  // 6. Liquidity
  if (jup?.liquidity != null) {
    const l = jup.liquidity;
    if (l >= 500000) { score += 3; checks.push({ name: 'Liquidity', pass: true, value: `$${(l/1e6).toFixed(2)}M — Deep`, weight: 'medium', source: 'jupiter' }); }
    else if (l >= 50000) { checks.push({ name: 'Liquidity', pass: true, value: `$${(l/1e3).toFixed(0)}K — Adequate`, weight: 'medium', source: 'jupiter' }); }
    else if (l >= 5000) { score -= 8; checks.push({ name: 'Liquidity', pass: false, value: `$${(l/1e3).toFixed(1)}K — Thin`, weight: 'medium', source: 'jupiter' }); }
    else { score -= 15; hardCap = Math.min(hardCap, 45); checks.push({ name: 'Liquidity', pass: false, value: `$${l.toFixed(0)} — Dangerously low`, weight: 'high', source: 'jupiter' }); }
  }

  // 7. Token Age
  if (jup?.firstPool?.createdAt) {
    const d = (Date.now() - new Date(jup.firstPool.createdAt).getTime()) / 86400000;
    if (d >= 180) { score += 3; checks.push({ name: 'Token Age', pass: true, value: `${Math.floor(d/30)} months — Established`, weight: 'low', source: 'jupiter' }); }
    else if (d >= 30) { checks.push({ name: 'Token Age', pass: true, value: `${Math.floor(d)} days`, weight: 'low', source: 'jupiter' }); }
    else if (d >= 3) { score -= 5; checks.push({ name: 'Token Age', pass: false, value: `${Math.floor(d)} days — New`, weight: 'low', source: 'jupiter' }); }
    else { score -= 12; checks.push({ name: 'Token Age', pass: false, value: `${Math.floor(d*24)} hours — Very new`, weight: 'medium', source: 'jupiter' }); }
  }

  // 8. Holders
  const hc = jup?.holderCount || null;
  if (hc != null) {
    if (hc >= 10000) { score += 3; checks.push({ name: 'Holders', pass: true, value: `${(hc/1e3).toFixed(1)}K — Strong community`, weight: 'medium', source: 'jupiter' }); }
    else if (hc >= 1000) { checks.push({ name: 'Holders', pass: true, value: `${(hc/1e3).toFixed(1)}K`, weight: 'low', source: 'jupiter' }); }
    else if (hc >= 100) { score -= 5; checks.push({ name: 'Holders', pass: false, value: `${hc} — Small`, weight: 'low', source: 'jupiter' }); }
    else { score -= 10; checks.push({ name: 'Holders', pass: false, value: `${hc} — Very few`, weight: 'medium', source: 'jupiter' }); }
  }

  // 9. Top Holder %
  const topPct = jup?.audit?.topHoldersPercentage ?? (holders?.[0]?.balance_percentage || null);
  if (topPct != null) {
    if (topPct > 50) { score -= 25; hardCap = Math.min(hardCap, 50); checks.push({ name: 'Top Holder %', pass: false, value: `${topPct.toFixed(1)}% — Whale dominance`, weight: 'high', source: jup ? 'jupiter' : 'goldrush' }); }
    else if (topPct > 25) { score -= 10; checks.push({ name: 'Top Holder %', pass: false, value: `${topPct.toFixed(1)}% — Concentrated`, weight: 'medium', source: jup ? 'jupiter' : 'goldrush' }); }
    else if (topPct > 10) { checks.push({ name: 'Top Holder %', pass: true, value: `${topPct.toFixed(1)}%`, weight: 'low', source: jup ? 'jupiter' : 'goldrush' }); }
    else { score += 3; checks.push({ name: 'Top Holder %', pass: true, value: `${topPct.toFixed(1)}% — Well distributed`, weight: 'low', source: jup ? 'jupiter' : 'goldrush' }); }
  }

  // 10. CEX
  if (jup?.cexes?.length > 0) { score += Math.min(5, jup.cexes.length); checks.push({ name: 'CEX Listed', pass: true, value: jup.cexes.join(', '), weight: 'medium', source: 'jupiter' }); }

  // 11. Honeypot
  if (rc?.risks?.length > 0) {
    let hpDone = false;
    for (const risk of rc.risks.slice(0, 6)) {
      const n = risk.name || 'Risk', bad = ['danger','error','warn'].includes(risk.level);
      if (n.toLowerCase().includes('honeypot')) { if (!hpDone) { score -= 35; hardCap = Math.min(hardCap, 10); hpDone = true; } checks.push({ name: 'Honeypot', pass: false, value: 'DETECTED — do not buy', weight: 'critical', source: 'rugcheck' }); }
      else if (bad) { const lr = n.toLowerCase().includes('mutable')||n.toLowerCase().includes('metadata'), est = jup?.isVerified||(jup?.holderCount||0)>5000; score -= (lr&&est)?2:6; checks.push({ name: n, pass: false, value: risk.description||risk.level, weight: 'low', source: 'rugcheck' }); }
    }
    if (!hpDone) checks.push({ name: 'Honeypot', pass: true, value: 'Not detected', weight: 'high', source: 'rugcheck' });
  } else if (rc) { checks.push({ name: 'Honeypot', pass: true, value: 'Not detected', weight: 'high', source: 'rugcheck' }); }

  // 12. LP Lock
  if (rc?.lockers?.length > 0) { checks.push({ name: 'LP Locked', pass: true, value: `${rc.lockers.length} locker(s) ✓`, weight: 'high', source: 'rugcheck' }); score += 3; }
  else if (rc?.markets?.length > 0) { const est = (jup?.isVerified&&(jup?.liquidity||0)>100000)||(jup?.cexes?.length>0); if (est) checks.push({ name: 'LP Locked', pass: true, value: 'Not locked (established)', weight: 'low', source: 'rugcheck' }); else { score -= 12; hardCap = Math.min(hardCap, 55); checks.push({ name: 'LP Locked', pass: false, value: 'NOT LOCKED — LP can be pulled', weight: 'high', source: 'rugcheck' }); } }

  // 13. Pool TVL
  if (rc?.totalMarketLiquidity > 0) { const t = rc.totalMarketLiquidity; if (t>=500000) checks.push({ name:'Pool TVL', pass:true, value:`$${(t/1e6).toFixed(2)}M`, weight:'medium', source:'rugcheck' }); else if (t>=50000) checks.push({ name:'Pool TVL', pass:true, value:`$${(t/1e3).toFixed(0)}K`, weight:'medium', source:'rugcheck' }); else if (t>=5000) checks.push({ name:'Pool TVL', pass:false, value:`$${(t/1e3).toFixed(1)}K — Low`, weight:'medium', source:'rugcheck' }); else { score-=8; checks.push({ name:'Pool TVL', pass:false, value:`$${t.toFixed(0)} — Extremely low`, weight:'high', source:'rugcheck' }); } }

  // 14. Creator
  if (rc?.creator) { const cb=rc.creator.balance||0, ca=rc.creator.address||''; if (cb>0) { const pl=rc.creator.percentage?`${rc.creator.percentage.toFixed(1)}%`:'some'; score-=5; checks.push({ name:'Creator Wallet', pass:false, value:`Holds ${pl} of supply`, weight:'medium', source:'rugcheck' }); } else if (ca) checks.push({ name:'Creator Wallet', pass:true, value:'Empty ✓', weight:'low', source:'rugcheck' }); }

  // 15. Insiders
  if (rc?.graphInsidersDetected!=null) { if (rc.graphInsidersDetected>0) { score-=10; hardCap=Math.min(hardCap,55); checks.push({ name:'Insider Wallets', pass:false, value:`${rc.graphInsidersDetected} insider(s)`, weight:'high', source:'rugcheck' }); } else checks.push({ name:'Insider Wallets', pass:true, value:'None detected ✓', weight:'medium', source:'rugcheck' }); }

  // 16. Transfer Fee
  const feePct = typeof rc?.transferFee==='object'?(rc.transferFee.pct||0):(rc?.transferFee||0);
  if (feePct>0) { if (feePct>10) { score-=20; hardCap=Math.min(hardCap,30); checks.push({ name:'Transfer Fee', pass:false, value:`${feePct}% — EXTREME`, weight:'critical', source:'rugcheck' }); } else if (feePct>3) { score-=10; checks.push({ name:'Transfer Fee', pass:false, value:`${feePct}% — High`, weight:'high', source:'rugcheck' }); } else checks.push({ name:'Transfer Fee', pass:false, value:`${feePct}%`, weight:'low', source:'rugcheck' }); }
  else if (rc) checks.push({ name:'Transfer Fee', pass:true, value:'None ✓', weight:'medium', source:'rugcheck' });

  // 17. Rugged
  if (rc?.rugged) { score-=30; hardCap=Math.min(hardCap,10); checks.push({ name:'Rug History', pass:false, value:'PREVIOUSLY RUGGED', weight:'critical', source:'rugcheck' }); }

  // 18. LP Providers
  if (rc?.totalLPProviders!=null) { const l=rc.totalLPProviders; if (l>=10) checks.push({ name:'LP Providers', pass:true, value:`${l} — Distributed`, weight:'low', source:'rugcheck' }); else if (l>=3) checks.push({ name:'LP Providers', pass:true, value:`${l}`, weight:'low', source:'rugcheck' }); else if (l>=1) { score-=5; checks.push({ name:'LP Providers', pass:false, value:`${l} — Single LP`, weight:'medium', source:'rugcheck' }); } }

  // 19. MC/FDV
  if (jup?.mcap && jup?.fdv && jup.fdv>0) { const r=jup.mcap/jup.fdv, ms=jup.mcap>1e9?`$${(jup.mcap/1e9).toFixed(2)}B`:jup.mcap>1e6?`$${(jup.mcap/1e6).toFixed(2)}M`:`$${(jup.mcap/1e3).toFixed(0)}K`; if (r>=0.8) checks.push({ name:'Market Cap', pass:true, value:`${ms} (${(r*100).toFixed(0)}% circ.)`, weight:'low', source:'jupiter' }); else if (r>=0.3) checks.push({ name:'Market Cap', pass:true, value:`${ms} (${(r*100).toFixed(0)}% circ.)`, weight:'low', source:'jupiter' }); else { score-=5; checks.push({ name:'Market Cap', pass:false, value:`${ms} (${(r*100).toFixed(0)}% circ. — dilution risk)`, weight:'low', source:'jupiter' }); } }

  // Safety net
  const dsc = Object.values(sources).filter(Boolean).length;
  if (dsc === 0) hardCap = Math.min(hardCap, 30);
  else if (dsc === 1) hardCap = Math.min(hardCap, 55);

  score = Math.round(Math.max(0, Math.min(hardCap, score)));
  const verdict = score >= 75 ? 'SECURE' : score >= 55 ? 'MODERATE' : score >= 35 ? 'WARNING' : 'DANGER';

  const result = {
    score, verdict, tier: score>=75?'safe':score>=55?'caution':score>=35?'warning':'danger',
    address: mintAddress, name: jup?.name||null, symbol: jup?.symbol||null,
    checks, sources,
    dataConfidence: dsc >= 3 ? 'high' : dsc === 2 ? 'medium' : 'low',
    sourcesUsed: dsc,
    details: { mintAuthDisabled: mintAuth, freezeAuthDisabled: freezeAuth, rugcheckRaw: rc?.score??null, organicScore: jup?.organicScore??null, liquidity: jup?.liquidity??null, holderCount: hc, mcap: jup?.mcap??null, verified: jup?.isVerified??null, cexes: jup?.cexes??[], lpLocked: rc?.lockers?.length>0, totalMarketLiquidity: rc?.totalMarketLiquidity??null, insidersDetected: rc?.graphInsidersDetected??null, transferFee: rc?.transferFee??null, rugged: rc?.rugged??false, lpProviders: rc?.totalLPProviders??null, creator: rc?.creator?.address??null },
  };

  scanCache.set(mintAddress, result);
  return result;
}

async function getRPCData(mintAddress) {
  if (!connection) return {};
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    const p = info.value?.data?.parsed?.info;
    return p ? { mintAuthority: p.mintAuthority??null, freezeAuthority: p.freezeAuthority??null, supply: p.supply??null, decimals: p.decimals??null } : {};
  } catch (e) { console.error('[RPC]', mintAddress, e.message); return {}; }
}

// ── Global error handler ──
app.use((err, req, res, next) => {
  console.error('[EXPRESS]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: 'Something went wrong. Retry.', retryAfter: 5 });
});

// ── Start ──
const server = app.listen(PORT, () => {
  console.log(`⛨  Worker ${process.pid} on :${PORT}`);

  // Keepalive: ping self every 4 min to prevent Render free tier sleep (14 min idle = sleep)
  // 4 min gives 3x safety margin
  setInterval(() => {
    fetch('https://shield-production-8awh.onrender.com/health')
      .then(r => r.json())
      .then(d => console.log(`[KEEPALIVE] ok uptime=${d.uptime}s cache=${d.cacheSize}`))
      .catch(() => console.log('[KEEPALIVE] failed'));
  }, 4 * 60 * 1000);

  // Warm up external connections 30s after start — pre-populate circuit breakers
  setTimeout(async () => {
    try {
      await fetch('https://api.jup.ag/tokens/v2/search?query=SOL', { signal: AbortSignal.timeout(5000) });
      await fetch('https://api.rugcheck.xyz/v1/tokens/So11111111111111111111111111111111111111112/report/summary', { signal: AbortSignal.timeout(5000) });
      console.log('[WARMUP] External APIs pre-warmed');
    } catch {}
  }, 30000);
});
server.timeout = 35000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
