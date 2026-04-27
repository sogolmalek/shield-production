const SHIELD_API = 'https://shield-production-8awh.onrender.com';
const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Retry fetch for popup ──
async function fetchRetry(url, options = {}, { retries = 2, baseDelay = 800, timeout = 12000 } = {}) {
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
      if (attempt < retries) await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

document.addEventListener('DOMContentLoaded', async () => {
  // ── Navigation ──
  document.querySelectorAll('.nb').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nb').forEach(b => b.classList.remove('on'));
      document.querySelectorAll('.pg').forEach(p => p.classList.remove('on'));
      btn.classList.add('on');
      document.getElementById('pg-' + btn.getAttribute('data-p'))?.classList.add('on');
    });
  });

  updateStats();

  // ── Auto-scan if on token page ──
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    let mint = null;

    if (url.includes('dexscreener.com')) {
      const dexMatch = url.match(/\/solana\/([a-zA-Z0-9]{32,44})/i);
      if (dexMatch?.[1]) {
        switchTab('scan');
        showLoading('Resolving token from DexScreener\u2026');
        try {
          const pairRes = await fetchRetry(`https://api.dexscreener.com/latest/dex/pairs/solana/${dexMatch[1]}`, {}, { retries: 2, timeout: 8000 }).then(r => r.ok ? r.json() : null);
          const pair = pairRes?.pair || pairRes?.pairs?.[0];
          mint = pair?.baseToken?.address || null;
        } catch {}
        if (!mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dexMatch[1])) mint = dexMatch[1];
      }
    } else {
      const mintMatch = url.match(/\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})|\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})|\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})|[?&](?:outputMint|inputMint|mint)=([1-9A-HJ-NP-Za-km-z]{32,44})/);
      mint = mintMatch?.[1] || mintMatch?.[2] || mintMatch?.[3] || mintMatch?.[4] || null;
    }

    if (mint) {
      switchTab('scan');
      el('rAd').textContent = mint;
      showLoading('Analyzing on-chain data\u2026');
      await doScan(mint);
    }
  } catch {}

  // ── Toggles ──
  el('tgShield')?.addEventListener('click', function () {
    const on = this.classList.toggle('on');
    chrome.storage.local.set({ shieldEnabled: on });
    if (el('stTxt')) el('stTxt').textContent = on ? 'Active' : 'Disabled';
    if (el('stDot')) el('stDot').style.background = on ? '#34D399' : '#EF4444';
  });

  el('tgSwap')?.addEventListener('click', function () {
    chrome.storage.local.set({ shieldSwapWarnings: this.classList.toggle('on') });
  });

  el('thSldr')?.addEventListener('input', function () {
    if (el('thVal')) el('thVal').textContent = this.value;
    chrome.storage.local.set({ shieldThreshold: parseInt(this.value) });
  });

  el('hKey')?.addEventListener('change', function () {
    chrome.storage.local.set({ shieldHeliusKey: this.value.trim() });
  });

  el('exSites')?.addEventListener('change', function () {
    chrome.storage.local.set({ shieldExcludedSites: this.value.trim() });
  });

  // ── Quick Scan ──
  el('sBtn')?.addEventListener('click', runScan);
  el('sIn')?.addEventListener('keydown', e => { if (e.key === 'Enter') runScan(); });

  // ── Wallet ──
  el('connectWalletBtn')?.addEventListener('click',    () => connectWallet());
  el('connectWalletBtn2')?.addEventListener('click',   () => connectWallet());
  el('disconnectWalletBtn')?.addEventListener('click', () => disconnectWallet());
  el('depositBtn')?.addEventListener('click',          () => doDeposit());
  el('dep1')?.addEventListener('click',  () => doDeposit(1));
  el('dep5')?.addEventListener('click',  () => doDeposit(5));
  el('dep10')?.addEventListener('click', () => doDeposit(10));
});


// ── Helpers ──
function el(id) { return document.getElementById(id); }

function switchTab(page) {
  document.querySelectorAll('.nb').forEach(b => b.classList.remove('on'));
  document.querySelectorAll('.pg').forEach(p => p.classList.remove('on'));
  document.querySelector(`[data-p="${page}"]`)?.classList.add('on');
  el(`pg-${page}`)?.classList.add('on');
}

function showLoading(text) {
  const ld = el('sLd');
  if (ld) {
    const span = ld.querySelector('span');
    if (span) span.textContent = text || 'Analyzing on-chain data\u2026';
    ld.classList.add('show');
  }
}

function hideLoading() {
  el('sLd')?.classList.remove('show');
}

function showError(msg, retryFn) {
  hideLoading();
  const existing = document.getElementById('scan-error');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'scan-error';
  div.style.cssText = 'background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:10px;padding:14px;margin-bottom:12px;font-size:12px;animation:fadeIn .2s ease';
  div.innerHTML = `<div style="font-weight:600;color:#EF4444;margin-bottom:4px">\u26A0 Scan Failed</div><div style="color:rgba(255,255,255,.55);line-height:1.5;margin-bottom:${retryFn ? '10px' : '0'}">${msg}</div>`;
  if (retryFn) {
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.style.cssText = 'background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);color:#a78bfa;padding:6px 16px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit';
    btn.addEventListener('click', () => { div.remove(); retryFn(); });
    div.appendChild(btn);
  }

  const scanPage = el('pg-scan');
  if (scanPage) scanPage.insertBefore(div, el('sRes') || scanPage.lastChild);
}


// ═══════════════════════════════════════
// SCAN — with retry and error handling
// ═══════════════════════════════════════
async function doScan(addr) {
  document.getElementById('scan-error')?.remove();
  document.getElementById('pay-prompt')?.remove();
  el('sRes')?.classList.remove('show');
  showLoading('Analyzing on-chain data\u2026');

  try {
    const stored = await new Promise(r => chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected'], r));
    const wallet = stored.shieldWalletConnected ? stored.shieldWalletAddr : null;

    const res = await fetchRetry(`${SHIELD_API}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: addr, wallet, fingerprint: 'popup_' + Date.now() }),
    }, { retries: 2, timeout: 15000 });

    hideLoading();

    if (res.status === 402) {
      const errData = await res.json().catch(() => ({}));
      showPaymentPrompt(errData, addr);
      return;
    }
    if (res.status === 429) {
      showError('Rate limited. Please wait a minute and try again.', () => doScan(addr));
      return;
    }
    if (res.status === 503) {
      showError('Server is restarting. Please retry in a few seconds.', () => doScan(addr));
      return;
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      showError(errData.message || 'Scan failed. Please retry.', () => doScan(addr));
      return;
    }

    const data = await res.json();
    if (data?.score !== undefined) {
      displayResult(data, addr);
    } else {
      showError('No score returned. Token may not exist on Solana.');
    }
  } catch (e) {
    hideLoading();
    if (e.name === 'AbortError') {
      showError('Request timed out. The server may be waking up (Render free tier). Retry in ~15 seconds.', () => doScan(addr));
    } else {
      showError('Network error. Check your connection and retry.', () => doScan(addr));
    }
  }
}

async function runScan() {
  const input = el('sIn');
  const addr = input?.value?.trim();
  if (!addr || addr.length < 32 || addr.length > 44) {
    if (input) { input.style.borderColor = 'rgba(239,68,68,.5)'; input.style.transition = 'border-color .3s'; setTimeout(() => input.style.borderColor = '', 1500); }
    return;
  }
  el('rAd') && (el('rAd').textContent = addr);
  await doScan(addr);
}


// ═══════════════════════════════════════
// STATS
// ═══════════════════════════════════════
function updateStats() {
  chrome.storage.local.get([
    'scannedCount', 'rugsDodged', 'totalSpent', 'shieldInstallDate',
    'freeDailyUsed', 'freeTotalUsed', 'freeLastReset', 'shieldWalletConnected', 'shieldWalletAddr',
    'shieldEnabled', 'shieldSwapWarnings', 'shieldThreshold', 'shieldHeliusKey', 'shieldExcludedSites',
  ], (d) => {
    if (el('tScans')) el('tScans').textContent = d.scannedCount || 0;
    if (el('rDodge')) el('rDodge').textContent = d.rugsDodged  || 0;
    if (el('tSpent')) el('tSpent').textContent = '$' + (d.totalSpent || 0).toFixed(2);

    const installDate = d.shieldInstallDate || Date.now();
    const daysSince = Math.floor((Date.now() - installDate) / 86400000);
    if (el('dAct')) el('dAct').textContent = daysSince || '<1';

    const trialDaysLeft = Math.max(0, 3 - daysSince);
    const trialActive = trialDaysLeft > 0;
    const today = new Date().toDateString();
    let dailyUsed = d.freeDailyUsed || 0;
    if (d.freeLastReset !== today) { dailyUsed = 0; chrome.storage.local.set({ freeDailyUsed: 0, freeLastReset: today }); }

    if (el('fBan') && el('eBan')) {
      if (trialActive) {
        el('fBan').style.display = 'block'; el('eBan').style.display = 'none';
        if (el('fDays')) el('fDays').textContent = trialDaysLeft;
        if (el('fUsed')) el('fUsed').textContent = dailyUsed;
        if (el('fFill')) el('fFill').style.width = (dailyUsed / 10 * 100) + '%';
      } else if (!d.shieldWalletConnected) {
        el('fBan').style.display = 'none'; el('eBan').style.display = 'block';
      } else {
        el('fBan').style.display = 'none'; el('eBan').style.display = 'none';
      }
    }

    if (d.shieldWalletConnected && d.shieldWalletAddr) {
      showConnectedUI(d.shieldWalletAddr);
      loadBalance(d.shieldWalletAddr);
    }

    if (d.shieldEnabled === false && el('tgShield')) {
      el('tgShield').classList.remove('on');
      if (el('stTxt')) el('stTxt').textContent = 'Disabled';
      if (el('stDot')) el('stDot').style.background = '#EF4444';
    }
    if (d.shieldSwapWarnings === false) el('tgSwap')?.classList.remove('on');
    if (d.shieldThreshold && el('thSldr')) { el('thSldr').value = d.shieldThreshold; if (el('thVal')) el('thVal').textContent = d.shieldThreshold; }
    if (d.shieldHeliusKey && el('hKey')) el('hKey').value = d.shieldHeliusKey;
    if (d.shieldExcludedSites && el('exSites')) el('exSites').value = d.shieldExcludedSites;
  });
}


// ═══════════════════════════════════════
// DISPLAY RESULT
// ═══════════════════════════════════════
function displayResult(data, addr) {
  const score = data.score;
  const tier = score >= 75 ? 'safe' : score >= 55 ? 'caution' : score >= 35 ? 'warning' : 'danger';
  const verdict = data.verdict || (score >= 75 ? 'SECURE' : score >= 55 ? 'MODERATE' : score >= 35 ? 'WARNING' : 'DANGER');
  const colors = { safe: '#34D399', caution: '#FBBF24', warning: '#F59E0B', danger: '#EF4444' };
  const bgs = { safe: 'rgba(52,211,153,.08)', caution: 'rgba(251,191,36,.08)', warning: 'rgba(245,158,11,.08)', danger: 'rgba(239,68,68,.08)' };

  if (el('rSc')) { el('rSc').textContent = score + '/100'; el('rSc').style.color = colors[tier]; }
  if (el('rVd')) { el('rVd').textContent = verdict; el('rVd').style.color = colors[tier]; el('rVd').style.background = bgs[tier]; }
  if (el('rAd')) el('rAd').textContent = addr;

  if (data.checks && el('rCh')) {
    let html = '';
    for (const c of data.checks) {
      const name = c.name || c[0], ok = c.pass ?? c[1], val = c.value || c[2];
      const src = c.source ? ` <span style="opacity:.3;font-size:8px">${c.source}</span>` : '';
      html += `<div class="rr"><span class="l"><span class="${ok ? 'p' : 'f'}" style="font-size:10px;width:14px;text-align:center">${ok ? '\u2713' : '\u2717'}</span>${name}</span><span class="v ${ok ? 'p' : 'f'}">${val}${src}</span></div>`;
    }
    el('rCh').innerHTML = html;
  }

  el('sRes')?.classList.add('show');

  chrome.storage.local.get(['scannedCount', 'rugsDodged', 'freeDailyUsed', 'totalSpent'], (d) => {
    const updates = { scannedCount: (d.scannedCount || 0) + 1 };
    if (score < 30) updates.rugsDodged = (d.rugsDodged || 0) + 1;
    if (data.billing?.type === 'credits') updates.totalSpent = Math.round(((d.totalSpent || 0) + 0.01) * 100) / 100;
    else updates.freeDailyUsed = (d.freeDailyUsed || 0) + 1;
    chrome.storage.local.set(updates);
  });
}


// ═══════════════════════════════════════
// PAYMENT PROMPT
// ═══════════════════════════════════════
function showPaymentPrompt(errData, mintForRetry) {
  const scanPage = el('pg-scan');
  if (!scanPage) return;
  document.getElementById('pay-prompt')?.remove();

  const div = document.createElement('div');
  div.id = 'pay-prompt';
  div.style.cssText = 'background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:14px;margin-bottom:12px;font-size:12px;animation:fadeIn .2s ease';
  div.innerHTML = `
    <div style="font-weight:600;color:#F59E0B;margin-bottom:6px">\u26A1 ${errData.message || 'Credits needed'}</div>
    <div style="color:rgba(255,255,255,.55);margin-bottom:10px;line-height:1.5">$0.01/scan \u00b7 $1 = 100 scans \u00b7 $5 = 500 \u00b7 $10 = 1000<br/>Or subscribe: $5/mo (500 scans included)</div>
    <div style="display:flex;gap:6px">
      <button id="pp-d1" class="dep-btn" style="flex:1">$1</button>
      <button id="pp-d5" class="dep-btn" style="flex:1">$5</button>
      <button id="pp-d10" class="dep-btn" style="flex:1">$10</button>
    </div>
    <div id="pp-status" style="margin-top:8px;font-size:11px;color:rgba(255,255,255,.4)"></div>
  `;
  scanPage.insertBefore(div, scanPage.firstChild);

  function triggerDeposit(amount) {
    const status = document.getElementById('pp-status');
    doDeposit(amount);
    if (status) status.textContent = `\u23F3 Waiting for Phantom to confirm $${amount}\u2026`;

    chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected'], async (d) => {
      if (!d.shieldWalletConnected || !d.shieldWalletAddr) {
        if (status) status.textContent = 'Connect your wallet first (Wallet tab).';
        return;
      }
      let prevBal = 0;
      try { prevBal = (await fetchRetry(`${SHIELD_API}/api/credits/${d.shieldWalletAddr}`).then(r => r.json())).balance || 0; } catch {}

      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > 30) { clearInterval(poll); if (status) status.textContent = 'Payment not detected yet. Close and reopen popup to check.'; return; }
        try {
          const bal = await fetchRetry(`${SHIELD_API}/api/credits/${d.shieldWalletAddr}`).then(r => r.json());
          if ((bal.balance || 0) > prevBal) {
            clearInterval(poll);
            if (status) status.textContent = `\u2713 $${bal.balance.toFixed(2)} credited \u2014 retrying scan\u2026`;
            div.remove();
            updateStats();
            if (mintForRetry) setTimeout(() => doScan(mintForRetry), 800);
          }
        } catch {}
      }, 3000);
    });
  }

  document.getElementById('pp-d1')?.addEventListener('click', () => triggerDeposit(1));
  document.getElementById('pp-d5')?.addEventListener('click', () => triggerDeposit(5));
  document.getElementById('pp-d10')?.addEventListener('click', () => triggerDeposit(10));
}


// ═══════════════════════════════════════
// WALLET
// ═══════════════════════════════════════
async function loadBalance(addr) {
  try {
    const res = await fetchRetry(`${SHIELD_API}/api/credits/${addr}`, {}, { retries: 1, timeout: 8000 });
    const data = await res.json();
    const bal = data.balance || 0;
    const scans = data.scansRemaining || 0;

    if (el('balSection')) el('balSection').style.display = 'block';
    if (el('balValue')) el('balValue').textContent = '$' + bal.toFixed(2);
    if (el('balScans')) el('balScans').textContent = scans + ' scans left';
    if (el('wBal')) el('wBal').textContent = '$' + bal.toFixed(2);
    if (el('wScans')) el('wScans').textContent = scans + ' scans';
    if (el('depSection')) el('depSection').style.display = data.lowBalance ? 'block' : 'none';
  } catch {
    if (el('wBal')) el('wBal').textContent = 'Offline';
  }
}

async function connectWallet() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.url?.startsWith('chrome://')) {
      showWalletMessage('Open any website first (e.g. dexscreener.com), then try connecting.');
      return;
    }

    showWalletMessage('Connecting to Phantom\u2026');

    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout')), 15000);
      chrome.tabs.sendMessage(tab.id, { type: 'SHIELD_CONNECT_WALLET' }, (res) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });

    if (response?.address) {
      chrome.storage.local.set({ shieldWalletConnected: true, shieldWalletAddr: response.address });
      chrome.tabs.sendMessage(tab.id, { type: 'SHIELD_STORE_WALLET', address: response.address }).catch(() => {});
      showConnectedUI(response.address);
      await loadBalance(response.address);
      el('eBan')?.style && (el('eBan').style.display = 'none');
      clearWalletMessage();
    } else {
      showWalletMessage(response?.error || 'Phantom not found. Install from phantom.app');
    }
  } catch (e) {
    if (e.message === 'timeout') showWalletMessage('Connection timed out. Make sure Phantom is installed and unlocked.');
    else showWalletMessage('Open any website first, then try connecting. Phantom must be installed.');
  }
}

function showWalletMessage(msg) {
  let msgEl = document.getElementById('wallet-msg');
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.id = 'wallet-msg';
    msgEl.style.cssText = 'font-size:11px;color:var(--m);text-align:center;margin-top:10px;padding:8px;background:var(--s);border-radius:8px;border:1px solid var(--b)';
    el('wDis')?.appendChild(msgEl);
  }
  msgEl.textContent = msg;
}

function clearWalletMessage() {
  document.getElementById('wallet-msg')?.remove();
}

function disconnectWallet() {
  el('wDis')?.style && (el('wDis').style.display = 'block');
  el('wCon')?.style && (el('wCon').style.display = 'none');
  el('balSection')?.style && (el('balSection').style.display = 'none');
  el('depSection')?.style && (el('depSection').style.display = 'none');
  chrome.storage.local.set({ shieldWalletConnected: false, shieldWalletAddr: '' });
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'SHIELD_CLEAR_WALLET' }).catch(() => {});
  });
}

function showConnectedUI(addr) {
  el('wDis')?.style && (el('wDis').style.display = 'none');
  el('wCon')?.style && (el('wCon').style.display = 'block');
  if (el('wAddr')) el('wAddr').textContent = addr.slice(0, 4) + '\u2026' + addr.slice(-4);
}

function doDeposit(amount) {
  const amt = amount !== undefined ? amount : (parseInt(el('depAmount')?.value) || 5);
  chrome.tabs.create({ url: `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=${amt}&splToken=${USDC_MINT}&label=Shield+Credits+${amt}USD` });
}
