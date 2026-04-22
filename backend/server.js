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
const { CreditSystem, SCAN_COST } = require('./credits');
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
    userState.set(fp, { firstSeen: Date.now(), scansToday: 0, lastReset: new Date().toDateString(), totalScans: 0 });
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
    pricing: { '$1': '100 scans', '$5': '500 scans', '$10': '1000 scans' },
  };
}

// ── Routes ──
app.get('/', (req, res) => res.json({ status: 'live', service: 'Shield API', version: '2.2.0', worker: process.pid }));

// ── SCAN ──
app.post('/api/scan', scanLimiter, async (req, res) => {
  const { token, wallet, fingerprint } = req.body;
  if (!token) return res.status(400).json({ error: 'token_required' });

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
    if (daysSince >= FREE_TRIAL_DAYS || user.scansToday >= FREE_SCANS_PER_DAY) {
      const reason = daysSince >= FREE_TRIAL_DAYS ? 'trial_expired' : 'daily_limit';
      const msg    = daysSince >= FREE_TRIAL_DAYS
        ? 'Free trial ended. Deposit USDC to continue.'
        : `Daily limit (${FREE_SCANS_PER_DAY} scans) reached.`;
      return res.status(402).json({ error: reason, message: msg, payment: depositPayload() });
    }
    user.scansToday++;
    user.totalScans++;
    billingInfo = { freeScansLeft: FREE_SCANS_PER_DAY - user.scansToday };
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

app.post('/api/payment/verify', paymentLimiter, async (req, res) => {
  const { txSignature, wallet } = req.body;
  if (!txSignature || !wallet) return res.status(400).json({ ok: false, error: 'txSignature and wallet required' });
  res.json(await credits.verifyDeposit(txSignature, wallet));
});

app.post('/api/credits/deposit', paymentLimiter, async (req, res) => {
  res.json(await credits.verifyDeposit(req.body.txSignature, req.body.wallet));
});

// ── SCORING ENGINE ──
async function scoreTok(mintAddress) {
  const cached = scanCache.get(mintAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.result;

  const [rcRes, rpcRes, grRes] = await Promise.allSettled([
    fetch(`${RUGCHECK_API}/tokens/${mintAddress}/report/summary`, { signal: AbortSignal.timeout(8000) })
      .then(r => (r.ok ? r.json() : null)),
    getRPCData(mintAddress),
    goldRush ? goldRush.getTokenHolders(mintAddress).catch(() => null) : Promise.resolve(null),
  ]);

  const rc      = rcRes.status  === 'fulfilled' ? rcRes.value  : null;
  const rpc     = rpcRes.status === 'fulfilled' ? rpcRes.value : {};
  const holders = grRes.status  === 'fulfilled' ? grRes.value  : null;

  let score   = 100;
  let hardCap = 100;
  const checks = [];

  // 1. RugCheck (primary — up to −60 pts)
  if (rc && rc.score != null) {
    score -= Math.min(60, Math.floor(rc.score / 33));
    const lbl = rc.score < 100 ? 'Clean' : rc.score < 500 ? 'Caution' : rc.score < 2000 ? 'High Risk' : 'Extreme Risk';
    checks.push(['RugCheck', rc.score < 500, `${lbl} (${rc.score})`]);
  } else {
    score -= 30;
    checks.push(['RugCheck', false, 'Unavailable (−30)']);
  }

  // 2. Mint Authority — Active → −20 + cap 60 | Unknown (RPC down) → −10
  const mintAuth = rpc.mintAuthority ?? null;
  if      (mintAuth === true) { score -= 20; hardCap = Math.min(hardCap, 60); checks.push(['Mint Authority', false, 'Active — can mint']); }
  else if (mintAuth === null) { score -= 10;                                  checks.push(['Mint Authority', false, 'Unknown (RPC failed)']); }
  else                                                                         checks.push(['Mint Authority', true,  'Revoked ✓']);

  // 3. Freeze Authority — Active → −15 + cap 65 | Unknown → −5
  const freezeAuth = rpc.freezeAuthority ?? null;
  if      (freezeAuth === true) { score -= 15; hardCap = Math.min(hardCap, 65); checks.push(['Freeze Authority', false, 'Active — can freeze']); }
  else if (freezeAuth === null) { score -= 5;                                   checks.push(['Freeze Authority', false, 'Unknown (RPC failed)']); }
  else                                                                           checks.push(['Freeze Authority', true,  'Revoked ✓']);

  // All APIs down → cap at WARNING, never SECURE with zero data
  if (rc === null && mintAuth === null && freezeAuth === null) hardCap = Math.min(hardCap, 45);

  // 4. Supply (informational)
  if (rpc.supply != null && rpc.decimals != null) {
    const n = parseFloat(rpc.supply) / Math.pow(10, rpc.decimals);
    const lbl = n > 1e12 ? (n/1e12).toFixed(1)+'T' : n > 1e9 ? (n/1e9).toFixed(1)+'B' : n > 1e6 ? (n/1e6).toFixed(1)+'M' : n.toLocaleString();
    checks.push(['Supply', true, lbl]);
  }

  // 5. Top holder — >50% → −25 + cap 55 | >25% → −10
  if (holders && holders.length > 0) {
    const topPct = holders[0]?.balance_percentage || 0;
    if      (topPct > 50) { score -= 25; hardCap = Math.min(hardCap, 55); checks.push(['Top Holder', false, `${topPct.toFixed(1)}% — whale alert`]); }
    else if (topPct > 25) { score -= 10;                                   checks.push(['Top Holder', false, `${topPct.toFixed(1)}% — concentrated`]); }
    else                                                                    checks.push(['Top Holder', true,  `${topPct.toFixed(1)}%`]);
  }

  // 6. RugCheck risk flags — honeypot → −30 + cap 15 | danger → −8
  if (rc && rc.risks && rc.risks.length > 0) {
    let honeypotDone = false;
    for (const risk of rc.risks.slice(0, 5)) {
      const name  = risk.name || 'Risk';
      const isBad = ['danger', 'error', 'warn'].includes(risk.level);
      if (name.toLowerCase().includes('honeypot')) {
        if (!honeypotDone) { score -= 30; hardCap = Math.min(hardCap, 15); honeypotDone = true; }
        checks.push(['Honeypot', false, 'DETECTED — do not buy']);
      } else {
        if (isBad) score -= 8;
        checks.push([name, !isBad, risk.description || risk.level]);
      }
    }
    if (!honeypotDone) checks.push(['Honeypot', true, 'Not detected']);
  } else if (rc) {
    checks.push(['Honeypot', true, 'Not detected']);
  }

  score = Math.round(Math.max(0, Math.min(hardCap, score)));
  const verdict = score >= 70 ? 'SECURE' : score >= 50 ? 'CAUTION' : score >= 30 ? 'WARNING' : 'DANGER';

  const result = {
    score, verdict,
    tier: score >= 70 ? 'safe' : score >= 50 ? 'caution' : score >= 30 ? 'warning' : 'danger',
    address: mintAddress, checks,
    details: { mintAuthActive: !!mintAuth, freezeAuthActive: !!freezeAuth, rugcheckRaw: rc?.score ?? null },
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
