const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize } = require("./utils/state");
const { ensureLoggedIn, submitSmsCode, getPendingWorkflow, scheduleDailyReauth, validateWhopLicense } = require("./utils/reauth");
const rh = require("./utils/robinhood");

app.get("/manifest.json", (req, res) => {
  res.sendFile(require("path").join(__dirname, "dashboard", "manifest.json"));
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(require("path").join(__dirname, "dashboard", "sw.js"));
});
app.get("/icon.svg", (req, res) => {
  res.sendFile(require("path").join(__dirname, "dashboard", "icon.svg"));
});

app.get("/health", (req, res) => {
  res.json({ status: "running", time: new Date().toISOString(), auth: rh.getToken() ? "connected" : "disconnected" });
});

app.get("/api/buying-power", async (req, res) => {
  try {
    var token = rh.getToken();
    if (!token) return res.json({ buying_power: null });
    var https = require("https");
    var data = await new Promise((resolve, reject) => {
      var options = {
        hostname: "api.robinhood.com",
        path: "/accounts/" + process.env.RH_ACCOUNT_NUMBER + "/",
        headers: { "Authorization": "Bearer " + token, "Accept": "application/json" }
      };
      var req2 = https.request(options, (r) => {
        var raw = "";
        r.on("data", chunk => raw += chunk);
        r.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { resolve({}); } });
      });
      req2.on("error", reject);
      req2.end();
    });
    res.json({ buying_power: data.buying_power || data.cash || null });
  } catch(e) {
    res.json({ buying_power: null });
  }
});

app.get("/api/state", async (req, res) => {
  var s = getState();
  s.auth = { logged_in: !!rh.getToken(), pending: !!getPendingWorkflow() };
  var licenseKey = process.env.WHOP_LICENSE_KEY;
  s.license = { valid: !!licenseKey && licenseKey.length > 5, error: licenseKey ? null : "No license key set" };
  res.json(s);
});

app.post("/api/reauth", async (req, res) => {
  rh.setToken(null);
  var ok = await ensureLoggedIn();
  var pending = getPendingWorkflow();
  res.json({ ok: ok, pending_type: pending ? pending.challenge_type : null, message: ok ? "Connected to Robinhood" : pending ? "Check phone or enter SMS code" : "Login failed — check Railway logs" });
});

app.post("/api/license", async (req, res) => {
  var { licenseKey } = req.body;
  if (!licenseKey) return res.status(400).json({ error: "licenseKey required" });
  process.env.WHOP_LICENSE_KEY = licenseKey;
  var valid = await validateWhopLicense();
  res.json({ ok: valid, error: valid ? null : "Invalid or expired license" });
});

app.post("/api/sms", async (req, res) => {
  var code = req.body.code;
  if (!code) return res.status(400).json({ error: "code required" });
  var result = await submitSmsCode(code);
  res.json(result);
});

app.post("/api/contracts", (req, res) => {
  const { spy, iwm } = req.body;
  if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
  setContractSize(spy, iwm);
  res.json({ ok: true, contracts: getState().contracts });
});

app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK]", JSON.stringify(req.body));
  // Validate Whop license before every trade
  var licenseValid = await validateWhopLicense();
  if (!licenseValid) {
    return res.status(403).json({ error: "Invalid or expired license. Visit whop.com to manage your subscription." });
  }
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
});
