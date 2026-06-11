const express = require("express");
const path = require("path");
const https = require("https");
const fs = require("fs");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize } = require("./utils/state");
const { ensureLoggedIn, submitSmsCode, getPendingWorkflow, scheduleDailyReauth } = require("./utils/reauth");
const rh = require("./utils/robinhood");
const discord = require("./utils/discord");
const profitManager = require("./utils/profitmanager");
const orbUtil = require("./utils/orb");
const settings = require("./utils/settings");

// Catch unhandled promise rejections so server never silently crashes
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED_REJECTION]", err && err.message ? err.message : err);
});

app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "manifest.json"));
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "dashboard", "sw.js"));
});
app.get("/icon.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "icon.svg"));
});

app.get("/health", (req, res) => {
  res.json({ status: "running", time: new Date().toISOString(), auth: rh.getToken() ? "connected" : "disconnected" });
});

app.get("/api/buying-power", async (req, res) => {
  try {
    // Fetch buying power from Trayd API
    var traydRes = await new Promise((resolve) => {
      var options = {
        hostname: "mcp.trayd.ai",
        path: "/portfolio?account_number=" + (process.env.RH_ACCOUNT_NUMBER || ""),
        headers: { "Accept": "application/json" }
      };
      var req2 = https.request(options, (r) => {
        var raw = "";
        r.on("data", c => raw += c);
        r.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
      });
      req2.on("error", () => resolve({}));
      req2.end();
    });
    var bp = traydRes.buying_power || traydRes.cash || null;
    if (!bp) {
      // Fallback to Robinhood accounts endpoint
      var token = rh.getToken();
      if (token) {
        var data = await new Promise((resolve) => {
          var opts = {
            hostname: "api.robinhood.com",
            path: "/accounts/" + (process.env.RH_ACCOUNT_NUMBER || "") + "/",
            headers: { "Authorization": "Bearer " + token, "Accept": "application/json", "X-Robinhood-API-Version": "1.431.4", "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)" }
          };
          var req3 = https.request(opts, (r) => {
            var raw = ""; r.on("data", c => raw += c);
            r.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
          });
          req3.on("error", () => resolve({})); req3.end();
        });
        bp = data.buying_power || data.cash || null;
      }
    }
    res.json({ buying_power: bp });
  } catch(e) {
    console.log("[BUYING_POWER_ERROR]", e.message);
    res.json({ buying_power: null });
  }
});
app.get("/api/state", (req, res) => {
  var s = getState();
  s.auth = { logged_in: !!rh.getToken(), pending: !!getPendingWorkflow() };
  s.dte = settings.getAll().dte;
  res.json(s);
});

app.post("/api/settings/dte", (req, res) => {
  try {
    const { spy, iwm } = req.body || {};
    if (spy !== undefined) settings.setDTE("SPY", spy);
    if (iwm !== undefined) settings.setDTE("IWM", iwm);
    res.json({ ok: true, dte: settings.getAll().dte, durable: settings.getAll().durable });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/orb/refresh", async (req, res) => {
  try {
    var results = await orbUtil.populateIfNeeded(true);
    res.json({ ok: true, orb: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/prices", async (req, res) => {
  try {
    // Use Yahoo Finance — no auth needed, always works
    var tickers = { "SPY": "SPY", "IWM": "IWM", "QQQ": "QQQ", "SPX": "^GSPC" };
    async function getYahooPrice(display, symbol) {
      return new Promise((resolve) => {
        var options = {
          hostname: "query1.finance.yahoo.com",
          path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d",
          headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
        };
        var req2 = https.request(options, (r) => {
          var raw = "";
          r.on("data", c => raw += c);
          r.on("end", () => {
            try {
              var parsed = JSON.parse(raw);
              var meta = parsed.chart && parsed.chart.result && parsed.chart.result[0] && parsed.chart.result[0].meta;
              resolve([display, {
                price: meta ? (meta.regularMarketPrice || meta.previousClose || null) : null,
                prev_close: meta ? (meta.chartPreviousClose || meta.previousClose || null) : null
              }]);
            } catch(e) { resolve([display, { price: null, prev_close: null }]); }
          });
        });
        req2.on("error", () => resolve([display, { price: null, prev_close: null }]));
        req2.end();
      });
    }
    var results = await Promise.all(Object.entries(tickers).map(([d, s]) => getYahooPrice(d, s)));
    res.json({ prices: Object.fromEntries(results) });
  } catch(e) {
    console.log("[PRICES_ERROR]", e.message);
    res.json({ prices: {} });
  }
});
app.get("/api/pnl", (req, res) => {
  try {
    var pnlFile = "/tmp/orb-pnl.json";
    if (!fs.existsSync(pnlFile)) return res.json({ daily: null, weekly: null, monthly: null, yearly: null });
    var data = JSON.parse(fs.readFileSync(pnlFile, "utf8"));
    var now = new Date();
    var daily = 0, weekly = 0, monthly = 0, yearly = 0;
    var hasData = false;
    (data.trades || []).forEach(function(t) {
      var d = new Date(t.time);
      var pnl = parseFloat(t.pnl) || 0;
      if (d.toDateString() === now.toDateString()) { daily += pnl; hasData = true; }
      var weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
      if (d >= weekAgo) { weekly += pnl; hasData = true; }
      var monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
      if (d >= monthAgo) { monthly += pnl; hasData = true; }
      var yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      if (d >= yearAgo) { yearly += pnl; hasData = true; }
    });
    res.json(hasData ? { daily, weekly, monthly, yearly } : { daily: null, weekly: null, monthly: null, yearly: null });
  } catch(e) {
    console.log("[PNL_ERROR]", e.message);
    res.json({ daily: null, weekly: null, monthly: null, yearly: null });
  }
});

app.post("/api/reauth", async (req, res) => {
  try {
    rh.setToken(null);
    var ok = await ensureLoggedIn();
    var pending = getPendingWorkflow();
    res.json({ ok: ok, pending_type: pending ? pending.challenge_type : null, message: ok ? "Connected to Robinhood" : pending ? "Check phone or enter SMS code" : "Login failed — check Railway logs" });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sms", async (req, res) => {
  try {
    var code = req.body.code;
    if (!code) return res.status(400).json({ error: "code required" });
    var result = await submitSmsCode(code);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/contracts", (req, res) => {
  try {
    const { spy, iwm } = req.body;
    if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
    setContractSize(spy, iwm);
    res.json({ ok: true, contracts: getState().contracts });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/test/discord/:type", async (req, res) => {
  try {
    var type = req.params.type;
    if (type === "60") await discord.postGoodMorning(60);
    if (type === "45") await discord.postGoodMorning(45);
    if (type === "30") await discord.postGoodMorning(30);
    if (type === "5")  await discord.postGoodMorning(5);
    if (type === "1")  await discord.postGoodMorning(1);
    if (type === "summary") await discord.postDailySummary();
    if (type === "positions") await discord.postOpenPositions("Test");
    if (type === "entry") await discord.postEntry("SPY", "call", 2.40, 757.50, 754.25);
    if (type === "stop") await discord.postStopLoss("SPY", 1.80, "Stop Loss — ORB Midpoint");
    if (type === "profit") await discord.postProfitTier("SPY", 1, 5, 2.88, 20);
    res.json({ ok: true, tested: type });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK]", JSON.stringify(req.body));
  if (!rh.getToken()) {
    var ok = await ensureLoggedIn();
    if (!ok) return res.status(403).json({ error: "Not connected to Robinhood" });
  }
  try {
    const result = await handleAlert(req.body);
    res.json(result);
  } catch (err) {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("ORB server listening on port " + PORT);
  await ensureLoggedIn();
  scheduleDailyReauth();
  discord.scheduleDailySummary();
  discord.scheduleMarketOpenMessages();
  discord.schedulePositionUpdates();
  profitManager.startProfitManager(rh.getToken.bind(rh));
  orbUtil.scheduleORBCapture();
  discord.startPaperEngine(rh.getToken.bind(rh));
});
