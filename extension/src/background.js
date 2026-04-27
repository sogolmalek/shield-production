/**
 * SHIELD — Background Service Worker
 * KEY FIX: All API fetch calls go through here (service worker has no CSP restrictions).
 * Content scripts send messages → background fetches → sends result back.
 */

const SHIELD_API         = 'https://shield-production-8awh.onrender.com';
const COST_PER_SCAN      = 0.01;
const FREE_SCANS_PER_DAY = 10;
const FREE_TRIAL_DAYS    = 3;
const FREE_TOTAL_MAX     = 30;  // total free scans across entire trial

// ── Install ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    shieldEnabled:         true,
    shieldSwapWarnings:    true,
    scannedCount:          0,
    totalSpent:            0,
    rugsDodged:            0,
    shieldInstallDate:     Date.now(),
    shieldThreshold:       30,
    shieldWalletConnected: false,
    shieldWalletAddr:      '',
    shieldHeliusKey:       '',
    shieldExcludedSites:   '',
    freeDailyUsed:         0,
    freeTotalUsed:         0,
    freeLastReset:         new Date().toDateString(),
    autoCharge:            false,
    autoChargeAmount:      1,
  });
  console.log('[SHIELD] Installed — 3-day free trial (10 scans/day, 30 total).');
});

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Wrap in async IIFE to properly handle sendResponse
  if (msg.type === 'DO_SCAN') {
    (async () => {
      try {
        const d = await chrome.storage.local.get([
          'shieldWalletAddr', 'shieldWalletConnected', 'shieldEnabled',
          'shieldInstallDate', 'freeDailyUsed', 'freeLastReset',
        ]);

        if (!d.shieldEnabled) {
          sendResponse({ error: 'disabled' });
          return;
        }

        const wallet = d.shieldWalletConnected ? d.shieldWalletAddr : null;
        const fp     = msg.fingerprint || 'bg_' + Date.now();

        const res = await fetch(`${SHIELD_API}/api/scan`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token: msg.token, wallet, fingerprint: fp }),
        });

        if (res.status === 402) {
          const errData = await res.json().catch(() => ({}));
          sendResponse({ blocked: true, reason: errData.error, message: errData.message, payment: errData.payment });
          return;
        }

        if (!res.ok) {
          sendResponse({ error: 'scan_failed' });
          return;
        }

        const data = await res.json();

        // Update counters (fire and forget)
        const s = await chrome.storage.local.get(['scannedCount', 'totalSpent', 'freeDailyUsed', 'rugsDodged']);
        const updates = { scannedCount: (s.scannedCount || 0) + 1 };
        if (data.billing?.type === 'credits') {
          updates.totalSpent = Math.round(((s.totalSpent || 0) + COST_PER_SCAN) * 100) / 100;
        } else {
          updates.freeDailyUsed = (s.freeDailyUsed || 0) + 1;
        }
        if (data.score < 30) updates.rugsDodged = (s.rugsDodged || 0) + 1;
        chrome.storage.local.set(updates);

        sendResponse({ ok: true, data });

      } catch (e) {
        console.error('[SHIELD] Scan fetch error:', e.message);
        sendResponse({ error: e.message });
      }
    })();
    return true; // keep message channel open for async
  }

  if (msg.type === 'GET_BALANCE') {
    fetch(`${SHIELD_API}/api/credits/${msg.wallet}`)
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e  => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'VERIFY_PAYMENT') {
    fetch(`${SHIELD_API}/api/payment/verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ txSignature: msg.txSignature, wallet: msg.wallet }),
    })
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e  => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'CAN_SCAN') {
    (async () => {
      const d = await chrome.storage.local.get([
        'shieldInstallDate', 'shieldWalletConnected',
        'freeDailyUsed', 'freeTotalUsed', 'freeLastReset', 'shieldEnabled',
      ]);
      if (!d.shieldEnabled) return sendResponse({ allowed: false, reason: 'disabled' });
      const daysSince   = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
      const trialActive = daysSince < FREE_TRIAL_DAYS;
      const today       = new Date().toDateString();
      let dailyUsed     = d.freeDailyUsed || 0;
      let totalUsed     = d.freeTotalUsed || 0;
      if (d.freeLastReset !== today) {
        dailyUsed = 0;
        chrome.storage.local.set({ freeDailyUsed: 0, freeLastReset: today });
      }
      if (trialActive && dailyUsed < FREE_SCANS_PER_DAY && totalUsed < FREE_TOTAL_MAX) {
        return sendResponse({ allowed: true, free: true, remaining: FREE_SCANS_PER_DAY - dailyUsed, totalRemaining: FREE_TOTAL_MAX - totalUsed });
      }
      if (d.shieldWalletConnected) return sendResponse({ allowed: true, free: false });
      return sendResponse({ allowed: false, reason: 'limit_reached' });
    })();
    return true;
  }

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

  if (msg.type === 'RUG_SAVED') {
    (async () => {
      const d = await chrome.storage.local.get(['rugsDodged']);
      chrome.storage.local.set({ rugsDodged: (d.rugsDodged || 0) + 1 });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'GET_STATS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  // ── RESOLVE_TICKER — $TICKER → mint address via backend (Jupiter API) ──
  if (msg.type === 'RESOLVE_TICKER') {
    (async () => {
      try {
        const ticker = (msg.ticker || '').toUpperCase().replace(/^\$/, '');
        if (!ticker || ticker.length < 1 || ticker.length > 20) {
          sendResponse({ found: false });
          return;
        }
        const res = await fetch(`${SHIELD_API}/api/resolve/${encodeURIComponent(ticker)}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        sendResponse(data);
      } catch (e) {
        console.error('[SHIELD] Ticker resolve error:', e.message);
        sendResponse({ found: false });
      }
    })();
    return true;
  }

  // ── RESOLVE_DEXSCREENER — pair address → token address ──
  if (msg.type === 'RESOLVE_DEXSCREENER') {
    (async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${msg.pairAddress}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) { sendResponse({ tokenAddress: null }); return; }
        const data = await res.json();
        const pair = data?.pair || data?.pairs?.[0];
        if (pair?.baseToken?.address) {
          sendResponse({ tokenAddress: pair.baseToken.address, symbol: pair.baseToken.symbol, name: pair.baseToken.name });
        } else {
          sendResponse({ tokenAddress: null });
        }
      } catch (e) {
        console.error('[SHIELD] DexScreener resolve error:', e.message);
        sendResponse({ tokenAddress: null });
      }
    })();
    return true;
  }

  // ── TRIAL_ENDED notification ──
  if (msg.type === 'CHECK_TRIAL') {
    (async () => {
      const d = await chrome.storage.local.get(['shieldInstallDate', 'trialEndedNotified']);
      const daysSince = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
      if (daysSince >= FREE_TRIAL_DAYS && !d.trialEndedNotified) {
        chrome.storage.local.set({ trialEndedNotified: true });
        chrome.notifications.create('shield-trial-ended', {
          type:    'basic',
          iconUrl: 'icons/icon128.png',
          title:   '⛨ Shield — Free Trial Ended',
          message: 'Top up $1 USDC to keep scanning. $0.01 per scan, no subscription.',
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});
