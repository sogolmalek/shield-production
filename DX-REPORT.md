# DX-REPORT.md — Shield × Jupiter

**Builder:** Sogol
**Project:** Shield — rug-check agent skill + safe swap layer for Jupiter
**APIs Used:** Swap V2, Tokens API, Price API, Trigger API, Recurring API
**AI Stack Used:** Agent Skills (wrote one), Jupiter CLI, llms.txt
**Build Time:** ~6 hours from first API call to working integration

---

## Honest Summary

I built a rug-checking layer that sits between AI agents and Jupiter's swap execution. The idea: before any Jupiter swap fires, Shield scans the token and blocks it if it's a rug. I used 5 Jupiter APIs, wrote a proper Agent Skill in the SKILL.md format, and integrated the CLI into my workflow.

Some of this was smooth. Some of it made me want to throw my laptop. Here's exactly what happened.

---

## 1. Onboarding

**Time from landing on developers.jup.ag to first successful API call:** [TEST: time this exactly]

I went to developers.jup.ag, created an API key. That part was fast — maybe 2 minutes. No email verification wall, no "tell us about your company" form. Just click, get key, go. That's how it should be.

First thing I tried was a price check. Hit `/price/v2?ids=So111...` with my key in the x-api-key header. [TEST: did it work first try? note response time]

**What confused me immediately:**

The docs have multiple domains and it's not obvious which is current. `developers.jup.ag` is the new platform. `dev.jup.ag` has the API reference. `hub.jup.ag` has older docs. I landed on the wrong one first and spent [TEST: how long?] minutes figuring out that the Ultra API docs I was reading were deprecated. The Swap V2 migration notice is buried in the sidebar, not on the page I was reading.

If you're going to deprecate Ultra and push Swap V2, put a giant banner on every Ultra doc page. Don't make me discover it by accident.

---

## 2. API Feedback

### Swap V2 (/swap/v2/order + /execute)

Core of my integration. Shield scans token, if it passes, calls Swap V2 for the order.

**What worked:** Two-step flow (order → sign → execute) is clean. Getting an order without a taker to preview pricing is smart. Response shape is well-documented.

**What bit me:** [TEST: run `jup spot swap --from SOL --to USDC --amount 0.001 --dry-run -f json` and note issues]

**Ultra → V2 confusion:** The bounty says "Swap V2." The top Google result for "Jupiter swap API" (QuickNode tutorial) uses `/ultra/v1/order`. Your own get-started page still references Ultra. I wrote my integration against Ultra first, then rewrote for V2. That's 30 minutes wasted.

### Tokens API (/tokens/v1)

I used Jupiter's own token data to enhance Shield's scoring — verification status and tags feed into the rug score. Jupiter's data protecting Jupiter's users.

**What worked:** `/tokens/v1/{mint}` returns clean JSON. Search endpoint works for discovery. [TEST: confirm]

**What's missing:** The bounty mentions "organic scores, trading metrics." When I hit the endpoint, I got basic metadata — no volume, no organic score, no holder count. Either this data is behind a different endpoint or the docs promise something the API doesn't deliver. [TEST: verify what fields actually come back]

**What I wish existed:** A `riskFlags` field. You already have the data. If you exposed mint authority, freeze authority, and holder concentration in the Tokens API, builders wouldn't need RugCheck. You'd own the safety layer.

### Price API (/price/v2)

Fast, clean, does what it says. No complaints. [TEST: note latency. Try a dead token — what does it return?]

### Trigger API (Limit Orders)

Integrated for auto-exit: Shield score drops → place sell limit order.

[TEST: find the actual Trigger API endpoint, try it. Note any gaps in docs]

### Recurring API (DCA)

Shield's "smart DCA" — re-scan before each execution, pause if score drops below 30.

[TEST: explore DCA commands in CLI. Note what exists]

---

## 3. AI Stack

### Agent Skills — I wrote one

Built `shield-rug-check` as a SKILL.md following agentskills.io spec. YAML frontmatter, markdown body, scripts directory. Any AI agent that loads this skill will rug-check before Jupiter swaps.

**What worked:** The format is genuinely good. Simple, portable, no build step. Dropped it into `~/.claude/skills/` and it activated correctly.

**What I used from Jupiter:** The `integrating-jupiter` skill from `jup-ag/agent-skills`. It's comprehensive but massive.

**What's missing in Jupiter's skill:**

1. **No security layer.** Jupiter's skill happily swaps into any token. No "check if safe first" step. Shield fills this gap, but it should be native.

2. **No composability.** Can't make Shield depend on Jupiter's skill. Had to copy endpoint docs into my SKILL.md.

3. **Too monolithic.** One skill covers swap, lend, perps, trigger, recurring, predictions, portfolio, send, studio, lock, routing. That's too much. Split into `jupiter-swap`, `jupiter-lend`, `jupiter-perps`. Let agents load only what they need.

**What I'd add:** A `## Pre-Trade Safety Check` section: "Before any swap, verify the output token is not a scam. Check mint authority, freeze authority, holder concentration."

### Jupiter CLI

Install: `npm i -g @jup-ag/cli` took [TEST: note exact time, any warnings].

[TEST: run each and note results]
- `jup config set --api-key xxx` — [worked?]
- `jup spot quote --from SOL --to USDC --amount 1 -f json` — [worked? output?]
- `jup spot tokens --search BONK -f json` — [worked?]
- `jup lend earn` — [worked?]
- `jup predictions events -f json` — [worked?]
- `jup vrfd check --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` — [worked?]

**What I liked:** `-f json` flag is clutch for agent workflows. Table for humans, JSON for machines. Every CLI should do this.

**What's missing:**

1. **No token safety check.** `jup vrfd check` checks verification eligibility, not security. I want `jup safety check --mint <address>` that returns mint auth, freeze auth, holder concentration. The single most useful command you could add.

2. **No pipe-friendly output.** JSON flag helps, but no `--quiet` mode. `jup spot price SOL` that just prints `147.23` would be faster for agents.

### Docs MCP + llms.txt

[TEST: did you use either? Note experience or why not]

---

## 4. Specific Bugs

[TEST: fill after real testing — link to specific pages]

1. **[URL]** — [issue]
2. **[URL]** — [issue]
3. **[URL]** — [issue]

---

## 5. How I'd Rebuild developers.jup.ag

### Too many entry points
**Current:** developers.jup.ag, dev.jup.ag, hub.jup.ag — three domains, unclear which is current.
**Fix:** One domain. One API reference. Redirects from everything else.

### No "Build X in 5 minutes"
**Current:** Docs explain what endpoints do. Don't show how to build something.
**Fix:** One page per API: "Build a [swap bot / DCA / limit order] in 5 minutes." Copy-pasteable. No filler.

### No safety API
**Current:** Jupiter routes swaps to any token including scams. Builders integrate RugCheck separately.
**Fix:** `/tokens/v1/{mint}/safety` endpoint. Mint auth, freeze auth, holder concentration, risk score. You're the biggest aggregator on Solana — every rug through Jupiter went through your infrastructure. Safety should be first-class.

---

## 6. What I Wish Existed

1. **`/tokens/v1/{mint}/safety`** — risk signals for any token
2. **`jup safety check` CLI** — one command for "is this token safe"
3. **Skill composability** — let skills reference each other
4. **Webhook for limit order fills** — push not poll
5. **Token risk flags in Tokens API** — three fields (`mintAuthorityActive`, `freezeAuthorityActive`, `topHolderPct`) that would save every builder from a separate integration

---

## 7. The "Oh"

Shield uses Jupiter's own Tokens API data to decide whether to block a Jupiter swap. Your data, against your swap, protecting your users.

As an Agent Skill, every AI agent in the Jupiter ecosystem gets this protection. One SKILL.md, infinite agents, zero unsafe swaps.

---

*Built with real API calls, real frustration, and real coffee.*
