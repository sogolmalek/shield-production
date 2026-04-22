# 🚀 Deploy Shield — Step by Step

## Step 1: Push to GitHub (2 min)

```bash
cd shield-final
git init
git add .
git commit -m "Shield v2 — rug score everywhere"
```

Boro GitHub.com → New Repository → name: `shield` → Create

```bash
git remote add origin https://github.com/YOUR_USERNAME/shield.git
git branch -M main
git push -u origin main
```

---

## Step 2: Deploy Backend to Render (5 min)

1. Boro **[render.com](https://render.com)** → Sign up (free)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub → select **shield** repo
4. Settings:
   - **Name:** `shield-api`
   - **Root Directory:** `backend`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Environment Variables → Add:
   - `ALCHEMY_RPC` = `https://solana-mainnet.g.alchemy.com/v2/FE1Fd3x7PlqkZYxMqQpP3orTaf1dsmG4`
   - `GOLDRUSH_API_KEY` = `cqt_rQVgy4MyC3CgJcgvVBR3BFgR9Dgm`
6. Click **"Deploy Web Service"**
7. Wait 2-3 min → You get a URL like: `https://shield-api-xxxx.onrender.com`
8. Test: open that URL in browser → should see JSON with "status: live"

---

## Step 3: Update Extension with Backend URL (1 min)

Open `extension/src/content.js` line 8:

```javascript
// CHANGE THIS:
const SHIELD_API = 'https://shield-api.onrender.com';

// TO YOUR RENDER URL:
const SHIELD_API = 'https://shield-api-xxxx.onrender.com';
```

---

## Step 4: Load Extension in Chrome (1 min)

1. Open Chrome → go to `chrome://extensions`
2. Toggle **"Developer mode"** ON (top right)
3. Click **"Load unpacked"**
4. Select the `extension/` folder
5. Shield icon appears in your toolbar ⛨

---

## Step 5: Test It

1. Go to any site with Solana tokens (e.g. birdeye.so, dexscreener.com)
2. Shield badges should appear next to token addresses
3. Hover a badge → see full security report
4. Click "Buy Safe via LI.FI" → swap modal opens

---

## Done! 🎯

Your Shield is live:
- Backend: `https://shield-api-xxxx.onrender.com`
- Demo: `https://shieldme.netlify.app`
- Extension: loaded in Chrome
