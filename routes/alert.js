var stateModule = require("../utils/state");
var trayd = require("../utils/trayd");
var fs = require("fs");

function logTradePnL(ticker, side, entryPrice, exitPrice, contracts) {
  try {
    var pnlFile = "/tmp/orb-pnl.json";
    var data = { trades: [] };
    if (fs.existsSync(pnlFile)) data = JSON.parse(fs.readFileSync(pnlFile, "utf8"));
    var pnl = (parseFloat(exitPrice) - parseFloat(entryPrice)) * contracts * 100;
    data.trades.push({ time: new Date().toISOString(), ticker, side, entryPrice, exitPrice, contracts, pnl });
    var yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    data.trades = data.trades.filter(function(t) { return new Date(t.time) >= yearAgo; });
    fs.writeFileSync(pnlFile, JSON.stringify(data));
  } catch(e) { console.log("[PNL_ERROR]", e.message); }
}

/*
  Pine Script sends these webhook messages:
  {"ticker":"SPY","event":"orb_set"}           — 9:35 AM first candle closes
  {"ticker":"SPY","event":"breakout_long"}      — 5-min bar closes above ORB high
  {"ticker":"SPY","event":"breakout_short"}     — 5-min bar closes below ORB low
  {"ticker":"SPY","event":"stop_long"}          — 5-min bar closes below ORB mid (long stop)
  {"ticker":"SPY","event":"stop_short"}         — 5-min bar closes above ORB mid (short stop)

  Optional fields (if available):
  orb_high, orb_low, close, option_price
*/

async function handleAlert(payload) {
  stateModule.resetDay();
  var ticker = ((payload.ticker) || "").toUpperCase();
  var event  = (payload.event || "").toLowerCase();

  if (!ticker || !event) throw new Error("Missing ticker or event");
  if (ticker !== "SPY" && ticker !== "IWM") throw new Error("Unknown ticker: " + ticker);

  var s        = stateModule.getState();
  var pos      = stateModule.getPosition(ticker);
  var optPrice = payload.option_price ? parseFloat(payload.option_price) : null;
  var close    = payload.close ? parseFloat(payload.close) : null;
  var orbHigh  = payload.orb_high ? parseFloat(payload.orb_high) : null;
  var orbLow   = payload.orb_low  ? parseFloat(payload.orb_low)  : null;

  // ── ORB SET ───────────────────────────────────────────────────────────────
  if (event === "orb_set") {
    if (orbHigh && orbLow) {
      stateModule.setORB(ticker, orbHigh, orbLow);
      var orb = stateModule.getState().orb[ticker];
      stateModule.logEvent("ORB_SET", ticker + " High=" + orb.high + " Low=" + orb.low + " Mid=" + orb.mid);
    } else {
      // Mark ORB as set even without levels — server will use chart data
      stateModule.logEvent("ORB_SET", ticker + " ORB candle closed — waiting for breakout");
    }
    return { ok: true, message: ticker + " ORB set" };
  }

  // ── STOP LOSS — LONG (close below mid) ───────────────────────────────────
  if (event === "stop_long") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active long position" };
    if (pos.side !== "call") return { ok: true, message: ticker + " position is not a call" };
    stateModule.logEvent("STOP_LOSS", ticker + " ORB midpoint stop hit — closing long");
    await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB midpoint stop" });
    if (optPrice) logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
    stateModule.closePosition(ticker, "ORB midpoint stop");
    return { ok: true, message: ticker + " long stopped at ORB midpoint" };
  }

  // ── STOP LOSS — SHORT (close above mid) ──────────────────────────────────
  if (event === "stop_short") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active short position" };
    if (pos.side !== "put") return { ok: true, message: ticker + " position is not a put" };
    stateModule.logEvent("STOP_LOSS", ticker + " ORB midpoint stop hit — closing short");
    await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB midpoint stop" });
    if (optPrice) logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
    stateModule.closePosition(ticker, "ORB midpoint stop");
    return { ok: true, message: ticker + " short stopped at ORB midpoint" };
  }

  // ── BREAKOUT LONG — Buy Call ──────────────────────────────────────────────
  if (event === "breakout_long") {
    var total = s.contracts[ticker];
    var half  = Math.ceil(total / 2);

    // If we have a short position open, close it first
    if (pos && !pos.stopped && pos.side === "put") {
      stateModule.logEvent("FLIP", ticker + " breakout long — closing put first");
      await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB breakout flip to long" });
      if (optPrice) logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
      stateModule.closePosition(ticker, "flip to long");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " call @ breakout_long half=" + half + "/" + total);
      var order = await trayd.placeOrder({ ticker: ticker, side: "call", contracts: half });
      stateModule.openHalfPosition(ticker, "call", half, optPrice || close || 0);

      // Cross-entry: IWM breaks before SPY
      var cross = null;
      var spyPos = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos || spyPos.stopped) && s.orb.SPY.set) {
        var spyHalf = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM breakout long → entering SPY call half=" + spyHalf);
        cross = await trayd.placeOrder({ ticker: "SPY", side: "call", contracts: spyHalf });
        stateModule.openHalfPosition("SPY", "call", spyHalf, null);
      }
      return { ok: true, entry: order, cross: cross };
    }

    // Already in a long — check for retest add
    if (pos.halfIn && !pos.stopped) {
      var addQty = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty + "c");
      await trayd.placeOrder({ ticker: ticker, side: "call", contracts: addQty });
      stateModule.addSecondHalf(ticker, addQty, optPrice || close || pos.entryPrice);
      return { ok: true, message: ticker + " second half added on retest" };
    }

    return { ok: true, message: ticker + " already in long position" };
  }

  // ── BREAKOUT SHORT — Buy Put ──────────────────────────────────────────────
  if (event === "breakout_short") {
    var total2 = s.contracts[ticker];
    var half2  = Math.ceil(total2 / 2);

    // If we have a long position open, close it first
    if (pos && !pos.stopped && pos.side === "call") {
      stateModule.logEvent("FLIP", ticker + " breakout short — closing call first");
      await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB breakout flip to short" });
      if (optPrice) logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
      stateModule.closePosition(ticker, "flip to short");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " put @ breakout_short half=" + half2 + "/" + total2);
      var order2 = await trayd.placeOrder({ ticker: ticker, side: "put", contracts: half2 });
      stateModule.openHalfPosition(ticker, "put", half2, optPrice || close || 0);

      // Cross-entry: IWM breaks before SPY
      var cross2 = null;
      var spyPos2 = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos2 || spyPos2.stopped) && s.orb.SPY.set) {
        var spyHalf2 = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM breakout short → entering SPY put half=" + spyHalf2);
        cross2 = await trayd.placeOrder({ ticker: "SPY", side: "put", contracts: spyHalf2 });
        stateModule.openHalfPosition("SPY", "put", spyHalf2, null);
      }
      return { ok: true, entry: order2, cross: cross2 };
    }

    // Already in a short — check for retest add
    if (pos.halfIn && !pos.stopped) {
      var addQty2 = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty2 + "c");
      await trayd.placeOrder({ ticker: ticker, side: "put", contracts: addQty2 });
      stateModule.addSecondHalf(ticker, addQty2, optPrice || close || pos.entryPrice);
      return { ok: true, message: ticker + " second half added on retest" };
    }

    return { ok: true, message: ticker + " already in short position" };
  }

  // ── BAR CLOSE — profit tier checks (optional, if sent) ───────────────────
  if (event === "bar_close") {
    if (!pos || pos.stopped || !optPrice || pos.entryPrice <= 0) {
      return { ok: true, message: ticker + " no action on bar_close" };
    }

    var gainPct = ((optPrice - pos.entryPrice) / pos.entryPrice) * 100;
    var tier = pos.lastProfitTier;

    // Activate breakeven stop at +50%
    if (!pos.breakEvenActivated && gainPct >= 50) {
      stateModule.setBreakEven(ticker);
      stateModule.logEvent("BREAKEVEN", ticker + " +50% — stop moved to breakeven");
    }

    // Every +20% → sell 10%
    var increments = Math.floor(gainPct / 20);
    if (increments > tier && gainPct < 100 && tier < 100) {
      var sell10 = Math.max(1, Math.floor(pos.contracts * 0.10));
      stateModule.logEvent("PROFIT_TIER_1", ticker + " +" + gainPct.toFixed(1) + "% selling 10% (" + sell10 + "c)");
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell10, reason: "+20% tier sell 10%" });
      stateModule.markProfitTier(ticker, increments);
      return { ok: true, message: ticker + " +20% profit tier" };
    }

    // +100% → sell 50%
    if (gainPct >= 100 && tier < 100) {
      var sell50 = Math.max(1, Math.floor(pos.contracts * 0.50));
      stateModule.logEvent("PROFIT_TIER_2", ticker + " +100% selling 50% (" + sell50 + "c)");
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell50, reason: "+100% sell 50%" });
      stateModule.markProfitTier(ticker, 100);
      return { ok: true, message: ticker + " +100% profit tier" };
    }

    return { ok: true, message: ticker + " bar_close processed" };
  }

  // ── EXPECTED MOVE HIT ─────────────────────────────────────────────────────
  if (event === "expected_move_hit") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active position" };
    var timeframe = payload.timeframe || "daily";
    var qty90 = Math.floor(pos.contracts * 0.9);
    if (qty90 < 1) return { ok: true, message: ticker + " not enough contracts" };
    stateModule.logEvent("PROFIT_TIER_3", ticker + " " + timeframe + " expected move — selling 90% (" + qty90 + "c)");
    await trayd.closePartialPosition({ ticker: ticker, contracts: qty90, reason: timeframe + " expected move 90% exit" });
    stateModule.markProfitTier(ticker, 300);
    return { ok: true, message: ticker + " 90% exit on expected move" };
  }

  throw new Error("Unknown event: " + event);
}

module.exports = { handleAlert: handleAlert };
