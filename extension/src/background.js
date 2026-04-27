/**
 * SHIELD — Background Service Worker v3.0
 * Production hardening:
 *   1. Retry with backoff on all API calls
 *   2. Server health awareness — skip calls when server is down
 *   3. Connection state tracking — detect and recover from extension context invalidation
 *   4. Timeout handling on all fetches
 *   5. Queue management — prevent duplicate scans
 */

const SHIELD_API         = 'https://shield-production-8awh.onrender.com';
const COST_PER_SCAN      = 0.01;
const FREE_SCANS_PER_DAY = 10;
const FREE_TRIAL_DAYS    = 3;
const FREE_TOTAL_MAX     = 30;

// ── Server health state ──
let serverHealthy = true;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 60000; // 1 min

async function checkServerHealth() {
  if (Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL) return serverHealthy;
  try {
    const res = await fetch(SHIELD_API + '/health', { signal: AbortSignal.timeout(5000) });
    serverHealthy = res.ok;
    lastHealthCheck = Date.now();
  } catch {
    serverHealthy = false;
    lastHealthCheck = Date.now();
  }
  return serverHealthy;
}

// ── Retry with exponential backoff ──
async function fetchRetry(url, options = {}, { retries = 2, baseDelay = 800, timeout = 10000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// ── Dedup: prevent same token being scanned twice simultaneously ──
const pendingScans = new Map(); // token → Promise

// ── Install ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    shieldEnabled: true, shieldSwapWarnings: true,
    scannedCount: 0, totalSpent: 0, rugsDodged: 0,
    shieldInstallDate: Date.now(), shieldThreshold: 30,
    shieldWalletConnected: false, shieldWalletAddr: '',
    shieldHeliusKey: '', shieldExcludedSites: '',
    freeDailyUsed: 0, freeTotalUsed: 0, freeLastReset: new Date().toDateString(),
    autoCharge: false, autoChargeAmount: 1,
  });
  console.log('[SHIELD] Installed — 3-day free trial.');
});

// ── Pre-warm ──
function warmServer() { fetch(SHIELD_API + '/', { signal: AbortSignal.timeout(5000) }).catch(() => {}); }
warmServer();
chrome.runtime.onStartup?.addListener(warmServer);
chrome.alarms.create('shield-server-warm', { periodInMinutes: 4 });


// ═══════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── DO_SCAN ──
  if (msg.type === 'DO_SCAN') {
    (async () => {
      try {
        const d = await chrome.storage.local.get([
          'shieldWalletAddr', 'shieldWalletConnected', 'shieldEnabled',
        ]);
        if (!d.shieldEnabled) { sendResponse({ error: 'disabled' }); return; }

        // Check if server is reachable
        const healthy = await checkServerHealth();
        if (!healthy) {
          sendResponse({ error: 'server_down', message: 'Shield server temporarily unavailable. Retrying...', retryAfter: 10 });
          return;
        }

        // Dedup: if same token is already being scanned, wait for that result
        if (pendingScans.has(msg.token)) {
          try {
            const existing = await pendingScans.get(msg.token);
            sendResponse(existing);
          } catch { sendResponse({ error: 'scan_failed' }); }
          return;
        }

        const wallet = d.shieldWalletConnected ? d.shieldWalletAddr : null;
        const fp = msg.fingerprint || 'bg_' + Date.now();

        const scanPromise = (async () => {
          const res = await fetchRetry(`${SHIELD_API}/api/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: msg.token, wallet, fingerprint: fp }),
          }, { retries: 2, timeout: 15000 });

          if (res.status === 402) {
            const errData = await res.json().catch(() => ({}));
            return { blocked: true, reason: errData.error, message: errData.message, payment: errData.payment };
          }
          if (res.status === 429) {
            const errData = await res.json().catch(() => ({}));
            return { error: 'rate_limited', message: errData.message || 'Too many requests', retryAfter: errData.retryAfter || 60 };
          }
          if (res.status === 503) {
            serverHealthy = false;
            return { error: 'server_down', message: 'Server restarting. Retry shortly.', retryAfter: 10 };
          }
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            return { error: 'scan_failed', message: errData.message, retryAfter: errData.retryAfter || 5 };
          }

          const data = await res.json();
          return { ok: true, data };
        })();

        pendingScans.set(msg.token, scanPromise);

        try {
          const result = await scanPromise;
          sendResponse(result);

          // Update counters for successful scans
          if (result.ok && result.data) {
            const s = await chrome.storage.local.get(['scannedCount', 'totalSpent', 'freeDailyUsed', 'rugsDodged']);
            const updates = { scannedCount: (s.scannedCount || 0) + 1 };
            if (result.data.billing?.type === 'credits') {
              updates.totalSpent = Math.round(((s.totalSpent || 0) + COST_PER_SCAN) * 100) / 100;
            } else {
              updates.freeDailyUsed = (s.freeDailyUsed || 0) + 1;
            }
            if (result.data.score < 30) updates.rugsDodged = (s.rugsDodged || 0) + 1;
            chrome.storage.local.set(updates);
          }
        } finally {
          // Remove from pending after a short delay (allow near-simultaneous requests to dedup)
          setTimeout(() => pendingScans.delete(msg.token), 2000);
        }

      } catch (e) {
        console.error('[SHIELD] Scan error:', e.message);
        sendResponse({ error: e.message || 'Network error', retryAfter: 5 });
      }
    })();
    return true;
  }

  // ── GET_BALANCE ──
  if (msg.type === 'GET_BALANCE') {
    fetchRetry(`${SHIELD_API}/api/credits/${msg.wallet}`, {}, { retries: 1, timeout: 8000 })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // ── VERIFY_PAYMENT ──
  if (msg.type === 'VERIFY_PAYMENT') {
    fetchRetry(`${SHIELD_API}/api/payment/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txSignature: msg.txSignature, wallet: msg.wallet }),
    }, { retries: 3, timeout: 15000 })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // ── CAN_SCAN ──
  if (msg.type === 'CAN_SCAN') {
    (async () => {
      const d = await chrome.storage.local.get([
        'shieldInstallDate', 'shieldWalletConnected',
        'freeDailyUsed', 'freeTotalUsed', 'freeLastReset', 'shieldEnabled',
      ]);
      if (!d.shieldEnabled) return sendResponse({ allowed: false, reason: 'disabled' });
      const daysSince = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
      const trialActive = daysSince < FREE_TRIAL_DAYS;
      const today = new Date().toDateString();
      let dailyUsed = d.freeDailyUsed || 0;
      let totalUsed = d.freeTotalUsed || 0;
      if (d.freeLastReset !== today) { dailyUsed = 0; chrome.storage.local.set({ freeDailyUsed: 0, freeLastReset: today }); }
      if (trialActive && dailyUsed < FREE_SCANS_PER_DAY && totalUsed < FREE_TOTAL_MAX) {
        return sendResponse({ allowed: true, free: true, remaining: FREE_SCANS_PER_DAY - dailyUsed, totalRemaining: FREE_TOTAL_MAX - totalUsed });
      }
      if (d.shieldWalletConnected) return sendResponse({ allowed: true, free: false });
      return sendResponse({ allowed: false, reason: 'limit_reached' });
    })();
    return true;
  }

  // ── SCAN_DONE ──
  if (msg.type === 'SCAN_DONE') {
    (async () => {
      const d = await chrome.storage.local.get(['scannedCount', 'totalSpent', 'freeDailyUsed']);
      const updates = { scannedCount: (d.scannedCount || 0) + 1 };
      if (msg.free) updates.freeDailyUsed = (d.freeDailyUsed || 0) + 1;
      else updates.totalSpent = Math.round(((d.totalSpent || 0) + COST_PER_SCAN) * 100) / 100;
      chrome.storage.local.set(updates);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── RUG_SAVED ──
  if (msg.type === 'RUG_SAVED') {
    (async () => {
      const d = await chrome.storage.local.get(['rugsDodged']);
      chrome.storage.local.set({ rugsDodged: (d.rugsDodged || 0) + 1 });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── GET_STATS ──
  if (msg.type === 'GET_STATS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  // ── RESOLVE_TICKER ──
  if (msg.type === 'RESOLVE_TICKER') {
    (async () => {
      try {
        const ticker = (msg.ticker || '').toUpperCase().replace(/^\$/, '');
        if (!ticker || ticker.length > 20) { sendResponse({ found: false }); return; }
        const res = await fetchRetry(`${SHIELD_API}/api/resolve/${encodeURIComponent(ticker)}`, {}, { retries: 2, timeout: 8000 });
        sendResponse(await res.json());
      } catch (e) {
        console.error('[SHIELD] Ticker resolve error:', e.message);
        sendResponse({ found: false });
      }
    })();
    return true;
  }

  // ── RESOLVE_DEXSCREENER — stablecoin-aware pair→token resolve ──
  if (msg.type === 'RESOLVE_DEXSCREENER') {
    (async () => {
      try {
        const STABLES = new Set([
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
          'So11111111111111111111111111111111111111112',     // SOL/WSOL
          '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
          'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
        ]);

        const res = await fetchRetry(`https://api.dexscreener.com/latest/dex/pairs/solana/${msg.pairAddress}`, {}, { retries: 2, timeout: 8000 });
        if (!res.ok) { sendResponse({ tokenAddress: null }); return; }
        const data = await res.json();
        const pair = data?.pair || data?.pairs?.[0];
        if (!pair) { sendResponse({ tokenAddress: null }); return; }

        const base  = pair.baseToken;
        const quote = pair.quoteToken;

        // If baseToken is a stablecoin/SOL, the interesting token is quoteToken
        // If quoteToken is a stablecoin/SOL, the interesting token is baseToken
        let tokenAddr, tokenSymbol, tokenName;
        if (base?.address && !STABLES.has(base.address)) {
          tokenAddr = base.address; tokenSymbol = base.symbol; tokenName = base.name;
        } else if (quote?.address && !STABLES.has(quote.address)) {
          tokenAddr = quote.address; tokenSymbol = quote.symbol; tokenName = quote.name;
        } else {
          // Both are stablecoins/SOL — this is a stable pair like SOL/USDC
          sendResponse({ tokenAddress: null, isStablePair: true, base: base?.symbol, quote: quote?.symbol });
          return;
        }

        sendResponse(tokenAddr
          ? { tokenAddress: tokenAddr, symbol: tokenSymbol, name: tokenName }
          : { tokenAddress: null });
      } catch (e) {
        console.error('[SHIELD] DexScreener error:', e.message);
        sendResponse({ tokenAddress: null });
      }
    })();
    return true;
  }

  // ── RESOLVE_AND_SCAN ──
  if (msg.type === 'RESOLVE_AND_SCAN') {
    (async () => {
      try {
        const ticker = (msg.ticker || '').toUpperCase().replace(/^\$/, '');
        if (!ticker) { sendResponse({ mint: null }); return; }
        const resolveRes = await fetchRetry(`${SHIELD_API}/api/resolve/${encodeURIComponent(ticker)}`, {}, { retries: 2, timeout: 6000 });
        const resolveData = await resolveRes.json();
        if (!resolveData.found || !resolveData.mint) { sendResponse({ mint: null }); return; }
        const mint = resolveData.mint;
        const d = await chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected']);
        const wallet = d.shieldWalletConnected ? d.shieldWalletAddr : null;
        const fp = msg.fingerprint || 'ticker_' + Date.now();
        const scanRes = await fetchRetry(`${SHIELD_API}/api/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: mint, wallet, fingerprint: fp }),
        }, { retries: 2, timeout: 15000 });
        if (!scanRes.ok) { sendResponse({ mint, data: null }); return; }
        sendResponse({ mint, data: await scanRes.json() });
      } catch (e) {
        console.error('[SHIELD] Resolve+scan error:', e.message);
        sendResponse({ mint: null });
      }
    })();
    return true;
  }

  // ── CHECK_TRIAL ──
  if (msg.type === 'CHECK_TRIAL') {
    (async () => {
      const d = await chrome.storage.local.get([
        'shieldInstallDate', 'trialEndedNotified', 'trialEndingSoonNotified',
        'shieldWalletConnected', 'shieldWalletAddr', 'freeDailyUsed', 'freeTotalUsed',
      ]);
      const daysSince = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
      const totalUsed = d.freeTotalUsed || 0;

      if (daysSince >= 2 && !d.trialEndingSoonNotified && totalUsed >= 25) {
        chrome.storage.local.set({ trialEndingSoonNotified: true });
        chrome.notifications.create('shield-trial-ending', {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: '\u26E8 Shield — Trial Ending Soon',
          message: `${FREE_TOTAL_MAX - totalUsed} free scans left. Connect wallet to top up.`,
        });
      }

      if ((daysSince >= FREE_TRIAL_DAYS || totalUsed >= FREE_TOTAL_MAX) && !d.trialEndedNotified) {
        chrome.storage.local.set({ trialEndedNotified: true });
        chrome.notifications.create('shield-trial-ended', {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: '\u26E8 Shield — Free Trial Ended',
          message: 'Top up $1 USDC for 100 more scans.',
        });
      }

      if (d.shieldWalletConnected && d.shieldWalletAddr) {
        try {
          const balRes = await fetchRetry(`${SHIELD_API}/api/credits/${d.shieldWalletAddr}`, {}, { retries: 1, timeout: 8000 });
          const bal = await balRes.json();
          if (bal.lowBalance && bal.scansRemaining > 0) {
            const { lowBalanceNotified } = await chrome.storage.local.get(['lowBalanceNotified']);
            if (!lowBalanceNotified) {
              chrome.storage.local.set({ lowBalanceNotified: true });
              chrome.notifications.create('shield-low-balance', {
                type: 'basic', iconUrl: 'icons/icon128.png',
                title: '\u26E8 Shield — Low Balance',
                message: `${bal.scansRemaining} scans left ($${bal.balance.toFixed(2)}).`,
              });
            }
          } else if (bal.empty) {
            chrome.notifications.create('shield-empty-balance', {
              type: 'basic', iconUrl: 'icons/icon128.png',
              title: '\u26E8 Shield — Credits Empty',
              message: 'Deposit USDC to continue. $1 = 100 scans.',
            });
          } else if (!bal.lowBalance) {
            chrome.storage.local.set({ lowBalanceNotified: false });
          }
        } catch {}
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // ── SERVER_STATUS — let content scripts check health ──
  if (msg.type === 'SERVER_STATUS') {
    checkServerHealth().then(healthy => sendResponse({ healthy, lastCheck: lastHealthCheck }));
    return true;
  }
});


// ── Alarms ──
chrome.alarms.create('shield-notification-check', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'shield-server-warm') warmServer();
  if (alarm.name === 'shield-notification-check') {
    chrome.storage.local.get(['shieldWalletConnected', 'shieldWalletAddr'], async (d) => {
      if (!d.shieldWalletConnected || !d.shieldWalletAddr) return;
      try {
        const res = await fetchRetry(`${SHIELD_API}/api/credits/${d.shieldWalletAddr}`, {}, { retries: 1, timeout: 8000 });
        const bal = await res.json();
        if (bal.empty) chrome.notifications.create('shield-empty-periodic', { type: 'basic', iconUrl: 'icons/icon128.png', title: '\u26E8 Shield — Credits Empty', message: 'Deposit $1 USDC for 100 scans.' });
        else if (bal.lowBalance) chrome.notifications.create('shield-low-periodic', { type: 'basic', iconUrl: 'icons/icon128.png', title: '\u26E8 Shield — Running Low', message: `${bal.scansRemaining} scans remaining.` });
      } catch {}
    });
  }
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('shield-')) {
    chrome.action.openPopup?.() || chrome.tabs.create({ url: 'src/popup.html' });
  }
});
