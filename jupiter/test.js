#!/usr/bin/env node
/**
 * Shield × Jupiter — Production Test
 * 
 * Run: JUPITER_API_KEY=your_key node src/test.js
 * 
 * Tests every Jupiter API endpoint used by Shield.
 * Fill in DX-REPORT.md based on results.
 */

const API_KEY = process.env.JUPITER_API_KEY;
if (!API_KEY) {
  console.error('❌ Set JUPITER_API_KEY first: JUPITER_API_KEY=xxx node src/test.js');
  console.error('   Get your key at https://developers.jup.ag');
  process.exit(1);
}

const JUP = 'https://api.jup.ag';
const RUGCHECK = 'https://api.rugcheck.xyz/v1';
const headers = { 'Content-Type': 'application/json', 'x-api-key': API_KEY };

// Test tokens
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let passed = 0;
let failed = 0;
const issues = [];

async function test(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    console.log(`✅ ${name} (${ms}ms)`);
    if (result) console.log(`   ${result}`);
    passed++;
    return { name, ms, ok: true };
  } catch (e) {
    const ms = Date.now() - start;
    console.log(`❌ ${name} (${ms}ms) — ${e.message}`);
    issues.push({ name, error: e.message, ms });
    failed++;
    return { name, ms, ok: false, error: e.message };
  }
}

async function run() {
  console.log('\n⛨ SHIELD × JUPITER — Production Test\n');
  console.log(`API Key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
  console.log('─'.repeat(50));

  // ── 1. RugCheck API (no key needed) ──
  console.log('\n📡 RugCheck API');
  await test('RugCheck: scan BONK', async () => {
    const res = await fetch(`${RUGCHECK}/tokens/${BONK}/report/summary`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return `mintAuthority=${data.mintAuthority}, freezeAuthority=${data.freezeAuthority}`;
  });

  // ── 2. Jupiter Tokens API ──
  console.log('\n📡 Jupiter Tokens API');
  await test('Tokens: get BONK metadata', async () => {
    const res = await fetch(`${JUP}/tokens/v1/${BONK}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Status ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return `name=${data.name}, symbol=${data.symbol}, tags=${data.tags?.join(',')}`;
  });

  await test('Tokens: search "meme"', async () => {
    const res = await fetch(`${JUP}/tokens/v1/search?query=meme&limit=3`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return `Found ${data.length} tokens`;
  });

  await test('Tokens V2: verified tokens', async () => {
    const res = await fetch(`${JUP}/tokens/v2/tag?query=verified`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return `${data.length} verified tokens`;
  });

  // ── 3. Jupiter Price API ──
  console.log('\n📡 Jupiter Price API');
  await test('Price: SOL price', async () => {
    const res = await fetch(`${JUP}/price/v2?ids=${SOL}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    const price = data.data?.[SOL]?.price;
    return `SOL = $${price}`;
  });

  await test('Price: BONK price', async () => {
    const res = await fetch(`${JUP}/price/v2?ids=${BONK}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    const price = data.data?.[BONK]?.price;
    return `BONK = $${price}`;
  });

  // ── 4. Jupiter Swap V2 ──
  console.log('\n📡 Jupiter Swap V2');
  await test('Swap V2: get order (SOL→USDC, no taker)', async () => {
    const params = new URLSearchParams({
      inputMint: SOL,
      outputMint: USDC,
      amount: '100000000', // 0.1 SOL
    });
    const res = await fetch(`${JUP}/swap/v2/order?${params}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Status ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    return `outAmount=${data.outAmount}, mode=${data.mode}, router=${data.router}`;
  });

  // ── 5. Jupiter Trigger API (limit orders) ──
  console.log('\n📡 Jupiter Trigger API');
  await test('Trigger: check endpoint availability', async () => {
    // Just check if the endpoint exists — don't create real orders
    const res = await fetch(`${JUP}/trigger/v1/orders?wallet=11111111111111111111111111111111`, { headers, signal: AbortSignal.timeout(5000) });
    return `Status ${res.status} (${res.ok ? 'available' : 'check needed'})`;
  });

  // ── 6. Jupiter Recurring API (DCA) ──
  console.log('\n📡 Jupiter Recurring API');
  await test('Recurring: check endpoint availability', async () => {
    const res = await fetch(`${JUP}/recurring/v1/orders?wallet=11111111111111111111111111111111`, { headers, signal: AbortSignal.timeout(5000) });
    return `Status ${res.status} (${res.ok ? 'available' : 'check needed'})`;
  });

  // ── 7. Combined: Shield scan + Jupiter data ──
  console.log('\n📡 Shield × Jupiter Combined');
  await test('Combined: scan BONK with Jupiter enhancement', async () => {
    // 1. RugCheck
    const rcRes = await fetch(`${RUGCHECK}/tokens/${BONK}/report/summary`, { signal: AbortSignal.timeout(6000) });
    const rc = rcRes.ok ? await rcRes.json() : null;

    // 2. Jupiter Tokens
    const jtRes = await fetch(`${JUP}/tokens/v1/${BONK}`, { headers, signal: AbortSignal.timeout(5000) });
    const jt = jtRes.ok ? await jtRes.json() : null;

    // 3. Jupiter Price  
    const jpRes = await fetch(`${JUP}/price/v2?ids=${BONK}`, { headers, signal: AbortSignal.timeout(5000) });
    const jp = jpRes.ok ? await jpRes.json() : null;

    // 4. Build score
    let score = 50;
    if (rc) {
      if (!rc.mintAuthority) score += 15;
      if (!rc.freezeAuthority) score += 10;
      if (rc.markets?.some(m => m.lp?.lpLocked)) score += 12;
    }
    if (jt?.tags?.includes('verified')) score += 5;

    score = Math.max(0, Math.min(100, score));
    const action = score >= 50 ? 'PROCEED' : score >= 30 ? 'WARN' : 'BLOCK';

    return `Score=${score}, Action=${action}, Jupiter verified=${jt?.tags?.includes('verified')}, Price=$${jp?.data?.[BONK]?.price}`;
  });

  // ── Results ──
  console.log('\n' + '═'.repeat(50));
  console.log(`\n⛨ RESULTS: ${passed} passed, ${failed} failed\n`);

  if (issues.length > 0) {
    console.log('ISSUES FOR DX REPORT:');
    issues.forEach(i => console.log(`  - ${i.name}: ${i.error}`));
  }

  console.log('\n📝 Now fill in DX-REPORT.md with these real results!');
  console.log('   Each ✅/❌ above = a data point for your report.\n');
}

run().catch(e => console.error('Fatal:', e));
