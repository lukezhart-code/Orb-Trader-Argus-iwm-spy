var fs = require("fs");
var PERSIST_FILE = "/tmp/orb-state.json";

function loadPersistedState() {
  try {
    if (fs.existsSync(PERSIST_FILE)) {
      var saved = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
      return saved;
    }
  } catch(e) {}
  return null;
}

function savePersistedState() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({ contracts: state.contracts }));
  } catch(e) {}
}

var _saved = loadPersistedState();

let state = {
  contracts: (_saved && _saved.contracts) ? _saved.contracts : { SPY: 1, IWM: 1 },
  orb: {
    SPY: { high: null, low: null, mid: null, set: false },
    IWM: { high: null, low: null, mid: null, set: false }
  },
  positions: { SPY: null, IWM: null },
  lastReset: null,
  log: []
};

function getState() { return state; }

function resetDay() {
  var today = new Date().toDateString();
  if (state.lastReset !== today) {
    state.orb = {
      SPY: { high: null, low: null, mid: null, set: false },
      IWM: { high: null, low: null, mid: null, set: false }
    };
    state.positions = { SPY: null, IWM: null };
    state.lastReset = today;
    logEvent("DAY_RESET", "New day. Contracts SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
  }
}

function setORB(ticker, high, low) {
  var h = parseFloat(high);
  var l = parseFloat(low);
  var mid = parseFloat(((h + l) / 2).toFixed(4));
  state.orb[ticker] = { high: h, low: l, mid: mid, set: true };
  logEvent("ORB_SET", ticker + " High=" + h + " Low=" + l + " Mid=" + mid);
}

function getPosition(ticker) { return state.positions[ticker]; }

function openHalfPosition(ticker, side, contracts, entryPrice) {
  state.positions[ticker] = {
    side: side,
    halfIn: true,
    fullIn: false,
    contracts: contracts,
    totalContracts: contracts,
    entryPrice: parseFloat(entryPrice) || 0,
    breakEvenActivated: false,
    lastProfitTier: 0,
    stopped: false
  };
  logEvent("POSITION_OPEN", ticker + " " + side + " half " + contracts + "c @ $" + entryPrice);
}

function addSecondHalf(ticker, contracts, fillPrice) {
  var pos = state.positions[ticker];
  if (!pos || pos.fullIn) return;
  pos.contracts += contracts;
  pos.fullIn = true;
  pos.halfIn = false;
  logEvent("POSITION_ADD", ticker + " +half +" + contracts + "c @ $" + fillPrice + " total=" + pos.contracts);
}

function setBreakEven(ticker) {
  var pos = state.positions[ticker];
  if (pos && !pos.breakEvenActivated) {
    pos.breakEvenActivated = true;
    logEvent("BREAKEVEN", ticker + " breakeven stop activated @ entry $" + pos.entryPrice);
  }
}

function markProfitTier(ticker, tier) {
  var pos = state.positions[ticker];
  if (pos) pos.lastProfitTier = Math.max(pos.lastProfitTier, tier);
}

function closePosition(ticker, reason) {
  var pos = state.positions[ticker];
  if (pos) {
    pos.stopped = true;
    logEvent("POSITION_CLOSE", ticker + " closed: " + reason);
  }
}

function setContractSize(spy, iwm) {
  state.contracts.SPY = parseInt(spy) || 1;
  state.contracts.IWM = parseInt(iwm) || 1;
  savePersistedState();
  logEvent("CONTRACTS", "Size updated SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
}

function logEvent(type, message) {
  var entry = { time: new Date().toISOString(), type: type, message: message };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log("[" + type + "] " + message);
}

module.exports = {
  getState: getState,
  resetDay: resetDay,
  setORB: setORB,
  getPosition: getPosition,
  openHalfPosition: openHalfPosition,
  addSecondHalf: addSecondHalf,
  setBreakEven: setBreakEven,
  markProfitTier: markProfitTier,
  closePosition: closePosition,
  setContractSize: setContractSize,
  logEvent: logEvent
};
