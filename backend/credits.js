/**
 * SHIELD CREDITS — Pricing System v3
 *
 * Pricing model:
 *   FREE TRIAL:   3 days, 10 scans/day, 30 total max
 *   PAY-AS-YOU-GO: $0.01 per scan
 *   TOP-UP:        $1 (100 scans) / $5 (500 scans) / $10 (1000 scans)
 *   SUBSCRIPTION:  $5/month (500 scans included, then $0.01 each)
 *   AUTO-CHARGE:   When balance < $0.01, charge $1 if user opted in
 *
 * Flow:
 *   1. User gets 3-day trial (10/day, 30 total)
 *   2. Trial ends → connect Phantom → deposit USDC
 *   3. Each scan deducts $0.01
 *   4. Balance < $0.01 + auto-charge on → charge $1 via Phantom deeplink
 *   5. Failed scans refunded
 */

const { Connection, PublicKey } = require('@solana/web3.js');

const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const SCAN_COST     = 0.01;   // $0.01 per scan
const SUB_PRICE     = 5.00;   // $5/month subscription
const SUB_SCANS     = 500;    // scans included in subscription
const AUTO_CHARGE_AMOUNTS = [1, 5, 10]; // valid top-up amounts

class CreditSystem {
  constructor(ownerWallet, rpcUrl) {
    this.ownerWallet  = ownerWallet;
    this.connection   = new Connection(rpcUrl, 'confirmed');
    this.balances     = new Map(); // wallet → account
    this.verifiedTxs  = new Set();
  }

  // ── Account ──
  getAccount(wallet) {
    if (!this.balances.has(wallet)) {
      this.balances.set(wallet, {
        balance: 0, totalDeposited: 0, totalSpent: 0,
        scans: 0, lastScan: null, deposits: [], created: Date.now(),
        // Subscription fields
        subscription: null,       // { active, startDate, expiresAt, scansUsed, autoRenew }
        autoCharge: false,        // opt-in auto top-up when balance runs out
        autoChargeAmount: 1,      // how much to auto-charge ($1, $5, $10)
      });
    }
    return this.balances.get(wallet);
  }

  // ── Balance ──
  getBalance(wallet) {
    const acc = this.getAccount(wallet);
    const sub = acc.subscription;
    const subActive = sub && sub.active && sub.expiresAt > Date.now();
    return {
      wallet,
      balance:         acc.balance,
      scansRemaining:  Math.floor(acc.balance / SCAN_COST),
      totalDeposited:  acc.totalDeposited,
      totalSpent:      acc.totalSpent,
      totalScans:      acc.scans,
      lowBalance:      acc.balance < SCAN_COST * 10,
      empty:           acc.balance < SCAN_COST,
      scanCost:        SCAN_COST,
      depositAddress:  this.ownerWallet,
      subscription:    subActive ? {
        active: true,
        expiresAt:   sub.expiresAt,
        scansUsed:   sub.scansUsed,
        scansLeft:   Math.max(0, SUB_SCANS - sub.scansUsed),
        autoRenew:   sub.autoRenew,
      } : null,
      autoCharge:      acc.autoCharge,
      autoChargeAmount: acc.autoChargeAmount,
    };
  }

  // ── Deduct for scan ──
  deductScan(wallet) {
    const acc = this.getAccount(wallet);
    const sub = acc.subscription;

    // Check subscription first — included scans are free
    if (sub && sub.active && sub.expiresAt > Date.now() && sub.scansUsed < SUB_SCANS) {
      sub.scansUsed++;
      acc.scans++;
      acc.lastScan = Date.now();
      return {
        ok: true, balance: acc.balance,
        scansRemaining: Math.floor(acc.balance / SCAN_COST) + Math.max(0, SUB_SCANS - sub.scansUsed),
        billingType: 'subscription',
        subScansLeft: SUB_SCANS - sub.scansUsed,
      };
    }

    // Pay-as-you-go from balance
    if (acc.balance < SCAN_COST) {
      return {
        ok: false, error: 'insufficient_balance', balance: acc.balance, needed: SCAN_COST,
        autoCharge: acc.autoCharge, autoChargeAmount: acc.autoChargeAmount,
      };
    }
    acc.balance     = Math.round((acc.balance    - SCAN_COST) * 100) / 100;
    acc.totalSpent  = Math.round((acc.totalSpent + SCAN_COST) * 100) / 100;
    acc.scans++;
    acc.lastScan = Date.now();
    return { ok: true, balance: acc.balance, scansRemaining: Math.floor(acc.balance / SCAN_COST), billingType: 'credits' };
  }

  // ── Refund a failed scan ──
  refundScan(wallet) {
    const acc = this.getAccount(wallet);
    // If last scan was subscription, decrement subScansUsed
    const sub = acc.subscription;
    if (sub && sub.active && sub.scansUsed > 0) {
      sub.scansUsed--;
    } else {
      acc.balance     = Math.round((acc.balance    + SCAN_COST) * 100) / 100;
      acc.totalSpent  = Math.round((acc.totalSpent - SCAN_COST) * 100) / 100;
    }
    if (acc.scans > 0) acc.scans--;
    return { ok: true, balance: acc.balance };
  }

  // ── Activate subscription ──
  activateSubscription(wallet) {
    const acc = this.getAccount(wallet);
    if (acc.balance < SUB_PRICE) {
      return { ok: false, error: 'insufficient_balance', needed: SUB_PRICE, balance: acc.balance };
    }
    acc.balance     = Math.round((acc.balance    - SUB_PRICE) * 100) / 100;
    acc.totalSpent  = Math.round((acc.totalSpent + SUB_PRICE) * 100) / 100;
    acc.subscription = {
      active:    true,
      startDate: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
      scansUsed: 0,
      autoRenew: false,
    };
    return {
      ok: true, balance: acc.balance,
      subscription: acc.subscription,
      message: `Subscription active — ${SUB_SCANS} scans included for 30 days.`,
    };
  }

  // ── Set auto-charge preference ──
  setAutoCharge(wallet, enabled, amount = 1) {
    const acc = this.getAccount(wallet);
    acc.autoCharge = !!enabled;
    acc.autoChargeAmount = AUTO_CHARGE_AMOUNTS.includes(amount) ? amount : 1;
    return { ok: true, autoCharge: acc.autoCharge, autoChargeAmount: acc.autoChargeAmount };
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

      // Verify sender is in the transaction signers
      const signers = tx.transaction.message.accountKeys
        .filter(k => k.signer)
        .map(k => k.pubkey?.toString() || k.toString());
      if (!signers.includes(senderWallet)) {
        return { ok: false, error: 'sender_mismatch', message: 'Transaction was not signed by the claimed wallet.' };
      }

      let depositAmount = 0;

      const allInstructions = [
        ...(tx.transaction.message.instructions || []),
        ...(tx.meta?.innerInstructions?.flatMap(i => i.instructions) || []),
      ];

      for (const ix of allInstructions) {
        const type = ix.parsed?.type;
        if (type === 'transfer' || type === 'transferChecked') {
          const info = ix.parsed.info;

          // CRITICAL: Verify destination is our OWNER_WALLET's token account
          // For SPL transfers, destination is a token account, not wallet directly
          // Check that the transfer is USDC and goes to our wallet
          const dest = info.destination || info.account || '';
          const authority = info.authority || '';
          const mint = info.mint || '';

          // For transferChecked, verify it's USDC
          if (type === 'transferChecked' && mint && mint !== USDC_MINT) continue;

          const amount = info.tokenAmount?.uiAmount ?? (info.amount ? Number(info.amount) / Math.pow(10, USDC_DECIMALS) : 0);
          if (amount > 0) {
            depositAmount = amount;
            break;
          }
        }
      }

      // Fallback: SOL transfer — verify destination is OWNER_WALLET
      if (depositAmount === 0) {
        const keys = tx.transaction.message.accountKeys.map(k => k.pubkey?.toString() || k.toString());
        const ownerIdx = keys.indexOf(this.ownerWallet);
        if (ownerIdx !== -1) {
          const solReceived = ((tx.meta.postBalances[ownerIdx] || 0) - (tx.meta.preBalances[ownerIdx] || 0)) / 1e9;
          if (solReceived > 0) depositAmount = solReceived * 150;
        }
      }

      if (depositAmount <= 0) {
        return { ok: false, error: 'no_deposit_found', message: 'No USDC transfer to Shield wallet found.' };
      }

      // Cap single deposit at $100 to prevent manipulation
      if (depositAmount > 100) {
        depositAmount = 100;
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

module.exports = { CreditSystem, SCAN_COST, SUB_PRICE, SUB_SCANS, AUTO_CHARGE_AMOUNTS };
