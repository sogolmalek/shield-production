#!/usr/bin/env node
/**
 * Shield Rug Check Scanner
 * Usage: node scan.js <TOKEN_MINT_ADDRESS>
 * Returns JSON with score, checks, and recommended action.
 */

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';
const SHIELD_API = 'https://shield-api.onrender.com';

const KNOWN_SAFE = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
]);

async function scan(mint) {
  // Skip known safe tokens
  if (KNOWN_SAFE.has(mint)) {
    return {
      score: 100, tier: 'safe', verdict: 'Known Safe Token',
      action: 'PROCEED', address: mint,
      checks: {}, meta: { source: 'known-safe', skipped: true },
    };
  }

  // Try RugCheck API first
  let rc = null;
  try {
    const res = await fetch(`${RUGCHECK_API}/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) rc = await res.json();
  } catch (e) { /* fallback */ }

  // Build score
  const mintAuthActive = rc ? (rc.mintAuthority !== null && rc.mintAuthority !== '') : true;
  const freezeAuthActive = rc ? (rc.freezeAuthority !== null && rc.freezeAuthority !== '') : true;
  const lpLocked = rc?.markets?.some(m => m.lp?.lpLocked) ?? false;
  const topHolderPct = rc?.topHolders?.[0]?.pct ?? 50;
  const devWalletPct = rc?.creator?.pct ?? 10;
  const isHoneypot = rc?.risks?.some(r => r.name?.toLowerCase().includes('honeypot')) ?? false;
  const liquidityUSD = rc?.markets?.reduce((s, m) => s + (m.lp?.usd ?? 0), 0) ?? 0;
  const ageHours = rc?.createdAt ? Math.floor((Date.now() - new Date(rc.createdAt).getTime()) / 3600000) : 0;

  let score = 50;
  if (!mintAuthActive) score += 15; else score -= 25;
  if (!freezeAuthActive) score += 10; else score -= 20;
  if (lpLocked) score += 12; else score -= 15;
  if (topHolderPct < 15) score += 10; else if (topHolderPct > 40) score -= 15;
  if (devWalletPct < 5) score += 8; else if (devWalletPct > 20) score -= 20;
  if (isHoneypot) score -= 40;
  if (liquidityUSD > 100000) score += 5;
  if (ageHours > 168) score += 5;
  score = Math.max(0, Math.min(100, score));

  const tier = score >= 70 ? 'safe' : score >= 50 ? 'caution' : score >= 30 ? 'warning' : 'danger';
  const action = score >= 50 ? 'PROCEED' : score >= 30 ? 'WARN' : 'BLOCK';

  return {
    score, tier, action,
    verdict: score >= 70 ? 'Low Risk' : score >= 50 ? 'Moderate' : score >= 30 ? 'High Risk' : 'Extreme Risk',
    address: mint,
    checks: {
      mintAuth: { pass: !mintAuthActive, label: 'Mint Authority', value: mintAuthActive ? 'Active' : 'Revoked' },
      freezeAuth: { pass: !freezeAuthActive, label: 'Freeze Authority', value: freezeAuthActive ? 'Active' : 'Revoked' },
      lpLock: { pass: lpLocked, label: 'LP Lock', value: lpLocked ? 'Locked' : 'Unlocked' },
      topHolder: { pass: topHolderPct < 25, label: 'Top Holder', value: Math.round(topHolderPct) + '%' },
      devWallet: { pass: devWalletPct < 10, label: 'Dev Wallet', value: Math.round(devWalletPct) + '%' },
      honeypot: { pass: !isHoneypot, label: 'Honeypot', value: isHoneypot ? 'Detected' : 'Clean' },
      liquidity: { pass: liquidityUSD > 50000, label: 'Liquidity', value: '$' + fmt(liquidityUSD) },
      age: { pass: ageHours > 72, label: 'Token Age', value: ageHours > 48 ? Math.floor(ageHours / 24) + 'd' : ageHours + 'h' },
    },
    meta: { source: rc ? 'rugcheck' : 'fallback', timestamp: Date.now() },
  };
}

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toString();
}

// CLI entry point
const mint = process.argv[2];
if (!mint) {
  console.error('Usage: node scan.js <TOKEN_MINT_ADDRESS>');
  process.exit(1);
}

scan(mint).then(result => {
  console.log(JSON.stringify(result, null, 2));
  if (result.action === 'BLOCK') process.exit(1);
}).catch(e => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(2);
});
