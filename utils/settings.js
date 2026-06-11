// utils/settings.js
// App settings persisted to durable storage (survives redeploys when a Railway
// volume is attached). Currently holds per-ticker DTE, set from the dashboard.

var fs = require("fs");
var persist = require("./persist");
var FILE = persist.filePath("orb-settings.json");

var DEFAULTS = { dte: { SPY: 1, IWM: 0 } };

function deepDefault() { return JSON.parse(JSON.stringify(DEFAULTS)); }

function normalize(s) {
  s = s || {};
  s.dte = s.dte || {};
  if (typeof s.dte.SPY !== "number") s.dte.SPY = DEFAULTS.dte.SPY;
  if (typeof s.dte.IWM !== "number") s.dte.IWM = DEFAULTS.dte.IWM;
  return s;
}

function load() {
  try {
    if (fs.existsSync(FILE)) return normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (e) { console.log("[SETTINGS] load failed: " + e.message); }
  return deepDefault();
}

var settings = load();

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(settings)); }
  catch (e) { console.log("[SETTINGS] save failed: " + e.message); }
}

function getDTE(ticker) {
  var v = settings.dte[ticker];
  return typeof v === "number" ? v : (ticker === "SPY" ? 1 : 0);
}

function setDTE(ticker, val) {
  var n = parseInt(val, 10);
  if (isNaN(n) || n < 0 || n > 5) return getDTE(ticker);
  settings.dte[ticker] = n;
  save();
  return n;
}

function getAll() {
  return { dte: { SPY: getDTE("SPY"), IWM: getDTE("IWM") }, durable: persist.isDurable() };
}

module.exports = { getDTE, setDTE, getAll, FILE };
