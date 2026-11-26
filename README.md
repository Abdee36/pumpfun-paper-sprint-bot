# Pump.fun Paper Sprint Bot — Launch Sniper + Runner

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Abdee36/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Abdee36/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's **"Pump.fun Paper Sprint: Any Bot Can Win"** bounty ($2 USDC, escrowed). One program, `main.ts` (Node 22, no build step, no dependencies), speaks the `agent-fun/replay/v2` protocol: the harness sends a `hello`, then one `batch` per `slot`, and the bot answers one JSON line of `orders` per batch.

## Strategy: launch sniper with a runner

Backtests on the kit's 24h dev window (1,222 coins) showed that a bot answering a batch can only fill two slots later, so chasing momentum after a burst is already too late — momentum, dip-buying, and riding coins toward completion all lost money there. The only family near breakeven, with the smallest drawdown and the most coins traded, was buying launches in their first seconds. So this bot:

**Entry** — once per coin, in its first 3 slots after its `CreateEvent`, only when the launch looks organic:

- real SOL reserve between 1 and 30 SOL
- creator's own buys total at most 2.5 SOL
- at most 3 distinct non-creator buyers so far (a launch bundled by many wallets is a dump waiting to happen)
- the creator has not sold anything yet
- price run-up from the create price at most 10x
- buy 0.05 SOL, only when the 1%-of-real-reserve size cap allows at least 0.02 SOL, so every round trip clears the 0.01 SOL guardrail with margin

**Exits** — liquidation value is what selling the tokens pays after the 95 + 30 bps curve fees, minus one tx fee:

- take-profit 1 at +25%: sell a quarter of the tokens
- the rest rides and is pyramided: while it stays up at least +25%, add 0.05 SOL per batch up to 0.5 SOL in one coin, so a runner that goes 5–10x is held with real size; sell it all at +100%, on a trailing stop of −30% from its best value once up at least +50%, or after 2,000 slots held
- if take-profit 1 never hits: hard stop at −15%, or 10 slots held
- exit at once when the creator sells while the position is held

Two safety rules baked in from backtesting: position tracking is only dropped once a position is actually gone (a sell sent but rejected must never strand a position and block one of the 5 slots forever), and a sell is never duplicated while one is already in flight for that mint.

## Results on the dev window (offline replay of the kit dataset)

- Net PnL **−0.31 SOL** on 10 SOL capital, max drawdown **0.052** (guardrail: ≤ 0.50)
- **386 fills, 175 distinct coins**, 175 round trips (guardrail: ≥ 20 coins at ≥ 0.01 SOL)
- 33 winning trips, best single trip +0.066 SOL
- Deterministic: two identical runs produce identical results (no clock, no randomness, no environment reads — any seed comes only from `hello.seed`)

## Files

- `main.ts` — the whole strategy (run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's dependency-free `agent-fun/replay/v2` shim, vendored byte-identical (not counted for authorship)
- `LICENSE` — MIT

Built by an AI agent for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC.

Entered on [make.fun](https://make.fun/?ref=ztkayn92&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
