/**
 * SHIELD Content Script v4.0
 * 
 * Architecture: ONE resolve function handles everything.
 * resolveToken(input) → { mint, source } or null
 * 
 * Input types:
 *   - proper-case Solana address → scan directly
 *   - lowercase address (DexScreener URL) → DexScreener pair API → token-pairs API → backend
 *   - $TICKER cashtag → Jupiter resolve → scan
 *   - pair address → DexScreener API → extract non-stablecoin token
 * 
 * No race conditions: DexScreener pages lock the bar until resolve completes.
 */
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
  let barLocked = false; // Prevents scanText from racing with DexScreener resolve

  // ── Hardened fingerprint — survives localStorage clear ──
  const fp = (() => {
    // Combine multiple signals for a fingerprint that's hard to reset
    const signals = [];
    // 1. Screen resolution + color depth (doesn't change)
    signals.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
    // 2. Timezone offset (doesn't change)
    signals.push(`tz${new Date().getTimezoneOffset()}`);
    // 3. Language
    signals.push(navigator.language || 'en');
    // 4. Platform
    signals.push(navigator.platform || 'unknown');
    // 5. Hardware concurrency (CPU cores)
    signals.push(`c${navigator.hardwareConcurrency || 0}`);
    // 6. Device memory
    signals.push(`m${navigator.deviceMemory || 0}`);

    // Hash the signals into a stable fingerprint
    const raw = signals.join('|');
    let hash = 0;
    for (let i = 0; i < raw.length; i++) { hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0; }
    const hardFP = 'sh_' + Math.abs(hash).toString(36);

    // Also keep localStorage FP for backward compat
    try {
      const stored = localStorage.getItem('shield_fp');
      if (stored) return stored + '_' + hardFP;
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('shield_fp', id);
      return id + '_' + hardFP;
    } catch {
      return hardFP + '_' + Math.random().toString(36).slice(2);
    }
  })();

  function isProperMint(a) {
    if (a.length < 32 || a.length > 44 || SKIP.has(a)) return false;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(a)) return false;
    return /[A-Z]/.test(a) && /[a-z]/.test(a); // Must be mixed case
  }

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function injectBridge() {
    try { const s = document.createElement('script'); s.src = chrome.runtime.getURL('src/bridge.js'); (document.head || document.documentElement).appendChild(s); s.onload = () => s.remove(); } catch {}
  }
  injectBridge();


  // ═══════════════════════════════════════
  // MESSAGING — all comms to background.js
  // ═══════════════════════════════════════
  function sendMsg(msg) {
    if (!isContextValid()) return Promise.resolve(null);
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(res);
        });
      } catch { resolve(null); }
    });
  }


  // ═══════════════════════════════════════
  // SCAN QUEUE — max 4 concurrent
  // ═══════════════════════════════════════
  const scanQueue = [];
  let activeScans = 0;
  const MAX_CONCURRENT = 4;

  function enqueueScan(mint) {
    if (cache[mint]) return Promise.resolve(cache[mint]);
    return new Promise(resolve => {
      scanQueue.push({ mint, resolve });
      drainQueue();
    });
  }

  function drainQueue() {
    while (activeScans < MAX_CONCURRENT && scanQueue.length > 0) {
      const { mint, resolve } = scanQueue.shift();
      if (cache[mint]) { resolve(cache[mint]); continue; }
      activeScans++;
      doScan(mint).then(r => { activeScans--; resolve(r); drainQueue(); });
    }
  }

  function doScan(mint, retry = 0) {
    return new Promise(resolve => {
      sendMsg({ type: 'DO_SCAN', token: mint, fingerprint: fp }).then(res => {
        if (!res) { if (retry < 1) { setTimeout(() => doScan(mint, retry + 1).then(resolve), 2000); } else resolve(null); return; }
        if (res.blocked) { resolve({ score: -1, blocked: true, reason: res.reason, message: res.message, payment: res.payment }); return; }
        if (res.error === 'server_down' && retry < 2) { setTimeout(() => doScan(mint, retry + 1).then(resolve), (res.retryAfter || 10) * 1000); return; }
        if (res.error) { resolve(null); return; }
        if (res.data) { cache[mint] = res.data; resolve(res.data); }
        else resolve(null);
      });
    });
  }

  function scan(mint) { return enqueueScan(mint); }


  // ═══════════════════════════════════════
  // RESOLVE — single entry point for ALL address types
  // ═══════════════════════════════════════

  // Resolve DexScreener pair/token address → proper mint address
  function resolveDex(addr) {
    return sendMsg({ type: 'RESOLVE_DEXSCREENER', pairAddress: addr });
  }

  // Resolve $TICKER → mint + scan data in one call
  function resolveAndScan(ticker) {
    return sendMsg({ type: 'RESOLVE_AND_SCAN', ticker, fingerprint: fp });
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
  // FLOATING BAR
  // ═══════════════════════════════════════
  function removeBar() {
    const old = document.getElementById('shield-bar');
    if (old) { old.remove(); }
    if (document.body) document.body.style.marginTop = '';
  }

  function closeBarAnimated() {
    const old = document.getElementById('shield-bar');
    if (old) { old.classList.add('closing'); setTimeout(removeBar, 250); }
    else removeBar();
  }

  function showBar(mint) {
    if (barLocked) return;
    removeBar(); // Always replace — no "already exists" skip
    ensureStyles();

    const bar = document.createElement('div');
    bar.id = 'shield-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0f14;border-bottom:2px solid rgba(139,92,246,.4);padding:10px 16px;display:flex;align-items:center;gap:12px;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#e4e7ef;box-shadow:0 4px 24px rgba(0,0,0,.6)';
    bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score loading"><span class="sb-spinner"></span>Scanning</span><span class="sb-verdict" style="opacity:.5">Analyzing on-chain data\u2026</span>';

    document.body.prepend(bar);
    document.body.style.marginTop = '48px';

    const closeBar = () => { bar.classList.add('closing'); setTimeout(removeBar, 250); };
    const addClose = () => { const b = document.createElement('button'); b.className = 'sb-close'; b.textContent = '\u2715'; b.addEventListener('click', closeBar); bar.appendChild(b); };

    // Cold start detector
    const coldTimer = setTimeout(() => {
      const v = bar.querySelector('.sb-verdict');
      if (v && v.textContent.includes('Analyzing')) v.textContent = 'Server waking up\u2026 hang tight';
    }, 5000);

    scan(mint).then(r => {
      clearTimeout(coldTimer);
      setTimeout(() => {
        if (!document.getElementById('shield-bar')) return; // Bar was closed

        if (!r) {
          bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score danger">Error</span><span class="sb-verdict">Could not reach API</span><button class="sb-retry" id="sb-retry-btn">Retry</button>';
          addClose();
          document.getElementById('sb-retry-btn')?.addEventListener('click', () => { removeBar(); showBar(mint); });
          return;
        }
        if (r.blocked) {
          const dl = r.payment?.deeplink || `https://phantom.app/ul/transfer?recipient=${OWNER_WALLET}&amount=1&splToken=${USDC_MINT}&label=Shield+Credits`;
          bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score warning">\u26A1</span><span class="sb-verdict" style="flex:1;font-size:12px">' + (r.message || 'Free trial ended') + '</span><button class="sb-pay" id="sb-topup-1">$1</button><button class="sb-pay" id="sb-topup-5">$5</button><button class="sb-pay" id="sb-topup-10">$10</button>';
          addClose();
          [1, 5, 10].forEach(amt => { document.getElementById('sb-topup-' + amt)?.addEventListener('click', () => { window.open(dl.replace(/amount=\d+/, 'amount=' + amt), '_blank'); }); });
          return;
        }

        const tier = r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger';
        const verdict = r.verdict || tier.toUpperCase();
        const conf = r.dataConfidence || (r.sourcesUsed >= 3 ? 'high' : r.sourcesUsed === 2 ? 'medium' : 'low');
        const confLabel = conf === 'high' ? '4/4' : conf === 'medium' ? '2-3' : '1';
        const nameLabel = r.name ? `<span style="font-size:11px;color:rgba(255,255,255,.6);font-weight:600">${r.symbol || r.name}</span>` : '';

        bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span>'
          + '<span class="sb-score ' + tier + '" style="animation:shieldCheckPop .3s ease">' + r.score + '</span>'
          + '<span class="sb-verdict">' + verdict + '</span>'
          + nameLabel
          + '<span class="sb-conf ' + conf + '">' + confLabel + ' src</span>'
          + '<span style="font-size:10px;color:rgba(255,255,255,.2)">' + mint.slice(0, 4) + '\u2026' + mint.slice(-4) + '</span>'
          + (r.score >= 35
            ? '<button class="sb-buy" id="sb-buy-btn">\u26A1 Buy via LI.FI</button>'
            : '<span style="font-size:11px;color:#ef4444;font-weight:600;animation:shieldFadeIn .3s ease">\uD83D\uDED1 Blocked</span>');
        addClose();
        document.getElementById('sb-buy-btn')?.addEventListener('click', () => {
          if (typeof globalThis.ShieldLifi !== 'undefined') globalThis.ShieldLifi.createSwapModal(mint, r.score, tier, verdict);
          else window.open('https://jumper.exchange/?toChain=1151111081099710&toToken=' + mint + '&integrator=shield-rug-score&fee=0.005', '_blank');
        });
      }, 400); // Min display time
    });

    sendMsg({ type: 'CHECK_TRIAL' });
  }

  function showStablePairBar(base, quote) {
    removeBar();
    ensureStyles();
    const bar = document.createElement('div');
    bar.id = 'shield-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0d0f14;border-bottom:2px solid rgba(52,211,153,.4);padding:10px 16px;display:flex;align-items:center;gap:12px;font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#e4e7ef;box-shadow:0 4px 24px rgba(0,0,0,.6)';
    bar.innerHTML = '<span class="sb-logo">\u26E8 SHIELD</span><span class="sb-score safe" style="animation:shieldCheckPop .3s ease">\u2713</span><span class="sb-verdict" style="color:#34D399">' + (base || '?') + '/' + (quote || '?') + ' \u2014 Known pair, no rug risk</span>';
    document.body.prepend(bar);
    document.body.style.marginTop = '48px';
    const b = document.createElement('button'); b.className = 'sb-close'; b.textContent = '\u2715';
    b.addEventListener('click', closeBarAnimated); bar.appendChild(b);
  }


  // ═══════════════════════════════════════
  // DETECT URL — runs once per page load / URL change
  // Covers: DexScreener, Jupiter, Raydium, Pump.fun, Photon, BullX, GMGN, Birdeye, Solscan, etc.
  // ═══════════════════════════════════════
  function detectURL() {
    const href = location.href;
    const host = location.hostname;

    // ── DexScreener (all URL formats) ──
    // /solana/xxx, /token/solana/xxx — always lowercase pair or token address
    if (host.includes('dexscreener.com')) {
      const m = href.match(/\/(?:solana|token\/solana)\/([a-zA-Z0-9]{32,44})/i);
      if (!m) return;
      const addr = m[1];
      barLocked = true;

      resolveDex(addr).then(res => {
        barLocked = false;
        if (res?.tokenAddress) showBar(res.tokenAddress);
        else if (res?.isStablePair) showStablePairBar(res.base, res.quote);
        else {
          scan(addr).then(r => {
            if (r && !r.blocked && r.score > 0) showBar(r.address || addr);
            else if (r?.blocked) showBar(addr);
          });
        }
      }).catch(() => { barLocked = false; });
      return;
    }

    // ── Jupiter (all URL formats) ──
    // jup.ag/swap/SOL-XXX, jup.ag/swap?outputMint=XXX, jup.ag/?outputMint=XXX
    if (host.includes('jup.ag') || host.includes('jupiter.ag')) {
      const jupPatterns = [
        /[?&]outputMint=([1-9A-HJ-NP-Za-km-z]{32,44})/,
        /\/swap\/[A-Za-z0-9]+-([1-9A-HJ-NP-Za-km-z]{32,44})/,
        /\/swap\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      ];
      for (const p of jupPatterns) {
        const m = href.match(p);
        if (m && m[1] && isProperMint(m[1])) { showBar(m[1]); return; }
      }
      return;
    }

    // ── Raydium ──
    // raydium.io/swap/?outputMint=XXX, raydium.io/liquidity/pool/XXX
    if (host.includes('raydium.io')) {
      const rayMatch = href.match(/[?&]outputMint=([1-9A-HJ-NP-Za-km-z]{32,44})/)
                    || href.match(/\/(?:pool|pair)\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (rayMatch && rayMatch[1] && isProperMint(rayMatch[1])) { showBar(rayMatch[1]); return; }
      return;
    }

    // ── Pump.fun ──
    // pump.fun/coin/XXX, pump.fun/token/XXX
    if (host.includes('pump.fun')) {
      const pumpMatch = href.match(/\/(?:coin|token)\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (pumpMatch && pumpMatch[1] && isProperMint(pumpMatch[1])) { showBar(pumpMatch[1]); return; }
      return;
    }

    // ── Photon ──
    // photon-sol.tinyastro.io/token/XXX
    if (host.includes('photon') || host.includes('tinyastro')) {
      const photonMatch = href.match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (photonMatch && photonMatch[1] && isProperMint(photonMatch[1])) { showBar(photonMatch[1]); return; }
      return;
    }

    // ── BullX ──
    // bullx.io/terminal?...address=XXX
    if (host.includes('bullx.io')) {
      const bullMatch = href.match(/[?&]address=([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (bullMatch && bullMatch[1] && isProperMint(bullMatch[1])) { showBar(bullMatch[1]); return; }
      return;
    }

    // ── GMGN ──
    // gmgn.ai/sol/token/XXX
    if (host.includes('gmgn.ai')) {
      const gmgnMatch = href.match(/\/sol\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (gmgnMatch && gmgnMatch[1] && isProperMint(gmgnMatch[1])) { showBar(gmgnMatch[1]); return; }
      return;
    }

    // ── Birdeye, Solscan, generic patterns ──
    const patterns = [
      /\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /[?&](?:outputMint|inputMint|mint|address|token)=([1-9A-HJ-NP-Za-km-z]{32,44})/,
    ];
    for (const p of patterns) {
      const m = href.match(p);
      if (m && m[1] && isProperMint(m[1])) { showBar(m[1]); return; }
    }
  }


  // ═══════════════════════════════════════
  // INLINE BADGES (non-Twitter pages)
  // ═══════════════════════════════════════
  const badgedMints = new Set();

  function scanText() {
    if (barLocked) return; // Don't scan text while DexScreener is resolving

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const t = node.parentElement?.tagName?.toUpperCase();
        return ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(t) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const found = new Set();
    while (walker.nextNode()) {
      const m = walker.currentNode.textContent.match(SOLANA_RE);
      if (m) m.forEach(x => { if (isProperMint(x)) found.add(x); });
    }
    found.forEach(mint => {
      if (badgedMints.has(mint)) return;
      badgedMints.add(mint);
      let el = document.querySelector('[href*="' + mint + '"]');
      if (!el) {
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (tw.nextNode()) { if (tw.currentNode.textContent.includes(mint)) { el = tw.currentNode.parentElement; break; } }
      }
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
        badge.style.color = COLORS[tier]; badge.style.background = COLORS[tier] + '20';
        badge.title = 'Shield: ' + r.score + '/100';
        badge.addEventListener('click', e => { e.stopPropagation(); showBar(mint); });
      }).catch(() => { badge.style.opacity = '0'; setTimeout(() => { badge.remove(); badgedMints.delete(mint); }, 300); });
    });
  }


  // ═══════════════════════════════════════
  // TWITTER/X — badges on tweets
  // ═══════════════════════════════════════
  const articleMints = new Map();
  const resolvedTickers = new Map();

  function tierOf(r) { return r.score >= 75 ? 'safe' : r.score >= 55 ? 'caution' : r.score >= 35 ? 'warning' : 'danger'; }

  function injectTweetBadge(article, mint, sd) {
    const tt = article.querySelector('[data-testid="tweetText"]') || article;
    const existing = tt.querySelector('[data-shield-mint="' + mint + '"]');

    if (existing && sd) {
      // Update scanning → scored
      const c = COLORS[sd.tier];
      existing.className = 'shield-badge';
      existing.style.cssText = 'background:' + c + '20;color:' + c + ';display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      existing.textContent = '\u26E8 ' + sd.score;
      existing.title = 'Shield: ' + sd.score + '/100 \u2014 ' + sd.verdict;
      existing.onclick = null;
      existing.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showBar(mint); });
      return;
    }
    if (existing) return; // Already has scanning badge

    const b = document.createElement('span');
    b.setAttribute('data-shield-mint', mint);
    if (sd) {
      const c = COLORS[sd.tier];
      b.className = 'shield-badge';
      b.style.cssText = 'background:' + c + '20;color:' + c + ';display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      b.textContent = '\u26E8 ' + sd.score; b.title = 'Shield: ' + sd.score + '/100 \u2014 ' + sd.verdict;
      b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showBar(mint); });
    } else {
      b.className = 'shield-badge scanning';
      b.style.cssText = 'background:rgba(139,92,246,.15);color:#a78bfa;display:inline-block;font-family:monospace;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:4px;cursor:pointer;vertical-align:middle';
      b.textContent = '\u26E8\u2026'; b.title = 'Shield scanning\u2026';
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

    // 1. Raw Solana addresses
    const addrMatches = text.match(SOLANA_RE);
    if (addrMatches) addrMatches.forEach(m => { if (isProperMint(m)) scanAndBadge(article, mintMap, m); });

    // 2. Cashtags (max 3 per tweet)
    const tickers = [];
    article.querySelectorAll('a[href]').forEach(link => {
      const m = (link.href || '').match(/[?&]q=%24([A-Za-z]{2,10})/);
      if (m) { const t = m[1].toUpperCase(); if (!SKIP_TICKERS.has(t) && tickers.length < 3 && !tickers.includes(t)) tickers.push(t); }
    });
    const textMatches = text.match(/\$([A-Za-z]{2,10})\b/g);
    if (textMatches) textMatches.forEach(m => { const t = m.slice(1).toUpperCase(); if (!SKIP_TICKERS.has(t) && tickers.length < 3 && !tickers.includes(t)) tickers.push(t); });

    // 3. Resolve each ticker
    tickers.forEach(ticker => {
      const key = '$' + ticker;
      if (mintMap.has(key)) return;
      mintMap.set(key, 'resolving');

      const cached = resolvedTickers.get(ticker);
      if (cached) { mintMap.delete(key); scanAndBadge(article, mintMap, cached); return; }

      resolveAndScan(ticker).then(res => {
        mintMap.delete(key);
        if (!res?.mint || !res?.data) return;
        resolvedTickers.set(ticker, res.mint);
        cache[res.mint] = res.data;
        const sd = { score: res.data.score, tier: tierOf(res.data), verdict: res.data.verdict || tierOf(res.data).toUpperCase() };
        mintMap.set(res.mint, sd);
        injectTweetBadge(article, res.mint, sd);
      });
    });
  }

  // Heartbeat: re-inject badges Twitter removes
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

  // MutationObserver: catch new articles
  let mutDebounce = null;
  function startMutationObserver() {
    new MutationObserver(() => {
      clearTimeout(mutDebounce);
      mutDebounce = setTimeout(scanVisibleArticles, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // IntersectionObserver: only scan visible tweets
  let intObserver = null;
  function startIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return;
    intObserver = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting && e.target.tagName === 'ARTICLE' && !articleMints.has(e.target)) scanArticle(e.target);
      });
    }, { rootMargin: '200px' });
  }

  function scanVisibleArticles() {
    document.querySelectorAll('article').forEach(a => {
      if (articleMints.has(a)) return;
      if (intObserver) intObserver.observe(a);
      else scanArticle(a);
    });
  }


  // ═══════════════════════════════════════
  // MESSAGE HANDLER (wallet connect)
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
      setTimeout(() => { window.removeEventListener('message', handler); sendResponse({ error: 'Phantom timed out.' }); }, 15000);
      return true;
    }
    if (msg.type === 'SHIELD_STORE_WALLET') { try { localStorage.setItem('shield_wallet', msg.address); } catch {} sendResponse({ ok: true }); }
    if (msg.type === 'SHIELD_CLEAR_WALLET') { try { localStorage.removeItem('shield_wallet'); } catch {} sendResponse({ ok: true }); }
  });


  // ═══════════════════════════════════════
  // START — bulletproof SPA navigation detection
  // ═══════════════════════════════════════
  function start() {
    console.log('[SHIELD] \u26E8 Active on', location.hostname);
    ensureStyles();
    startIntersectionObserver();
    setTimeout(detectURL, 1000);
    setTimeout(scanText, 2500);
    startMutationObserver();
    startHeartbeat();

    let lastURL = location.href;
    let lastMint = null; // Track what we're currently scanning to avoid re-scanning same token
    let navDebounce = null;

    function onNavigate() {
      const currentURL = location.href;
      if (currentURL === lastURL) return;
      lastURL = currentURL;

      clearTimeout(navDebounce);
      navDebounce = setTimeout(() => {
        // Extract mint from new URL to check if it's actually a different token
        const newMint = extractMintFromURL(currentURL);
        if (newMint === lastMint && newMint !== null) return; // Same token, different URL params — skip
        lastMint = newMint;

        barLocked = false;
        removeBar();
        badgedMints.clear();
        detectURL();
        setTimeout(scanText, 1000);
      }, 200);
    }

    // 1. Hook pushState/replaceState
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function() { origPush.apply(this, arguments); onNavigate(); };
    history.replaceState = function() { origReplace.apply(this, arguments); onNavigate(); };

    // 2. popstate (back/forward)
    window.addEventListener('popstate', onNavigate);

    // 3. hashchange (for hash-based SPAs)
    window.addEventListener('hashchange', onNavigate);

    // 4. Polling fallback — every 1s for fast detection
    setInterval(onNavigate, 1000);
  }

  // Helper: extract mint address from any URL (used to detect "same token different URL")
  function extractMintFromURL(url) {
    const patterns = [
      /\/(?:solana|token\/solana)\/([a-zA-Z0-9]{32,44})/i,
      /\/swap\/[A-Za-z0-9]+-([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/swap\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/sol\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/token\/(?:solana\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/address\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /\/(?:pool|pair)\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      /[?&](?:outputMint|inputMint|mint|address|token)=([1-9A-HJ-NP-Za-km-z]{32,44})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
