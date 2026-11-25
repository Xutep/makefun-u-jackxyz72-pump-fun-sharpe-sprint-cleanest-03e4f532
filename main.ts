// Steady Scalper — a paper-trading bot for the pump.fun Sharpe sprint.
//
// Idea: Sharpe (hourly) rewards steady, controlled gains, not one lucky
// moonshot. So this bot scalps many small, similar-sized round trips on
// freshly created pump.fun coins and exits fast, with tight rules:
//
//   * Buy only a coin that is brand new, already shows early buying
//     momentum (price up a few percent since its CreateEvent, on real
//     trades), has not already run far, and is nowhere near completing
//     its curve. One small fixed stake per coin, never averaging down.
//   * Sell on a trailing stop once a trade is in profit (armed at +10%,
//     exit on a 10% pullback from the peak, with a +50% safety cap), a
//     tight stop-loss at -6%, or a stale exit that frees the slot when a
//     coin goes nowhere. Letting winners run is what pays for the many
//     small losers: capping gains low would cap the upside that funds
//     the whole book. Every exit is a full sell, so each coin is at most
//     one round trip and the per-trade outcome stays bounded.
//   * At most 5 open positions (the harness cap), so variance stays low
//     and the bot keeps turning coins over to clear the 20-round-trip
//     minimum with room to spare.
//
// Everything is deterministic: every decision is a pure function of the
// hello message and the batches the harness sends (no clock, no random
// source, no network). Two runs on the same data answer byte for byte
// alike, which is what the replay harness requires.
//
// Fees shape the sizes: a buy and a sell together cost about 2.5% of the
// stake in curve fees plus two transaction fees, so the stake (0.04 SOL),
// the +8% momentum entry filter and the exits (trailing stop armed at
// +10%, stop-loss at -6%) are chosen so a winning round trip clears its
// costs several times over while a losing one stays small.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL spent on each buy (0.04 SOL). */
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 4n) / 100n;
/** Smallest buy worth placing: the round-trip minimum is 0.01 SOL. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Only buy while the size cap lets us place at least this much. */
const MIN_CAP_LAMPORTS = (LAMPORTS_PER_SOL * 2n) / 100n;
/** Trades a coin must have printed before it can be bought. */
const MIN_TRADES_TO_BUY = 4;
/** Buy only if the price is up at least this much since first seen. */
const MIN_MOMENTUM = 0.08;
/** Never chase a coin already up more than this since first seen. */
const MAX_CHASE = 0.60;
/** Never buy a coin whose real SOL reserve is already this large. */
const MAX_REAL_SOL_LAMPORTS = 30n * LAMPORTS_PER_SOL;
/** Take profit: a high safety cap; the trailing stop does the real work. */
const TAKE_PROFIT = 0.50;
/** Stop loss: sell when the price is down this much on entry. */
const STOP_LOSS = 0.06;
/** Arm the trailing stop once the price is up this much on entry. */
const TRAIL_ARM = 0.10;
/** ...then sell when the price falls this much from its peak. */
const TRAIL_DROP = 0.10;
/** Stale exit: after this many slots, leave if barely above entry. */
const STALE_SLOTS = 1800;
/** ...the price must be at least this far above entry to keep holding. */
const STALE_KEEP = 0.01;
/** Slippage allowance on buys and sells (10%). */
const MAX_SLIPPAGE_BPS = 1000;

// ------------------------------------------------------------------ helpers

/** SOL per token from a curve's virtual reserves (0 when unknown). */
function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const tokens = Number(curve.virtual_token_reserves);
  const quote = Number(curve.virtual_quote_reserves);
  if (tokens <= 0 || quote <= 0) return 0;
  return quote / tokens;
}

/** Mints with a buy or a sell still in flight (not yet in a fill). */
function pendingMints(state: BotState, side: 'buy' | 'sell'): Set<string> {
  const out = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === side) out.add(p.order.mint);
  }
  return out;
}

// ------------------------------------------------------------------ tracking

interface CoinWatch {
  /** Price when the coin was first seen. */
  firstPrice: number;
  /** Trades seen when the coin was first seen. */
  firstTrades: number;
  /** Price at the moment our buy filled. */
  entryPrice: number;
  /** Highest price seen since the buy filled. */
  peakPrice: number;
  /** Slot our buy was decided on. */
  entrySlot: number;
  /** True once a buy has been sent for this coin (never buy twice). */
  bought: boolean;
  /** True once a sell has been sent for this coin. */
  selling: boolean;
}

const watched = new Map<string, CoinWatch>();

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const pendingBuys = pendingMints(state, 'buy');
    const pendingSells = pendingMints(state, 'sell');

    // Register new coins and refresh the watches of coins we hold.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!watched.has(e.mint)) {
          watched.set(e.mint, {
            firstPrice: 0,
            firstTrades: 0,
            entryPrice: 0,
            peakPrice: 0,
            entrySlot: 0,
            bought: false,
            selling: false,
          });
        }
      } else if (e.event === 'CompleteEvent') {
        // The harness closes the position itself; forget the coin.
        watched.delete(e.mint);
      }
    }

    // Seed firstPrice on the first batch where a price is observable.
    for (const [mint, w] of watched) {
      if (w.firstPrice === 0) {
        const p = priceOf(state, mint);
        if (p > 0) {
          w.firstPrice = p;
          const curve = state.curves.get(mint);
          w.firstTrades = curve === undefined ? 0 : curve.trades;
        }
      }
    }

    // --- sells first: free slots and lock in outcomes before buying more.
    for (const [mint, holding] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const w = watched.get(mint);
      const price = priceOf(state, mint);
      if (w === undefined || price <= 0) continue;
      // The buy fill lands a couple of slots after the decision; the
      // account shows the position first, so record the entry then.
      if (w.entryPrice === 0) {
        w.entryPrice = price;
        w.peakPrice = price;
        w.entrySlot = state.slot;
        continue;
      }
      if (price > w.peakPrice) w.peakPrice = price;
      const gain = price / w.entryPrice - 1;
      const fromPeak = price / w.peakPrice - 1;
      const heldSlots = state.slot - w.entrySlot;
      const takeProfit = gain >= TAKE_PROFIT;
      const stopLoss = gain <= -STOP_LOSS;
      const trailing = w.peakPrice >= w.entryPrice * (1 + TRAIL_ARM) && fromPeak <= -TRAIL_DROP;
      const stale = heldSlots >= STALE_SLOTS && gain < STALE_KEEP;
      if (takeProfit || stopLoss || trailing || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        } as SellInput);
        w.selling = true;
      }
    }

    // --- buys: one small stake per fresh coin with early momentum.
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      const w = watched.get(mint);
      if (w === undefined || w.bought || w.selling) continue;
      if (pendingBuys.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.trades - w.firstTrades < MIN_TRADES_TO_BUY) continue;
      if (curve.real_quote_reserves > MAX_REAL_SOL_LAMPORTS) continue;
      const price = priceOf(state, mint);
      if (price <= 0 || w.firstPrice <= 0) continue;
      const move = price / w.firstPrice - 1;
      if (move < MIN_MOMENTUM || move > MAX_CHASE) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_CAP_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (slots <= 0 || free < amount + txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      } as BuyInput);
      w.bought = true;
      free -= amount + txFee;
      slots -= 1;
    }

    return orders;
  },
});
