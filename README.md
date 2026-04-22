# ⛨ Shield — Rug Score Everywhere + Safe Swap from Any Chain

> Every token you see online, scored for rug risk. Buy the safe ones from any chain. Block the dangerous ones automatically.

**Shield** is a Chrome extension that passively overlays real-time rug pull risk scores on every Solana token across the web — and lets you **buy safe via cross-chain swap** or **block dangerous trades via AI agent skill**.

Built for the [Solana Frontier Hackathon](https://colosseum.com).

---

## What Shield Does

```
You browse the web (DEXScreener, Twitter, Jupiter, Telegram)
        ↓
Shield detects Solana token address
        ↓
8 security checks in <200ms (RugCheck + RPC)
        ↓
Color-coded badge injected inline
   🟢 72 Safe   🟡 51 Caution   🔴 14 Danger
        ↓
Click "Buy Safe via LI.FI" → cross-chain swap from any chain
        ↓
Score < 30? → 🛑 SWAP BLOCKED
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Chrome Extension (content.js + lifi.js)        │
│  • DOM scanner → detect token addresses         │
│  • Badge injection → score overlay              │
│  • LI.FI modal → cross-chain swap               │
│  • Jupiter "Buy Safe" button                     │
└──────────────────────┬──────────────────────────┘
                       │
            ┌──────────▼──────────┐
            │  Shield Backend      │
            │  • RugCheck API      │
            │  • Alchemy RPC       │
            │  • LI.FI proxy       │
            │  • USDC payments     │
            └──────────┬──────────┘
                       │
  ┌────────────────────┼────────────────────┐
  │                    │                    │
  ▼                    ▼                    ▼
Quicknode/RPC      LI.FI (20+          Jupiter APIs
(on-chain data)    bridges, 60+        (Swap V2, Tokens,
                   chains)             Price, Trigger)
```

## Hackathon Tracks

### Track 1: Quicknode — Data Backbone
Shield's scoring engine runs on RPC infrastructure. Every badge = a Quicknode call. 8 parallel security checks (`getAccountInfo`, `getTokenLargestAccounts`, `getSignaturesForAddress`) in <200ms.

### Track 2: LI.FI — Execution Layer  
Click "Buy Safe via LI.FI" in any Shield tooltip. Pick your source chain (Ethereum, Arbitrum, Base, Polygon, BSC, Solana). LI.FI routes the optimal path across 20+ bridges. **First cross-chain swap that blocks rug pulls.**

### Track 3: Jupiter — Agent Skill + Smart Trading
Shield as an **Agent Skill** (SKILL.md) for AI agents using Jupiter. Any agent that trades via Jupiter CLI gets rug-checking for free. Plus: Jupiter Tokens API data enhances Shield scoring, Trigger API enables auto-exit, Recurring API enables rug-aware DCA.

## Security Checks

| Check | What It Detects |
|-------|----------------|
| Mint Authority | Can team print unlimited tokens? |
| Freeze Authority | Can team freeze your wallet? |
| LP Lock | Is liquidity locked or pullable? |
| Top Holder % | Whale concentration risk |
| Dev Wallet % | Insider holding risk |
| Honeypot | Can you actually sell? |
| Liquidity Depth | How much real liquidity exists? |
| Token Age | How new is this token? |

## Revenue Model

- $0.01 USDC per scan via x402 on Solana
- Free tier: 10 scans/day for 3 days
- Revenue wallet: `A59AVvijPfVC62vxpWqHevgc5FEaQ6bEEmdvSdMYDebs`

## Project Structure

```
shield/
├── backend/
│   ├── server.js              # API: scoring + LI.FI proxy + payments
│   ├── package.json
│   ├── Dockerfile
│   └── render.yaml
├── extension/
│   ├── manifest.json           # Chrome Manifest V3
│   ├── src/
│   │   ├── content.js          # DOM scanner + badge injection
│   │   ├── content.css         # Badge + tooltip styles
│   │   ├── lifi.js             # LI.FI cross-chain swap modal
│   │   ├── lifi.css            # Swap modal styles
│   │   ├── background.js       # Service worker + free tier
│   │   ├── popup.html          # Dashboard
│   │   └── popup.js            # Dashboard logic
│   ├── demo/
│   │   └── index.html          # Standalone interactive demo
│   └── icons/
├── skills/
│   └── shield-rug-check/
│       ├── SKILL.md            # Jupiter Agent Skill
│       └── scripts/
│           └── scan.js         # Standalone CLI scanner
├── jupiter/
│   ├── shield-jupiter.js      # 5 Jupiter APIs integration
│   └── test.js                # Endpoint test suite
├── DX-REPORT.md                # Jupiter DX feedback
└── README.md
```

## Quick Start

### Backend
```bash
cd backend && npm install && node server.js
```

### Extension
```bash
# Update SHIELD_API in extension/src/content.js
# chrome://extensions → Developer Mode → Load Unpacked → extension/
```

### Jupiter Agent Skill
```bash
# Install skill
cp -r skills/shield-rug-check ~/.claude/skills/

# Test scan
node skills/shield-rug-check/scripts/scan.js <TOKEN_MINT>

# Test all Jupiter endpoints
JUPITER_API_KEY=xxx node jupiter/test.js
```

## Demo

- Live: [shieldme.netlify.app](https://shieldme.netlify.app)

## Tech Stack

Chrome Extension (Manifest V3) · RugCheck API · Alchemy RPC · LI.FI (cross-chain) · Jupiter APIs (Swap V2, Tokens, Price, Trigger, Recurring) · x402 micropayments · Solana

## License

MIT
