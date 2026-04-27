/**
 * SHIELD Backend — Production Server v2.2
 * Fixes:
 *   1. Rate limiting — 30 req/min on /api/scan, blocks scrapers
 *   2. userState persisted to disk — free trial survives restarts
 *   3. No hardcoded API keys — env only, warns if missing
 *   4. Node.js cluster — one worker per CPU, auto-restarts on crash
 */

const cluster = require('cluster');
const os      = require('os');

// ── Primary: fork workers ──
if (cluster.isPrimary) {
  const cpus = Math.min(os.cpus().length, 4); // cap at 4 — free tier has 0.1 CPU anyway
  console.log(`\n⛨  SHIELD primary ${process.pid} — forking ${cpus} workers`);
  for (let i = 0; i < cpus; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    console.log(`[CLUSTER] Worker ${worker.process.pid} exited (${code}) — restarting`);
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
app.use(express.json());

// ── Config — environment variables only, no hardcoded secrets ──
const PORT         = process.env.PORT             || 10000;
const ALCHEMY_RPC  = process.env.ALCHEMY_RPC      || null;
const GOLDRUSH_KEY = process.env.GOLDRUSH_API_KEY || null;
const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';

if (!ALCHEMY_RPC)  console.warn('[WARN] ALCHEMY_RPC not set — RPC calls disabled');
if (!GOLDRUSH_KEY) console.warn('[WARN] GOLDRUSH_API_KEY not set — holder data disabled');

const FREE_SCANS_PER_DAY = 10;  // must match extension/src/background.js
const FREE_TRIAL_DAYS    = 3;
const FREE_TOTAL_MAX     = 30; // hard cap across entire trial

// ── Rate limiters ──
const scanLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,   // 30 scans/min per IP
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many requests. Slow down.' },
});
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,   // 10 payment verifications/min per IP
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many payment requests.' },
});
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,  // general 120 req/min
  standardHeaders: true, legacyHeaders: false,
});
app.use(generalLimiter);

// ── Connections ──
const connection = ALCHEMY_RPC  ? new Connection(ALCHEMY_RPC, 'confirmed') : null;
const goldRush   = GOLDRUSH_KEY ? new ShieldGoldRush(GOLDRUSH_KEY) : null;
const credits    = new CreditSystem(OWNER_WALLET, ALCHEMY_RPC || '');

// ── Persistence ──
const CREDITS_FILE   = 'credits-state.json';
const USERSTATE_FILE = 'userstate.json';

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); }
  catch (e) { console.error('[SAVE ERROR]', file, e.message); }
}

// Load on startup
const savedCredits = loadJSON(CREDITS_FILE);
if (savedCredits) { credits.import(savedCredits); console.log('[CREDITS] Loaded.'); }

const userState = new Map();
const savedUsers = loadJSON(USERSTATE_FILE);
if (savedUsers) {
  for (const [fp, u] of Object.entries(savedUsers)) userState.set(fp, u);
  console.log(`[USERSTATE] Loaded ${userState.size} users.`);
}

// Auto-save every 5 min
setInterval(() => {
  saveJSON(CREDITS_FILE, credits.export());
  const us = {};
  for (const [fp, u] of userState) us[fp] = u;
  saveJSON(USERSTATE_FILE, us);
}, 5 * 60 * 1000);

// Save on graceful shutdown
process.on('SIGTERM', () => {
  saveJSON(CREDITS_FILE, credits.export());
  const us = {};
  for (const [fp, u] of userState) us[fp] = u;
  saveJSON(USERSTATE_FILE, us);
  process.exit(0);
});

const scanCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ── Helpers ──
function getOrCreateUser(fp) {
  if (!userState.has(fp)) {
    userState.set(fp, { firstSeen: Date.now(), scansToday: 0, lastReset: new Date().toDateString(), totalScans: 0, totalFreeScans: 0 });
  }
  return userState.get(fp);
}

function depositPayload(amount = 5) {
  return {
    depositAddress: OWNER_WALLET,
    scanCost: SCAN_COST,
    currency: 'USDC',
    network: 'Solana',
    deeplink: `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=${amount}&splToken=${USDC_MINT}&label=Shield+Credits`,
    pricing: {
      payPerScan: '$0.01 per scan',
      topUp: { '$1': '100 scans', '$5': '500 scans', '$10': '1000 scans' },
      subscription: '$5/month — 500 scans included, then $0.01 each',
    },
  };
}

// ── Routes ──
app.get('/', (req, res) => res.json({ status: 'live', service: 'Shield API', version: '2.3.0', worker: process.pid }));

// ── SCAN ──
app.post('/api/scan', scanLimiter, async (req, res) => {
  let { token, wallet, fingerprint } = req.body;
  if (!token) return res.status(400).json({ error: 'token_required' });

  // Fix lowercase addresses (DexScreener lowercases URLs)
  // Base58 is case-sensitive so we can't decode lowercase. Instead:
  // 1. Try RugCheck API (sometimes handles case-insensitive)
  // 2. Try Jupiter search by checking if any token's id matches case-insensitively
  // 3. Try Solana RPC getAccountInfo with original case (will fail for lowercase)
  if (token !== token.toLowerCase() || token.length < 32) {
    // Address has mixed case — proceed normally
  } else {
    // All lowercase — try to find correct case
    let resolved = false;
    try {
      // Method 1: Search Jupiter by symbol or partial match
      // Extract potential symbol from known patterns (e.g., ends with "pump")
      const jupSearch = await fetch(`https://api.jup.ag/tokens/v2/search?query=${token.slice(0, 8)}`, { signal: AbortSignal.timeout(5000) });
      if (jupSearch.ok) {
        const tokens = await jupSearch.json();
        if (Array.isArray(tokens)) {
          const match = tokens.find(t => t.id && t.id.toLowerCase() === token.toLowerCase());
          if (match) { token = match.id; resolved = true; }
        }
      }
    } catch {}

    if (!resolved) {
      // Method 2: Try RugCheck with original lowercase (some APIs handle it)
      try {
        const rcTest = await fetch(`${RUGCHECK_API}/tokens/${token}/report/summary`, { signal: AbortSignal.timeout(5000) });
        if (rcTest.ok) {
          const rcData = await rcTest.json();
          // RugCheck might return the correct-case address in response
          if (rcData.mint && rcData.mint.toLowerCase() === token) { token = rcData.mint; resolved = true; }
          else if (rcData.tokenMeta?.mint && rcData.tokenMeta.mint.toLowerCase() === token) { token = rcData.tokenMeta.mint; resolved = true; }
        }
      } catch {}
    }

    if (!resolved) {
      return res.status(400).json({
        error: 'invalid_address',
        message: 'Could not resolve lowercase address. Please provide the correct-case Solana address.',
        hint: 'DexScreener lowercases URLs. Copy the address from the token page instead.',
      });
    }
  }

  let billingType    = 'free_trial';
  let billingInfo    = {};
  let creditDeducted = false;

  if (wallet) {
    const bal = credits.getBalance(wallet);
    if (bal.balance >= SCAN_COST) {
      const deduct = credits.deductScan(wallet);
      if (deduct.ok) {
        billingType = 'credits';
        billingInfo = { balance: deduct.balance, scansRemaining: deduct.scansRemaining };
        creditDeducted = true;
      }
    }
  }

  if (billingType === 'free_trial') {
    const fp   = fingerprint || wallet || req.ip || 'anon';
    const user = getOrCreateUser(fp);
    const today = new Date().toDateString();
    if (user.lastReset !== today) { user.scansToday = 0; user.lastReset = today; }

    const daysSince = Math.floor((Date.now() - user.firstSeen) / 86400000);
    const totalFree = user.totalFreeScans || 0;

    // Trial over: expired OR daily limit OR total 30 scans used
    if (daysSince >= FREE_TRIAL_DAYS || user.scansToday >= FREE_SCANS_PER_DAY || totalFree >= FREE_TOTAL_MAX) {
      let reason, msg;
      if (daysSince >= FREE_TRIAL_DAYS) {
        reason = 'trial_expired';
        msg = 'Free trial ended. $0.01/scan — top up $1, $5, or $10.';
      } else if (totalFree >= FREE_TOTAL_MAX) {
        reason = 'total_limit';
        msg = `All ${FREE_TOTAL_MAX} free scans used. $0.01/scan — top up to continue.`;
      } else {
        reason = 'daily_limit';
        msg = `Daily limit (${FREE_SCANS_PER_DAY} scans) reached. Come back tomorrow or top up now.`;
      }
      return res.status(402).json({ error: reason, message: msg, payment: depositPayload() });
    }
    user.scansToday++;
    user.totalScans++;
    user.totalFreeScans = (user.totalFreeScans || 0) + 1;
    billingInfo = { freeScansLeft: FREE_SCANS_PER_DAY - user.scansToday, freeTotalLeft: FREE_TOTAL_MAX - user.totalFreeScans };
  }

  try {
    const result = await scoreTok(token);
    return res.json({ ...result, billing: { type: billingType, ...billingInfo } });
  } catch (e) {
    if (creditDeducted && wallet) { credits.refundScan(wallet); console.log(`[REFUND] $${SCAN_COST} → ${wallet}`); }
    console.error('[SCAN ERROR]', e.message);
    return res.status(500).json({ error: 'scan_failed', message: e.message });
  }
});

// ── CREDITS ──
app.get('/api/credits/:wallet', (req, res) => res.json(credits.getBalance(req.params.wallet)));

// ── TICKER RESOLUTION — $TICKER → mint address via Jupiter ──
const tickerCache = new Map();
const TICKER_CACHE_TTL = 10 * 60 * 1000; // 10 min

app.get('/api/resolve/:ticker', async (req, res) => {
  const ticker = req.params.ticker.toUpperCase().replace(/^\$/, '');
  if (!ticker || ticker.length < 1 || ticker.length > 20) {
    return res.status(400).json({ error: 'invalid_ticker' });
  }

  // Check cache
  const cached = tickerCache.get(ticker);
  if (cached && Date.now() - cached.timestamp < TICKER_CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const jupRes = await fetch(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(ticker)}`, {
      signal: AbortSignal.timeout(8000),
    });

    if (!jupRes.ok) {
      return res.status(502).json({ error: 'jupiter_api_error', status: jupRes.status });
    }

    const tokens = await jupRes.json();

    if (!tokens || tokens.length === 0) {
      return res.json({ found: false, ticker, mint: null });
    }

    // Find exact symbol match first, then fall back to first result
    const exact = tokens.find(t => t.symbol?.toUpperCase() === ticker);
    const best = exact || tokens[0];

    const data = {
      found: true,
      ticker,
      mint:      best.id,
      name:      best.name,
      symbol:    best.symbol,
      verified:  best.isVerified || false,
      tags:      best.tags || [],
      decimals:  best.decimals,
    };

    tickerCache.set(ticker, { data, timestamp: Date.now() });
    return res.json(data);

  } catch (e) {
    console.error('[TICKER RESOLVE]', ticker, e.message);
    return res.status(500).json({ error: 'resolve_failed', message: e.message });
  }
});

app.post('/api/payment/verify', paymentLimiter, async (req, res) => {
  const { txSignature, wallet } = req.body;
  if (!txSignature || !wallet) return res.status(400).json({ ok: false, error: 'txSignature and wallet required' });
  res.json(await credits.verifyDeposit(txSignature, wallet));
});

app.post('/api/credits/deposit', paymentLimiter, async (req, res) => {
  res.json(await credits.verifyDeposit(req.body.txSignature, req.body.wallet));
});

// ── SUBSCRIPTION ──
app.post('/api/subscription/activate', paymentLimiter, async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
  const result = credits.activateSubscription(wallet);
  if (!result.ok) return res.status(402).json(result);
  res.json(result);
});

app.get('/api/subscription/:wallet', (req, res) => {
  const bal = credits.getBalance(req.params.wallet);
  res.json({ subscription: bal.subscription, balance: bal.balance });
});

// ── AUTO-CHARGE SETTINGS ──
app.post('/api/settings/auto-charge', (req, res) => {
  const { wallet, enabled, amount } = req.body;
  if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
  res.json(credits.setAutoCharge(wallet, enabled, amount));
});

// ── PRICING INFO ──
app.get('/api/pricing', (req, res) => {
  res.json({
    freeTrial: { days: FREE_TRIAL_DAYS, scansPerDay: FREE_SCANS_PER_DAY, totalMax: FREE_TOTAL_MAX },
    payPerScan: SCAN_COST,
    topUp: { 1: '100 scans', 5: '500 scans', 10: '1000 scans' },
    subscription: { price: SUB_PRICE, scansIncluded: SUB_SCANS, period: '30 days', overageCost: SCAN_COST },
    autoCharge: { amounts: AUTO_CHARGE_AMOUNTS, default: 1 },
    currency: 'USDC', network: 'Solana',
    depositAddress: OWNER_WALLET,
  });
});

// ── SCORING ENGINE v3 — Production Grade ──
// Sources: Jupiter Token API V2, RugCheck, Solana RPC, GoldRush
// 12 checks, weighted scoring, hard caps for critical failures

async function scoreTok(mintAddress) {
  const cached = scanCache.get(mintAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.result;

  // Parallel fetch from 4 sources
  const [rcRes, rpcRes, grRes, jupRes] = await Promise.allSettled([
    fetch(`${RUGCHECK_API}/tokens/${mintAddress}/report`, { signal: AbortSignal.timeout(10000) })
      .then(r => (r.ok ? r.json() : null)),
    getRPCData(mintAddress),
    goldRush ? goldRush.getTokenHolders(mintAddress).catch(() => null) : Promise.resolve(null),
    fetch(`https://api.jup.ag/tokens/v2/search?query=${mintAddress}`, { signal: AbortSignal.timeout(8000) })
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  const rc      = rcRes.status  === 'fulfilled' ? rcRes.value  : null;
  const rpc     = rpcRes.status === 'fulfilled' ? rpcRes.value : {};
  const holders = grRes.status  === 'fulfilled' ? grRes.value  : null;
  const jupTokens = jupRes.status === 'fulfilled' ? jupRes.value : null;
  const jup     = Array.isArray(jupTokens) ? jupTokens.find(t => t.id === mintAddress) : null;

  let score   = 100;
  let hardCap = 100;
  const checks = [];
  const sources = { rugcheck: !!rc, rpc: !!rpc.supply, jupiter: !!jup, goldrush: !!holders };

  // ═══════════════════════════════════════
  // 1. RUGCHECK RISK SCORE (primary — up to −60)
  // ═══════════════════════════════════════
  if (rc && rc.score != null) {
    const penalty = rc.score < 100 ? 0 : rc.score < 300 ? 10 : rc.score < 700 ? 25 : rc.score < 2000 ? 40 : 60;
    score -= penalty;
    const lbl = rc.score < 100 ? 'Clean' : rc.score < 300 ? 'Low Risk' : rc.score < 700 ? 'Moderate Risk' : rc.score < 2000 ? 'High Risk' : 'Extreme Risk';
    checks.push({ name: 'RugCheck Score', pass: rc.score < 700, value: `${lbl} (${rc.score})`, weight: 'high', source: 'rugcheck' });
  } else {
    score -= 15;
    checks.push({ name: 'RugCheck Score', pass: false, value: 'Unavailable', weight: 'high', source: 'rugcheck' });
  }

  // ═══════════════════════════════════════
  // 2. MINT AUTHORITY (critical — hard cap)
  // ═══════════════════════════════════════
  const mintAuth = jup?.audit?.mintAuthorityDisabled ?? (rpc.mintAuthority === false ? true : rpc.mintAuthority === true ? false : null);
  if (mintAuth === false) {
    score -= 20; hardCap = Math.min(hardCap, 55);
    checks.push({ name: 'Mint Authority', pass: false, value: 'ACTIVE — team can print tokens', weight: 'critical', source: jup ? 'jupiter' : 'rpc' });
  } else if (mintAuth === true) {
    checks.push({ name: 'Mint Authority', pass: true, value: 'Disabled ✓', weight: 'critical', source: jup ? 'jupiter' : 'rpc' });
  } else {
    score -= 8;
    checks.push({ name: 'Mint Authority', pass: false, value: 'Unknown', weight: 'critical', source: 'none' });
  }

  // ═══════════════════════════════════════
  // 3. FREEZE AUTHORITY (critical — hard cap)
  // ═══════════════════════════════════════
  const freezeAuth = jup?.audit?.freezeAuthorityDisabled ?? (rpc.freezeAuthority === false ? true : rpc.freezeAuthority === true ? false : null);
  if (freezeAuth === false) {
    score -= 15; hardCap = Math.min(hardCap, 60);
    checks.push({ name: 'Freeze Authority', pass: false, value: 'ACTIVE — can freeze wallets', weight: 'critical', source: jup ? 'jupiter' : 'rpc' });
  } else if (freezeAuth === true) {
    checks.push({ name: 'Freeze Authority', pass: true, value: 'Disabled ✓', weight: 'critical', source: jup ? 'jupiter' : 'rpc' });
  } else {
    score -= 5;
    checks.push({ name: 'Freeze Authority', pass: false, value: 'Unknown', weight: 'critical', source: 'none' });
  }

  // ═══════════════════════════════════════
  // 4. JUPITER ORGANIC SCORE (trust signal)
  // ═══════════════════════════════════════
  if (jup && jup.organicScore != null) {
    const org = jup.organicScore;
    if (org >= 80)      { score += 5;  checks.push({ name: 'Organic Score', pass: true,  value: `${org.toFixed(0)}/100 — High`, weight: 'medium', source: 'jupiter' }); }
    else if (org >= 50) {              checks.push({ name: 'Organic Score', pass: true,  value: `${org.toFixed(0)}/100 — Moderate`, weight: 'medium', source: 'jupiter' }); }
    else if (org >= 20) { score -= 10; checks.push({ name: 'Organic Score', pass: false, value: `${org.toFixed(0)}/100 — Low`, weight: 'medium', source: 'jupiter' }); }
    else                { score -= 20; hardCap = Math.min(hardCap, 50); checks.push({ name: 'Organic Score', pass: false, value: `${org.toFixed(0)}/100 — Very Low (likely bot activity)`, weight: 'medium', source: 'jupiter' }); }
  }

  // ═══════════════════════════════════════
  // 5. JUPITER VERIFICATION STATUS
  // ═══════════════════════════════════════
  if (jup) {
    const verified = jup.isVerified || false;
    const tags = jup.tags || [];
    const isStrict = tags.includes('strict');
    if (verified && isStrict) { score += 5; checks.push({ name: 'Jupiter Verified', pass: true, value: 'Verified + Strict ✓', weight: 'medium', source: 'jupiter' }); }
    else if (verified)        {             checks.push({ name: 'Jupiter Verified', pass: true, value: 'Verified ✓', weight: 'medium', source: 'jupiter' }); }
    else                      { score -= 5; checks.push({ name: 'Jupiter Verified', pass: false, value: 'Not verified', weight: 'low', source: 'jupiter' }); }
  }

  // ═══════════════════════════════════════
  // 6. LIQUIDITY DEPTH
  // ═══════════════════════════════════════
  if (jup && jup.liquidity != null) {
    const liq = jup.liquidity;
    if (liq >= 500000)     { score += 3; checks.push({ name: 'Liquidity', pass: true,  value: `$${(liq/1e6).toFixed(2)}M — Deep`, weight: 'medium', source: 'jupiter' }); }
    else if (liq >= 50000) {             checks.push({ name: 'Liquidity', pass: true,  value: `$${(liq/1e3).toFixed(0)}K — Adequate`, weight: 'medium', source: 'jupiter' }); }
    else if (liq >= 5000)  { score -= 8; checks.push({ name: 'Liquidity', pass: false, value: `$${(liq/1e3).toFixed(1)}K — Thin`, weight: 'medium', source: 'jupiter' }); }
    else                   { score -= 15; hardCap = Math.min(hardCap, 45); checks.push({ name: 'Liquidity', pass: false, value: `$${liq.toFixed(0)} — Dangerously low`, weight: 'high', source: 'jupiter' }); }
  }

  // ═══════════════════════════════════════
  // 7. TOKEN AGE
  // ═══════════════════════════════════════
  if (jup?.firstPool?.createdAt) {
    const ageMs = Date.now() - new Date(jup.firstPool.createdAt).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays >= 180)    { score += 3; checks.push({ name: 'Token Age', pass: true,  value: `${Math.floor(ageDays/30)} months — Established`, weight: 'low', source: 'jupiter' }); }
    else if (ageDays >= 30){             checks.push({ name: 'Token Age', pass: true,  value: `${Math.floor(ageDays)} days`, weight: 'low', source: 'jupiter' }); }
    else if (ageDays >= 3) { score -= 5; checks.push({ name: 'Token Age', pass: false, value: `${Math.floor(ageDays)} days — New`, weight: 'low', source: 'jupiter' }); }
    else                   { score -= 12; checks.push({ name: 'Token Age', pass: false, value: `${Math.floor(ageDays * 24)} hours — Very new`, weight: 'medium', source: 'jupiter' }); }
  }

  // ═══════════════════════════════════════
  // 8. HOLDER COUNT
  // ═══════════════════════════════════════
  const holderCount = jup?.holderCount || null;
  if (holderCount != null) {
    if (holderCount >= 10000)    { score += 3; checks.push({ name: 'Holders', pass: true,  value: `${(holderCount/1e3).toFixed(1)}K — Strong community`, weight: 'medium', source: 'jupiter' }); }
    else if (holderCount >= 1000){             checks.push({ name: 'Holders', pass: true,  value: `${(holderCount/1e3).toFixed(1)}K`, weight: 'low', source: 'jupiter' }); }
    else if (holderCount >= 100) { score -= 5; checks.push({ name: 'Holders', pass: false, value: `${holderCount} — Small`, weight: 'low', source: 'jupiter' }); }
    else                         { score -= 10; checks.push({ name: 'Holders', pass: false, value: `${holderCount} — Very few`, weight: 'medium', source: 'jupiter' }); }
  }

  // ═══════════════════════════════════════
  // 9. TOP HOLDER CONCENTRATION
  // ═══════════════════════════════════════
  const topPct = jup?.audit?.topHoldersPercentage ?? (holders?.[0]?.balance_percentage || null);
  if (topPct != null) {
    if (topPct > 50)      { score -= 25; hardCap = Math.min(hardCap, 50); checks.push({ name: 'Top Holder %', pass: false, value: `${topPct.toFixed(1)}% — Whale dominance`, weight: 'high', source: jup ? 'jupiter' : 'goldrush' }); }
    else if (topPct > 25) { score -= 10; checks.push({ name: 'Top Holder %', pass: false, value: `${topPct.toFixed(1)}% — Concentrated`, weight: 'medium', source: jup ? 'jupiter' : 'goldrush' }); }
    else if (topPct > 10) {              checks.push({ name: 'Top Holder %', pass: true,  value: `${topPct.toFixed(1)}%`, weight: 'low', source: jup ? 'jupiter' : 'goldrush' }); }
    else                  { score += 3;  checks.push({ name: 'Top Holder %', pass: true,  value: `${topPct.toFixed(1)}% — Well distributed`, weight: 'low', source: jup ? 'jupiter' : 'goldrush' }); }
  }

  // ═══════════════════════════════════════
  // 10. CEX LISTINGS
  // ═══════════════════════════════════════
  if (jup?.cexes && jup.cexes.length > 0) {
    score += Math.min(5, jup.cexes.length);
    checks.push({ name: 'CEX Listed', pass: true, value: `${jup.cexes.join(', ')}`, weight: 'medium', source: 'jupiter' });
  }

  // ═══════════════════════════════════════
  // 11. HONEYPOT DETECTION (RugCheck flags)
  // ═══════════════════════════════════════
  if (rc && rc.risks && rc.risks.length > 0) {
    let honeypotDone = false;
    for (const risk of rc.risks.slice(0, 6)) {
      const name = risk.name || 'Risk';
      const isBad = ['danger', 'error', 'warn'].includes(risk.level);
      if (name.toLowerCase().includes('honeypot')) {
        if (!honeypotDone) { score -= 35; hardCap = Math.min(hardCap, 10); honeypotDone = true; }
        checks.push({ name: 'Honeypot', pass: false, value: 'DETECTED — do not buy', weight: 'critical', source: 'rugcheck' });
      } else if (isBad) {
        // Reduce penalty for low-risk flags on established/verified tokens
        const isLowRisk = name.toLowerCase().includes('mutable') || name.toLowerCase().includes('metadata');
        const isEstablished = jup?.isVerified || (jup?.holderCount || 0) > 5000;
        const penalty = (isLowRisk && isEstablished) ? 2 : 6;
        score -= penalty;
        checks.push({ name, pass: false, value: risk.description || risk.level, weight: 'low', source: 'rugcheck' });
      }
    }
    if (!honeypotDone) checks.push({ name: 'Honeypot', pass: true, value: 'Not detected', weight: 'high', source: 'rugcheck' });
  } else if (rc) {
    checks.push({ name: 'Honeypot', pass: true, value: 'Not detected', weight: 'high', source: 'rugcheck' });
  }

  // ═══════════════════════════════════════
  // 12. LP LOCK STATUS (RugCheck full report)
  // ═══════════════════════════════════════
  if (rc?.lockers && rc.lockers.length > 0) {
    checks.push({ name: 'LP Locked', pass: true, value: `${rc.lockers.length} locker(s) detected ✓`, weight: 'high', source: 'rugcheck' });
    score += 3;
  } else if (rc?.markets && rc.markets.length > 0) {
    // Don't penalize verified tokens with deep liquidity or CEX listings — LP lock is less relevant for them
    const isEstablished = (jup?.isVerified && (jup?.liquidity || 0) > 100000) || (jup?.cexes?.length > 0);
    if (isEstablished) {
      checks.push({ name: 'LP Locked', pass: true, value: 'Not locked (established token — low risk)', weight: 'low', source: 'rugcheck' });
    } else {
      score -= 12; hardCap = Math.min(hardCap, 55);
      checks.push({ name: 'LP Locked', pass: false, value: 'NOT LOCKED — LP can be pulled', weight: 'high', source: 'rugcheck' });
    }
  }

  // ═══════════════════════════════════════
  // 13. TOTAL MARKET LIQUIDITY (RugCheck)
  // ═══════════════════════════════════════
  if (rc?.totalMarketLiquidity != null && rc.totalMarketLiquidity > 0) {
    const tvl = rc.totalMarketLiquidity;
    if (tvl >= 500000)     { checks.push({ name: 'Pool TVL', pass: true,  value: `$${(tvl/1e6).toFixed(2)}M`, weight: 'medium', source: 'rugcheck' }); }
    else if (tvl >= 50000) { checks.push({ name: 'Pool TVL', pass: true,  value: `$${(tvl/1e3).toFixed(0)}K`, weight: 'medium', source: 'rugcheck' }); }
    else if (tvl >= 5000)  { checks.push({ name: 'Pool TVL', pass: false, value: `$${(tvl/1e3).toFixed(1)}K — Low`, weight: 'medium', source: 'rugcheck' }); }
    else                   { score -= 8; checks.push({ name: 'Pool TVL', pass: false, value: `$${tvl.toFixed(0)} — Extremely low`, weight: 'high', source: 'rugcheck' }); }
  }

  // ═══════════════════════════════════════
  // 14. CREATOR WALLET ANALYSIS
  // ═══════════════════════════════════════
  if (rc?.creator) {
    const creatorBal = rc.creator.balance || 0;
    const creatorAddr = rc.creator.address || '';
    if (creatorBal > 0) {
      // Creator still holds tokens
      const pctLabel = rc.creator.percentage ? `${rc.creator.percentage.toFixed(1)}%` : 'some';
      score -= 5;
      checks.push({ name: 'Creator Wallet', pass: false, value: `Holds ${pctLabel} of supply`, weight: 'medium', source: 'rugcheck' });
    } else if (creatorAddr) {
      checks.push({ name: 'Creator Wallet', pass: true, value: 'Empty — creator sold/transferred ✓', weight: 'low', source: 'rugcheck' });
    }
  }

  // ═══════════════════════════════════════
  // 15. INSIDER DETECTION (RugCheck graph)
  // ═══════════════════════════════════════
  if (rc?.graphInsidersDetected != null) {
    if (rc.graphInsidersDetected > 0) {
      score -= 10; hardCap = Math.min(hardCap, 55);
      checks.push({ name: 'Insider Wallets', pass: false, value: `${rc.graphInsidersDetected} insider(s) detected`, weight: 'high', source: 'rugcheck' });
    } else {
      checks.push({ name: 'Insider Wallets', pass: true, value: 'None detected ✓', weight: 'medium', source: 'rugcheck' });
    }
  }

  // ═══════════════════════════════════════
  // 16. TRANSFER FEE / HIDDEN TAX
  // ═══════════════════════════════════════
  const feePct = typeof rc?.transferFee === 'object' ? (rc.transferFee.pct || 0) : (rc?.transferFee || 0);
  if (feePct > 0) {
    if (feePct > 10) {
      score -= 20; hardCap = Math.min(hardCap, 30);
      checks.push({ name: 'Transfer Fee', pass: false, value: `${feePct}% — EXTREME hidden tax`, weight: 'critical', source: 'rugcheck' });
    } else if (feePct > 3) {
      score -= 10;
      checks.push({ name: 'Transfer Fee', pass: false, value: `${feePct}% — High tax`, weight: 'high', source: 'rugcheck' });
    } else {
      checks.push({ name: 'Transfer Fee', pass: false, value: `${feePct}%`, weight: 'low', source: 'rugcheck' });
    }
  } else if (rc) {
    checks.push({ name: 'Transfer Fee', pass: true, value: 'None ✓', weight: 'medium', source: 'rugcheck' });
  }

  // ═══════════════════════════════════════
  // 17. PREVIOUSLY RUGGED FLAG
  // ═══════════════════════════════════════
  if (rc?.rugged === true) {
    score -= 30; hardCap = Math.min(hardCap, 10);
    checks.push({ name: 'Rug History', pass: false, value: 'TOKEN WAS PREVIOUSLY RUGGED', weight: 'critical', source: 'rugcheck' });
  }

  // ═══════════════════════════════════════
  // 18. LP PROVIDER COUNT
  // ═══════════════════════════════════════
  if (rc?.totalLPProviders != null) {
    const lps = rc.totalLPProviders;
    if (lps >= 10)       { checks.push({ name: 'LP Providers', pass: true,  value: `${lps} — Distributed`, weight: 'low', source: 'rugcheck' }); }
    else if (lps >= 3)   { checks.push({ name: 'LP Providers', pass: true,  value: `${lps}`, weight: 'low', source: 'rugcheck' }); }
    else if (lps >= 1)   { score -= 5; checks.push({ name: 'LP Providers', pass: false, value: `${lps} — Single LP (rug risk)`, weight: 'medium', source: 'rugcheck' }); }
  }

  // ═══════════════════════════════════════
  // 19. MARKET CAP / FDV RATIO
  // ═══════════════════════════════════════
  if (jup?.mcap && jup?.fdv && jup.fdv > 0) {
    const ratio = jup.mcap / jup.fdv;
    const mcapStr = jup.mcap > 1e9 ? `$${(jup.mcap/1e9).toFixed(2)}B` : jup.mcap > 1e6 ? `$${(jup.mcap/1e6).toFixed(2)}M` : `$${(jup.mcap/1e3).toFixed(0)}K`;
    if (ratio >= 0.8)      { checks.push({ name: 'Market Cap', pass: true, value: `${mcapStr} (${(ratio*100).toFixed(0)}% circ.)`, weight: 'low', source: 'jupiter' }); }
    else if (ratio >= 0.3) { checks.push({ name: 'Market Cap', pass: true, value: `${mcapStr} (${(ratio*100).toFixed(0)}% circ.)`, weight: 'low', source: 'jupiter' }); }
    else                   { score -= 5; checks.push({ name: 'Market Cap', pass: false, value: `${mcapStr} (only ${(ratio*100).toFixed(0)}% circ. — dilution risk)`, weight: 'low', source: 'jupiter' }); }
  }

  // ═══════════════════════════════════════
  // SAFETY NET: If no data at all → cap hard
  // ═══════════════════════════════════════
  const dataSourceCount = Object.values(sources).filter(Boolean).length;
  if (dataSourceCount === 0) hardCap = Math.min(hardCap, 30);
  else if (dataSourceCount === 1) hardCap = Math.min(hardCap, 55);

  score = Math.round(Math.max(0, Math.min(hardCap, score)));
  const verdict = score >= 75 ? 'SECURE' : score >= 55 ? 'MODERATE' : score >= 35 ? 'WARNING' : 'DANGER';

  const result = {
    score, verdict,
    tier: score >= 75 ? 'safe' : score >= 55 ? 'caution' : score >= 35 ? 'warning' : 'danger',
    address: mintAddress,
    name: jup?.name || null,
    symbol: jup?.symbol || null,
    checks,
    sources,
    details: {
      mintAuthDisabled:    mintAuth,
      freezeAuthDisabled:  freezeAuth,
      rugcheckRaw:         rc?.score ?? null,
      organicScore:        jup?.organicScore ?? null,
      liquidity:           jup?.liquidity ?? null,
      holderCount:         holderCount,
      mcap:                jup?.mcap ?? null,
      verified:            jup?.isVerified ?? null,
      cexes:               jup?.cexes ?? [],
      lpLocked:            rc?.lockers?.length > 0,
      totalMarketLiquidity: rc?.totalMarketLiquidity ?? null,
      insidersDetected:    rc?.graphInsidersDetected ?? null,
      transferFee:         rc?.transferFee ?? null,
      rugged:              rc?.rugged ?? false,
      lpProviders:         rc?.totalLPProviders ?? null,
      creator:             rc?.creator?.address ?? null,
    },
  };

  scanCache.set(mintAddress, { result, timestamp: Date.now() });
  return result;
}

async function getRPCData(mintAddress) {
  if (!connection) return {};
  try {
    const mint   = new PublicKey(mintAddress);
    const info   = await connection.getParsedAccountInfo(mint);
    const parsed = info.value?.data?.parsed?.info;
    if (!parsed) return {};
    return {
      mintAuthority:   parsed.mintAuthority   ?? null,
      freezeAuthority: parsed.freezeAuthority ?? null,
      supply:          parsed.supply          ?? null,
      decimals:        parsed.decimals        ?? null,
    };
  } catch (e) {
    console.error('[RPC]', mintAddress, e.message);
    return {};
  }
}

app.listen(PORT, () => {
  console.log(`⛨  Worker ${process.pid} on :${PORT}`);
});
