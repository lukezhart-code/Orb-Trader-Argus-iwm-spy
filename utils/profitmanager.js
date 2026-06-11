// Profit Manager — polls open option positions every 30 seconds
// Handles: breakeven stop, +20% sell 10%, +100% sell 50%, expected move sell 90%

var stateModule = require("./state");
var exitlogic = require("./exitlogic");
var trayd = require("./trayd");
var discord = require("./discord");
var https = require("https");
var fs = require("fs");

function isMarketHours() {
  var now = new Date();
  var utcTotal = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 9:30 AM - 4:00 PM ET = 13:30 - 20:00 UTC
  return utcTotal >= 13 * 60 + 30 && utcTotal <= 20 * 60;
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

async function getOptionPrice(token, instrumentUrl) {
  return new Promise((resolve) => {
    var options = {
      hostname: "api.robinhood.com",
      path: "/marketdata/options/?instruments=" + encodeURIComponent(instrumentUrl),
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "X-Robinhood-API-Version": "1.431.4",
        "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
      }
    };
    var req = https.request(options, (r) => {
      var raw = "";
      r.on("data", c => raw += c);
      r.on("end", () => {
        try {
          var parsed = JSON.parse(raw);
          var result = parsed.results && parsed.results[0];
          var price = result ? parseFloat(result.last_trade_price || result.mark_price || result.adjusted_mark_price || 0) : 0;
          resolve(price);
        } catch(e) { resolve(0); }
      });
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function getOpenOptionPositions(token) {
  return new Promise((resolve) => {
    var options = {
      hostname: "api.robinhood.com",
      path: "/options/positions/?nonzero=true",
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "X-Robinhood-API-Version": "1.431.4",
        "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
      }
    };
    var req = https.request(options, (r) => {
      var raw = "";
      r.on("data", c => raw += c);
      r.on("end", () => {
        try { resolve(JSON.parse(raw).results || []); }
        catch(e) { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.end();
  });
}

async function checkProfitTiers(token) {
  if (!isMarketHours()) return;

  var s = stateModule.getState();
  var tickers = ["SPY", "IWM"];

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var pos = stateModule.getPosition(ticker);
    if (!pos || pos.stopped || pos.entryPrice <= 0) continue;

    // Get current option price from Robinhood
    var rhPositions = await getOpenOptionPositions(token);
    var rhPos = rhPositions.find(function(p) { return p.chain_symbol === ticker && parseFloat(p.quantity) > 0; });
    if (!rhPos) {
      console.log("[PROFIT_MGR] No RH position found for " + ticker);
      continue;
    }

    var optionPrice = await getOptionPrice(token, rhPos.option);
    if (!optionPrice || optionPrice <= 0) {
      console.log("[PROFIT_MGR] Could not get option price for " + ticker);
      continue;
    }

    var entryPrice = pos.entryPrice;
    var contracts = pos.contracts;
    var decision = exitlogic.evaluate(pos, optionPrice);
    var gainPct = decision.gain;

    console.log("[PROFIT_MGR] " + ticker + " entry=$" + entryPrice.toFixed(2) + " current=$" + optionPrice.toFixed(2) + " gain=" + gainPct.toFixed(1) + "% tier=" + (pos.lastProfitTier||0) + " stop=" + decision.newStopPct + "%");

    // persist trailing stop level
    pos.stopPct = decision.newStopPct;

    // ── End-of-day: sell 50% of every open position at 3:45 PM ET ──────────
    if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
      var eodQty = Math.max(1, Math.floor(contracts * exitlogic.EOD_SELL_FRAC));
      stateModule.logEvent("EOD_SELL", ticker + " 3:45 ET — selling 50% (" + eodQty + "c) before close @ $" + optionPrice.toFixed(2));
      await trayd.closePartialPosition({ ticker: ticker, contracts: eodQty, reason: "EOD 50% (15m before close)" });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, eodQty);
      pos.contracts -= eodQty;
      pos.eodSold = exitlogic.etDateKey();
      if (pos.contracts <= 0) { stateModule.closePosition(ticker, "EOD flat"); continue; }
      contracts = pos.contracts;
    }

    // ── Breakeven activation at +30% ──────────────────────────────────────
    if (decision.activateBreakeven) {
      stateModule.setBreakEven(ticker);
      stateModule.logEvent("BREAKEVEN", ticker + " +30% — stop moved to breakeven $" + entryPrice.toFixed(2));
    }

    // ── Trailing / initial stop-out → exit full remaining ─────────────────
    if (decision.stopOut && !pos.stopped) {
      var reason = pos.breakEvenActivated ? "Trailing stop " + decision.newStopPct + "%" : "Initial stop -15%";
      stateModule.logEvent("STOP_OUT", ticker + " " + reason + " hit @ $" + optionPrice.toFixed(2) + " (" + gainPct.toFixed(1) + "%)");
      await trayd.closePartialPosition({ ticker: ticker, contracts: contracts, reason: reason });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, contracts);
      stateModule.closePosition(ticker, reason);
      continue;
    }

    // ── Scale-out: sell 10% for every +10% of gain ────────────────────────
    if (decision.scaleOut) {
      var sell10 = Math.max(1, Math.floor(contracts * decision.sellFraction));
      stateModule.logEvent("PROFIT_TIER", ticker + " +" + gainPct.toFixed(1) + "% — selling 10% (" + sell10 + "c) @ $" + optionPrice.toFixed(2));
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell10, reason: "+" + Math.floor(gainPct) + "% scale-out" });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, sell10);
      stateModule.markProfitTier(ticker, decision.newTier);
    }
  }
}

function startProfitManager(getToken) {
  console.log("[PROFIT_MGR] Starting — checks every 30 seconds during market hours");
  setInterval(async function() {
    try {
      var token = getToken();
      if (!token) return;
      await checkProfitTiers(token);
    } catch(e) {
      console.log("[PROFIT_MGR_ERROR]", e.message);
    }
  }, 30 * 1000); // every 30 seconds
}

module.exports = { startProfitManager };
