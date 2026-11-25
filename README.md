[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Xutep/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Xutep/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Steady Scalper — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun. It trades paper SOL on a 6-hour pump.fun replay; places go by hourly Sharpe ratio, so steady, controlled gains beat one lucky moonshot.

## Strategy

- **Buy small, buy fresh:** one fixed 0.04 SOL stake per coin, only on coins just created that already show early buying momentum (price up ≥4% since creation on real trades), that have not already run far (≤40%), and that are nowhere near completing their curve.
- **Exit fast, exit fully:** take-profit at +12%, stop-loss at −8%, a trailing stop once a trade is +6% in profit, and a stale exit that frees the slot when a coin goes nowhere. Every exit sells the whole position, so each coin is at most one bounded round trip.
- **Stay diversified and turning over:** at most 5 open positions, so the bot keeps cycling through fresh coins and clears the 20-round-trip minimum with room to spare.

Everything is deterministic — every decision is a pure function of the `hello` message and the `batch` messages the harness sends, with no clock, no randomness and no network — so two runs on the same data answer byte for byte alike, as the replay harness requires.

## Layout

- `main.ts` — the bot (Node 22, TypeScript, stdlib only). Run by the grader as `node main.ts`.
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, vendored byte-identical from the competition kit (`sdk/ts/makefun-bot.ts`).
- `LICENSE` — MIT.

## Play

Try make.fun with referral code `ws5xj46w`: https://make.fun/r/ws5xj46w
