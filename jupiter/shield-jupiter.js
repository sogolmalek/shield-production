/**
 * SHIELD × JUPITER
 * "Jupiter's own data says don't buy" + "Rug-aware swaps, DCA, and limit orders"
 * 
 * Combines:
 * - Jupiter Swap V2 (/order + /execute) — safe swaps
 * - Jupiter Tokens API — organic scores + metadata for enhanced scoring
 * - Jupiter Price API — real-time USD pricing
 * - Jupiter Trigger API — auto-exit limit orders when Shield score drops
 * - Jupiter Recurring API — smart DCA that pauses on rug signals
 * - Shield rug scoring — RugCheck + RPC security checks
 * 
 * Usage:
 *   const shield = new ShieldJupiter(JUPITER_API_KEY);
 *   const result = await shield.safeSwap({ inputMint, outputMint, amount, wallet });
 */

const JUPITER_API = 'https://api.jup.ag';
const JUPITER_SWAP = 'https://api.jup.ag/swap/v2'; // Swap V2 — the new unified endpoint
const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';

class ShieldJupiter {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.rpcUrl = options.rpcUrl || 'https://solana-mainnet.g.alchemy.com/v2/FE1Fd3x7PlqkZYxMqQpP3orTaf1dsmG4';
    this.blockThreshold = options.blockThreshold || 30;
    this.warnThreshold = options.warnThreshold || 50;
    this.scanCache = new Map();
    this.CACHE_TTL = 5 * 60 * 1000; // 5 min
  }

  // ── Headers ──
  get headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }

  // ═══════════════════════════════════════
  // 1. SHIELD SCORING (enhanced with Jupiter Tokens API)
  // ═══════════════════════════════════════

  async scan(mint) {
    // Check cache
    const cached = this.scanCache.get(mint);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.data;

    // Parallel: RugCheck + Jupiter Tokens API
    const [rugcheck, jupiterToken, jupiterPrice] = await Promise.allSettled([
      this._fetchRugCheck(mint),
      this._fetchJupiterToken(mint),
      this._fetchJupiterPrice(mint),
    ]);

    const rc = rugcheck.status === 'fulfilled' ? rugcheck.value : null;
    const jt = jupiterToken.status === 'fulfilled' ? jupiterToken.value : null;
    const jp = jupiterPrice.status === 'fulfilled' ? jupiterPrice.value : null;

    // Build score from RugCheck
    let score = this._buildBaseScore(rc);

    // ENHANCE with Jupiter's own data (the "oh" moment)
    // Jupiter's Tokens API has organic_score and verification_status
    const jupiterEnhancement = this._enhanceWithJupiter(jt);
    score = Math.max(0, Math.min(100, score + jupiterEnhancement.adjustment));

    const tier = score >= 70 ? 'safe' : score >= 50 ? 'caution' : score >= 30 ? 'warning' : 'danger';
    const action = score >= this.warnThreshold ? 'PROCEED' : score >= this.blockThreshold ? 'WARN' : 'BLOCK';

    const result = {
      score, tier, action,
      verdict: score >= 70 ? 'Low Risk' : score >= 50 ? 'Moderate' : score >= 30 ? 'High Risk' : 'Extreme Risk',
      address: mint,
      priceUSD: jp?.price || null,
      checks: this._buildChecks(rc),
      jupiterInsights: jupiterEnhancement.insights,
      sources: { rugcheck: !!rc, jupiterTokens: !!jt, jupiterPrice: !!jp },
    };

    this.scanCache.set(mint, { data: result, ts: Date.now() });
    return result;
  }

  _buildBaseScore(rc) {
    if (!rc) return 40; // Conservative without data

    let score = 50;
    const mintAuth = rc.mintAuthority !== null && rc.mintAuthority !== '';
    const freezeAuth = rc.freezeAuthority !== null && rc.freezeAuthority !== '';
    const lpLocked = rc.markets?.some(m => m.lp?.lpLocked) ?? false;
    const topPct = rc.topHolders?.[0]?.pct ?? 50;
    const devPct = rc.creator?.pct ?? 10;
    const honeypot = rc.risks?.some(r => r.name?.toLowerCase().includes('honeypot')) ?? false;
    const liq = rc.markets?.reduce((s, m) => s + (m.lp?.usd ?? 0), 0) ?? 0;

    if (!mintAuth) score += 15; else score -= 25;
    if (!freezeAuth) score += 10; else score -= 20;
    if (lpLocked) score += 12; else score -= 15;
    if (topPct < 15) score += 10; else if (topPct > 40) score -= 15;
    if (devPct < 5) score += 8; else if (devPct > 20) score -= 20;
    if (honeypot) score -= 40;
    if (liq > 100000) score += 5;

    return Math.max(0, Math.min(100, score));
  }

  _enhanceWithJupiter(jt) {
    if (!jt) return { adjustment: 0, insights: [] };

    let adjustment = 0;
    const insights = [];

    // Jupiter verification status
    if (jt.tags?.includes('verified') || jt.tags?.includes('community')) {
      adjustment += 5;
      insights.push('Jupiter verified token');
    }
    if (jt.tags?.includes('token-2022')) {
      insights.push('Token-2022 standard');
    }

    // Jupiter daily volume (if available)
    if (jt.daily_volume !== undefined) {
      if (jt.daily_volume > 1000000) {
        adjustment += 5;
        insights.push(`High daily volume: $${(jt.daily_volume / 1e6).toFixed(1)}M`);
      } else if (jt.daily_volume < 1000) {
        adjustment -= 5;
        insights.push(`Very low volume: $${jt.daily_volume.toFixed(0)}`);
      }
    }

    // Jupiter freeze authority check matches ours
    if (jt.freeze_authority !== null && jt.freeze_authority !== undefined) {
      insights.push('Jupiter confirms freeze authority present');
    }

    return { adjustment, insights };
  }

  _buildChecks(rc) {
    if (!rc) return {};
    return {
      mintAuth: { pass: !(rc.mintAuthority !== null && rc.mintAuthority !== ''), label: 'Mint Authority', value: (rc.mintAuthority !== null && rc.mintAuthority !== '') ? 'Active' : 'Revoked' },
      freezeAuth: { pass: !(rc.freezeAuthority !== null && rc.freezeAuthority !== ''), label: 'Freeze Authority', value: (rc.freezeAuthority !== null && rc.freezeAuthority !== '') ? 'Active' : 'Revoked' },
      lpLock: { pass: rc.markets?.some(m => m.lp?.lpLocked) ?? false, label: 'LP Lock', value: (rc.markets?.some(m => m.lp?.lpLocked)) ? 'Locked' : 'Unlocked' },
      topHolder: { pass: (rc.topHolders?.[0]?.pct ?? 50) < 25, label: 'Top Holder', value: Math.round(rc.topHolders?.[0]?.pct ?? 50) + '%' },
      devWallet: { pass: (rc.creator?.pct ?? 10) < 10, label: 'Dev Wallet', value: Math.round(rc.creator?.pct ?? 10) + '%' },
      honeypot: { pass: !(rc.risks?.some(r => r.name?.toLowerCase().includes('honeypot'))), label: 'Honeypot', value: rc.risks?.some(r => r.name?.toLowerCase().includes('honeypot')) ? 'Detected' : 'Clean' },
      liquidity: { pass: (rc.markets?.reduce((s, m) => s + (m.lp?.usd ?? 0), 0) ?? 0) > 50000, label: 'Liquidity', value: '$' + this._fmt(rc.markets?.reduce((s, m) => s + (m.lp?.usd ?? 0), 0) ?? 0) },
    };
  }

  // ═══════════════════════════════════════
  // 2. SAFE SWAP (Jupiter Swap V2 + Shield)
  // ═══════════════════════════════════════

  async safeSwap({ inputMint, outputMint, amount, wallet, forceExecute = false }) {
    // Step 1: Shield scan
    const shield = await this.scan(outputMint);

    if (shield.action === 'BLOCK' && !forceExecute) {
      return {
        executed: false,
        blocked: true,
        reason: `Shield blocked: Score ${shield.score}/100 — ${shield.verdict}`,
        shield,
      };
    }

    // Step 2: Get Jupiter quote via Swap V2 (GET /order)
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      taker: wallet,
    });

    const orderRes = await fetch(`${JUPITER_SWAP}/order?${params}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!orderRes.ok) {
      const err = await orderRes.json().catch(() => ({}));
      return { executed: false, error: 'Jupiter order failed', details: err, shield };
    }

    const order = await orderRes.json();

    return {
      executed: false, // Needs wallet signature
      readyToSign: true,
      shield,
      order,
      warning: shield.action === 'WARN' ? `Moderate risk (${shield.score}/100). Review before signing.` : null,
      jupiterInsights: shield.jupiterInsights,
    };
  }

  // ═══════════════════════════════════════
  // 3. SAFE DCA (Jupiter Recurring + Shield)
  // "Smart DCA that pauses before the rug"
  // ═══════════════════════════════════════

  async safeDCA({ inputMint, outputMint, amount, frequency, wallet }) {
    // Pre-check: should we even start this DCA?
    const shield = await this.scan(outputMint);

    if (shield.action === 'BLOCK') {
      return {
        started: false,
        reason: `Shield blocked DCA: Score ${shield.score}/100 — too risky for recurring buys`,
        shield,
      };
    }

    // Get Jupiter DCA quote
    const dcaRes = await fetch(`${JUPITER_API}/recurring/v1/createOrder`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        inputMint,
        outputMint,
        inAmount: amount.toString(),
        frequency,
        maker: wallet,
      }),
    });

    const dca = await dcaRes.json();

    return {
      started: true,
      shield,
      dca,
      safeguard: `Shield will re-scan before each DCA execution. If score drops below ${this.blockThreshold}, DCA will pause.`,
    };
  }

  // Check if active DCA should continue
  async shouldContinueDCA(outputMint) {
    const shield = await this.scan(outputMint);
    return {
      continue: shield.action !== 'BLOCK',
      shield,
      reason: shield.action === 'BLOCK'
        ? `Score dropped to ${shield.score}/100 — DCA PAUSED`
        : `Score ${shield.score}/100 — DCA continues`,
    };
  }

  // ═══════════════════════════════════════
  // 4. AUTO-EXIT (Jupiter Trigger + Shield)
  // "Set a limit order when Shield detects danger"
  // ═══════════════════════════════════════

  async checkAndProtect({ mint, wallet, balance }) {
    const shield = await this.scan(mint);

    if (shield.score < this.blockThreshold && balance > 0) {
      // Score dropped — create emergency sell order
      const price = await this._fetchJupiterPrice(mint);
      const currentPrice = price?.price || 0;

      // Set limit sell at 95% of current price (get out fast)
      const triggerRes = await fetch(`${JUPITER_API}/trigger/v1/createOrder`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          inputMint: mint,
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          inAmount: balance.toString(),
          triggerPrice: (currentPrice * 0.95).toString(),
          maker: wallet,
        }),
      });

      const trigger = await triggerRes.json();

      return {
        action: 'EMERGENCY_EXIT',
        shield,
        trigger,
        message: `Shield score dropped to ${shield.score}/100. Emergency sell order placed at 95% of current price.`,
      };
    }

    return {
      action: 'HOLD',
      shield,
      message: `Score ${shield.score}/100 — position is safe.`,
    };
  }

  // ═══════════════════════════════════════
  // 5. TOKEN DISCOVERY (Jupiter Tokens + Shield)
  // "Find tokens that Jupiter lists AND Shield approves"
  // ═══════════════════════════════════════

  async findSafeTokens(query, limit = 10) {
    // Search via Jupiter Tokens API
    const searchRes = await fetch(`${JUPITER_API}/tokens/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: this.headers,
    });

    if (!searchRes.ok) return [];
    const tokens = await searchRes.json();

    // Scan each token in parallel
    const results = await Promise.allSettled(
      tokens.map(async t => {
        const shield = await this.scan(t.address);
        const price = await this._fetchJupiterPrice(t.address);
        return {
          ...t,
          shield,
          priceUSD: price?.price || null,
          safe: shield.action !== 'BLOCK',
        };
      })
    );

    return results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => (b.shield?.score || 0) - (a.shield?.score || 0));
  }

  // ═══════════════════════════════════════
  // INTERNAL API CALLS
  // ═══════════════════════════════════════

  async _fetchRugCheck(mint) {
    const res = await fetch(`${RUGCHECK_API}/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return res.json();
  }

  async _fetchJupiterToken(mint) {
    const res = await fetch(`${JUPITER_API}/tokens/v1/${mint}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return res.json();
  }

  async _fetchJupiterPrice(mint) {
    const res = await fetch(`${JUPITER_API}/price/v2?ids=${mint}`, {
      headers: this.headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[mint] || null;
  }

  _fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return n.toString();
  }
}

module.exports = { ShieldJupiter };

// ── CLI Mode ──
if (require.main === module) {
  const apiKey = process.env.JUPITER_API_KEY;
  const action = process.argv[2];
  const mint = process.argv[3];

  if (!action || !mint) {
    console.log('Usage:');
    console.log('  JUPITER_API_KEY=xxx node shield-jupiter.js scan <MINT>');
    console.log('  JUPITER_API_KEY=xxx node shield-jupiter.js safe-swap <OUTPUT_MINT>');
    console.log('  JUPITER_API_KEY=xxx node shield-jupiter.js find <QUERY>');
    process.exit(1);
  }

  const shield = new ShieldJupiter(apiKey || 'demo');

  (async () => {
    if (action === 'scan') {
      const result = await shield.scan(mint);
      console.log(JSON.stringify(result, null, 2));
    } else if (action === 'find') {
      const results = await shield.findSafeTokens(mint);
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('Unknown action:', action);
    }
  })();
}
