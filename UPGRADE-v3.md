# Shield v3.0 — Production Hardening Changelog

## What changed

### Backend (server.js → v3.0)

**Reliability**
- `fetchWithRetry()` — all external API calls (RugCheck, Jupiter, DexScreener, Solana RPC) now retry 2-3x with exponential backoff + jitter
- Circuit breaker on every data source (rugcheck, jupiter, rpc, goldrush) — after 5 consecutive failures, stops calling that source for 60s, then half-opens to test 2 successes before closing. Prevents cascading failures.
- Request timeout middleware — every request gets a 30s server-side timeout. If hit, responds 504 with `retryAfter` hint.
- Cluster restart throttle — if workers crash >10 times in 60s, primary cools down 30s instead of hot-looping.
- `uncaughtException` handler saves credits + user state before dying.
- `unhandledRejection` handler logs but doesn't crash.

**Data Safety**
- Atomic file writes — writes to `.tmp` then renames (no corrupt JSON on mid-write crash).
- Graceful shutdown — SIGTERM/SIGINT drain in-flight requests for 5s before exit.

**Memory**
- `LRUCache` replaces bare `Map` for scan and ticker caches — capped at 500/200 entries, auto-evicts oldest. No memory leak on high-traffic days.

**Observability**
- `GET /health` endpoint returns: uptime, memory, cache size, user count, circuit breaker states, dependency config status. Returns 503 if any circuit is OPEN.
- All error responses now include `retryAfter` (seconds) so clients know when to retry.
- `isShuttingDown` flag — returns 503 during shutdown instead of accepting and failing.

### Extension — background.js (v3.0)

**Reliability**
- `fetchRetry()` in service worker — retries 2x with backoff on all API calls.
- Server health awareness — `checkServerHealth()` pings `/health` every 60s, skips scans when server is confirmed down.
- Scan dedup — `pendingScans` Map prevents duplicate in-flight scans for the same token (e.g. multiple tweets with same $TICKER scroll into view).
- `SERVER_STATUS` message type — content scripts can ask "is server up?" before showing loading states.

**Error handling**
- 429 (rate limited), 503 (server restart), and network errors all return structured objects with `retryAfter`.
- Auto-retry on `server_down` response (1 retry with configurable delay).

### Extension — content.js (v3.0)

**UX**
- Loading spinner in the floating bar (CSS `shieldSpin` animation) instead of static "Scanning…" text.
- Minimum 400ms display for loading state — prevents flicker on cached/fast scans.
- Smooth close animation (slide-out over 250ms) on bar dismiss and URL change.
- Score reveal with `shieldCheckPop` scale animation.
- "Swap Blocked" label fades in with `shieldFadeIn`.
- Retry button on error — user can retry without page reload.

**Reliability**
- `isContextValid()` check before every `chrome.runtime.sendMessage` — prevents "Extension context invalidated" errors after extension update.
- Auto-retry once on context invalidation (2s delay).
- Auto-retry on `server_down` (up to 2x with server-specified delay).
- Twitter badges: `.scanning` CSS class with pulse animation during scan, smooth opacity transition on removal.
- Phantom wallet connect timeout increased to 15s with descriptive error message.

### Extension — popup.js (v3.0)

**UX**
- `showError()` function — renders a styled error card with message + retry button inside the scan tab. No more `alert()` calls.
- Specific error messages for: rate limiting, server restart, timeout (with Render cold-start explanation), network error.
- Loading text is contextual: "Resolving token from DexScreener…" vs "Analyzing on-chain data…".
- `fadeIn` animation on scan results and error cards.
- Wallet connection shows inline messages instead of alert() — "Connecting to Phantom…" → "Connected" or descriptive error.

**Reliability**
- `fetchRetry()` on all popup API calls with 12s timeout.
- doScan() replaces runScan() as the core scan function — handles all HTTP status codes (402, 429, 503, 5xx) with appropriate UI.
- Payment polling is more resilient (uses fetchRetry).

### Extension — lifi.js

- `getRoutes()` now retries 2x on failure with 1s/2s backoff.


---

## Revenue: LI.FI Portal Setup

### Current state
The code uses `integrator: 'shield-rug-score'` and `fee: 0.005` (0.5%) on all routes. This is already wired into:
- `lifi.js` — route requests + Jumper Exchange fallback URL
- The fee is shown to users in the quote ("Fees" line)

### What you need to do
1. Go to **https://portal.li.fi/** and create an account
2. Register the integrator string: `shield-rug-score`
3. Set your fee to 0.005 (0.5%) or whatever you negotiate
4. Add your wallet address for fee collection
5. LI.FI will whitelist the integrator — fees auto-settle to your wallet

### Revenue math
- If 100 users swap $50/day via Shield → $5,000 daily volume
- 0.5% fee → $25/day → $750/month passive revenue
- This scales with user growth and doesn't depend on scan revenue

---

## Revenue: Phantom Payment Flow

### Current flow (already working)
1. User hits trial limit → bar/popup shows $1/$5/$10 buttons
2. Click opens Phantom deeplink: `phantom.app/ul/transfer?recipient=<OWNER_WALLET>&amount=<AMT>&splToken=<USDC_MINT>`
3. User approves in Phantom → USDC sent to your wallet
4. Backend verifies the tx signature and credits the balance

### Testing checklist
- [ ] Install Phantom on Chrome
- [ ] Fund test wallet with devnet or small mainnet USDC
- [ ] Trigger trial limit (scan 30 tokens or wait 3 days)
- [ ] Click $1 in the payment prompt
- [ ] Verify Phantom opens with correct amount/recipient
- [ ] After approval, check `GET /api/credits/<wallet>` for balance
- [ ] Scan again — should succeed and deduct $0.01
- [ ] Check `totalSpent` in popup stats

### If deposit doesn't auto-credit
The popup polls `/api/credits/<wallet>` every 3s for 90s after the deeplink opens. If the USDC transfer hits chain but doesn't auto-credit, the user can manually trigger verification:
```
POST /api/payment/verify
{ "txSignature": "<sig>", "wallet": "<addr>" }
```
This parses the on-chain tx and credits the balance.


---

## Deploy

### Backend (Render)
```bash
cd backend
git add -A && git commit -m "v3.0: production hardening"
git push origin main
# Render auto-deploys from main
```
Verify: `curl https://shield-production-8awh.onrender.com/health`

### Extension (Chrome Web Store)
1. Zip the `extension/` folder
2. Upload to Chrome Web Store developer dashboard
3. Version 3.0.0 should pass review (no new permissions needed)

Or for local testing:
1. Go to `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" → select `extension/` folder
