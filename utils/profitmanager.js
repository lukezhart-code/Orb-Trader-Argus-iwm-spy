// Profit Manager — polls open option positions every 60 seconds
// Handles: breakeven stop, +20% sell 10%, +100% sell 50%, expected move sell 90%

var stateModule = require("./state");
var trayd = require("./trayd");
var discord = require("./discord");
var https = require("https");
var fs = require("fs");

function isMarketHours() {
  var now = new Date();
  var utcTotal = now.getUTCHours() * 60 + now.getUTCMinutes();
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
    var gainPct = ((optionPrice - entryPrice) / entryPrice) * 100;
    var contracts = pos.contracts;
    var tier = pos.lastProfitTier || 0;

    console.log("[PROFIT_MGR] " + ticker + " entry=$" + entryPrice.toFixed(2) + " current=$" + optionPrice.toFixed(2) + " gain=" + gainPct.toFixed(1) + "% tier=" + tier);

    discord.updateLastKnownPrice(ticker, optionPrice);

    // Breakeven stop at +50%
    if (!pos.breakEvenActivated && gainPct >= 50) {
      stateModule.setBreakEven(ticker);
      stateModule.logEvent("BREAKEVEN", ticker + " +50% — stop moved to breakeven $" + entryPrice.toFixed(2));
      await discord.postBreakeven(ticker);
    }

    // Every +20% → sell 10%
    var increments = Math.floor(gainPct / 20);
    if (increments > tier && gainPct < 100 && tier < 5) {
      var sell10 = Math.max(1, Math.floor(contracts * 0.10));
      stateModule.logEvent("PROFIT_TIER_1", ticker + " +" + gainPct.toFixed(1) + "% — selling 10% (" + sell10 + "c) @ $" + optionPrice.toFixed(2));
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell10, reason: "+" + Math.floor(gainPct) + "% profit tier" });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, sell10);
      await discord.postProfitTier(ticker, 1, sell10, optionPrice, gainPct);
      stateModule.markProfitTier(ticker, increments);
    }

    // +100% → sell 50%
    if (gainPct >= 100 && tier < 100) {
      var sell50 = Math.max(1, Math.floor(contracts * 0.50));
      stateModule.logEvent("PROFIT_TIER_2", ticker + " +100% — selling 50% (" + sell50 + "c) @ $" + optionPrice.toFixed(2));
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell50, reason: "+100% profit tier" });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, sell50);
      await discord.postProfitTier(ticker, 2, sell50, optionPrice, gainPct);
      stateModule.markProfitTier(ticker, 100);
    }

    // +200% → sell 90% (expected move proxy)
    if (gainPct >= 200 && tier < 300) {
      var sell90 = Math.max(1, Math.floor(contracts * 0.90));
      stateModule.logEvent("PROFIT_TIER_3", ticker + " +200% — selling 90% (" + sell90 + "c) @ $" + optionPrice.toFixed(2));
      await trayd.closePartialPosition({ ticker: ticker, contracts: sell90, reason: "expected move 90% exit" });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, sell90);
      await discord.postProfitTier(ticker, 3, sell90, optionPrice, gainPct);
      stateModule.markProfitTier(ticker, 300);
    }

    // Breakeven stop — exit if price drops back to entry after activation
    if (pos.breakEvenActivated && optionPrice <= entryPrice && !pos.stopped) {
      stateModule.logEvent("STOP_BREAKEVEN", ticker + " hit breakeven stop @ $" + optionPrice.toFixed(2));
      await trayd.closePartialPosition({ ticker: ticker, contracts: contracts, reason: "breakeven stop hit" });
      logTradePnL(ticker, pos.side, entryPrice, optionPrice, contracts);
      await discord.postStopLoss(ticker, optionPrice, "Breakeven Stop Hit");
      stateModule.closePosition(ticker, "breakeven stop");
    }
  }
}

function startProfitManager(getToken) {
  console.log("[PROFIT_MGR] Starting — checks every 60 seconds during market hours");
  setInterval(async function() {
    try {
      var token = getToken();
      if (!token) return;
      await checkProfitTiers(token);
    } catch(e) {
      console.log("[PROFIT_MGR_ERROR]", e.message);
    }
  }, 60 * 1000);
}

module.exports = { startProfitManager };
