(() => {
  'use strict';

  const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
  const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOLANA_RE    = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  const SKIP = new Set([
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'So11111111111111111111111111111111111111112',
    'ComputeBudget111111111111111111111111111111',
    'Vote111111111111111111111111111111111111111',
    'Stake11111111111111111111111111111111111111',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  ]);

  const cache = {};
  const COLORS = { safe: '#34D399', caution: '#FBBF24', warning: '#F59E0B', danger: '#EF4444' };

  const fp = (() => {
    try {
      const s = localStorage.getItem('shield_fp');
      if (s) return s;
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('shield_fp', id);
      return id;
    } catch { return 'anon_' + Math.random().toString(36).slice(2); }
  })();

  function valid(a) {
    return a.length >= 32 && a.length <= 44 && !SKIP.has(a);
  }

  // Inject bridge for Phantom access
  function injectBridge() {
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('src/bridge.js');
      (document.head || document.documentElement).appendChild(s);
      s.onload = () => s.remove();
    } catch {}
  }
  injectBridge();

  // Inject styles once
  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'shield-bar-styles';
    style.textContent = `
      @keyframes shieldSlideIn { from { transform:translateY(-100%); opacity:0; } to { transform:translateY(0); opacity:1; } }
      #shield-bar { animation: shieldSlideIn 0.35s ease forwards; }
      .sb-logo   { font-family:monospace;font-weight:700;color:#a78bfa;letter-spacing:2px;font-size:12px }
      .sb-score  { font-family:monospace;font-weight:700;font-size:18px;padding:2px 12px;border-radius:6px }
      .sb-score.safe    { color:#34d399;background:rgba(52,211,153,.15) }
      .sb-score.caution { color:#fbbf24;background:rgba(251,191,36,.15) }
      .sb-score.warning { color:#f59e0b;background:rgba(245,158,11,.15) }
      .sb-score.danger  { color:#ef4444;background:rgba(239,68,68,.15) }
      .sb-score.loading { color:#a78bfa;background:rgba(139,92,246,.15) }
      .sb-verdict { color:rgba(255,255,255,.5);font-size:12px }
      .sb-close { background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;padding:2px 8px;margin-left:auto;line-height:1 }
      .sb-close:hover { color:#fff }
      .sb-buy { background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);color:#34d399;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit }
      .sb-buy:hover { background:rgba(52,211,153,.2) }
      .sb-pay { background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:#fbbf24;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit }
      .sb-pay:hover { background:rgba(251,191,36,.2) }
      .shield-badge { display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle;transition:all .2s }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ── SCAN via background service worker (bypasses page CSP) ──
  function scan(mint) {
    if (cache[mint]) return Promise.resolve(cache[mint]);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'DO_SCAN', token: mint, fingerprint: fp }, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        if (!res) { resolve(null); return; }
        if (res.blocked) { resolve({ score: -1, blocked: true, reason: res.reason, message: res.message, payment: res.payment }); return; }
        if (res.error)   { resolve(null); return; }
        cache[mint] = res.data;
        resolve(res.data);
      });
    });
  }

  // ── AUTO-CHARGE via Phantom deeplink + poll background ──
  async function autoCharge(mint, amount, onSuccess) {
    const stored = await new Promise(r => chrome.storage.local.get(['shieldWalletAddr', 'shieldWalletConnected'], r));
    if (!stored.shieldWalletConnected) return false;

    const wallet = stored.shieldWalletAddr;
    const link   = `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=${amount}&splToken=${USDC_MINT}&label=Shield+Credits`;
    window.open(link, '_blank');

    // Poll balance via background
    let prevBal = 0;
    await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_BALANCE', wallet }, (res) => {
      prevBal = res?.data?.balance || 0; r();
    }));

    return new Promise(resolve => {
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        if (attempts > 30) { clearInterval(poll); resolve(false); return; }
        chrome.runtime.sendMessage({ type: 'GET_BALANCE', wallet }, (res) => {
          const bal = res?.data?.balance || 0;
          if (bal > prevBal) {
            clearInterval(poll);
            delete cache[mint];
            if (onSuccess) onSuccess(res.data);
            resolve(true);
          }
        });
      }, 3000);
    });
  }

  // ── FLOATING BAR ──
  function showBar(mint) {
    if (document.getElementById('shield-bar')) return;
    ensureStyles();

    const bar = document.createElement('div');
    bar.id = 'shield-bar';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#0d0f14', 'border-bottom:2px solid rgba(139,92,246,.4)',
      'padding:10px 16px', 'display:flex', 'align-items:center', 'gap:12px',
      'font-family:-apple-system,system-ui,sans-serif', 'font-size:13px', 'color:#e4e7ef',
      'box-shadow:0 4px 24px rgba(0,0,0,.6)',
    ].join(';');

    bar.innerHTML = `<span class="sb-logo">⛨ SHIELD</span><span class="sb-score loading">Scanning…</span>`;

    const origMargin = document.body?.style?.marginTop || '';
    document.body.prepend(bar);
    if (document.body) document.body.style.marginTop = '48px';

    function closeBar() {
      bar.remove();
      if (document.body) document.body.style.marginTop = origMargin;
    }

    function addClose() {
      const btn = document.createElement('button');
      btn.className = 'sb-close';
      btn.textContent = '✕';
      btn.addEventListener('click', closeBar);
      bar.appendChild(btn);
    }

    scan(mint).then(r => {
      if (!r) {
        bar.innerHTML = `<span class="sb-logo">⛨ SHIELD</span><span class="sb-score danger">Error</span><span class="sb-verdict">Could not reach API</span>`;
        addClose();
        return;
      }

      if (r.blocked) {
        bar.innerHTML = `
          <span class="sb-logo">⛨ SHIELD</span>
          <span class="sb-score warning">⚡ Credits</span>
          <span class="sb-verdict" style="flex:1">${r.message || 'Free trial ended'}</span>
          <button class="sb-pay" id="sb-charge-btn">💳 Top Up $5</button>
        `;
        addClose();
        document.getElementById('sb-charge-btn')?.addEventListener('click', async () => {
          const btn = document.getElementById('sb-charge-btn');
          if (!btn) return;
          btn.textContent = '⏳ Waiting for Phantom…';
          btn.disabled = true;
          const ok = await autoCharge(mint, 5, (bal) => {
            if (btn) btn.textContent = `✓ $${bal.balance.toFixed(2)} credited`;
          });
          if (ok) { closeBar(); setTimeout(() => showBar(mint), 300); }
          else { if (btn) { btn.textContent = '💳 Top Up $5'; btn.disabled = false; } }
        });
        return;
      }

      const tier    = r.score >= 70 ? 'safe' : r.score >= 50 ? 'caution' : r.score >= 30 ? 'warning' : 'danger';
      const verdict = r.verdict || tier.toUpperCase();

      bar.innerHTML = `
        <span class="sb-logo">⛨ SHIELD</span>
        <span class="sb-score ${tier}">${r.score}</span>
        <span class="sb-verdict">${verdict}</span>
        <span style="font-size:10px;color:rgba(255,255,255,.3)">${mint.slice(0,6)}…${mint.slice(-4)}</span>
        ${r.score >= 30
          ? `<button class="sb-buy" id="sb-buy-btn">⚡ Buy Safe via LI.FI</button>`
          : `<span style="font-size:11px;color:#ef4444;font-weight:600">🛑 Swap Blocked</span>`
        }
      `;
      addClose();

      document.getElementById('sb-buy-btn')?.addEventListener('click', () => {
        if (typeof globalThis.ShieldLifi !== 'undefined') {
          globalThis.ShieldLifi.createSwapModal(mint, r.score, tier, verdict);
        } else {
          window.open(`https://jumper.exchange/?toChain=1151111081099710&toToken=${mint}`, '_blank');
        }
      });
    });

    // Check trial ended notification
    chrome.runtime.sendMessage({ type: 'CHECK_TRIAL' });
  }

  // ── INLINE BADGES ──
  const badgedMints = new Set();

  function scanText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const tag = node.parentElement?.tagName?.toUpperCase();
        if (['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const found = new Set();
    while (walker.nextNode()) {
      const matches = walker.currentNode.textContent.match(SOLANA_RE);
      if (matches) matches.forEach(m => { if (valid(m)) found.add(m); });
    }

    found.forEach(mint => {
      if (badgedMints.has(mint)) return;
      badgedMints.add(mint);

      // Find element — check href/data attrs first, then text node parent
      let el = document.querySelector(`[href*="${mint}"], [data-address="${mint}"], [data-mint="${mint}"]`);
      if (!el) {
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (tw.nextNode()) {
          if (tw.currentNode.textContent.includes(mint)) {
            el = tw.currentNode.parentElement;
            break;
          }
        }
      }
      if (!el || el.querySelector('.shield-badge')) return;

      const badge = document.createElement('span');
      badge.className = 'shield-badge';
      badge.style.cssText = 'background:rgba(139,92,246,.15);color:#a78bfa';
      badge.textContent = '⛨…';
      badge.title = 'Shield scanning…';
      try { el.appendChild(badge); } catch { return; }

      scan(mint).then(r => {
        if (!r || r.blocked) { badge.remove(); badgedMints.delete(mint); return; }
        const tier  = r.score >= 70 ? 'safe' : r.score >= 50 ? 'caution' : r.score >= 30 ? 'warning' : 'danger';
        const color = COLORS[tier];
        badge.textContent      = `⛨ ${r.score}`;
        badge.style.color      = color;
        badge.style.background = `${color}20`;
        badge.title            = `Shield: ${r.score}/100 — ${r.verdict || tier.toUpperCase()}`;
        badge.addEventListener('click', e => { e.stopPropagation(); showBar(mint); });
      }).catch(() => { badge.remove(); badgedMints.delete(mint); });
    });
  }

  // ── URL DETECTION ──
  function detectURL() {
    const href = location.href;
    const patterns = [
      /\/(?:en\/)?solana\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /[?&]outputMint=([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /[?&]inputMint=([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /[?&](?:from|to|mint)=([1-9A-HJ-NP-Za-km-z]{32,44})/,
    ];
    for (const p of patterns) {
      const m = href.match(p);
      if (m && m[1] && valid(m[1])) { showBar(m[1]); return; }
    }
  }

  // ── MESSAGE HANDLER ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHIELD_CONNECT_WALLET') {
      const handler = (event) => {
        if (event.data.type === 'SHIELD_RES_CONNECT') {
          window.removeEventListener('message', handler);
          if (event.data.address) {
            try { localStorage.setItem('shield_wallet', event.data.address); } catch {}
            sendResponse({ address: event.data.address });
          } else {
            sendResponse({ error: event.data.error || 'Phantom not found' });
          }
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'SHIELD_REQ_CONNECT' }, '*');
      setTimeout(() => window.removeEventListener('message', handler), 10000);
      return true;
    }
    if (msg.type === 'SHIELD_STORE_WALLET') {
      try { localStorage.setItem('shield_wallet', msg.address); } catch {}
      sendResponse({ ok: true });
    }
    if (msg.type === 'SHIELD_CLEAR_WALLET') {
      try { localStorage.removeItem('shield_wallet'); } catch {}
      sendResponse({ ok: true });
    }
  });

  // ── TWITTER / X — React-proof badge system ──
  // Problem: Twitter React re-renders remove injected badges every few seconds.
  // Solution: heartbeat re-injects missing badges every 2s.

  const articleMints = new Map(); // article_el → Map<mint, scoreData|null>

  function extractMintsFromText(text) {
    const found = new Set();
    const raw = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    if (raw) raw.forEach(m => { if (valid(m)) found.add(m); });
    const ca = text.match(/(?:CA|Contract|Mint|Address)\s*[:\-]\s*([1-9A-HJ-NP-Za-km-z]{32,44})/gi);
    if (ca) ca.forEach(m => {
      const addr = m.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1];
      if (addr && valid(addr)) found.add(addr);
    });
    return found;
  }

  function injectBadge(article, mint, scoreData) {
    const tweetText = article.querySelector('[data-testid="tweetText"]') || article;
    if (tweetText.querySelector(`[data-shield-mint="${mint}"]`)) return;
    const badge = document.createElement('span');
    badge.setAttribute('data-shield-mint', mint);
    badge.className = 'shield-badge';
    if (!scoreData) {
      badge.style.cssText = 'background:rgba(139,92,246,.15);color:#a78bfa;display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      badge.textContent = '⛨…';
      badge.title = 'Shield scanning…';
    } else {
      const color = COLORS[scoreData.tier];
      badge.style.cssText = `background:${color}20;color:${color};display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle`;
      badge.textContent = `⛨ ${scoreData.score}`;
      badge.title = `Shield: ${scoreData.score}/100 — ${scoreData.verdict}`;
      badge.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showBar(mint); });
    }
    try { tweetText.appendChild(badge); } catch {}
  }

  function scanArticle(article) {
    const text = article.textContent || '';
    if (text.length < 32) return;
    const mints = extractMintsFromText(text);
    if (mints.size === 0) return;
    if (!articleMints.has(article)) articleMints.set(article, new Map());
    const mintMap = articleMints.get(article);
    mints.forEach(mint => {
      if (mintMap.has(mint)) return;
      mintMap.set(mint, null);
      injectBadge(article, mint, null);
      scan(mint).then(r => {
        if (!r || r.blocked) { mintMap.delete(mint); return; }
        const tier    = r.score >= 70 ? 'safe' : r.score >= 50 ? 'caution' : r.score >= 30 ? 'warning' : 'danger';
        const verdict = r.verdict || tier.toUpperCase();
        const sd = { score: r.score, tier, verdict };
        mintMap.set(mint, sd);
        injectBadge(article, mint, sd);
      }).catch(() => mintMap.delete(mint));
    });
  }

  // Heartbeat: re-inject badges React removed
  function startHeartbeat() {
    setInterval(() => {
      for (const [article, mintMap] of articleMints) {
        if (!document.contains(article)) { articleMints.delete(article); continue; }
        for (const [mint, sd] of mintMap) {
          const tt = article.querySelector('[data-testid="tweetText"]') || article;
          if (!tt.querySelector(`[data-shield-mint="${mint}"]`)) injectBadge(article, mint, sd);
        }
      }
    }, 2000);
  }

  // MutationObserver: detect new tweets
  let mutationDebounce = null;
  function startMutationObserver() {
    const observer = new MutationObserver(() => {
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        document.querySelectorAll('article').forEach(article => {
          if (!articleMints.has(article)) scanArticle(article);
        });
      }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  // ── START ──
  function start() {
    console.log('[SHIELD] ⛨ Active on', location.hostname);
    ensureStyles();
    setTimeout(detectURL, 1200);
    setTimeout(scanText,  3500);

    // MutationObserver + heartbeat for Twitter/X React re-renders
    startMutationObserver();
    startHeartbeat();

    // SPA navigation watch
    let lastURL = location.href;
    setInterval(() => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        const bar = document.getElementById('shield-bar');
        if (bar) { bar.remove(); if (document.body) document.body.style.marginTop = ''; }
        badgedMints.clear();
        setTimeout(detectURL, 800);
        setTimeout(scanText,  2500);
      }
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
