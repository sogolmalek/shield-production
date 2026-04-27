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

// ── Pre-warm server on startup (prevents cold start delay) ──
function warmServer() {
  fetch(SHIELD_API + '/').catch(() => {});
}
warmServer();

// Also warm on every service worker wake
chrome.runtime.onStartup?.addListener(warmServer);

// Periodic warm every 13 min via alarm
chrome.alarms.create('shield-server-warm', { periodInMinutes: 13 });

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

  // ── RESOLVE_AND_SCAN — resolve $TICKER + scan in one call (for Twitter) ──
  if (msg.type === 'RESOLVE_AND_SCAN') {
    (async () => {
      try {
        const ticker = (msg.ticker || '').toUpperCase().replace(/^\$/, '');
        if (!ticker) { sendResponse({ mint: null }); return; }
        const resolveRes = await fetch(`${SHIELD_API}/api/resolve/${encodeURIComponent(ticker)}`, { signal: AbortSignal.timeout(6000) });
        const resolveData = await resolveRes.json();
        if (!resolveData.found || !resolveData.mint) { sendResponse({ mint: null }); return; }
        const mint = resolveData.mint;
        const d = await chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected']);
        const wallet = d.shieldWalletConnected ? d.shieldWalletAddr : null;
        const fp = msg.fingerprint || 'ticker_' + Date.now();
        const scanRes = await fetch(`${SHIELD_API}/api/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: mint, wallet, fingerprint: fp }),
        });
        if (!scanRes.ok) { sendResponse({ mint, data: null }); return; }
        const scanData = await scanRes.json();
        sendResponse({ mint, data: scanData });
      } catch (e) {
        console.error('[SHIELD] Resolve+scan error:', e.message);
        sendResponse({ mint: null });
      }
    })();
    return true;
  }

  // ── NOTIFICATIONS ──
  if (msg.type === 'CHECK_TRIAL') {
    (async () => {
      const d = await chrome.storage.local.get([
        'shieldInstallDate', 'trialEndedNotified', 'trialEndingSoonNotified',
        'shieldWalletConnected', 'shieldWalletAddr',
        'freeDailyUsed', 'freeTotalUsed',
      ]);
      const daysSince = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
      const totalUsed = d.freeTotalUsed || 0;

      // Trial ending soon (day 2, 5 scans left)
      if (daysSince >= 2 && !d.trialEndingSoonNotified && totalUsed >= 25) {
        chrome.storage.local.set({ trialEndingSoonNotified: true });
        chrome.notifications.create('shield-trial-ending', {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: '\u26E8 Shield — Trial Ending Soon',
          message: `${FREE_TOTAL_MAX - totalUsed} free scans left. Connect Phantom wallet to top up when ready.`,
        });
      }

      // Trial ended
      if ((daysSince >= FREE_TRIAL_DAYS || totalUsed >= FREE_TOTAL_MAX) && !d.trialEndedNotified) {
        chrome.storage.local.set({ trialEndedNotified: true });
        chrome.notifications.create('shield-trial-ended', {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: '\u26E8 Shield — Free Trial Ended',
          message: 'Top up $1 USDC for 100 more scans. $0.01 per scan.',
        });
      }

      // Low balance check for paying users
      if (d.shieldWalletConnected && d.shieldWalletAddr) {
        try {
          const balRes = await fetch(`${SHIELD_API}/api/credits/${d.shieldWalletAddr}`);
          const bal = await balRes.json();
          if (bal.lowBalance && bal.scansRemaining > 0) {
            const lowBalNotified = (await chrome.storage.local.get(['lowBalanceNotified'])).lowBalanceNotified;
            if (!lowBalNotified) {
              chrome.storage.local.set({ lowBalanceNotified: true });
              chrome.notifications.create('shield-low-balance', {
                type: 'basic', iconUrl: 'icons/icon128.png',
                title: '\u26E8 Shield — Low Balance',
                message: `${bal.scansRemaining} scans left ($${bal.balance.toFixed(2)}). Top up to keep scanning.`,
              });
            }
          } else if (bal.empty) {
            chrome.notifications.create('shield-empty-balance', {
              type: 'basic', iconUrl: 'icons/icon128.png',
              title: '\u26E8 Shield — Credits Empty',
              message: 'Deposit USDC to continue scanning. $1 = 100 scans.',
            });
          } else if (!bal.lowBalance) {
            // Reset low balance notification when they top up
            chrome.storage.local.set({ lowBalanceNotified: false });
          }
        } catch {}
      }

      sendResponse({ ok: true });
    })();
    return true;
  }
});

// ── Periodic notification check (every 30 min) ──
chrome.alarms.create('shield-notification-check', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'shield-server-warm') {
    warmServer();
  }
  if (alarm.name === 'shield-notification-check') {
    chrome.storage.local.get(['shieldWalletConnected', 'shieldWalletAddr'], async (d) => {
      if (!d.shieldWalletConnected || !d.shieldWalletAddr) return;
      try {
        const res = await fetch(`${SHIELD_API}/api/credits/${d.shieldWalletAddr}`);
        const bal = await res.json();
        if (bal.empty) {
          chrome.notifications.create('shield-empty-periodic', {
            type: 'basic', iconUrl: 'icons/icon128.png',
            title: '\u26E8 Shield — Credits Empty',
            message: 'You have no scans left. Deposit $1 USDC to get 100 scans.',
          });
        } else if (bal.lowBalance) {
          chrome.notifications.create('shield-low-periodic', {
            type: 'basic', iconUrl: 'icons/icon128.png',
            title: '\u26E8 Shield — Running Low',
            message: `${bal.scansRemaining} scans remaining. Top up soon.`,
          });
        }
      } catch {}
    });
  }
});

// ── Notification click → open popup or payment ──
chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('shield-')) {
    chrome.action.openPopup?.() || chrome.tabs.create({ url: 'src/popup.html' });
  }
});
