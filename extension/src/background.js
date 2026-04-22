/**
 * SHIELD — Background Service Worker
 * KEY FIX: All API fetch calls go through here (service worker has no CSP restrictions).
 * Content scripts send messages → background fetches → sends result back.
 */

const SHIELD_API         = 'https://shield-production-8awh.onrender.com';
const COST_PER_SCAN      = 0.01;
const FREE_SCANS_PER_DAY = 10;
const FREE_TRIAL_DAYS    = 3;

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
    freeLastReset:         new Date().toDateString(),
  });
  console.log('[SHIELD] Installed — 3-day free trial (10 scans/day).');
});

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── DO_SCAN — content script asks background to fetch scan result ──
  // This bypasses any page CSP — service worker fetches freely
  if (msg.type === 'DO_SCAN') {
    chrome.storage.local.get([
      'shieldWalletAddr', 'shieldWalletConnected', 'shieldEnabled',
      'shieldInstallDate', 'freeDailyUsed', 'freeLastReset',
    ], async (d) => {
      if (!d.shieldEnabled) {
        sendResponse({ error: 'disabled' });
        return;
      }

      const wallet = d.shieldWalletConnected ? d.shieldWalletAddr : null;
      const fp     = msg.fingerprint || 'bg_' + Date.now();

      try {
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

        // Update counters
        chrome.storage.local.get(['scannedCount', 'totalSpent', 'freeDailyUsed', 'rugsDodged'], (s) => {
          const updates = { scannedCount: (s.scannedCount || 0) + 1 };
          if (data.billing?.type === 'credits') {
            updates.totalSpent = Math.round(((s.totalSpent || 0) + COST_PER_SCAN) * 100) / 100;
          } else {
            updates.freeDailyUsed = (s.freeDailyUsed || 0) + 1;
          }
          if (data.score < 30) updates.rugsDodged = (s.rugsDodged || 0) + 1;
          chrome.storage.local.set(updates);
        });

        sendResponse({ ok: true, data });

      } catch (e) {
        console.error('[SHIELD] Scan fetch error:', e.message);
        sendResponse({ error: e.message });
      }
    });
    return true; // async
  }

  // ── GET_BALANCE — fetch credits balance via background ──
  if (msg.type === 'GET_BALANCE') {
    fetch(`${SHIELD_API}/api/credits/${msg.wallet}`)
      .then(r => r.json())
      .then(data => sendResponse({ ok: true, data }))
      .catch(e  => sendResponse({ error: e.message }));
    return true;
  }

  // ── VERIFY_PAYMENT ──
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

  // ── CAN_SCAN ──
  if (msg.type === 'CAN_SCAN') {
    chrome.storage.local.get([
      'shieldInstallDate', 'shieldWalletConnected',
      'freeDailyUsed', 'freeLastReset', 'shieldEnabled',
    ], (d) => {
      if (!d.shieldEnabled) return sendResponse({ allowed: false, reason: 'disabled' });
      const daysSince   = Math.floor((Date.now() - (d.shieldInstallDate || Date.now())) / 86400000);
      const trialActive = daysSince < FREE_TRIAL_DAYS;
      const today       = new Date().toDateString();
      let dailyUsed     = d.freeDailyUsed || 0;
      if (d.freeLastReset !== today) {
        dailyUsed = 0;
        chrome.storage.local.set({ freeDailyUsed: 0, freeLastReset: today });
      }
      if (trialActive && dailyUsed < FREE_SCANS_PER_DAY) return sendResponse({ allowed: true, free: true, remaining: FREE_SCANS_PER_DAY - dailyUsed });
      if (d.shieldWalletConnected) return sendResponse({ allowed: true, free: false });
      return sendResponse({ allowed: false, reason: 'limit_reached' });
    });
    return true;
  }

  // ── SCAN_DONE ──
  if (msg.type === 'SCAN_DONE') {
    chrome.storage.local.get(['scannedCount', 'totalSpent', 'freeDailyUsed'], (d) => {
      const updates = { scannedCount: (d.scannedCount || 0) + 1 };
      if (msg.free) updates.freeDailyUsed = (d.freeDailyUsed || 0) + 1;
      else updates.totalSpent = Math.round(((d.totalSpent || 0) + COST_PER_SCAN) * 100) / 100;
      chrome.storage.local.set(updates);
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── RUG_SAVED ──
  if (msg.type === 'RUG_SAVED') {
    chrome.storage.local.get(['rugsDodged'], (d) => {
      chrome.storage.local.set({ rugsDodged: (d.rugsDodged || 0) + 1 });
      sendResponse({ ok: true });
    });
    return true;
  }

  // ── GET_STATS ──
  if (msg.type === 'GET_STATS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  // ── TRIAL_ENDED notification ──
  if (msg.type === 'CHECK_TRIAL') {
    chrome.storage.local.get(['shieldInstallDate', 'trialEndedNotified'], (d) => {
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
    });
    return true;
  }
});
