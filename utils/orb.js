// utils/orb.js
// Server-side Opening Range capture. Does NOT depend on the orb_set webhook —
// fetches the first regular-session 5-min candle from Yahoo on startup, on a
// 2-min poll until captured, and on demand. This is what populates the dashboard
// and arms cross-entry even when the server starts after 9:35 ET or the webhook
// never arrives.

var https = require("https");
var stateModule = require("./state");

function etDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

// Fetch first regular-session 5-min candle high/low. DST-correct via
// meta.currentTradingPeriod.regular.start. Resolves null if not yet available.
function fetchOpeningRange(ticker) {
  return new Promise(function(resolve) {
    var options = {
      hostname: "query1.finance.yahoo.com",
      path: "/v8/finance/chart/" + encodeURIComponent(ticker) + "?interval=5m&range=1d",
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    };
    var req = https.request(options, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() {
        try {
          var parsed = JSON.parse(raw);
          var result = parsed.chart && parsed.chart.result && parsed.chart.result[0];
          if (!result) return resolve(null);
          var ts = result.timestamp || [];
          var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
          if (!q) return resolve(null);
          var regStart = result.meta && result.meta.currentTradingPeriod &&
                         result.meta.currentTradingPeriod.regular &&
                         result.meta.currentTradingPeriod.regular.start;
          for (var i = 0; i < ts.length; i++) {
            if (regStart && ts[i] < regStart) continue;        // skip pre-market bars
            if (q.high[i] != null && q.low[i] != null) {
              return resolve({ high: q.high[i], low: q.low[i] }); // first regular 5-min bar = ORB
            }
          }
          resolve(null);
        } catch(e) { resolve(null); }
      });
    });
    req.on("error", function() { resolve(null); });
    req.end();
  });
}

var lastCaptureDate = {}; // ticker -> ET date string of last successful capture

async function populateTicker(ticker, force) {
  var s = stateModule.getState();
  var today = etDate();
  var orb = s.orb && s.orb[ticker];
  // Skip if already captured for today (unless forced)
  if (!force && orb && orb.set && lastCaptureDate[ticker] === today) {
    return { ticker: ticker, set: true, skipped: true };
  }
  var range = await fetchOpeningRange(ticker);
  if (range && range.high && range.low) {
    stateModule.setORB(ticker, range.high, range.low);
    lastCaptureDate[ticker] = today;
    return { ticker: ticker, set: true, high: range.high, low: range.low };
  }
  return { ticker: ticker, set: false, reason: "opening-range data not available yet" };
}

async function populateIfNeeded(force) {
  var out = [];
  out.push(await populateTicker("SPY", force));
  out.push(await populateTicker("IWM", force));
  return out;
}

function scheduleORBCapture() {
  stateModule.logEvent("ORB", "Opening-range auto-capture scheduler started");
  // First attempt 10s after boot (covers late starts/redeploys), then poll
  // every 2 min. populateTicker self-skips once captured for the day, and
  // re-captures automatically at the next ET day boundary.
  function run() {
    populateIfNeeded(false).then(function(results) {
      results.forEach(function(r) {
        if (r.set && !r.skipped) stateModule.logEvent("ORB", r.ticker + " ORB captured High=" + r.high + " Low=" + r.low);
      });
    }).catch(function(e) {
      stateModule.logEvent("ORB_ERROR", "Capture poll failed: " + e.message);
    }).finally(function() {
      setTimeout(run, 120000);
    });
  }
  setTimeout(run, 10000);
}

module.exports = { fetchOpeningRange, populateIfNeeded, scheduleORBCapture };
