(() => {
  'use strict';

  const OWNER_WALLET = 'A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs';
  const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOLANA_RE    = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  const SKIP = new Set([
    '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'So11111111111111111111111111111111111111112', 'ComputeBudget111111111111111111111111111111',
    'Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
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
    try { const s = localStorage.getItem('shield_fp'); if (s) return s; const id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('shield_fp', id); return id; }
    catch { return 'anon_' + Math.random().toString(36).slice(2); }
  })();

  function validMint(a) {
    if (a.length < 32 || a.length > 44 || SKIP.has(a)) return false;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
    if (a === a.toUpperCase()) return false;
    return true;
  }

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function injectBridge() {
    try { const s = document.createElement('script'); s.src = chrome.runtime.getURL('src/bridge.js'); (document.head || document.documentElement).appendChild(s); s.onload = () => s.remove(); } catch {}
  }
  injectBridge();


  // ═══════════════════════════════════════
  // SCAN QUEUE — max 4 concurrent, prevents API flood on Twitter feed
  // ═══════════════════════════════════════
  const scanQueue = [];
  let activeScanCount = 0;
  const MAX_CONCURRENT_SCANS = 4;

  function enqueueScan(mint) {
    if (cache[mint]) return Promise.resolve(cache[mint]);
    return new Promise(resolve => {
      scanQueue.push({ mint, resolve });
      drainQueue();
    });
  }

  function drainQueue() {
    while (activeScanCount < MAX_CONCURRENT_SCANS && scanQueue.length > 0) {
      const { mint, resolve } = scanQueue.shift();
      if (cache[mint]) { resolve(cache[mint]); continue; }
      activeScanCount++;
      scanDirect(mint).then(r => {
        activeScanCount--;
        resolve(r);
        drainQueue();
      });
    }
  }

  function scanDirect(mint, retryCount = 0) {
    if (!isContextValid()) return Promise.resolve(null);
    return new Promise(resolve => {
      const startTime = Date.now();
      try {
        chrome.runtime.sendMessage({ type: 'DO_SCAN', token: mint, fingerprint: fp }, res => {
          if (chrome.runtime.lastError) {
            if (retryCount < 1) { setTimeout(() => scanDirect(mint, retryCount + 1).then(resolve), 2000); }
            else resolve(null);
            return;
          }
          if (!res) { resolve(null); return; }
          if (res.blocked) { resolve({ score: -1, blocked: true, reason: res.reason, message: res.message, payment: res.payment }); return; }
          if (res.error === 'server_down' && retryCount < 2) {
            setTimeout(() => scanDirect(mint, retryCount + 1).then(resolve), (res.retryAfter || 10) * 1000);
            return;
          }
          if (res.error) { resolve(null); return; }
          if (res.data) {
            res.data._scanTime = Date.now() - startTime;
            cache[mint] = res.data;
            resolve(res.data);
          } else resolve(null);
        });
      } catch { resolve(null); }
    });
  }

  // Public scan function uses queue
  function scan(mint) { return enqueueScan(mint); }

  function resolveTicker(ticker) {
    if (!isContextValid()) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'RESOLVE_TICKER', ticker }, res => {
          if (chrome.runtime.lastError || !res?.found || !res?.mint) resolve(null);
          else resolve(res.mint);
        });
      } catch { resolve(null); }
    });
  }

  function resolveDexPair(pairAddress) {
    if (!isContextValid()) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'RESOLVE_DEXSCREENER', pairAddress }, res => {
          if (chrome.runtime.lastError || !res) resolve(null);
          else resolve(res);
        });
      } catch { resolve(null); }
    });
  }


  // ═══════════════════════════════════════
  // STYLES
  // ═══════════════════════════════════════
  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'shield-bar-styles';
    style.textContent = `
@keyframes shieldSlideIn{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes shieldSlideOut{from{transform:translateY(0);opacity:1}to{transform:translateY(-100%);opacity:0}}
@keyframes shieldPulse{0%,100%{opacity:.4}50%{opacity:1}}
@keyframes shieldSpin{to{transform:rotate(360deg)}}
@keyframes shieldFadeIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
@keyframes shieldCheckPop{0%{transform:scale(0)}50%{transform:scale(1.2)}100%{transform:scale(1)}}
#shield-bar{animation:shieldSlideIn .35s cubic-bezier(.4,0,.2,1) forwards}
#shield-bar.closing{animation:shieldSlideOut .25s cubic-bezier(.4,0,.2,1) forwards}
.sb-logo{font-family:monospace;font-weight:700;color:#a78bfa;letter-spacing:2px;font-size:12px}
.sb-score{font-family:monospace;font-weight:700;font-size:18px;padding:2px 12px;border-radius:6px;transition:all .3s ease}
.sb-score.safe{color:#34d399;background:rgba(52,211,153,.15)}.sb-score.caution{color:#fbbf24;background:rgba(251,191,36,.15)}
.sb-score.warning{color:#f59e0b;background:rgba(245,158,11,.15)}.sb-score.danger{color:#ef4444;background:rgba(239,68,68,.15)}
.sb-score.loading{color:#a78bfa;background:rgba(139,92,246,.15)}
.sb-spinner{width:14px;height:14px;border:2px solid rgba(139,92,246,.2);border-top-color:#a78bfa;border-radius:50%;animation:shieldSpin .6s linear infinite;display:inline-block;margin-right:6px;vertical-align:middle}
.sb-verdict{color:rgba(255,255,255,.5);font-size:12px;transition:opacity .3s}
.sb-close{background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer;padding:2px 8px;margin-left:auto;line-height:1;transition:color .2s}.sb-close:hover{color:#fff}
.sb-buy{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);color:#34d399;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;animation:shieldFadeIn .3s ease}.sb-buy:hover{background:rgba(52,211,153,.2)}
.sb-pay{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);color:#fbbf24;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s}.sb-pay:hover{background:rgba(251,191,36,.2)}
.sb-retry{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);color:#a78bfa;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s}.sb-retry:hover{background:rgba(139,92,246,.2)}
.sb-conf{font-size:9px;padding:2px 6px;border-radius:3px;margin-left:4px}
.sb-conf.high{color:rgba(52,211,153,.7);background:rgba(52,211,153,.1)}
.sb-conf.medium{color:rgba(251,191,36,.7);background:rgba(251,191,36,.1)}
.sb-conf.low{color:rgba(239,68,68,.7);background:rgba(239,68,68,.1)}
.shield-badge{display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle;transition:all .25s ease}
.shield-badge.scanning{animation:shieldPulse 1.5s ease infinite}
    `.trim();
    (document.head || document.documentElement).appendChild(style);
  }


  // ═══════════════════════════════════════
  // FLOATING BAR — cold start awareness + data confidence
  // ═══════════════════════════════════════
  function showBar(mint) {
    if (document.getElementById('shield-bar')) return;
    ensureStyles();
    const bar = document.createElement('div');
    bar.id = 'shield-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0f14;border-bottom:2px solid rgba(139,92,246,.4);padding:10px 16px;display:flex;align-items:center;gap:12px;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#e4e7ef;box-shadow:0 4px 24px rgba(0,0,0,.6)';
    bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score loading"><span class="sb-spinner"></span>Scanning</span><span class="sb-verdict" style="opacity:.5">Analyzing on-chain data\u2026</span>';

    const origMargin = document.body?.style?.marginTop || '';
    document.body.prepend(bar);
    if (document.body) document.body.style.marginTop = '48px';

    const closeBar = () => {
      bar.classList.add('closing');
      setTimeout(() => { bar.remove(); if (document.body) document.body.style.marginTop = origMargin; }, 250);
    };
    const addClose = () => {
      const b = document.createElement('button'); b.className = 'sb-close'; b.textContent = '\u2715';
      b.addEventListener('click', closeBar); bar.appendChild(b);
    };

    const startTime = Date.now();

    // Cold start detector — if >5s, show "waking up" message
    const coldStartTimer = setTimeout(() => {
      const verdictEl = bar.querySelector('.sb-verdict');
      if (verdictEl) verdictEl.textContent = 'Server waking up (free tier)\u2026 hang tight';
    }, 5000);

    scan(mint).then(r => {
      clearTimeout(coldStartTimer);
      const elapsed = Date.now() - startTime;
      const delay = Math.max(0, 400 - elapsed);

      setTimeout(() => {
        if (!r) {
          bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score danger">Error</span><span class="sb-verdict">Could not reach API</span><button class="sb-retry" id="sb-retry-btn">Retry</button>';
          addClose();
          document.getElementById('sb-retry-btn')?.addEventListener('click', () => { closeBar(); setTimeout(() => showBar(mint), 300); });
          return;
        }
        if (r.blocked) {
          const pi = r.payment || {};
          const dl = pi.deeplink || `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=1&splToken=${USDC_MINT}&label=Shield+Credits`;
          bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score warning">\u26A1</span><span class="sb-verdict" style="flex:1;font-size:12px">' + (r.message || 'Free trial ended') + '</span><button class="sb-pay" id="sb-topup-1">$1</button><button class="sb-pay" id="sb-topup-5">$5</button><button class="sb-pay" id="sb-topup-10">$10</button>';
          addClose();
          [1, 5, 10].forEach(amt => {
            document.getElementById('sb-topup-' + amt)?.addEventListener('click', () => {
              window.open(dl.replace(/amount=\d+/, 'amount=' + amt), '_blank');
            });
          });
          return;
        }
        const tier = r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger';
        const verdict = r.verdict || tier.toUpperCase();
        const conf = r.dataConfidence || (r.sourcesUsed >= 3 ? 'high' : r.sourcesUsed === 2 ? 'medium' : 'low');
        const confLabel = conf === 'high' ? '4/4 sources' : conf === 'medium' ? '2-3 sources' : '1 source';
        bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score ' + tier + '" style="animation:shieldCheckPop .3s ease">' + r.score + '</span><span class="sb-verdict">' + verdict + '</span><span class="sb-conf ' + conf + '">' + confLabel + '</span><span style="font-size:10px;color:rgba(255,255,255,.3)">' + mint.slice(0, 6) + '\u2026' + mint.slice(-4) + '</span>' + (r.score >= 35 ? '<button class="sb-buy" id="sb-buy-btn">\u26A1 Buy Safe via LI.FI</button>' : '<span style="font-size:11px;color:#ef4444;font-weight:600;animation:shieldFadeIn .3s ease">\uD83D\uDED1 Swap Blocked</span>');
        addClose();
        document.getElementById('sb-buy-btn')?.addEventListener('click', () => {
          if (typeof globalThis.ShieldLifi !== 'undefined') globalThis.ShieldLifi.createSwapModal(mint, r.score, tier, verdict);
          else window.open('https://jumper.exchange/?toChain=1151111081099710&toToken=' + mint + '&integrator=shield-rug-score&fee=0.005', '_blank');
        });
      }, delay);
    });

    if (isContextValid()) { try { chrome.runtime.sendMessage({ type: 'CHECK_TRIAL' }); } catch {} }
  }

  // ── Stablecoin pair bar ──
  function showStablePairBar(base, quote) {
    if (document.getElementById('shield-bar')) return;
    ensureStyles();
    const bar = document.createElement('div');
    bar.id = 'shield-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0f14;border-bottom:2px solid rgba(52,211,153,.4);padding:10px 16px;display:flex;align-items:center;gap:12px;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#e4e7ef;box-shadow:0 4px 24px rgba(0,0,0,.6)';
    bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score safe" style="animation:shieldCheckPop .3s ease">\u2713</span><span class="sb-verdict" style="color:#34D399">' + (base || '?') + '/' + (quote || '?') + ' \u2014 Known pair, no rug risk</span>';
    const origMargin = document.body?.style?.marginTop || '';
    document.body.prepend(bar);
    if (document.body) document.body.style.marginTop = '48px';
    const b = document.createElement('button'); b.className = 'sb-close'; b.textContent = '\u2715';
    b.addEventListener('click', () => { bar.classList.add('closing'); setTimeout(() => { bar.remove(); if (document.body) document.body.style.marginTop = origMargin; }, 250); });
    bar.appendChild(b);
  }


  // ═══════════════════════════════════════
  // URL DETECTION
  // ═══════════════════════════════════════
  function detectURL() {
    const href = location.href;
    const host = location.hostname;

    if (host.includes('dexscreener.com')) {
      const m = href.match(/\/solana\/([a-zA-Z0-9]{32,44})/i);
      if (m && m[1]) {
        const addr = m[1];
        resolveDexPair(addr).then(res => {
          if (res && res.tokenAddress) {
            showBar(res.tokenAddress);
          } else if (res && res.isStablePair) {
            showStablePairBar(res.base, res.quote);
          } else {
            // Fallback: send to backend which has 4-method resolve
            scan(addr).then(r => {
              if (r && !r.blocked && r.score >= 0) showBar(r.address || addr);
              else if (r && r.blocked) showBar(addr);
            });
          }
        });
      }
      return;
    }

    const patterns = [/\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/, /\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/, /\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/, /\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})/, /[?&](?:outputMint|inputMint|mint)=([1-9A-HJ-NP-Za-km-z]{32,44})/];
    for (const p of patterns) { const m = href.match(p); if (m && m[1] && validMint(m[1])) { showBar(m[1]); return; } }
  }


  // ═══════════════════════════════════════
  // INLINE BADGES (non-Twitter)
  // ═══════════════════════════════════════
  const badgedMints = new Set();
  function scanText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => { const t = node.parentElement?.tagName?.toUpperCase(); return ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(t) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    const found = new Set();
    while (walker.nextNode()) { const m = walker.currentNode.textContent.match(SOLANA_RE); if (m) m.forEach(x => { if (validMint(x)) found.add(x); }); }
    found.forEach(mint => {
      if (badgedMints.has(mint)) return;
      badgedMints.add(mint);
      let el = document.querySelector('[href*="' + mint + '"]');
      if (!el) { const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (tw.nextNode()) { if (tw.currentNode.textContent.includes(mint)) { el = tw.currentNode.parentElement; break; } } }
      if (!el || el.querySelector('.shield-badge')) return;
      const badge = document.createElement('span');
      badge.className = 'shield-badge scanning';
      badge.style.cssText = 'background:rgba(139,92,246,.15);color:#a78bfa';
      badge.textContent = '\u26E8\u2026';
      try { el.appendChild(badge); } catch { return; }
      scan(mint).then(r => {
        badge.classList.remove('scanning');
        if (!r || r.blocked) { badge.style.opacity = '0'; setTimeout(() => { badge.remove(); badgedMints.delete(mint); }, 300); return; }
        const tier = r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger';
        badge.textContent = '\u26E8 ' + r.score;
        badge.style.color = COLORS[tier];
        badge.style.background = COLORS[tier] + '20';
        badge.title = 'Shield: ' + r.score + '/100';
        badge.addEventListener('click', e => { e.stopPropagation(); showBar(mint); });
      }).catch(() => { badge.style.opacity = '0'; setTimeout(() => { badge.remove(); badgedMints.delete(mint); }, 300); });
    });
  }


  // ═══════════════════════════════════════
  // TWITTER/X — IntersectionObserver + MutationObserver
  // ═══════════════════════════════════════
  const articleMints = new Map();
  const resolvedTickers = new Map();

  function tierOf(r) { return r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger'; }

  function injectTweetBadge(article, mint, sd) {
    const tt = article.querySelector('[data-testid="tweetText"]') || article;
    const existing = tt.querySelector('[data-shield-mint="' + mint + '"]');

    if (existing && sd) {
      // UPDATE existing scanning badge with real score
      const c = COLORS[sd.tier];
      existing.className = 'shield-badge';
      existing.style.cssText = 'background:' + c + '20;color:' + c + ';display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      existing.textContent = '\u26E8 ' + sd.score;
      existing.title = 'Shield: ' + sd.score + '/100 \u2014 ' + sd.verdict;
      existing.onclick = null;
      existing.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showBar(mint); });
      return;
    }
    if (existing) return;

    const b = document.createElement('span');
    b.setAttribute('data-shield-mint', mint);
    b.className = 'shield-badge' + (sd ? '' : ' scanning');
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

    // Raw addresses
    const addrMatches = text.match(SOLANA_RE);
    if (addrMatches) addrMatches.forEach(m => { if (validMint(m)) scanAndBadge(article, mintMap, m); });

    // Cashtags (max 3 per tweet)
    const tickers = [];
    article.querySelectorAll('a[href]').forEach(link => {
      const m = (link.href || '').match(/[?&]q=%24([A-Za-z]{2,10})/);
      if (m) { const t = m[1].toUpperCase(); if (!SKIP_TICKERS.has(t) && tickers.length < 3 && !tickers.includes(t)) tickers.push(t); }
    });
    const textMatches = text.match(/\$([A-Za-z]{2,10})\b/g);
    if (textMatches) textMatches.forEach(m => { const t = m.slice(1).toUpperCase(); if (!SKIP_TICKERS.has(t) && tickers.length < 3 && !tickers.includes(t)) tickers.push(t); });

    tickers.forEach(ticker => {
      const key = '$' + ticker;
      if (mintMap.has(key)) return;
      mintMap.set(key, 'resolving');
      const cached = resolvedTickers.get(ticker);
      if (cached) { mintMap.delete(key); scanAndBadge(article, mintMap, cached); return; }
      if (!isContextValid()) return;
      try {
        chrome.runtime.sendMessage({ type: 'RESOLVE_AND_SCAN', ticker, fingerprint: fp }, res => {
          mintMap.delete(key);
          if (chrome.runtime.lastError || !res?.mint || !res?.data) return;
          resolvedTickers.set(ticker, res.mint);
          cache[res.mint] = res.data;
          const sd = { score: res.data.score, tier: tierOf(res.data), verdict: res.data.verdict || tierOf(res.data).toUpperCase() };
          mintMap.set(res.mint, sd);
          injectTweetBadge(article, res.mint, sd);
        });
      } catch {}
    });
  }

  // ── Heartbeat: re-inject badges Twitter removes ──
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

  // ── MutationObserver: catch new articles added to DOM ──
  let mutationDebounce = null;
  function startMutationObserver() {
    const observer = new MutationObserver(() => {
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(scanVisibleArticles, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── IntersectionObserver: only scan articles visible on screen ──
  let intersectionObserver = null;
  function startIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return; // Fallback to mutation-only
    intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && entry.target.tagName === 'ARTICLE') {
          if (!articleMints.has(entry.target)) scanArticle(entry.target);
        }
      });
    }, { rootMargin: '200px' }); // Pre-scan 200px before visible
  }

  function scanVisibleArticles() {
    document.querySelectorAll('article').forEach(a => {
      if (articleMints.has(a)) return;
      if (intersectionObserver) {
        intersectionObserver.observe(a); // Will fire when visible
      } else {
        scanArticle(a); // Fallback: scan immediately
      }
    });
  }


  // ═══════════════════════════════════════
  // MESSAGE HANDLER
  // ═══════════════════════════════════════
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
      setTimeout(() => { window.removeEventListener('message', handler); sendResponse({ error: 'Phantom connection timed out.' }); }, 15000);
      return true;
    }
    if (msg.type === 'SHIELD_STORE_WALLET') { try { localStorage.setItem('shield_wallet', msg.address); } catch {} sendResponse({ ok: true }); }
    if (msg.type === 'SHIELD_CLEAR_WALLET') { try { localStorage.removeItem('shield_wallet'); } catch {} sendResponse({ ok: true }); }
  });


  // ═══════════════════════════════════════
  // START
  // ═══════════════════════════════════════
  function start() {
    console.log('[SHIELD] \u26E8 Active on', location.hostname);
    ensureStyles();
    startIntersectionObserver();
    setTimeout(detectURL, 1500);
    setTimeout(scanText, 3500);
    startMutationObserver();
    startHeartbeat();

    let lastURL = location.href;
    setInterval(() => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        const oldBar = document.getElementById('shield-bar');
        if (oldBar) { oldBar.classList.add('closing'); setTimeout(() => { oldBar.remove(); if (document.body) document.body.style.marginTop = ''; }, 250); }
        badgedMints.clear();
        setTimeout(detectURL, 800);
        setTimeout(scanText, 2500);
      }
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
