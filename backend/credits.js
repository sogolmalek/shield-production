/**
 * SHIELD CREDITS — Prepaid scan system
 *
 * Flow:
 *   1. User connects Phantom → deposits USDC to Shield wallet
 *   2. Backend verifies tx on Solana → credits balance
 *   3. Each scan deducts $0.01 (off-chain, instant)
 *   4. Failed scans are refunded via refundScan()
 *   5. Low balance → "Top up" prompt in extension
 */

const { Connection, PublicKey } = require('@solana/web3.js');

const USDC_MINT    = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const SCAN_COST    = 0.01;   // $0.01 per scan

class CreditSystem {
  constructor(ownerWallet, rpcUrl) {
    this.ownerWallet  = ownerWallet;
    this.connection   = new Connection(rpcUrl, 'confirmed');
    this.balances     = new Map(); // wallet → account
    this.verifiedTxs  = new Set(); // prevent double-credit
  }

  // ── Account ──
  getAccount(wallet) {
    if (!this.balances.has(wallet)) {
      this.balances.set(wallet, {
        balance: 0, totalDeposited: 0, totalSpent: 0,
        scans: 0, lastScan: null, deposits: [], created: Date.now(),
      });
    }
    return this.balances.get(wallet);
  }

  // ── Balance ──
  getBalance(wallet) {
    const acc = this.getAccount(wallet);
    return {
      wallet,
      balance:         acc.balance,
      scansRemaining:  Math.floor(acc.balance / SCAN_COST),
      totalDeposited:  acc.totalDeposited,
      totalSpent:      acc.totalSpent,
      totalScans:      acc.scans,
      lowBalance:      acc.balance < SCAN_COST * 10,  // < 10 scans left
      empty:           acc.balance < SCAN_COST,
      scanCost:        SCAN_COST,
      depositAddress:  this.ownerWallet,
    };
  }

  // ── Deduct for scan ──
  deductScan(wallet) {
    const acc = this.getAccount(wallet);
    if (acc.balance < SCAN_COST) {
      return { ok: false, error: 'insufficient_balance', balance: acc.balance, needed: SCAN_COST };
    }
    acc.balance     = Math.round((acc.balance    - SCAN_COST) * 100) / 100;
    acc.totalSpent  = Math.round((acc.totalSpent + SCAN_COST) * 100) / 100;
    acc.scans++;
    acc.lastScan = Date.now();
    return { ok: true, balance: acc.balance, scansRemaining: Math.floor(acc.balance / SCAN_COST) };
  }

  // ── Refund a failed scan ──
  refundScan(wallet) {
    const acc = this.getAccount(wallet);
    acc.balance     = Math.round((acc.balance    + SCAN_COST) * 100) / 100;
    acc.totalSpent  = Math.round((acc.totalSpent - SCAN_COST) * 100) / 100;
    if (acc.scans > 0) acc.scans--;
    return { ok: true, balance: acc.balance };
  }

  // ── Verify USDC deposit on Solana ──
  async verifyDeposit(txSignature, senderWallet) {
    if (!txSignature || !senderWallet) {
      return { ok: false, error: 'missing_params', message: 'txSignature and wallet required.' };
    }

    if (this.verifiedTxs.has(txSignature)) {
      return { ok: false, error: 'already_verified', message: 'Transaction already credited.' };
    }

    try {
      const tx = await this.connection.getParsedTransaction(txSignature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx)            return { ok: false, error: 'tx_not_found',   message: 'Transaction not found. Wait a few seconds and try again.' };
      if (tx.meta?.err)   return { ok: false, error: 'tx_failed',      message: 'Transaction failed on-chain.' };

      let depositAmount = 0;

      // Scan top-level instructions
      const allInstructions = [
        ...(tx.transaction.message.instructions || []),
        ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || []),
      ];

      for (const ix of allInstructions) {
        const type = ix.parsed?.type;
        if (type === 'transfer' || type === 'transferChecked') {
          const info   = ix.parsed.info;
          const amount = info.tokenAmount?.uiAmount ?? (info.amount ? Number(info.amount) / Math.pow(10, USDC_DECIMALS) : 0);
          // Only credit USDC (ignore other SPL tokens)
          if (amount > 0 && (info.mint === USDC_MINT || type === 'transferChecked')) {
            depositAmount = amount;
            break;
          }
        }
      }

      // Fallback: SOL transfer (convert at $150/SOL rough rate)
      if (depositAmount === 0) {
        const keys     = tx.transaction.message.accountKeys.map(k => k.pubkey?.toString() || k.toString());
        const ownerIdx = keys.indexOf(this.ownerWallet);
        if (ownerIdx !== -1) {
          const solReceived = ((tx.meta.postBalances[ownerIdx] || 0) - (tx.meta.preBalances[ownerIdx] || 0)) / 1e9;
          if (solReceived > 0) depositAmount = solReceived * 150;
        }
      }

      if (depositAmount <= 0) {
        return { ok: false, error: 'no_deposit_found', message: 'No USDC transfer to Shield wallet found.' };
      }

      const acc = this.getAccount(senderWallet);
      acc.balance        = Math.round((acc.balance        + depositAmount) * 100) / 100;
      acc.totalDeposited = Math.round((acc.totalDeposited + depositAmount) * 100) / 100;
      acc.deposits.push({ tx: txSignature, amount: depositAmount, timestamp: Date.now() });
      this.verifiedTxs.add(txSignature);

      return {
        ok: true,
        credited:       depositAmount,
        balance:        acc.balance,
        scansRemaining: Math.floor(acc.balance / SCAN_COST),
        message:        `$${depositAmount.toFixed(2)} credited — ${Math.floor(acc.balance / SCAN_COST)} scans available.`,
      };

    } catch (e) {
      return { ok: false, error: 'verification_failed', message: e.message };
    }
  }

  // ── Persistence ──
  export() {
    const data = {};
    for (const [wallet, acc] of this.balances) data[wallet] = acc;
    return { balances: data, verifiedTxs: [...this.verifiedTxs] };
  }

  import(data) {
    if (data?.balances)   for (const [w, acc] of Object.entries(data.balances)) this.balances.set(w, acc);
    if (data?.verifiedTxs) data.verifiedTxs.forEach(tx => this.verifiedTxs.add(tx));
  }
}

module.exports = { CreditSystem, SCAN_COST };
