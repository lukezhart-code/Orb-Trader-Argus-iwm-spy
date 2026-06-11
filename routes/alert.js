var stateModule = require("../utils/state");
var trayd = require("../utils/trayd");
var orbUtil = require("../utils/orb");
var fs = require("fs");

// Discord is personal-only. require() is optional so the customer build
// (which ships no discord.js) is unaffected. All calls are fire-and-forget
// and fully swallowed so a Discord hiccup can never break order flow.
var discord = null;
try { discord = require("../utils/discord"); } catch (e) { discord = null; }
async function notify(fn, args) {
  try {
    if (discord && typeof discord[fn] === "function") await discord[fn].apply(null, args);
  } catch (e) { console.log("[DISCORD_NOTIFY_ERROR] " + fn + ": " + e.message); }
}
function fillPriceOf(order, fallback) {
  var p = order && order.result && order.result.price ? parseFloat(order.result.price) : NaN;
  return isNaN(p) ? (fallback || 0) : p;
}

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

/* ──────────────────────────────────────────────────────────────────────────
   DUPLICATE-SIGNAL PROTECTION
   Root cause of repeated buying: position state was written AFTER an
   awaited order placement (3-8s). Concurrent/retried webhooks all read
   pos=null during that window and each fired a fresh entry.

   Two guards, both evaluated SYNCHRONOUSLY before any await:
     1. processing[ticker]  — in-flight lock; a duplicate that arrives while
        an order is still being placed is dropped immediately.
     2. lastSignal[key]     — cooldown; identical ticker+event within
        DEDUP_WINDOW_MS is dropped. 30s absorbs TradingView retry storms
        (~5s apart) while staying far below a genuine retest (>=5 min).
   ────────────────────────────────────────────────────────────────────────── */
var DEDUP_WINDOW_MS = parseInt(process.env.ORB_DEDUP_MS, 10) || 30000;
var lastSignal = {};   // key "TICKER:event" -> epoch ms
var processing = {};   // "TICKER" -> bool (order in flight)

// Returns ms elapsed since the last identical signal if still inside the
// cooldown window (always > 0 when blocked); otherwise records now and returns 0.
function recentlySeen(ticker, event) {
  var key = ticker + ":" + event;
  var now = Date.now();
  if (lastSignal[key] && (now - lastSignal[key]) < DEDUP_WINDOW_MS) {
    return (now - lastSignal[key]) || 1;
  }
  lastSignal[key] = now;
  return 0;
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

  // Trade-placing events get duplicate protection. orb_set / informational do not.
  var TRADE_EVENTS = ["breakout_long", "breakout_short", "stop_long", "stop_short", "expected_move_hit"];
  var guarded = TRADE_EVENTS.indexOf(event) !== -1;
  var lockedTickers = [];

  if (guarded) {
    if (processing[ticker]) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — order already in progress");
      return { ok: true, deduped: true, message: ticker + " " + event + " ignored (in progress)" };
    }
    var ago = recentlySeen(ticker, event);
    if (ago > 0) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — duplicate " + Math.round(ago / 1000) + "s ago");
      return { ok: true, deduped: true, message: ticker + " " + event + " duplicate ignored (" + Math.round(ago / 1000) + "s)" };
    }
    processing[ticker] = true;
    lockedTickers.push(ticker);
  }

  try {
    return await processEvent(payload, ticker, event, lockedTickers);
  } finally {
    lockedTickers.forEach(function(t) { processing[t] = false; });
  }
}

async function processEvent(payload, ticker, event, lockedTickers) {
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
      return { ok: true, message: ticker + " ORB set (from payload)" };
    }
    // No levels in payload — fetch the opening range ourselves so the
    // dashboard populates and cross-entry arms.
    var range = await orbUtil.fetchOpeningRange(ticker);
    if (range && range.high && range.low) {
      stateModule.setORB(ticker, range.high, range.low);
      return { ok: true, message: ticker + " ORB set (fetched)" };
    }
    stateModule.logEvent("ORB_SET", ticker + " ORB candle closed — levels unavailable, waiting for breakout");
    return { ok: true, message: ticker + " ORB set (no levels)" };
  }

  // ── STOP LOSS — LONG (close below mid) ───────────────────────────────────
  if (event === "stop_long") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active long position" };
    if (pos.side !== "call") return { ok: true, message: ticker + " position is not a call" };
    stateModule.logEvent("STOP_LOSS", ticker + " ORB midpoint stop hit — closing long");
    await notify("postStopLoss", [ticker, optPrice || 0, "Stop — ORB Midpoint"]);
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
    await notify("postStopLoss", [ticker, optPrice || 0, "Stop — ORB Midpoint"]);
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
      await notify("postFullClose", [ticker, optPrice || 0]);
      await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB breakout flip to long" });
      if (optPrice) logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
      stateModule.closePosition(ticker, "flip to long");
      pos = null;
    }

    if (!pos || pos.stopped) {
      // Write state BEFORE the await so any duplicate that slips past the
      // lock still sees an open position instead of re-entering.
      stateModule.logEvent("ENTRY", ticker + " call @ breakout_long half=" + half + "/" + total);
      stateModule.openHalfPosition(ticker, "call", half, optPrice || close || 0);
      // Paper feed trades on the signal regardless of the real order outcome.
      await notify("postEntry", [ticker, "call", optPrice || 0, s.orb[ticker].high || orbHigh || 0, s.orb[ticker].low || orbLow || 0, close]);
      var order;
      try {
        order = await trayd.placeOrder({ ticker: ticker, side: "call", contracts: half });
      } catch (e) {
        stateModule.closePosition(ticker, "entry order failed");   // roll back on failure
        throw e;
      }

      // Cross-entry: IWM breaks before SPY
      var cross = null;
      var spyPos = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos || spyPos.stopped) && s.orb.SPY.set && !processing["SPY"]) {
        processing["SPY"] = true; lockedTickers.push("SPY");
        recentlySeen("SPY", "breakout_long");
        var spyHalf = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM breakout long → entering SPY call half=" + spyHalf);
        stateModule.openHalfPosition("SPY", "call", spyHalf, null);
        await notify("postEntry", ["SPY", "call", 0, s.orb.SPY.high || 0, s.orb.SPY.low || 0, null]);
        try {
          cross = await trayd.placeOrder({ ticker: "SPY", side: "call", contracts: spyHalf });
        } catch (e) {
          stateModule.closePosition("SPY", "cross entry failed");
          stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
        }
      }
      return { ok: true, entry: order, cross: cross };
    }

    // Already in a long — check for retest add
    if (pos.halfIn && !pos.stopped) {
      var addQty = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty + "c");
      stateModule.addSecondHalf(ticker, addQty, optPrice || close || pos.entryPrice);
      var addOrder = null;
      try {
        addOrder = await trayd.placeOrder({ ticker: ticker, side: "call", contracts: addQty });
      } catch (e) {
        stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
      }
      await notify("postAdd", [ticker, 0]);
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
      await notify("postFullClose", [ticker, optPrice || 0]);
      await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB breakout flip to short" });
      if (optPrice) logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
      stateModule.closePosition(ticker, "flip to short");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " put @ breakout_short half=" + half2 + "/" + total2);
      stateModule.openHalfPosition(ticker, "put", half2, optPrice || close || 0);
      await notify("postEntry", [ticker, "put", optPrice || 0, s.orb[ticker].high || orbHigh || 0, s.orb[ticker].low || orbLow || 0, close]);
      var order2;
      try {
        order2 = await trayd.placeOrder({ ticker: ticker, side: "put", contracts: half2 });
      } catch (e) {
        stateModule.closePosition(ticker, "entry order failed");
        throw e;
      }

      // Cross-entry: IWM breaks before SPY
      var cross2 = null;
      var spyPos2 = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos2 || spyPos2.stopped) && s.orb.SPY.set && !processing["SPY"]) {
        processing["SPY"] = true; lockedTickers.push("SPY");
        recentlySeen("SPY", "breakout_short");
        var spyHalf2 = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM breakout short → entering SPY put half=" + spyHalf2);
        stateModule.openHalfPosition("SPY", "put", spyHalf2, null);
        await notify("postEntry", ["SPY", "put", 0, s.orb.SPY.high || 0, s.orb.SPY.low || 0, null]);
        try {
          cross2 = await trayd.placeOrder({ ticker: "SPY", side: "put", contracts: spyHalf2 });
        } catch (e) {
          stateModule.closePosition("SPY", "cross entry failed");
          stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
        }
      }
      return { ok: true, entry: order2, cross: cross2 };
    }

    // Already in a short — check for retest add
    if (pos.halfIn && !pos.stopped) {
      var addQty2 = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty2 + "c");
      stateModule.addSecondHalf(ticker, addQty2, optPrice || close || pos.entryPrice);
      var addOrder2 = null;
      try {
        addOrder2 = await trayd.placeOrder({ ticker: ticker, side: "put", contracts: addQty2 });
      } catch (e) {
        stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
      }
      await notify("postAdd", [ticker, 0]);
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

    // Activate breakeven stop at +30%
    if (!pos.breakEvenActivated && gainPct >= 30) {
      stateModule.setBreakEven(ticker);
      stateModule.logEvent("BREAKEVEN", ticker + " +30% — stop moved to breakeven");
    }

    // Every +10% → sell 10%
    var increments = Math.floor(gainPct / 10);
    if (increments > tier && gainPct < 100 && tier < 100) {
      var sell10 = Math.max(1, Math.floor(pos.contracts * 0.10));
      stateModule.logEvent("PROFIT_TIER_1", ticker + " +" + gainPct.toFixed(1) + "% selling 10% (" + sell10 + "c)");
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell10, reason: "+10% scale-out" });
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
