---
name: shield-rug-check
description: >
  Rug pull safety layer for Jupiter swaps on Solana. Before any swap, buy, or DCA — 
  run Shield's 8-point security check on the target token. Blocks trades into dangerous 
  tokens (score < 30), warns on moderate risk (30-50), and clears safe tokens (50+). 
  Use when: the agent is about to execute a Jupiter swap, set a limit order, start a DCA, 
  or evaluate any Solana token for trading. Do NOT use for: non-Solana tokens, portfolio 
  viewing, or price-only queries.
license: MIT
metadata:
  author: shield
  version: "1.0.0"
  tags: "security, rug-check, jupiter, solana, defi-safety"
  compatibility: "Works with Jupiter CLI, Claude Code, Cursor, Codex, any MCP-compatible agent"
---

# Shield Rug Check — Safety Layer for Jupiter Agents

You are a security-first trading agent. **Before executing any Jupiter swap, limit order, or DCA on Solana, you MUST rug-check the target token using Shield.**

## When to Activate

- Agent is about to call Jupiter Swap V2 (`/order` or `/build`)
- Agent is setting a Jupiter Trigger (limit order, TP/SL)
- Agent is starting a Jupiter Recurring (DCA)
- User asks "should I buy [token]?" or "is [token] safe?"
- Any trade flow where the destination token is on Solana

## Core Flow

```
1. Extract target token mint address
2. Run Shield security scan (see scripts/scan.js)
3. Check score:
   - Score >= 50 → SAFE — proceed with Jupiter swap
   - Score 30-49 → WARN — inform user of risks, ask for confirmation
   - Score < 30  → BLOCK — refuse to execute the swap
4. Include Shield report in response to user
```

## Security Checks (8 total)

| # | Check | What Shield Detects | Red Flag |
|---|-------|--------------------|----|
| 1 | Mint Authority | Can team print unlimited tokens? | Active = BAD |
| 2 | Freeze Authority | Can team freeze your wallet? | Active = BAD |
| 3 | LP Lock | Is liquidity locked or pullable? | Unlocked = BAD |
| 4 | Top Holder % | Single wallet concentration | > 40% = BAD |
| 5 | Dev Wallet % | Insider holding risk | > 20% = BAD |
| 6 | Honeypot | Can you actually sell? | Detected = CRITICAL |
| 7 | Liquidity | How much real liquidity exists? | < $10K = BAD |
| 8 | Token Age | How new is this token? | < 24h = RISKY |

## How to Run the Scan

### Option A: Use the scan script
```bash
node scripts/scan.js <TOKEN_MINT_ADDRESS>
```

Returns JSON:
```json
{
  "score": 78,
  "tier": "safe",
  "verdict": "Low Risk",
  "checks": { ... },
  "action": "PROCEED"
}
```

### Option B: Call RugCheck API directly
```bash
curl -s "https://api.rugcheck.xyz/v1/tokens/<MINT>/report/summary"
```

### Option C: Use Shield backend API
```bash
curl -s -X POST https://shield-api.onrender.com/api/scan/free \
  -H "Content-Type: application/json" \
  -d '{"token": "<MINT>", "fingerprint": "agent"}'
```

## Decision Logic

```
IF score >= 50:
  → Tell user: "Shield Score: {score}/100 — {verdict}. Safe to proceed."
  → Execute Jupiter swap normally
  
IF score >= 30 AND score < 50:
  → Tell user: "Shield Score: {score}/100 — Moderate Risk."
  → List failing checks
  → Ask: "This token has moderate risk. Do you want to proceed?"
  → Only execute if user confirms

IF score < 30:
  → Tell user: "Shield Score: {score}/100 — {verdict}. SWAP BLOCKED."
  → List all failing checks
  → Say: "Shield has blocked this trade. This token shows signs of a potential rug pull."
  → DO NOT execute the Jupiter swap under any circumstances
  → Suggest alternatives: "Try searching for similar tokens with better safety scores."
```

## Integration with Jupiter APIs

### With Jupiter Swap V2
```javascript
// 1. Scan first
const shield = await scan(targetMint);
if (shield.score < 30) {
  return `BLOCKED: Score ${shield.score}/100 — ${shield.verdict}`;
}

// 2. Then swap via Jupiter Swap V2 (GET /order → sign → POST /execute)
const params = new URLSearchParams({
  inputMint, outputMint: targetMint, amount, taker: walletAddress
});
const order = await fetch(`https://api.jup.ag/swap/v2/order?${params}`, {
  headers: { 'x-api-key': API_KEY }
});
```

### With Jupiter Tokens API — Double-Check
```javascript
// Use Jupiter's own token data to enhance Shield's scoring
const tokenData = await fetch(`https://api.jup.ag/tokens/v1/${targetMint}`, {
  headers: { 'x-api-key': API_KEY }
});
const token = await tokenData.json();

// Jupiter's organic score + Shield's security score = full picture
const jupiterTrust = token.daily_volume > 100000 && token.verification_status === 'verified';
```

### With Jupiter Trigger (Limit Orders) — Auto-Exit
```javascript
// After buying a token, set a safety limit order:
// If Shield score drops below 30, auto-sell
// Check periodically and create a sell order if needed
```

### With Jupiter Recurring (DCA) — Smart Pause
```javascript
// Before each DCA execution, re-scan the token
// If score dropped below 30 since last buy, pause the DCA
// Resume when score recovers above 50
```

## Response Format

When reporting Shield results to the user, use this format:

```
⛨ SHIELD SECURITY REPORT
━━━━━━━━━━━━━━━━━━━━━━━
Token: {address}
Score: {score}/100 — {verdict}
Action: {PROCEED / WARN / BLOCKED}

Checks:
  ✓ Mint Authority: Revoked
  ✓ Freeze Authority: Revoked
  ✗ LP Lock: Unlocked ← WARNING
  ✓ Top Holder: 12%
  ✓ Dev Wallet: 3%
  ✓ Honeypot: Clean
  ! Liquidity: $23K ← LOW
  ✓ Token Age: 14d
━━━━━━━━━━━━━━━━━━━━━━━
```

## Edge Cases

- If RugCheck API is down, fall back to RPC-only scoring (less comprehensive but still useful)
- If token is SOL, USDC, or other major tokens (in the skip list), skip the scan — these are known safe
- If scan takes > 5 seconds, proceed with warning: "Shield scan timed out — proceed with caution"
- Never cache scores for more than 5 minutes — token conditions change fast

## Known Safe Tokens (Skip Scan)

```
So11111111111111111111111111111111111111112  (SOL)
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (USDC)
Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB  (USDT)
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263  (BONK)
JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN   (JUP)
```
