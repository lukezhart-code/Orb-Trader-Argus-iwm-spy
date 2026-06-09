// Discord - Argus ORB Trader

const https = require("https");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STARTING_BALANCE = 50000;
const CONTRACTS_PER_TRADE = 10;

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
    await httpPost(DISCORD_WEBHOOK, { embeds: [embed] });
  } catch(err) {
    console.log("[DISCORD_ERROR]", err.message);
  }
}

function formatMoney(n) {
  var abs = Math.abs(n);
  var str = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "-" + str : str;
}

function formatPct(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function accountFooter() {
  return "Argus ORB Trader 50K: " + formatMoney(accountState.balance);
}

async function postEntry(ticker, side, optionPrice, orbHigh, orbLow) {
  var contracts = CONTRACTS_PER_TRADE;
  var posValue = optionPrice * contracts * 100;
  var stop = ((orbHigh + orbLow) / 2).toFixed(2);
  var expiry = ticker === "SPY" ? "1DTE" : "0DTE";
  var emoji = side === "call" ? "🟢" : "🔴";
  var color = side === "call" ? 0x00e5a0 : 0xff4d6a;

  accountState.positions[ticker] = {
    side: side, contracts: contracts, totalContracts: contracts,
    entryPrice: optionPrice, posValue: posValue,
    orbHigh: orbHigh, orbLow: orbLow,
    halfIn: true, fullIn: false, realizedPnl: 0, lastProfitTier: 0
  };

  accountState.dailyTrades.push({ ticker, side, entryPrice: optionPrice, contracts });

  await sendDiscord({
    color: color,
    title: emoji + " ENTRY — " + ticker + " " + expiry + " " + side.toUpperCase(),
    fields: [
      { name: "Contracts", value: String(contracts), inline: true },
      { name: "Entry Price", value: "$" + optionPrice.toFixed(2), inline: true },
      { name: "Position Value", value: formatMoney(posValue), inline: true },
      { name: "ORB High", value: "$" + parseFloat(orbHigh).toFixed(2), inline: true },
      { name: "ORB Low", value: "$" + parseFloat(orbLow).toFixed(2), inline: true },
      { name: "Stop (Mid)", value: "$" + stop, inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
}

async function postAdd(ticker, optionPrice) {
  var pos = accountState.positions[ticker];
  if (!pos) return;
  var addContracts = CONTRACTS_PER_TRADE;
  pos.contracts += addContracts;
  pos.totalContracts = pos.contracts;
  pos.fullIn = true;
  pos.halfIn = false;
  var avgEntry = ((pos.entryPrice + optionPrice) / 2).toFixed(2);

  await sendDiscord({
    color: 0x4da6ff,
    title: "➕ ADD — " + ticker + " " + pos.side.toUpperCase() + " (Retest Confirmed)",
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
    title: "🟡 BREAKEVEN STOP ACTIVATED — " + ticker + " " + pos.side.toUpperCase(),
    fields: [
      { name: "Stop Level", value: "$" + pos.entryPrice.toFixed(2) + " (entry price)", inline: true },
      { name: "Contracts", value: String(pos.contracts), inline: true },
      { name: "Status", value: "Gains protected ✅", inline: true }
    ],
    footer: { text: accountFooter() },
    timestamp: new Date().toISOString()
  });
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
    ? emoji + " EXPECTED MOVE HIT — " + ticker + " " + pos.side.toUpperCase()
    : emoji + " PROFIT TIER " + tierNum + " — " + ticker + " " + pos.side.toUpperCase();

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
    title: "🔴 " + reason.toUpperCase() + " — " + ticker + " " + pos.side.toUpperCase(),
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
    title: "✅ POSITION FULLY CLOSED — " + ticker + " " + pos.side.toUpperCase(),
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

  resetDailyState();
}

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

async function postOpenPositions(label) {
  var positions = Object.entries(accountState.positions).filter(function(e) { return e[1] && !e[1].stopped; });

  var fields = positions.length > 0 ? positions.map(function(e) {
    var ticker = e[0]; var pos = e[1];
    var currentEst = pos.lastKnownPrice || pos.entryPrice;
    var pnl = (currentEst - pos.entryPrice) * pos.contracts * 100;
    var pct = pos.entryPrice > 0 ? ((currentEst - pos.entryPrice) / pos.entryPrice * 100).toFixed(1) : "0.0";
    var pnlStr = (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var side = pos.side === "call" ? "CALL" : "PUT";
    return {
      name: ticker + " " + side,
      value: "Entry: $" + pos.entryPrice.toFixed(2) + "\nCurrent: $" + currentEst.toFixed(2) + "\nP&L: " + pnlStr + " (" + (pnl >= 0 ? "+" : "") + pct + "%)\nContracts: " + pos.contracts,
      inline: true
    };
  }) : [{ name: "No Open Positions", value: "Watching for signals 👁️", inline: false }];

  await sendDiscord({
    color: 0x4da6ff,
    title: "📋 " + label + " — Position Update",
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

function schedulePositionUpdates() {
  function isMarketHours() {
    var now = new Date();
    var utcTotal = now.getUTCHours() * 60 + now.getUTCMinutes();
    return utcTotal >= 13 * 60 + 30 && utcTotal <= 20 * 60;
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
  var alerts = [
    { utcHour: 12, utcMin: 45, minutesBefore: 45 },
    { utcHour: 12, utcMin: 30, minutesBefore: 60 },
    { utcHour: 13, utcMin: 0,  minutesBefore: 30 },
    { utcHour: 13, utcMin: 25, minutesBefore: 5  },
    { utcHour: 13, utcMin: 29, minutesBefore: 1  }
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
      console.log("[DISCORD] Argus " + alert.minutesBefore + "-min message in " + Math.round(delay / 60000) + " min");
      setTimeout(async function() {
        await postGoodMorning(alert.minutesBefore);
        scheduleNext();
      }, delay);
    }
    scheduleNext();
  });
}

module.exports = {
  postEntry,
  postAdd,
  postBreakeven,
  postProfitTier,
  postStopLoss,
  postFullClose,
  postDailySummary,
  postOpenPositions,
  postGoodMorning,
  updateLastKnownPrice,
  scheduleDailySummary,
  scheduleMarketOpenMessages,
  schedulePositionUpdates,
  getAccountState: function() { return accountState; }
};
