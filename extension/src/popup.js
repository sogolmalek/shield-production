const SHIELD_API = 'https://shield-production-8awh.onrender.com';
const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── DOMContentLoaded — single listener ──
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

  // ── Stats + wallet ──
  updateStats();

  // ── Auto-scan if already on a token page ──
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const mintMatch = tab?.url?.match(/\/(?:en\/)?solana\/([1-9A-HJ-NP-Za-km-z]{32,44})|\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})|\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})|[?&]outputMint=([1-9A-HJ-NP-Za-km-z]{32,44})/);
    const mint = mintMatch?.[1] || mintMatch?.[2] || mintMatch?.[3] || mintMatch?.[4];
    if (mint) {
      switchTab('scan');
      el('rAd').textContent = mint;
      el('sLd')?.classList.add('show');
      const res = await fetch(`${SHIELD_API}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: mint, fingerprint: 'popup_' + Date.now() }),
      }).catch(() => null);
      el('sLd')?.classList.remove('show');
      if (res) {
        if (res.status === 402) {
          const errData = await res.json().catch(() => ({}));
          showPaymentPrompt(errData, mint);
        } else {
          const data = await res.json().catch(() => null);
          if (data?.score !== undefined) displayResult(data, mint);
        }
      }
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

  // ── Wallet buttons ──
  el('connectWalletBtn')?.addEventListener('click',  () => connectWallet());
  el('connectWalletBtn2')?.addEventListener('click', () => connectWallet());
  el('disconnectWalletBtn')?.addEventListener('click', () => disconnectWallet());
  el('depositBtn')?.addEventListener('click', () => doDeposit());

  // ── Deposit quick-amount buttons ──
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

// ── Load stats + wallet ──
function updateStats() {
  chrome.storage.local.get([
    'scannedCount', 'rugsDodged', 'totalSpent', 'shieldInstallDate',
    'freeDailyUsed', 'freeLastReset', 'shieldWalletConnected', 'shieldWalletAddr',
    'shieldEnabled', 'shieldSwapWarnings', 'shieldThreshold', 'shieldHeliusKey', 'shieldExcludedSites',
  ], (d) => {
    if (el('tScans')) el('tScans').textContent = d.scannedCount || 0;
    if (el('rDodge')) el('rDodge').textContent = d.rugsDodged  || 0;
    if (el('tSpent')) el('tSpent').textContent = '$' + (d.totalSpent || 0).toFixed(2);

    const installDate = d.shieldInstallDate || Date.now();
    const daysSince   = Math.floor((Date.now() - installDate) / 86400000);
    if (el('dAct')) el('dAct').textContent = daysSince || '<1';

    const trialDaysLeft = Math.max(0, 3 - daysSince);
    const trialActive   = trialDaysLeft > 0;
    const today         = new Date().toDateString();
    let dailyUsed       = d.freeDailyUsed || 0;
    if (d.freeLastReset !== today) {
      dailyUsed = 0;
      chrome.storage.local.set({ freeDailyUsed: 0, freeLastReset: today });
    }

    if (el('fBan') && el('eBan')) {
      if (trialActive) {
        el('fBan').style.display = 'block';
        el('eBan').style.display = 'none';
        if (el('fDays')) el('fDays').textContent = trialDaysLeft;
        if (el('fUsed')) el('fUsed').textContent = dailyUsed;
        if (el('fFill')) el('fFill').style.width  = (dailyUsed / 10 * 100) + '%';
      } else if (!d.shieldWalletConnected) {
        el('fBan').style.display = 'none';
        el('eBan').style.display = 'block';
      } else {
        el('fBan').style.display = 'none';
        el('eBan').style.display = 'none';
      }
    }

    if (d.shieldWalletConnected && d.shieldWalletAddr) {
      showConnectedUI(d.shieldWalletAddr);
      loadBalance(d.shieldWalletAddr);
    }

    // Settings
    if (d.shieldEnabled === false && el('tgShield')) {
      el('tgShield').classList.remove('on');
      if (el('stTxt')) el('stTxt').textContent = 'Disabled';
      if (el('stDot')) el('stDot').style.background = '#EF4444';
    }
    if (d.shieldSwapWarnings === false) el('tgSwap')?.classList.remove('on');
    if (d.shieldThreshold && el('thSldr')) {
      el('thSldr').value = d.shieldThreshold;
      if (el('thVal')) el('thVal').textContent = d.shieldThreshold;
    }
    if (d.shieldHeliusKey   && el('hKey'))    el('hKey').value    = d.shieldHeliusKey;
    if (d.shieldExcludedSites && el('exSites')) el('exSites').value = d.shieldExcludedSites;
  });
}

// ── Display scan result ──
function displayResult(data, addr) {
  const score   = data.score;
  const tier    = score >= 70 ? 'safe' : score >= 50 ? 'caution' : score >= 30 ? 'warning' : 'danger';
  const verdict = data.verdict || (score >= 70 ? 'SECURE' : score >= 50 ? 'CAUTION' : score >= 30 ? 'WARNING' : 'DANGER');
  const colors  = { safe: '#34D399', caution: '#FBBF24', warning: '#F59E0B', danger: '#EF4444' };
  const bgs     = { safe: 'rgba(52,211,153,.08)', caution: 'rgba(251,191,36,.08)', warning: 'rgba(245,158,11,.08)', danger: 'rgba(239,68,68,.08)' };

  if (el('rSc'))  { el('rSc').textContent = score + '/100'; el('rSc').style.color = colors[tier]; }
  if (el('rVd'))  { el('rVd').textContent = verdict; el('rVd').style.color = colors[tier]; el('rVd').style.background = bgs[tier]; }
  if (el('rAd'))  el('rAd').textContent = addr;

  if (data.checks && el('rCh')) {
    let html = '';
    for (const c of data.checks) {
      const name = c[0], ok = c[1], val = c[2];
      html += `<div class="rr"><span class="l"><span class="${ok ? 'p' : 'f'}" style="font-size:10px;width:14px;text-align:center">${ok ? '✓' : '✗'}</span>${name}</span><span class="v ${ok ? 'p' : 'f'}">${val}</span></div>`;
    }
    el('rCh').innerHTML = html;
  }

  el('sRes')?.classList.add('show');

  chrome.storage.local.get(['scannedCount', 'rugsDodged', 'freeDailyUsed', 'totalSpent'], (d) => {
    const updates = { scannedCount: (d.scannedCount || 0) + 1 };
    if (score < 30) updates.rugsDodged   = (d.rugsDodged  || 0) + 1;
    if (data.billing?.type === 'credits') updates.totalSpent = Math.round(((d.totalSpent || 0) + 0.01) * 100) / 100;
    else updates.freeDailyUsed = (d.freeDailyUsed || 0) + 1;
    chrome.storage.local.set(updates);
  });
}

// ── Quick scan ──
async function runScan() {
  const input = el('sIn');
  const addr  = input?.value?.trim();
  if (!addr || addr.length < 32 || addr.length > 44) {
    if (input) { input.style.borderColor = 'rgba(239,68,68,.5)'; setTimeout(() => input.style.borderColor = '', 1500); }
    return;
  }

  el('sRes')?.classList.remove('show');
  el('sLd')?.classList.add('show');

  try {
    const stored = await new Promise(r => chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected'], r));
    const wallet = stored.shieldWalletConnected ? stored.shieldWalletAddr : null;

    const res = await fetch(`${SHIELD_API}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: addr, wallet, fingerprint: 'popup_' + Date.now() }),
    });
    el('sLd')?.classList.remove('show');

    if (res.status === 402) {
      const errData = await res.json().catch(() => ({}));
      showPaymentPrompt(errData, addr);
      return;
    }

    const data = await res.json();
    if (data?.score !== undefined) {
      displayResult(data, addr);
    } else {
      alert('No score returned — token may not exist on Solana.');
    }
  } catch (e) {
    el('sLd')?.classList.remove('show');
    alert('Scan failed — check connection.');
  }
}

// ── Show 402 payment prompt inside popup ──
function showPaymentPrompt(errData, mintForRetry) {
  const scanPage = el('pg-scan');
  if (!scanPage) return;

  const existing = document.getElementById('pay-prompt');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.id = 'pay-prompt';
  div.style.cssText = 'background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:10px;padding:14px;margin-bottom:12px;font-size:12px';
  div.innerHTML = `
    <div style="font-weight:600;color:#F59E0B;margin-bottom:6px">⚡ ${errData.message || 'Credits needed'}</div>
    <div style="color:rgba(255,255,255,.55);margin-bottom:10px;line-height:1.5">$1 = 100 scans · $5 = 500 scans · $10 = 1000 scans</div>
    <div style="display:flex;gap:6px">
      <button id="pp-d1"  class="dep-btn" style="flex:1">$1</button>
      <button id="pp-d5"  class="dep-btn" style="flex:1">$5</button>
      <button id="pp-d10" class="dep-btn" style="flex:1">$10</button>
    </div>
    <div id="pp-status" style="margin-top:8px;font-size:11px;color:rgba(255,255,255,.4)"></div>
  `;
  scanPage.insertBefore(div, scanPage.firstChild);

  function triggerDeposit(amount) {
    const status = document.getElementById('pp-status');
    doDeposit(amount);
    if (status) status.textContent = `⏳ Waiting for Phantom to confirm $${amount}…`;

    // Poll for balance increase then auto-retry scan
    chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected'], async (d) => {
      if (!d.shieldWalletConnected || !d.shieldWalletAddr) {
        if (status) status.textContent = 'Connect your wallet first to auto-credit.';
        return;
      }
      const wallet = d.shieldWalletAddr;
      let prevBal = 0;
      try { prevBal = (await fetch(`${SHIELD_API}/api/credits/${wallet}`).then(r => r.json())).balance || 0; } catch {}

      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > 30) { clearInterval(poll); if (status) status.textContent = 'Payment not detected. Try again.'; return; }
        try {
          const bal = await fetch(`${SHIELD_API}/api/credits/${wallet}`).then(r => r.json());
          if ((bal.balance || 0) > prevBal) {
            clearInterval(poll);
            if (status) status.textContent = `✓ $${bal.balance.toFixed(2)} credited — retrying scan…`;
            div.remove();
            updateStats();
            setTimeout(runScan, 800);
          }
        } catch {}
      }, 3000);
    });
  }

  document.getElementById('pp-d1')?.addEventListener('click',  () => triggerDeposit(1));
  document.getElementById('pp-d5')?.addEventListener('click',  () => triggerDeposit(5));
  document.getElementById('pp-d10')?.addEventListener('click', () => triggerDeposit(10));
}

// ── Load balance from backend ──
async function loadBalance(addr) {
  try {
    const res  = await fetch(`${SHIELD_API}/api/credits/${addr}`);
    const data = await res.json();
    const bal  = data.balance || 0;
    const scans= data.scansRemaining || 0;

    if (el('balSection')) el('balSection').style.display = 'block';
    if (el('balValue'))   el('balValue').textContent  = '$' + bal.toFixed(2);
    if (el('balScans'))   el('balScans').textContent  = scans + ' scans left';

    // Also update wBal / wScans in the wallet card header
    if (el('wBal'))   el('wBal').textContent  = '$' + bal.toFixed(2);
    if (el('wScans')) el('wScans').textContent = scans + ' scans';

    if (el('depSection')) el('depSection').style.display = data.lowBalance ? 'block' : 'none';
  } catch {}
}

// ── Connect wallet ──
async function connectWallet() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.url?.startsWith('chrome://')) {
      alert('Open any website first (e.g. dexscreener.com), then try connecting.');
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SHIELD_CONNECT_WALLET' });
    if (response?.address) {
      const addr = response.address;
      chrome.storage.local.set({ shieldWalletConnected: true, shieldWalletAddr: addr });
      chrome.tabs.sendMessage(tab.id, { type: 'SHIELD_STORE_WALLET', address: addr }).catch(() => {});
      showConnectedUI(addr);
      await loadBalance(addr);
      el('eBan')?.style && (el('eBan').style.display = 'none');
    } else {
      alert('Phantom not found. Install from phantom.app');
    }
  } catch {
    alert('Open any website first (e.g. dexscreener.com), then try connecting.\n\nPhantom must be installed.');
  }
}

// ── Disconnect wallet ──
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

// ── Show connected UI ──
function showConnectedUI(addr) {
  el('wDis')?.style && (el('wDis').style.display = 'none');
  el('wCon')?.style && (el('wCon').style.display = 'block');
  if (el('wAddr')) el('wAddr').textContent = addr.slice(0, 4) + '…' + addr.slice(-4);
}

// ── Deposit USDC via Phantom deeplink ──
// amount: number in USDC (1, 5, 10)
function doDeposit(amount) {
  // If no argument, use the hidden input value; fall back to 5
  const amt = amount !== undefined ? amount : (parseInt(el('depAmount')?.value) || 5);
  chrome.tabs.create({
    url: `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=${amt}&splToken=${USDC_MINT}&label=Shield+Credits+${amt}USD`,
  });
}
