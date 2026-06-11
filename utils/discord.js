// Discord Paper Trading Bot
// Tracks a virtual account and posts all signals to Discord

const https = require("https");
const rh = require("./robinhood");
const expiryUtil = require("./expiry");
const exitlogic = require("./exitlogic");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// Paper-account option expiry mirrors the configurable real-order DTE.
function paperExpiry(ticker) {
  return expiryUtil.getExpiry(ticker);
}

// Use native fetch if available, otherwise use https
async function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
const STARTING_BALANCE = 50000;
const CONTRACTS_PER_TRADE = 50;

// Paper trading state
var accountState = {
  balance: STARTING_BALANCE,
  startingBalance: STARTING_BALANCE,
  positions: { SPY: null, IWM: null },
  dailyTrades: [],
  totalTrades: 0,
  wins: 0,
  losses: 0
};

function resetDailyState() {
  accountState.dailyTrades = [];
}

async function sendDiscord(embed) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await httpPost(DISCORD_WEBHOOK, {
      content: "@everyone",
      allowed_mentions: { parse: ["everyone"] },
      embeds: [embed]
    });
  } catch(err) {
    console.log("[DISCORD_ERROR]", err.message);
  }
}

function accountFooter() {
  return "Argus ORB Trader 50K: " + formatMoney(accountState.balance);
}

function formatMoney(n) {
  var abs = Math.abs(n);
  var str = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "-" + str : str;
}

function formatPct(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function posLabel(ticker, pos) {
  return expiryUtil.contractLabel(ticker, pos.side, pos.strike, pos.expiry);
}

async function postEntry(ticker, side, optionPrice, orbHigh, orbLow, underlying) {
  var contracts = CONTRACTS_PER_TRADE;
  var expiry = paperExpiry(ticker);
  var strike = underlying ? Math.round(parseFloat(underlying)) : null;
  if (!strike) {
    try { var u = await rh.getQuote(ticker); if (u) strike = Math.round(u); } catch (e) {}
  }
  var instrumentUrl = null;

  // Paper feed is independent of real order placement: fetch its own option mark.
  // optionPrice (if the real order filled) is used only as a hint/fallback.
  var price = optionPrice && optionPrice > 0 ? parseFloat(optionPrice) : null;
  if (strike) {
    try {
      var m = await rh.getOptionMark(ticker, side, strike, expiry);
      if (m) {
        instrumentUrl = m.instrument;
        if (!price && m.price) price = m.price;
        if (m.strike) strike = m.strike;     // reflect any nearby-strike roll
        if (m.expiry) expiry = m.expiry;      // reflect any expiry roll-forward
      }
    } catch (e) { console.log("[PAPER] entry price fetch failed: " + e.message); }
  }
  if (!price) price = 0; // unknown for now — the paper engine establishes it on first poll

  var posValue = price * contracts * 100;
  var stop = (((parseFloat(orbHigh) || 0) + (parseFloat(orbLow) || 0)) / 2).toFixed(2);
  var expiryLabel = expiryUtil.getDTELabel(ticker);
  var label = expiryUtil.contractLabel(ticker, side, strike, expiry);
  var emoji = side === "call" ? "🟢" : "🔴";
  var color = side === "call" ? 0x00e5a0 : 0xff4d6a;

  accountState.positions[ticker] = {
    side: side,
    contracts: contracts,
    totalContracts: contracts,
    entryPrice: price,
    posValue: posValue,
    orbHigh: orbHigh,
    orbLow: orbLow,
    halfIn: true,
    fullIn: false,
    realizedPnl: 0,
    lastProfitTier: 0,
    breakEvenActivated: false,
    stopPct: null,
    strike: strike,
    expiry: expiry,
    instrumentUrl: instrumentUrl,
    lastKnownPrice: price
  };

  accountState.dailyTrades.push({ ticker, side, entryPrice: price, contracts });

  await sendDiscord({
    color: color,
    title: emoji + " ENTRY — " + label,
    fields: [
      { name: "Contract", value: label + "  (" + expiryLabel + ")", inline: false },
      { name: "Contracts", value: String(contracts), inline: true },
      { name: "Entry Price", value: price > 0 ? "$" + price.toFixed(2) : "pending…", inline: true },
      { name: "Position Value", value: price > 0 ? formatMoney(posValue) : "—", inline: true },
      { name: "ORB High", value: "$" + (parseFloat(orbHigh) || 0).toFixed(2), inline: true },
      { name: "ORB Low",  value: "$" + (parseFloat(orbLow) || 0).toFixed(2),  inline: true },
      { name: "Stop (Mid)", value: "$" + stop, inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

async function postAdd(ticker, optionPrice) {
  var pos = accountState.positions[ticker];
  if (!pos) return;
  if (!optionPrice || optionPrice <= 0) optionPrice = pos.lastKnownPrice || pos.entryPrice || 0;
  var addContracts = CONTRACTS_PER_TRADE;
  pos.contracts += addContracts;
  pos.totalContracts = pos.contracts;
  pos.fullIn = true;
  pos.halfIn = false;
  var avgEntry = ((pos.entryPrice + optionPrice) / 2).toFixed(2);

  await sendDiscord({
    color: 0x4da6ff,
    title: "➕ ADD — " + posLabel(ticker, pos) + " (Retest Confirmed)",
    fields: [
      { name: "Added", value: "+" + addContracts + " contracts @ $" + optionPrice.toFixed(2), inline: true },
      { name: "Total", value: String(pos.contracts) + " contracts", inline: true },
      { name: "Avg Entry", value: "$" + avgEntry, inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

async function postBreakeven(ticker) {
  var pos = accountState.positions[ticker];
  if (!pos) return;

  await sendDiscord({
    color: 0xf5a623,
    title: "🟡 BREAKEVEN STOP ACTIVATED — " + posLabel(ticker, pos),
    fields: [
      { name: "Stop Level", value: "$" + pos.entryPrice.toFixed(2) + " (entry price)", inline: true },
      { name: "Contracts", value: String(pos.contracts), inline: true },
      { name: "Status", value: "Gains protected ✅", inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

async function postEodSell(ticker, sellContracts, currentPrice, gainPct) {
  var pos = accountState.positions[ticker];
  if (!pos) return;
  if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;
  var proceeds = sellContracts * currentPrice * 100;
  var cost = sellContracts * pos.entryPrice * 100;
  var tierPnl = proceeds - cost;
  pos.realizedPnl += tierPnl;
  pos.contracts -= sellContracts;
  accountState.balance += tierPnl;
  await sendDiscord({
    color: 0x4da6ff,
    title: "\ud83d\udd52 END OF DAY \u2014 Selling 50% \u2014 " + posLabel(ticker, pos),
    fields: [
      { name: "Sold", value: sellContracts + "c @ $" + currentPrice.toFixed(2), inline: true },
      { name: "Gain", value: formatPct(gainPct), inline: true },
      { name: "P&L This Sale", value: formatMoney(tierPnl), inline: true },
      { name: "Remaining", value: String(pos.contracts) + " contracts", inline: true },
      { name: "Reason", value: "15 min before close", inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
  if (pos.contracts <= 0) accountState.positions[ticker] = null;
}

async function postProfitTier(ticker, tierNum, sellContracts, currentPrice, gainPct) {
  var pos = accountState.positions[ticker];
  if (!pos) return;

  var proceeds = sellContracts * currentPrice * 100;
  var cost = sellContracts * pos.entryPrice * 100;
  var tierPnl = proceeds - cost;
  pos.realizedPnl += tierPnl;
  pos.contracts -= sellContracts;
  accountState.balance += tierPnl;

  var emoji = tierNum === 1 ? "💰" : tierNum === 2 ? "💰💰" : "🎯";
  var title = tierNum === 3
    ? emoji + " EXPECTED MOVE HIT — " + posLabel(ticker, pos)
    : emoji + " PROFIT TIER " + tierNum + " — " + posLabel(ticker, pos);

  await sendDiscord({
    color: 0xf5a623,
    title: title,
    fields: [
      { name: "Sold", value: sellContracts + "c @ $" + currentPrice.toFixed(2), inline: true },
      { name: "Gain", value: formatPct(gainPct), inline: true },
      { name: "P&L This Sale", value: formatMoney(tierPnl), inline: true },
      { name: "Remaining", value: String(pos.contracts) + " contracts", inline: true },
      { name: "Realized P&L", value: formatMoney(pos.realizedPnl), inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

async function postStopLoss(ticker, currentPrice, reason) {
  var pos = accountState.positions[ticker];
  if (!pos) return;
  if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;

  var proceeds = pos.contracts * currentPrice * 100;
  var cost = pos.contracts * pos.entryPrice * 100;
  var pnl = proceeds - cost + pos.realizedPnl;
  var pct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  accountState.balance += (proceeds - cost);

  if (pnl < 0) accountState.losses++;
  else accountState.wins++;
  accountState.totalTrades++;

  accountState.dailyTrades.push({
    ticker, side: pos.side, exitPrice: currentPrice,
    pnl: pnl, pct: pct, reason: reason, closed: true
  });

  accountState.positions[ticker] = null;

  await sendDiscord({
    color: 0xff4d6a,
    title: "🔴 " + reason.toUpperCase() + " — " + posLabel(ticker, pos),
    fields: [
      { name: "Closed", value: pos.contracts + "c @ $" + currentPrice.toFixed(2), inline: true },
      { name: "P&L", value: formatMoney(pnl) + " (" + formatPct(pct) + ")", inline: true },
      { name: "Reason", value: reason, inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

async function postFullClose(ticker, currentPrice) {
  var pos = accountState.positions[ticker];
  if (!pos || pos.contracts <= 0) return;
  if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;

  var proceeds = pos.contracts * currentPrice * 100;
  var cost = pos.contracts * pos.entryPrice * 100;
  var finalPnl = proceeds - cost + pos.realizedPnl;
  var totalPct = (finalPnl / (pos.totalContracts * pos.entryPrice * 100)) * 100;
  accountState.balance += (proceeds - cost);

  if (finalPnl > 0) accountState.wins++;
  else accountState.losses++;
  accountState.totalTrades++;

  accountState.positions[ticker] = null;

  await sendDiscord({
    color: 0x00e5a0,
    title: "✅ POSITION FULLY CLOSED — " + posLabel(ticker, pos),
    fields: [
      { name: "Final Sale", value: pos.contracts + "c @ $" + currentPrice.toFixed(2), inline: true },
      { name: "Total P&L", value: formatMoney(finalPnl) + " (" + formatPct(totalPct) + ")", inline: true },
      { name: "Account", value: formatMoney(accountState.balance), inline: true }
    ],
    timestamp: new Date().toISOString()
  });
}

async function postDailySummary() {
  var netPnl = accountState.balance - accountState.startingBalance;
  var netPct = (netPnl / accountState.startingBalance) * 100;
  var color = netPnl >= 0 ? 0x00e5a0 : 0xff4d6a;
  var emoji = netPnl >= 0 ? "📈" : "📉";

  var tradeLines = "";
  accountState.dailyTrades.forEach(function(t) {
    if (t.closed) {
      var e = t.pnl >= 0 ? "✅" : "🔴";
      tradeLines += e + " " + t.ticker + " " + t.side.toUpperCase() + ": " + formatMoney(t.pnl) + " (" + formatPct(t.pct) + ")\n";
    }
  });
  if (!tradeLines) tradeLines = "No closed trades today";

  await sendDiscord({
    color: color,
    title: emoji + " DAILY P&L SUMMARY — " + new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    fields: [
      { name: "Trades", value: tradeLines, inline: false },
      { name: "Net P&L", value: formatMoney(netPnl) + " (" + formatPct(netPct) + ")", inline: true },
      { name: "Wins / Losses", value: accountState.wins + " / " + accountState.losses, inline: true },
      { name: "Account Balance", value: formatMoney(accountState.balance), inline: true }
    ],
    footer: { text: "Argus ORB Trader 50K | Starting Balance: " + formatMoney(accountState.startingBalance) },
    timestamp: new Date().toISOString()
  });

  // Reset daily trades but keep running balance
  resetDailyState();
}

// Schedule daily summary at 4 PM ET (20:00 UTC)
function scheduleDailySummary() {
  function msUntil4pmET() {
    var now = new Date();
    var target = new Date();
    target.setUTCHours(20, 0, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }
  function scheduleNext() {
    setTimeout(async function() {
      await postDailySummary();
      scheduleNext();
    }, msUntil4pmET());
  }
  scheduleNext();
  console.log("[DISCORD] Daily summary scheduled for 4 PM ET");
}

// ── Open positions post ──────────────────────────────────────────────────────
async function postOpenPositions(label) {
  var positions = Object.entries(accountState.positions).filter(function(e) { return e[1] && !e[1].stopped; });
  if (positions.length === 0) return;

  var fields = positions.map(function(e) {
    var ticker = e[0]; var pos = e[1];
    var currentEst = pos.lastKnownPrice || pos.entryPrice;
    var pnl = (currentEst - pos.entryPrice) * pos.contracts * 100;
    var pct = pos.entryPrice > 0 ? ((currentEst - pos.entryPrice) / pos.entryPrice * 100).toFixed(1) : "0.0";
    var pnlStr = (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2});
    var side = pos.side === "call" ? "CALL" : "PUT";
    return {
      name: posLabel(ticker, pos),
      value: "Entry: $" + pos.entryPrice.toFixed(2) + "\nCurrent: $" + currentEst.toFixed(2) + "\nP&L: " + pnlStr + " (" + (pnl >= 0 ? "+" : "") + pct + "%)\nContracts: " + pos.contracts,
      inline: true
    };
  });

  await sendDiscord({
    color: 0x4da6ff,
    title: "📋 " + label + " — Open Positions",
    fields: fields,
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

function updateLastKnownPrice(ticker, optionPrice) {
  if (accountState.positions[ticker] && optionPrice) {
    accountState.positions[ticker].lastKnownPrice = optionPrice;
  }
}

// Every 30 minutes during market hours
function schedulePositionUpdates() {
  function isMarketHours() {
    var now = new Date();
    var utcTotal = now.getUTCHours() * 60 + now.getUTCMinutes();
    return utcTotal >= 13*60+30 && utcTotal <= 20*60;
  }
  function msUntilNext15() {
    var now = new Date();
    var m = now.getUTCMinutes();
    var next15 = Math.ceil((m + 1) / 15) * 15;
    var addMin = next15 - m;
    if (addMin <= 0) addMin += 15;
    var next = new Date(now);
    next.setUTCMinutes(now.getUTCMinutes() + addMin, 0, 0);
    return next - now;
  }
  function scheduleNext() {
    setTimeout(async function() {
      if (isMarketHours()) await postOpenPositions("15-Min Update");
      scheduleNext();
    }, msUntilNext15());
  }
  scheduleNext();
  console.log("[DISCORD] 15-min position updates scheduled");
}

// ── Market open countdown messages ──────────────────────────────────────────
async function postGoodMorning(minutesBefore) {
  var messages = {
    45: {
      color: 0x4da6ff,
      title: "👁️ 45 Minutes to Open — Argus Pre-Market Check",
      description: "Morning rundown incoming. Reviewing all open ORB positions before the bell. Stay sharp — the edge goes to those who prepare. 📋",
      footer: "Not financial advice. Options trading involves significant risk of loss."
    },
    60: {
      color: 0xf5c518,
      content: "@everyone",
      title: "☀️ Good Morning, Traders!",
      description: "Rise and shine — market opens in one hour. Grab your coffee, check your charts, and get settled in. Today is a new opportunity.\n\nArgus is awake, warmed up, and ready to work for you. 👁️",
      footer: "Not financial advice. Options trading involves significant risk of loss."
    },
    30: {
      color: 0xf5a623,
      content: "@everyone",
      title: "🌅 30 Minutes Out",
      description: "Half hour to go. Argus is authenticated, connected, and on standby. All systems green.\n\nTake a breath. Trust the process. Let Argus do its thing. 💚",
      footer: "Not financial advice. Trade at your own risk."
    },
    5: {
      color: 0xff8c00,
      content: "@everyone",
      title: "⚡ 5 Minutes — Argus Is Locked In",
      description: "We're almost there. Argus is watching every tick.\nWhen the bell rings, it's go time. 👀",
      footer: "Not financial advice. Trade at your own risk."
    },
    1: {
      color: 0xff4d6a,
      content: "@everyone",
      title: "🚨 60 SECONDS. ARGUS IS LIVE.",
      description: "This is it. Everything is armed and ready.\nStay focused. Stay disciplined. Let Argus work. 🔥",
      footer: "Not financial advice. Options trading carries substantial risk of loss."
    }
  };

  var msg = messages[minutesBefore];
  if (!msg || !DISCORD_WEBHOOK) return;

  try {
    await httpPost(DISCORD_WEBHOOK, {
      content: msg.content,
      embeds: [{
        color: msg.color,
        title: msg.title,
        description: msg.description,
        footer: { text: msg.footer },
        timestamp: new Date().toISOString()
      }]
    });
    console.log("[DISCORD] Good morning message sent (" + minutesBefore + " min before open)");
    if (minutesBefore === 45) {
      await postOpenPositions("Pre-Market 45 Min");
    }
  } catch(err) {
    console.log("[DISCORD_ERROR]", err.message);
  }
}

function scheduleMarketOpenMessages() {
  // Market opens 9:30 AM ET = 13:30 UTC (EDT)
  // Messages at: 8:30 (60min), 9:00 (30min), 9:25 (5min), 9:29 (1min)
  var alerts = [
    { utcHour: 12, utcMin: 45, minutesBefore: 45 },  // 8:45 AM ET
    { utcHour: 12, utcMin: 30, minutesBefore: 60 },  // 8:30 AM ET
    { utcHour: 13, utcMin: 0,  minutesBefore: 30 },  // 9:00 AM ET
    { utcHour: 13, utcMin: 25, minutesBefore: 5  },  // 9:25 AM ET
    { utcHour: 13, utcMin: 29, minutesBefore: 1  }   // 9:29 AM ET
  ];

  function msUntilNext(utcHour, utcMin) {
    var now = new Date();
    var target = new Date();
    target.setUTCHours(utcHour, utcMin, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }

  alerts.forEach(function(alert) {
    function scheduleNext() {
      var delay = msUntilNext(alert.utcHour, alert.utcMin);
      console.log("[DISCORD] Argus " + alert.minutesBefore + "-min message in " + Math.round(delay/60000) + " min");
      setTimeout(async function() {
        await postGoodMorning(alert.minutesBefore);
        scheduleNext();
      }, delay);
    }
    scheduleNext();
  });
}

// ── Paper price engine ───────────────────────────────────────────────────────
// Polls live option marks for the PAPER positions and drives P&L + TP tiers,
// fully independent of real order placement. Mirrors the profit-tier ladder.
function paperMarketHours() {
  var now = new Date();
  var utcTotal = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcTotal >= 13 * 60 + 30 && utcTotal <= 20 * 60; // 9:30–16:00 ET
}

async function priceOnePaperPosition(ticker) {
  var pos = accountState.positions[ticker];
  if (!pos) return;

  var price = null;
  try {
    if (pos.instrumentUrl) price = await rh.getOptionMarkByUrl(pos.instrumentUrl);
    if ((!price || price <= 0) && pos.strike) {
      var m = await rh.getOptionMark(ticker, pos.side, pos.strike, pos.expiry);
      if (m) { price = m.price; if (!pos.instrumentUrl) pos.instrumentUrl = m.instrument; }
    }
  } catch (e) { console.log("[PAPER_ENGINE] price fetch " + ticker + ": " + e.message); }
  if (!price || price <= 0) return;

  // Establish entry on first successful read if it wasn't known at entry time
  if (!pos.entryPrice || pos.entryPrice <= 0) {
    pos.entryPrice = price;
    pos.posValue = price * pos.contracts * 100;
    pos.lastKnownPrice = price;
    return;
  }

  updateLastKnownPrice(ticker, price);
  var decision = exitlogic.evaluate(pos, price);
  pos.stopPct = decision.newStopPct;

  // End-of-day: sell 50% at 3:45 PM ET
  if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
    var eodQty = Math.max(1, Math.floor(pos.contracts * exitlogic.EOD_SELL_FRAC));
    pos.eodSold = exitlogic.etDateKey();
    await postEodSell(ticker, eodQty, price, decision.gain);
    return;
  }

  if (decision.activateBreakeven) {
    pos.breakEvenActivated = true;
    await postBreakeven(ticker);
  }

  if (decision.stopOut) {
    var still0 = accountState.positions[ticker];
    if (still0) {
      var reason = still0.breakEvenActivated ? "Trailing Stop " + decision.newStopPct + "%" : "Initial Stop -15%";
      await postStopLoss(ticker, price, reason);
    }
    return;
  }

  if (decision.scaleOut) {
    var s10 = Math.max(1, Math.floor(pos.contracts * decision.sellFraction));
    await postProfitTier(ticker, 1, s10, price, decision.gain);
    if (accountState.positions[ticker]) accountState.positions[ticker].lastProfitTier = decision.newTier;
  }
}

function startPaperEngine(getToken) {
  console.log("[DISCORD] Paper engine started — " + CONTRACTS_PER_TRADE + " contracts, live marks every 30s");
  setInterval(async function() {
    try {
      if (!paperMarketHours()) return;
      if (getToken && !getToken()) return; // need a token for read-only marks
      await priceOnePaperPosition("SPY");
      await priceOnePaperPosition("IWM");
    } catch (e) { console.log("[PAPER_ENGINE_ERROR] " + e.message); }
  }, 30 * 1000);
}

module.exports = {
  postEntry,
  updateLastKnownPrice,
  postOpenPositions,
  schedulePositionUpdates,
  postAdd,
  postBreakeven,
  postProfitTier,
  postStopLoss,
  postFullClose,
  postDailySummary,
  scheduleDailySummary,
  scheduleMarketOpenMessages,
  startPaperEngine,
  priceOnePaperPosition,
  postEodSell,
  getAccountState: function() { return accountState; }
};
