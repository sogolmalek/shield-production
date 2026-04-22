/**
 * SHIELD × LI.FI — Cross-Chain Safe Swap
 * Fixes:
 *  - Solana→Solana routes correctly to Jupiter (not LI.FI bridges)
 *  - No inline onclick (all addEventListener)
 *  - Better error messages
 *  - Proper USDC amounts per chain
 */
(() => {
  'use strict';

  const LIFI_API = 'https://li.quest/v1';

  // LI.FI chain IDs
  const SOLANA_CHAIN_ID = 1151111081099710;
  const CHAIN_NAMES = {
    [SOLANA_CHAIN_ID]: 'Solana',
    1:     'Ethereum',
    42161: 'Arbitrum',
    8453:  'Base',
    10:    'Optimism',
    137:   'Polygon',
    56:    'BSC',
  };

  const SOURCE_CHAINS = [
    { id: 1,              name: 'Ethereum', icon: '⟠',  nativeCurrency: 'ETH',  native: '0x0000000000000000000000000000000000000000' },
    { id: 42161,          name: 'Arbitrum', icon: '🔵', nativeCurrency: 'ETH',  native: '0x0000000000000000000000000000000000000000' },
    { id: 8453,           name: 'Base',     icon: '🟦', nativeCurrency: 'ETH',  native: '0x0000000000000000000000000000000000000000' },
    { id: 10,             name: 'Optimism', icon: '🔴', nativeCurrency: 'ETH',  native: '0x0000000000000000000000000000000000000000' },
    { id: 137,            name: 'Polygon',  icon: '🟣', nativeCurrency: 'MATIC',native: '0x0000000000000000000000000000000000000000' },
    { id: 56,             name: 'BSC',      icon: '🟡', nativeCurrency: 'BNB',  native: '0x0000000000000000000000000000000000000000' },
    { id: SOLANA_CHAIN_ID,name: 'Solana',   icon: '◎',  nativeCurrency: 'SOL',  native: 'So11111111111111111111111111111111111111112' },
  ];

  // USDC contract addresses per chain
  const USDC_BY_CHAIN = {
    1:              '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    42161:          '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    8453:           '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    10:             '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    137:            '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    56:             '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    [SOLANA_CHAIN_ID]: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  };

  // ── LI.FI API ──
  async function getRoutes(fromChainId, fromToken, toToken, fromAmount) {
    const body = {
      fromChainId,
      toChainId: SOLANA_CHAIN_ID,
      fromTokenAddress: fromToken,
      toTokenAddress:   toToken,
      fromAmount,
      options: { slippage: 0.03, order: 'RECOMMENDED' },
    };

    const res = await fetch(`${LIFI_API}/advanced/routes`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Routes API returned ${res.status}`);
    }
    return res.json();
  }

  // ── Swap Modal ──
  function createSwapModal(tokenAddress, shieldScore, shieldTier, shieldVerdict) {
    if (shieldScore < 30) { showBlockedModal(tokenAddress, shieldScore, shieldVerdict); return; }

    document.querySelector('.shield-lifi-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'shield-lifi-overlay';

    const tierColors = { safe: '#34D399', caution: '#FBBF24', warning: '#F59E0B', danger: '#EF4444' };
    const color = tierColors[shieldTier] || '#FBBF24';

    overlay.innerHTML = `
      <div class="shield-lifi-modal">
        <div class="shield-lifi-header">
          <div class="shield-lifi-title">
            <span class="shield-lifi-logo">⛨</span>
            <span>Shield Safe Swap</span>
            <span class="shield-lifi-powered">powered by LI.FI</span>
          </div>
          <button class="shield-lifi-close" id="shieldLifiClose">✕</button>
        </div>

        <div class="shield-lifi-score-bar" style="border-left:3px solid ${color}">
          <div class="shield-lifi-score-info">
            <span class="shield-lifi-score-label">Shield Score</span>
            <span class="shield-lifi-score-value" style="color:${color}">${shieldScore}/100 — ${shieldVerdict}</span>
          </div>
          ${shieldScore < 50 ? '<div class="shield-lifi-warning-text">⚠ Moderate risk — proceed with caution</div>' : ''}
        </div>

        <div class="shield-lifi-token-target">
          <span class="shield-lifi-label">Buying on Solana</span>
          <span class="shield-lifi-addr">${tokenAddress.slice(0, 8)}…${tokenAddress.slice(-6)}</span>
        </div>

        <div class="shield-lifi-form">
          <div class="shield-lifi-field">
            <label class="shield-lifi-label">From Chain</label>
            <select id="shieldLifiChain" class="shield-lifi-select">
              ${SOURCE_CHAINS.map(c => `<option value="${c.id}">${c.icon} ${c.name}</option>`).join('')}
            </select>
          </div>

          <div class="shield-lifi-field">
            <label class="shield-lifi-label">Pay With</label>
            <div class="shield-lifi-pay-row">
              <select id="shieldLifiPayToken" class="shield-lifi-select shield-lifi-select-sm">
                <option value="native">Native (ETH/SOL)</option>
                <option value="usdc" selected>USDC</option>
              </select>
              <input type="number" id="shieldLifiAmount" class="shield-lifi-input"
                     placeholder="10.00" value="10" min="0.01" step="0.01" />
            </div>
          </div>

          <div id="shieldLifiQuoteBox" class="shield-lifi-quote-box" style="display:none">
            <div class="shield-lifi-quote-row">
              <span>You receive (est.)</span>
              <span id="shieldLifiReceive" class="shield-lifi-receive">—</span>
            </div>
            <div class="shield-lifi-quote-row shield-lifi-quote-detail">
              <span>Route</span><span id="shieldLifiRoute">—</span>
            </div>
            <div class="shield-lifi-quote-row shield-lifi-quote-detail">
              <span>Est. time</span><span id="shieldLifiTime">—</span>
            </div>
            <div class="shield-lifi-quote-row shield-lifi-quote-detail">
              <span>Fees</span><span id="shieldLifiFees">—</span>
            </div>
          </div>

          <div id="shieldLifiLoading" class="shield-lifi-loading" style="display:none">
            <div class="shield-lifi-spinner"></div>
            <span id="shieldLifiLoadTxt">Finding best route across 20+ bridges…</span>
          </div>

          <div id="shieldLifiError" class="shield-lifi-error" style="display:none"></div>

          <button id="shieldLifiQuoteBtn" class="shield-lifi-btn shield-lifi-btn-quote">Get Quote via LI.FI</button>
          <button id="shieldLifiSwapBtn" class="shield-lifi-btn shield-lifi-btn-swap" style="display:none" disabled>
            Connect Wallet to Swap
          </button>
        </div>

        <div class="shield-lifi-footer">
          <span>⛨ Shield verifies safety</span>
          <span>·</span>
          <span>LI.FI finds best route</span>
          <span>·</span>
          <span>You approve the tx</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // ── Wire event listeners (NO inline onclick) ──
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('shieldLifiClose').addEventListener('click', () => overlay.remove());

    document.getElementById('shieldLifiChain').addEventListener('change', () => {
      document.getElementById('shieldLifiQuoteBox').style.display = 'none';
      document.getElementById('shieldLifiSwapBtn').style.display  = 'none';
      document.getElementById('shieldLifiQuoteBtn').style.display = 'block';
      document.getElementById('shieldLifiError').style.display    = 'none';
    });

    document.getElementById('shieldLifiQuoteBtn').addEventListener('click', () => {
      fetchQuote(tokenAddress);
    });

    // Escape key
    const escHandler = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
  }

  // ── Fetch quote ──
  async function fetchQuote(tokenAddress) {
    const chainId  = parseInt(document.getElementById('shieldLifiChain').value);
    const payType  = document.getElementById('shieldLifiPayToken').value;
    const amount   = parseFloat(document.getElementById('shieldLifiAmount').value);

    if (!amount || amount <= 0) { showError('Enter a valid amount.'); return; }

    // ── Solana → Solana: use Jupiter directly (LI.FI bridges don't apply) ──
    if (chainId === SOLANA_CHAIN_ID) {
      const inputMint = payType === 'usdc'
        ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        : 'So11111111111111111111111111111111111111112';
      const jupUrl = `https://jup.ag/swap/${inputMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC'}-${tokenAddress}`;

      document.getElementById('shieldLifiReceive').textContent = 'Opening Jupiter…';
      document.getElementById('shieldLifiRoute').textContent   = 'Jupiter (Solana DEX aggregator)';
      document.getElementById('shieldLifiTime').textContent    = '~5s';
      document.getElementById('shieldLifiFees').textContent    = '~$0.001 gas';
      document.getElementById('shieldLifiQuoteBox').style.display = 'block';
      document.getElementById('shieldLifiQuoteBtn').style.display = 'none';
      document.getElementById('shieldLifiSwapBtn').style.display  = 'block';
      document.getElementById('shieldLifiSwapBtn').disabled       = false;
      document.getElementById('shieldLifiSwapBtn').textContent    = '⚡ Open in Jupiter';

      window.__shieldLifiJupUrl = jupUrl;
      document.getElementById('shieldLifiSwapBtn').addEventListener('click', () => {
        window.open(jupUrl, '_blank');
        document.getElementById('shieldLifiSwapBtn').textContent = 'Jupiter opened ↗';
        setTimeout(() => {
          document.getElementById('shieldLifiSwapBtn').textContent = '⚡ Open in Jupiter';
        }, 3000);
      }, { once: true });
      return;
    }

    // ── Cross-chain: use LI.FI ──
    let fromToken, decimals;
    if (payType === 'native') {
      fromToken = SOURCE_CHAINS.find(c => c.id === chainId)?.native || '0x0000000000000000000000000000000000000000';
      decimals  = 18;
    } else {
      fromToken = USDC_BY_CHAIN[chainId] || USDC_BY_CHAIN[1];
      decimals  = 6;
    }

    const fromAmount = BigInt(Math.floor(amount * Math.pow(10, decimals))).toString();

    document.getElementById('shieldLifiQuoteBtn').style.display = 'none';
    document.getElementById('shieldLifiLoading').style.display  = 'flex';
    document.getElementById('shieldLifiError').style.display    = 'none';
    document.getElementById('shieldLifiQuoteBox').style.display = 'none';
    document.getElementById('shieldLifiLoadTxt').textContent    = 'Finding best route across 20+ bridges…';

    try {
      const data = await getRoutes(chainId, fromToken, tokenAddress, fromAmount);

      if (!data.routes || data.routes.length === 0) {
        throw new Error('No routes found. Try a different amount, chain, or token.');
      }

      const best      = data.routes[0];
      const steps     = best.steps || [];
      const toolNames = steps.map(s => s.toolDetails?.name || s.tool || 'Bridge').join(' → ');
      const estTime   = steps.reduce((t, s) => t + (s.estimate?.executionDuration || 0), 0);
      const gasCost   = parseFloat(best.gasCostUSD || 0) || steps.reduce((t, s) => t + parseFloat(s.estimate?.gasCosts?.[0]?.amountUSD || 0), 0);
      const toAmount  = best.toAmountMin || best.toAmount || '0';
      const toDec     = best.toToken?.decimals || 9;
      const received  = (parseFloat(toAmount) / Math.pow(10, toDec)).toLocaleString(undefined, { maximumFractionDigits: 4 });

      document.getElementById('shieldLifiReceive').textContent = `${received} tokens`;
      document.getElementById('shieldLifiRoute').textContent   = toolNames || 'LI.FI optimal';
      document.getElementById('shieldLifiTime').textContent    = estTime > 60 ? `~${Math.ceil(estTime / 60)} min` : `~${estTime}s`;
      document.getElementById('shieldLifiFees').textContent    = `~$${gasCost.toFixed(2)} gas`;
      document.getElementById('shieldLifiQuoteBox').style.display = 'block';
      document.getElementById('shieldLifiSwapBtn').style.display  = 'block';
      document.getElementById('shieldLifiSwapBtn').disabled       = false;
      document.getElementById('shieldLifiSwapBtn').textContent    = 'Connect Wallet to Swap';

      window.__shieldLifiRoute = best;

      // Remove previous listener and add fresh one
      const swapBtn = document.getElementById('shieldLifiSwapBtn');
      const newBtn  = swapBtn.cloneNode(true);
      swapBtn.parentNode.replaceChild(newBtn, swapBtn);
      document.getElementById('shieldLifiSwapBtn').addEventListener('click', () => executeSwap(best, chainId, tokenAddress));

    } catch (e) {
      showError(e.message || 'Failed to get quote. Try a different chain or amount.');
      document.getElementById('shieldLifiQuoteBtn').style.display = 'block';
    } finally {
      document.getElementById('shieldLifiLoading').style.display = 'none';
    }
  }

  // ── Execute swap ──
  async function executeSwap(route, fromChainId, toToken) {
    const btn = document.getElementById('shieldLifiSwapBtn');
    if (!btn) return;

    const jumperUrl = `https://jumper.exchange/?fromChain=${fromChainId}&toChain=${SOLANA_CHAIN_ID}&toToken=${toToken}`;

    // Try connecting wallet first, then open Jumper
    const tryConnect = async () => {
      btn.textContent = 'Connecting wallet…';
      btn.disabled    = true;
      try {
        if (window.solana?.isPhantom) {
          await window.solana.connect();
        } else if (window.ethereum) {
          await window.ethereum.request({ method: 'eth_requestAccounts' });
        }
      } catch {}
      window.open(jumperUrl, '_blank');
      btn.textContent = 'Swap opened in Jumper ↗';
      setTimeout(() => { btn.textContent = '⚡ Open Jumper Again'; btn.disabled = false; }, 3000);
    };

    await tryConnect();
  }

  // ── Blocked modal ──
  function showBlockedModal(tokenAddress, score, verdict) {
    document.querySelector('.shield-lifi-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'shield-lifi-overlay';
    overlay.innerHTML = `
      <div class="shield-lifi-modal shield-lifi-blocked">
        <div class="shield-lifi-header">
          <div class="shield-lifi-title">
            <span class="shield-lifi-logo">⛨</span>
            <span>Swap Blocked by Shield</span>
          </div>
          <button class="shield-lifi-close" id="shieldLifiBlockClose">✕</button>
        </div>
        <div class="shield-lifi-blocked-content">
          <div class="shield-lifi-blocked-icon">🛑</div>
          <div class="shield-lifi-blocked-score">Score: ${score}/100</div>
          <div class="shield-lifi-blocked-verdict">${verdict}</div>
          <p class="shield-lifi-blocked-text">
            Shield has blocked this swap. Score is below 30 — high probability of rug pull.
            Do not buy this token.
          </p>
          <div class="shield-lifi-blocked-addr">${tokenAddress}</div>
          <button class="shield-lifi-btn shield-lifi-btn-close" id="shieldLifiBlockOk">
            I Understand — Close
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // All event listeners, no inline onclick
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('shieldLifiBlockClose').addEventListener('click', () => overlay.remove());
    document.getElementById('shieldLifiBlockOk').addEventListener('click',    () => overlay.remove());
  }

  function showError(msg) {
    const el = document.getElementById('shieldLifiError');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  // ── Export to globalThis (content-script isolated world) ──
  if (typeof globalThis !== 'undefined') {
    globalThis.ShieldLifi = { createSwapModal, getRoutes };
  }
})();
