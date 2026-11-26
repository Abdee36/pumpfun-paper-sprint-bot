// Pump.fun Paper Sprint bot: launch sniper with a partial take-profit and a runner.
//
// Idea (from offline research on the kit's 24h dev window, 1222 coins):
// a fresh pump.fun coin's first seconds decide most of its fate. Big buys land in
// bursts inside the first few slots, and a bot that answers a batch can only fill
// two slots later, so chasing momentum after the burst is already too late. The
// only edge left at that latency is to be early and small: buy a launch in its
// first three slots, only when the launch looks organic (a small creator buy, few
// distinct early buyers, the creator not selling), flip half fast, and let the
// other half ride the rare runner. Everything else — momentum chasing, dip
// buying, riding coins toward completion — lost money on the dev window in
// backtests; this launch sniper was the only family near breakeven, with the
// smallest drawdown and the most coins traded.
//
// Entry (once per coin, in its first 3 slots after its CreateEvent):
//   - real SOL reserve between 1 and 30 SOL (liquid enough to exit, not a whale toy)
//   - creator's own buys total at most 2.5 SOL
//   - at most 3 distinct non-creator buyers so far (a launch bundled by many
//     wallets is a dump waiting to happen)
//   - the creator has not sold anything yet
//   - price run-up from the create price at most 10x (already-pumped is skipped)
//   - buy 0.05 SOL, but only when the per-reply size cap allows at least 0.02 SOL
//     (so every round trip clears the 0.01 SOL guardrail with margin)
//
// Exits, per position (liquidation value = what selling the tokens pays after the
// 95 + 30 bps curve fees, minus one tx fee; cost = SOL spent, fees included):
//   - take-profit 1 at +25%: sell a quarter of the tokens
//   - the rest rides and is pyramided: while it stays up at least +25%, add
//     0.05 SOL per batch up to 0.5 SOL in one coin, so a runner that goes 5-10x
//     is held with real size; sell it all at +100%, or on a trailing stop of
//     -30% from the best value once up at least +50%, or after 2000 slots held
//   - if take-profit 1 never hits: hard stop at -15%, or 10 slots held
//   - exit at once (whole position) when the creator sells while we hold
//
// Deterministic by construction: no clock, no Math.random, no environment reads.
// Every decision is a pure function of the hello / batch / orders / slot stream
// the harness sends, iterated only over insertion-ordered maps, so the two
// graded executions produce byte-identical action logs.

import { runBot, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---- tunables (SOL unless noted) ----
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per launch
const MIN_BUY_LAMPORTS = 20_000_000n; // never buy less: guardrail round trips need >= 0.01 SOL
const MAX_AGE_SLOTS = 3; // only buy a coin in its first 3 slots
const MIN_REAL_SOL = 1; // real SOL reserve at decision time
const MAX_REAL_SOL = 30;
const MAX_DEV_BUY_SOL = 2.5; // creator's own buys so far
const MAX_EARLY_BUYERS = 3; // distinct non-creator buyers so far
const MAX_RUNUP = 10; // price now / create price, at most
const TP1 = 0.25; // take-profit 1: sell a quarter, keep most of the position riding
const TP1_PART = 0.25;
const TP2 = 1.0; // take-profit 2: sell the rest
const STOP_LOSS = 0.15;
const TRAIL_ARM = 0.5; // trailing stop arms once up 50%
const TRAIL = 0.3; // sell the rest on a 30% fall from its best value
const HOLD_FAST = 10; // slots: exit if TP1 never hit
const HOLD_RUNNER = 2000; // slots: exit the runner at the latest
const PYRAMID_UP = 0.25; // add only while the position is up at least 25%
const PYRAMID_ADD_LAMPORTS = 50_000_000n; // 0.05 SOL per add
const MAX_PER_COIN_LAMPORTS = 500_000_000n; // at most 0.5 SOL invested in one coin
const MAX_SLIPPAGE_BPS = 10_000; // wide open: a launch buy must never fail on latency drift
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30

interface Launch {
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuyLamports: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
}

interface Held {
  openedSlot: number;
  peakRatio: number; // best liquidation value / cost seen
  tookTp1: boolean;
  investedLamports: bigint; // SOL put into this coin so far (buys only)
}

/** Liquidation value of `tokens` against (vq, vt), after curve fees and one tx fee, in SOL. */
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * CURVE_FEE_BPS + 10_000n - 1n) / 10_000n;
  const net = q - fee - txLamports;
  return Number(net) / 1e9;
}

export function createStrategy(): Bot {
  const launches = new Map<Pubkey, Launch>();
  const held = new Map<Pubkey, Held>();
  const boughtOnce = new Set<Pubkey>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
        else pendingBuy.add(po.order.mint);
      }

      // Fold this batch's events into the launch tape (hello -> batch -> orders -> slot).
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          launches.set(e.mint, {
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuyLamports: 0n,
            devSold: false,
            buyers: new Set<Pubkey>(),
          });
        } else if (e.event === 'TradeEvent') {
          const launch = launches.get(e.mint);
          if (launch === undefined) continue;
          if (e.user === launch.creator) {
            if (e.is_buy) launch.devBuyLamports += BigInt(e.sol_amount);
            else launch.devSold = true;
          } else if (e.is_buy) {
            launch.buyers.add(e.user);
          }
        }
      }

      // Exits first: never send a second sell while one is already in flight.
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingSell.has(mint)) continue;
        const h = held.get(mint);
        if (h === undefined) continue;
        const mark = batch.marks.find((m) => m.mint === mint);
        const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = BigInt(pos.token_amount);
        const value = sellValueSol(tokens, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / 1e9;
        const ratio = cost > 0 ? value / cost : 0;
        if (ratio > h.peakRatio) h.peakRatio = ratio;
        const age = batch.slot - h.openedSlot;
        const launch = launches.get(mint);

        // The creator selling while we hold is the rug signal: leave at once.
        if (launch !== undefined && launch.devSold) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
          continue;
        }
        if (!h.tookTp1) {
          if (ratio >= 1 + TP1) {
            const part = (tokens * BigInt(Math.round(TP1_PART * 10_000))) / 10_000n;
            if (part > 0n) orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: MAX_SLIPPAGE_BPS });
            h.tookTp1 = true;
            continue;
          }
          if (ratio <= 1 - STOP_LOSS || age > HOLD_FAST) {
            orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
          continue;
        }
        // Runner: TP2, trailing stop once armed, or the holding limit.
        const trailHit = h.peakRatio >= 1 + TRAIL_ARM && ratio <= h.peakRatio * (1 - TRAIL);
        if (ratio >= 1 + TP2 || trailHit || age > HOLD_RUNNER) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }

      // Pyramid adds: while a position is up and still running, keep building
      // it toward MAX_PER_COIN_LAMPORTS, one add per batch. Winners are where
      // the money is — a launch that runs 5-10x pays for dozens of small losers,
      // but only if the position is big when it runs. The trailing stop below
      // caps the give-back on a reversal.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingSell.has(mint) || pendingBuy.has(mint)) continue;
        const h = held.get(mint);
        if (h === undefined || !h.tookTp1) continue;
        if (h.investedLamports >= MAX_PER_COIN_LAMPORTS) continue;
        const mark = batch.marks.find((m) => m.mint === mint);
        const vq = mark !== undefined ? BigInt(mark.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mark !== undefined ? BigInt(mark.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = sellValueSol(BigInt(pos.token_amount), vq, vt, tx);
        const cost = Number(pos.cost_lamports) / 1e9;
        if (cost <= 0 || value / cost < 1 + PYRAMID_UP) continue;
        const cap = state.maxBuyLamports(mint);
        const room = MAX_PER_COIN_LAMPORTS - h.investedLamports;
        const amount = cap < PYRAMID_ADD_LAMPORTS ? cap : PYRAMID_ADD_LAMPORTS;
        const sized = amount < room ? amount : room;
        if (sized < MIN_BUY_LAMPORTS || free < sized + tx) continue;
        h.investedLamports += sized;
        orders.push({ side: 'buy', mint, quote_lamports: sized, max_slippage_bps: MAX_SLIPPAGE_BPS });
        free -= sized + tx;
      }

      // Drop tracking for positions that are gone (and no buy is in flight for them).
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !pendingBuy.has(mint)) held.delete(mint);
      }

      // Entries: only coins traded in this batch, youngest first by batch order.
      const tradedNow = new Set<Pubkey>();
      for (const e of batch.events) tradedNow.add(e.mint);
      for (const mint of tradedNow) {
        if (orders.length >= state.hello.caps.max_orders_per_batch || slotsLeft <= 0) break;
        if (boughtOnce.has(mint) || state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const launch = launches.get(mint);
        const curve = state.curves.get(mint);
        if (launch === undefined || curve === undefined || curve.complete) continue;
        if (batch.slot - launch.createSlot > MAX_AGE_SLOTS) continue;
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        if (rqSol < MIN_REAL_SOL || rqSol > MAX_REAL_SOL) continue;
        if (Number(launch.devBuyLamports) / 1e9 > MAX_DEV_BUY_SOL) continue;
        if (launch.devSold) continue;
        if (launch.buyers.size > MAX_EARLY_BUYERS) continue;
        const createPrice = launch.vt0 === 0n ? 0 : Number(launch.vq0) / Number(launch.vt0);
        const priceNow = curve.virtual_token_reserves === 0n ? 0 : Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (createPrice <= 0 || priceNow / createPrice > MAX_RUNUP) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        boughtOnce.add(mint);
        held.set(mint, { openedSlot: batch.slot, peakRatio: 1, tookTp1: false, investedLamports: amount });
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        free -= amount + tx;
        slotsLeft -= 1;
      }
      return orders;
    },
  };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('/main.ts')) {
  await runBot(createStrategy());
}
