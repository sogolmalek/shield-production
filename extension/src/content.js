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

  const SKIP_TICKERS = new Set([
    'USD','USDC','USDT','SOL','ETH','BTC','BNB','MATIC','AVAX','DOT',
    'ADA','XRP','DOGE','EUR','GBP','JPY','CNY','BUSD','DAI','WETH',
    'WBTC','WSOL','LINK','UNI','AAVE','CRV','MKR','COMP','SNX','YFI',
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

  function validMint(a) {
    if (a.length < 32 || a.length > 44 || SKIP.has(a)) return false;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
    if (a === a.toLowerCase() || a === a.toUpperCase()) return false;
    return true;
  }

  function injectBridge() {
    try { const s = document.createElement('script'); s.src = chrome.runtime.getURL('src/bridge.js'); (document.head || document.documentElement).appendChild(s); s.onload = () => s.remove(); } catch {}
  }
  injectBridge();

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'shield-bar-styles';
    style.textContent = '@keyframes shieldSlideIn{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}#shield-bar{animation:shieldSlideIn .35s ease forwards}.sb-logo{font-family:monospace;font-weight:700;color:#a78bfa;letter-spacing:2px;font-size:12px}.sb-score{font-family:monospace;font-weight:700;font-size:18px;padding:2px 12px;border-radius:6px}.sb-score.safe{color:#34d399;background:rgba(52,211,153,.15)}.sb-score.caution{color:#fbbf24;background:rgba(251,191,36,.15)}.sb-score.warning{color:#f59e0b;background:rgba(245,158,11,.15)}.sb-score.danger{color:#ef4444;background:rgba(239,68,68,.15)}.sb-score.loading{color:#a78bfa;background:rgba(139,92,246,.15)}.sb-verdict{color:rgba(255,255,255,.5);font-size:12px}.sb-close{background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;padding:2px 8px;margin-left:auto;line-height:1}.sb-close:hover{color:#fff}.sb-buy{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);color:#34d399;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit}.sb-buy:hover{background:rgba(52,211,153,.2)}.sb-pay{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:#fbbf24;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit}.sb-pay:hover{background:rgba(251,191,36,.2)}.shield-badge{display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle;transition:all .2s}';
    (document.head || document.documentElement).appendChild(style);
  }

  // ── SCAN ──
  function scan(mint) {
    if (cache[mint]) return Promise.resolve(cache[mint]);
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'DO_SCAN', token: mint, fingerprint: fp }, res => {
        if (chrome.runtime.lastError) { console.log('[SHIELD] scan err:', chrome.runtime.lastError.message); resolve(null); return; }
        if (!res) { resolve(null); return; }
        if (res.blocked) { resolve({ score: -1, blocked: true, reason: res.reason, message: res.message, payment: res.payment }); return; }
        if (res.error) { resolve(null); return; }
        cache[mint] = res.data;
        resolve(res.data);
      });
    });
  }

  function resolveTicker(ticker) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'RESOLVE_TICKER', ticker }, res => {
        if (chrome.runtime.lastError || !res || !res.found || !res.mint) { resolve(null); return; }
        resolve(res.mint);
      });
    });
  }

  function resolveDexPair(pairAddress) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'RESOLVE_DEXSCREENER', pairAddress }, res => {
        if (chrome.runtime.lastError || !res || !res.tokenAddress) { resolve(null); return; }
        resolve(res.tokenAddress);
      });
    });
  }

  // ── FLOATING BAR ──
  function showBar(mint) {
    if (document.getElementById('shield-bar')) return;
    ensureStyles();
    const bar = document.createElement('div');
    bar.id = 'shield-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0f14;border-bottom:2px solid rgba(139,92,246,.4);padding:10px 16px;display:flex;align-items:center;gap:12px;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#e4e7ef;box-shadow:0 4px 24px rgba(0,0,0,.6)';
    bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score loading">Scanning\u2026</span>';
    const origMargin = document.body?.style?.marginTop || '';
    document.body.prepend(bar);
    if (document.body) document.body.style.marginTop = '48px';
    const closeBar = () => { bar.remove(); if (document.body) document.body.style.marginTop = origMargin; };
    const addClose = () => { const b = document.createElement('button'); b.className = 'sb-close'; b.textContent = '\u2715'; b.addEventListener('click', closeBar); bar.appendChild(b); };

    scan(mint).then(r => {
      if (!r) { bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score danger">Error</span><span class="sb-verdict">Could not reach API</span>'; addClose(); return; }
      if (r.blocked) {
        const paymentInfo = r.payment || {};
        const deeplink = paymentInfo.deeplink || 'https://phantom.app/ul/transfer?recipient=A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs&amount=1&splToken=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&label=Shield+Credits';
        bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score warning">\u26A1</span><span class="sb-verdict" style="flex:1;font-size:12px">' + (r.message || 'Free trial ended') + '</span><button class="sb-pay" id="sb-topup-1">$1</button><button class="sb-pay" id="sb-topup-5">$5</button><button class="sb-pay" id="sb-topup-10">$10</button>';
        addClose();
        [1,5,10].forEach(amt => {
          document.getElementById('sb-topup-' + amt)?.addEventListener('click', () => {
            const link = deeplink.replace('amount=1', 'amount=' + amt).replace('amount=5', 'amount=' + amt);
            window.open(link, '_blank');
          });
        });
        return;
      }
      const tier = r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger';
      const verdict = r.verdict || tier.toUpperCase();
      bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score ' + tier + '">' + r.score + '</span><span class="sb-verdict">' + verdict + '</span><span style="font-size:10px;color:rgba(255,255,255,.3)">' + mint.slice(0, 6) + '\u2026' + mint.slice(-4) + '</span>' + (r.score >= 35 ? '<button class="sb-buy" id="sb-buy-btn">\u26A1 Buy Safe via LI.FI</button>' : '<span style="font-size:11px;color:#ef4444;font-weight:600">\uD83D\uDED1 Swap Blocked</span>');
      addClose();
      document.getElementById('sb-buy-btn')?.addEventListener('click', () => {
        if (typeof globalThis.ShieldLifi !== 'undefined') globalThis.ShieldLifi.createSwapModal(mint, r.score, tier, verdict);
        else window.open('https://jumper.exchange/?toChain=1151111081099710&toToken=' + mint + '&integrator=shield-rug-score&fee=0.005', '_blank');
      });
    });
    chrome.runtime.sendMessage({ type: 'CHECK_TRIAL' });
  }

  // ── URL DETECTION ──
  function detectURL() {
    const href = location.href;
    const host = location.hostname;

    if (host.includes('dexscreener.com')) {
      const m = href.match(/\/solana\/([a-zA-Z0-9]{32,44})/i);
      if (m && m[1]) {
        const addr = m[1];
        // Try pair resolve first, fallback to direct scan (might be token address not pair)
        resolveDexPair(addr).then(tokenAddr => {
          if (tokenAddr) { showBar(tokenAddr); }
          else if (validMint(addr)) { showBar(addr); }  // URL has token address directly
        });
      }
      return;
    }

    const patterns = [/\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/, /\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/, /\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/, /\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})/, /[?&](?:outputMint|inputMint|mint)=([1-9A-HJ-NP-Za-km-z]{32,44})/];
    for (const p of patterns) { const m = href.match(p); if (m && m[1] && validMint(m[1])) { showBar(m[1]); return; } }
  }

  // ── INLINE BADGES (non-Twitter pages) ──
  const badgedMints = new Set();
  function scanText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => { const t = node.parentElement?.tagName?.toUpperCase(); return ['SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT'].includes(t) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    const found = new Set();
    while (walker.nextNode()) { const m = walker.currentNode.textContent.match(SOLANA_RE); if (m) m.forEach(x => { if (validMint(x)) found.add(x); }); }
    found.forEach(mint => {
      if (badgedMints.has(mint)) return;
      badgedMints.add(mint);
      let el = document.querySelector('[href*="' + mint + '"]');
      if (!el) { const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (tw.nextNode()) { if (tw.currentNode.textContent.includes(mint)) { el = tw.currentNode.parentElement; break; } } }
      if (!el || el.querySelector('.shield-badge')) return;
      const badge = document.createElement('span'); badge.className = 'shield-badge'; badge.style.cssText = 'background:rgba(139,92,246,.15);color:#a78bfa'; badge.textContent = '\u26E8\u2026';
      try { el.appendChild(badge); } catch { return; }
      scan(mint).then(r => {
        if (!r || r.blocked) { badge.remove(); badgedMints.delete(mint); return; }
        const tier = r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger';
        badge.textContent = '\u26E8 ' + r.score; badge.style.color = COLORS[tier]; badge.style.background = COLORS[tier] + '20';
        badge.title = 'Shield: ' + r.score + '/100'; badge.addEventListener('click', e => { e.stopPropagation(); showBar(mint); });
      }).catch(() => { badge.remove(); badgedMints.delete(mint); });
    });
  }

  // ── TWITTER/X ──
  const articleMints = new Map();
  const resolvedTickers = new Map();

  function tierOf(r) { return r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger'; }

  function injectTweetBadge(article, mint, sd) {
    const tt = article.querySelector('[data-testid="tweetText"]') || article;
    if (tt.querySelector('[data-shield-mint="' + mint + '"]')) return;
    const b = document.createElement('span');
    b.setAttribute('data-shield-mint', mint);
    b.className = 'shield-badge';
    if (!sd) {
      b.style.cssText = 'background:rgba(139,92,246,.15);color:#a78bfa;display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      b.textContent = '\u26E8\u2026'; b.title = 'Shield scanning\u2026';
    } else {
      const c = COLORS[sd.tier];
      b.style.cssText = 'background:' + c + '20;color:' + c + ';display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      b.textContent = '\u26E8 ' + sd.score; b.title = 'Shield: ' + sd.score + '/100 \u2014 ' + sd.verdict;
      b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showBar(mint); });
    }
    try { tt.appendChild(b); } catch {}
  }

  function scanAndBadge(article, mintMap, mint) {
    if (mintMap.has(mint)) return;
    mintMap.set(mint, null);
    injectTweetBadge(article, mint, null);
    scan(mint).then(r => {
      if (!r || r.blocked) { mintMap.delete(mint); return; }
      const sd = { score: r.score, tier: tierOf(r), verdict: r.verdict || tierOf(r).toUpperCase() };
      mintMap.set(mint, sd);
      injectTweetBadge(article, mint, sd);
    }).catch(() => mintMap.delete(mint));
  }

  function scanArticle(article) {
    if (articleMints.has(article)) return;
    articleMints.set(article, new Map());
    const mintMap = articleMints.get(article);
    const text = article.textContent || '';

    // 1. Raw addresses
    const addrMatches = text.match(SOLANA_RE);
    if (addrMatches) addrMatches.forEach(m => { if (validMint(m)) scanAndBadge(article, mintMap, m); });

    // 2. Cashtags — from links AND from text
    const tickers = [];

    // 2a. From cashtag links: /search?q=%24TICKER
    article.querySelectorAll('a[href]').forEach(link => {
      const href = link.href || '';
      const m = href.match(/[?&]q=%24([A-Za-z]{2,10})/);
      if (m) { const t = m[1].toUpperCase(); if (!SKIP_TICKERS.has(t) && tickers.length < 3 && !tickers.includes(t)) tickers.push(t); }
    });

    // 2b. From plain text: $JASMY, $PEPE, $WIF etc
    const textMatches = text.match(/\$([A-Za-z]{2,10})\b/g);
    if (textMatches) {
      textMatches.forEach(m => {
        const t = m.slice(1).toUpperCase();
        if (!SKIP_TICKERS.has(t) && tickers.length < 3 && !tickers.includes(t)) tickers.push(t);
      });
    }

    // 3. Resolve tickers — send directly to scan endpoint, server resolves
    tickers.forEach(ticker => {
      const key = '$' + ticker;
      if (mintMap.has(key)) return;
      mintMap.set(key, 'resolving');

      // Check local cache
      const cached = resolvedTickers.get(ticker);
      if (cached) { mintMap.delete(key); scanAndBadge(article, mintMap, cached); return; }

      // Send ticker to background to resolve + scan in one step
      chrome.runtime.sendMessage({ type: 'RESOLVE_AND_SCAN', ticker, fingerprint: fp }, res => {
        mintMap.delete(key);
        if (chrome.runtime.lastError || !res || !res.mint || !res.data) return;
        const mint = res.mint;
        resolvedTickers.set(ticker, mint);
        cache[mint] = res.data;
        const r = res.data;
        const sd = { score: r.score, tier: tierOf(r), verdict: r.verdict || tierOf(r).toUpperCase() };
        mintMap.set(mint, sd);
        injectTweetBadge(article, mint, sd);  // inject WITH score, no "scanning" state
      });
    });
  }

  function startHeartbeat() {
    setInterval(() => {
      for (const [article, mintMap] of articleMints) {
        if (!document.contains(article)) { articleMints.delete(article); continue; }
        for (const [mint, sd] of mintMap) {
          if (typeof mint === 'string' && mint.startsWith('$')) continue;
          const tt = article.querySelector('[data-testid="tweetText"]') || article;
          if (!tt.querySelector('[data-shield-mint="' + mint + '"]')) injectTweetBadge(article, mint, sd);
        }
      }
    }, 2000);
  }

  let mutationDebounce = null;
  function startMutationObserver() {
    const observer = new MutationObserver(() => {
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => {
        document.querySelectorAll('article').forEach(a => { if (!articleMints.has(a)) scanArticle(a); });
      }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── MESSAGE HANDLER ──
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHIELD_CONNECT_WALLET') {
      const handler = event => {
        if (event.data.type === 'SHIELD_RES_CONNECT') {
          window.removeEventListener('message', handler);
          sendResponse(event.data.address ? { address: event.data.address } : { error: event.data.error || 'Phantom not found' });
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'SHIELD_REQ_CONNECT' }, '*');
      setTimeout(() => window.removeEventListener('message', handler), 10000);
      return true;
    }
    if (msg.type === 'SHIELD_STORE_WALLET') { try { localStorage.setItem('shield_wallet', msg.address); } catch {} sendResponse({ ok: true }); }
    if (msg.type === 'SHIELD_CLEAR_WALLET') { try { localStorage.removeItem('shield_wallet'); } catch {} sendResponse({ ok: true }); }
  });

  // ── START ──
  function start() {
    console.log('[SHIELD] \u26E8 Active on', location.hostname);
    ensureStyles();
    setTimeout(detectURL, 1500);
    setTimeout(scanText, 3500);
    startMutationObserver();
    startHeartbeat();
    let lastURL = location.href;
    setInterval(() => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        document.getElementById('shield-bar')?.remove();
        if (document.body) document.body.style.marginTop = '';
        badgedMints.clear();
        setTimeout(detectURL, 800);
        setTimeout(scanText, 2500);
      }
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
