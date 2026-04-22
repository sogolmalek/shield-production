/**
 * SHIELD × GoldRush — Blockchain Data Layer
 * 
 * Replaces raw RPC calls with GoldRush's structured data APIs.
 * Used for: wallet risk scoring, transaction analysis, LP monitoring, pricing.
 */

const GOLDRUSH_API = 'https://api.covalenthq.com/v1';
const CHAIN = 'solana-mainnet';

class ShieldGoldRush {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  // ═══════════════════════════════
  // 1. TOKEN HOLDER ANALYSIS
  // ═══════════════════════════════

  // Get top holders of a token (for concentration risk)
  async getTokenHolders(tokenAddress) {
    try {
      const res = await fetch(
        `${GOLDRUSH_API}/${CHAIN}/tokens/${tokenAddress}/token_holders_v2/?page-size=20`,
        { headers: this.headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.data?.items || [];
    } catch (e) {
      console.log('[GoldRush] Token holders error:', e.message);
      return null;
    }
  }

  // ═══════════════════════════════
  // 2. WALLET BALANCES + PRICING
  // ═══════════════════════════════

  // Get all token balances for a wallet with USD pricing
  async getWalletBalances(walletAddress) {
    try {
      const res = await fetch(
        `${GOLDRUSH_API}/${CHAIN}/address/${walletAddress}/balances_v2/`,
        { headers: this.headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return {
        address: data.data?.address,
        items: (data.data?.items || []).map(item => ({
          token: item.contract_ticker_symbol,
          name: item.contract_name,
          address: item.contract_address,
          balance: item.balance,
          decimals: item.contract_decimals,
          quoteRate: item.quote_rate,
          quoteUSD: item.quote,
          logo: item.logo_url,
        })),
      };
    } catch (e) {
      console.log('[GoldRush] Balances error:', e.message);
      return null;
    }
  }

  // ═══════════════════════════════
  // 3. TRANSACTION HISTORY
  // ═══════════════════════════════

  // Get transaction history (for honeypot detection + activity analysis)
  async getTransactions(walletAddress, pageSize = 20) {
    try {
      const res = await fetch(
        `${GOLDRUSH_API}/${CHAIN}/address/${walletAddress}/transactions_v3/page/0/?page-size=${pageSize}`,
        { headers: this.headers, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return (data.data?.items || []).map(tx => ({
        hash: tx.tx_hash,
        blockTime: tx.block_signed_at,
        from: tx.from_address,
        to: tx.to_address,
        value: tx.value,
        gasSpent: tx.gas_spent,
        successful: tx.successful,
        type: tx.tx_type || 'unknown',
      }));
    } catch (e) {
      console.log('[GoldRush] Transactions error:', e.message);
      return null;
    }
  }

  // ═══════════════════════════════
  // 4. TOKEN TRANSFERS
  // ═══════════════════════════════

  // Get token transfers for an address (for analyzing sell pressure)
  async getTokenTransfers(walletAddress, tokenAddress) {
    try {
      const url = tokenAddress
        ? `${GOLDRUSH_API}/${CHAIN}/address/${walletAddress}/transfers_v2/?contract-address=${tokenAddress}&page-size=20`
        : `${GOLDRUSH_API}/${CHAIN}/address/${walletAddress}/transfers_v2/?page-size=20`;

      const res = await fetch(url, { headers: this.headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return null;
      const data = await res.json();
      return data.data?.items || [];
    } catch (e) {
      console.log('[GoldRush] Transfers error:', e.message);
      return null;
    }
  }

  // ═══════════════════════════════
  // 5. WALLET RISK SCORING
  // "Score wallet risk from SPL token balances, 
  //  approval hygiene, and full transaction history"
  // ═══════════════════════════════

  async scoreWalletRisk(walletAddress) {
    const [balances, txs] = await Promise.allSettled([
      this.getWalletBalances(walletAddress),
      this.getTransactions(walletAddress, 50),
    ]);

    const bal = balances.status === 'fulfilled' ? balances.value : null;
    const transactions = txs.status === 'fulfilled' ? txs.value : null;

    let riskScore = 50; // neutral start
    const flags = [];

    if (bal?.items) {
      // High number of zero-value shitcoins = suspicious
      const dustTokens = bal.items.filter(i => i.quoteUSD < 0.01 && i.quoteUSD > 0).length;
      if (dustTokens > 20) {
        riskScore -= 10;
        flags.push(`${dustTokens} dust tokens (possible airdrop scam targets)`);
      }

      // Very concentrated portfolio = risky behavior
      const totalValue = bal.items.reduce((s, i) => s + (i.quoteUSD || 0), 0);
      const topToken = bal.items.reduce((max, i) => (i.quoteUSD || 0) > (max.quoteUSD || 0) ? i : max, bal.items[0]);
      if (totalValue > 0 && topToken) {
        const concentration = (topToken.quoteUSD || 0) / totalValue;
        if (concentration > 0.95) {
          flags.push(`${(concentration * 100).toFixed(0)}% in single token`);
        }
      }
    }

    if (transactions) {
      // Failed transactions ratio
      const failed = transactions.filter(t => !t.successful).length;
      const failRate = transactions.length > 0 ? failed / transactions.length : 0;
      if (failRate > 0.3) {
        riskScore -= 15;
        flags.push(`${(failRate * 100).toFixed(0)}% failed transactions`);
      }

      // Recent activity (active = good)
      const recentTx = transactions.filter(t => {
        const age = Date.now() - new Date(t.blockTime).getTime();
        return age < 7 * 24 * 3600 * 1000; // last 7 days
      }).length;
      if (recentTx > 5) riskScore += 5;
    }

    return {
      walletAddress,
      riskScore: Math.max(0, Math.min(100, riskScore)),
      flags,
      tokenCount: bal?.items?.length || 0,
      txCount: transactions?.length || 0,
    };
  }

  // ═══════════════════════════════
  // 6. ENHANCED TOKEN SCORING
  // Combine GoldRush data with RugCheck for deeper analysis
  // ═══════════════════════════════

  async enhanceTokenScore(tokenAddress, baseScore) {
    let adjustment = 0;
    const insights = [];

    // Get holder data from GoldRush
    const holders = await this.getTokenHolders(tokenAddress);

    if (holders && holders.length > 0) {
      // Calculate holder concentration from GoldRush data
      const totalBalance = holders.reduce((s, h) => s + parseFloat(h.balance || 0), 0);

      if (totalBalance > 0) {
        const topHolderPct = (parseFloat(holders[0]?.balance || 0) / totalBalance) * 100;
        const top5Pct = holders.slice(0, 5).reduce((s, h) => s + parseFloat(h.balance || 0), 0) / totalBalance * 100;

        insights.push(`Top holder: ${topHolderPct.toFixed(1)}% (GoldRush)`);
        insights.push(`Top 5 holders: ${top5Pct.toFixed(1)}% (GoldRush)`);

        if (topHolderPct > 50) adjustment -= 15;
        else if (topHolderPct > 25) adjustment -= 5;
        else if (topHolderPct < 10) adjustment += 5;

        // Holder count as signal
        insights.push(`${holders.length}+ holders indexed (GoldRush)`);
        if (holders.length >= 20) adjustment += 3;
      }
    }

    // Get token transactions for activity analysis
    const txs = await this.getTransactions(tokenAddress, 20);
    if (txs && txs.length > 0) {
      // Healthy activity = diverse transactions
      const uniqueAddresses = new Set(txs.map(t => t.from).concat(txs.map(t => t.to))).size;
      insights.push(`${uniqueAddresses} unique addresses in recent txs (GoldRush)`);
      if (uniqueAddresses > 10) adjustment += 3;
      if (uniqueAddresses <= 2) adjustment -= 10;

      // Check for failed transactions (honeypot signal)
      const failedTxs = txs.filter(t => !t.successful).length;
      if (failedTxs > txs.length * 0.5) {
        adjustment -= 20;
        insights.push(`${failedTxs}/${txs.length} transactions failed — possible honeypot (GoldRush)`);
      }
    }

    return {
      adjustment,
      insights,
      enhancedScore: Math.max(0, Math.min(100, baseScore + adjustment)),
      source: 'goldrush',
    };
  }
}

module.exports = { ShieldGoldRush };
