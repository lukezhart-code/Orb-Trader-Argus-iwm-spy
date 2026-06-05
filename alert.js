var stateModule = require("../utils/state");
var trayd = require("../utils/trayd");

/*
  Webhook payload types:

  ORB set (fires at 9:35 AM ET close of first 5-min candle):
  { "ticker":"SPY", "event":"orb_set", "orb_high":532.50, "orb_low":530.00 }

  Every 5-min bar close:
  { "ticker":"SPY", "event":"bar_close", "close":533.10, "option_price":2.45 }

  Expected move hit — daily, weekly, or monthly:
  { "ticker":"SPY", "event":"expected_move_hit", "timeframe":"daily", "option_price":3.20 }
  { "ticker":"IWM", "event":"expected_move_hit", "timeframe":"weekly", "option_price":1.80 }
  { "ticker":"SPY", "event":"expected_move_hit", "timeframe":"monthly", "option_price":4.10 }
*/

async function handleAlert(payload) {
  stateModule.resetDay();
  var ticker = ((payload.ticker) || "").toUpperCase();
  var event = payload.event;
  if (!ticker || !event) throw new Error("Missing ticker or event");
  if (ticker !== "SPY" && ticker !== "IWM") throw new Error("Unknown ticker: " + ticker);

  // ── ORB Set (9:35 AM close)
  if (event === "orb_set") {
    if (!payload.orb_high || !payload.orb_low) throw new Error("orb_set requires orb_high and orb_low");
    stateModule.setORB(ticker, payload.orb_high, payload.orb_low);
    var orb = stateModule.getState().orb[ticker];
    return { ok: true, message: ticker + " ORB set High=" + orb.high + " Low=" + orb.low + " Mid=" + orb.mid };
  }

  // ── Expected move hit (daily / weekly / monthly) → sell 90%
  if (event === "expected_move_hit") {
    var timeframe = payload.timeframe || "daily";
    var pos = stateModule.getPosition(ticker);
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active position" };
    var qty = Math.floor(pos.contracts * 0.9);
    if (qty < 1) return { ok: true, message: ticker + " not enough contracts for 90% exit" };
    stateModule.logEvent("PROFIT_TIER_3", ticker + " " + timeframe + " expected move hit — selling 90% (" + qty + "c)");
    await trayd.closePartialPosition({ ticker: ticker, contracts: qty, reason: timeframe + " expected move 90% exit" });
    stateModule.markProfitTier(ticker, 300);
    return { ok: true, message: ticker + " 90% exit on " + timeframe + " expected move" };
  }

  // ── Bar close — main logic
  if (event === "bar_close") {
    if (!payload.close) throw new Error("bar_close requires close price");
    var close = parseFloat(payload.close);
    var optPrice = payload.option_price ? parseFloat(payload.option_price) : null;
    var s = stateModule.getState();
    var orb = s.orb[ticker];
    if (!orb.set) return { ok: true, message: ticker + " ORB not set yet" };
    var pos = stateModule.getPosition(ticker);

    // 1. Stop loss check
    if (pos && !pos.stopped && optPrice) {
      // Breakeven stop — if +50% was reached, stop = entry price
      if (pos.breakEvenActivated) {
        var beHit = (pos.side === "call" && optPrice <= pos.entryPrice) ||
                    (pos.side === "put"  && optPrice <= pos.entryPrice);
        if (beHit) {
          stateModule.logEvent("STOP_BREAKEVEN", ticker + " breakeven stop hit optPrice=" + optPrice + " entry=" + pos.entryPrice);
          await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "Breakeven stop" });
          stateModule.closePosition(ticker, "breakeven stop");
          return { ok: true, message: ticker + " closed at breakeven" };
        }
      }

      // Activate breakeven stop once +50% reached
      if (!pos.breakEvenActivated) {
        var gain50 = ((optPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (gain50 >= 50) {
          stateModule.setBreakEven(ticker);
        }
      }
    }

    // ORB midpoint stop (only if breakeven not yet active)
    if (pos && !pos.stopped && !pos.breakEvenActivated) {
      var midStopHit = (pos.side === "call" && close < orb.mid) ||
                       (pos.side === "put"  && close > orb.mid);
      if (midStopHit) {
        stateModule.logEvent("STOP_LOSS", ticker + " ORB midpoint stop close=" + close + " mid=" + orb.mid);
        await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB midpoint stop" });
        stateModule.closePosition(ticker, "ORB midpoint stop");
        return { ok: true, message: ticker + " stopped at ORB midpoint" };
      }
    }

    // 2. Profit tiers
    if (pos && !pos.stopped && optPrice && pos.entryPrice > 0) {
      var gainPct = ((optPrice - pos.entryPrice) / pos.entryPrice) * 100;
      var tier = pos.lastProfitTier;

      // Tier 1: every +20% → sell 10%
      var increments = Math.floor(gainPct / 20);
      if (increments > tier && gainPct < 100 && tier < 100) {
        var sell10 = Math.max(1, Math.floor(pos.contracts * 0.10));
        stateModule.logEvent("PROFIT_TIER_1", ticker + " +" + gainPct.toFixed(1) + "% selling 10% (" + sell10 + "c)");
        await trayd.closePartialPosition({ ticker: ticker, contracts: sell10, reason: "+20% tier sell 10%" });
        stateModule.markProfitTier(ticker, increments);
        return { ok: true, message: ticker + " +20% profit tier taken" };
      }

      // Tier 2: +100% → sell 50%
      if (gainPct >= 100 && tier < 100) {
        var sell50 = Math.max(1, Math.floor(pos.contracts * 0.50));
        stateModule.logEvent("PROFIT_TIER_2", ticker + " +100% selling 50% (" + sell50 + "c)");
        await trayd.closePartialPosition({ ticker: ticker, contracts: sell50, reason: "+100% sell 50%" });
        stateModule.markProfitTier(ticker, 100);
        return { ok: true, message: ticker + " +100% profit tier taken" };
      }
    }

    // 3. Retest add — second half
    if (pos && pos.halfIn && !pos.stopped) {
      var level = pos.side === "call" ? orb.high : orb.low;
      var pct = Math.abs(close - level) / level;
      var bouncing = (pos.side === "call" && close >= level * 0.999) ||
                     (pos.side === "put"  && close <= level * 1.001);
      if (pct <= 0.001 && bouncing) {
        var addQty = pos.totalContracts;
        stateModule.logEvent("RETEST", ticker + " retest @ " + close + " adding " + addQty + "c");
        await trayd.placeOrder({ ticker: ticker, side: pos.side, contracts: addQty });
        stateModule.addSecondHalf(ticker, addQty, optPrice || close);
        return { ok: true, message: ticker + " second half added on retest" };
      }
    }

    // 4. Initial entry (no limit on trades per day)
    if (!pos || pos.stopped) {
      var signal = null;
      if (close > orb.high) signal = "call";
      else if (close < orb.low) signal = "put";
      if (!signal) return { ok: true, message: ticker + " inside ORB, no signal" };

      var total = s.contracts[ticker];
      var half = Math.ceil(total / 2);
      stateModule.logEvent("ENTRY", ticker + " " + signal + " @ " + close + " half=" + half + "/" + total);
      var order = await trayd.placeOrder({ ticker: ticker, side: signal, contracts: half });
      stateModule.openHalfPosition(ticker, signal, half, optPrice || close);

      // Cross-entry: IWM breaks before SPY
      var cross = null;
      var spyPos = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos || spyPos.stopped) && s.orb.SPY.set) {
        var spyORB = s.orb.SPY;
        var spyHalf = Math.ceil(s.contracts.SPY / 2);
        var stop = signal === "call" ? spyORB.low : spyORB.high;
        stateModule.logEvent("CROSS_ENTRY", "IWM broke " + signal + " → SPY half=" + spyHalf + " stop=" + stop);
        cross = await trayd.placeOrder({ ticker: "SPY", side: signal, contracts: spyHalf });
        stateModule.openHalfPosition("SPY", signal, spyHalf, null);
      }
      return { ok: true, entry: order, cross: cross };
    }

    return { ok: true, message: ticker + " no action this bar" };
  }

  throw new Error("Unknown event: " + event);
}

module.exports = { handleAlert: handleAlert };
