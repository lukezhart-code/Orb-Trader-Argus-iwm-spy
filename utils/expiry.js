// utils/expiry.js
// Configurable days-to-expiry per ticker. The source of truth is the persisted
// settings store (set from the dashboard), NOT an env var. Defaults: SPY=1, IWM=0.

var settings = require("./settings");

function getDTE(ticker) {
  return settings.getDTE(ticker);
}

// Returns a Date advanced by getDTE(ticker) trading days from today.
function getExpiryDate(ticker) {
  var dte = getDTE(ticker);
  var d = new Date();
  var added = 0;
  while (added < dte) {
    d.setDate(d.getDate() + 1);
    var day = d.getDay();
    if (day !== 0 && day !== 6) added++;   // skip Sat/Sun
  }
  return d;
}

function getExpiry(ticker) {            // "YYYY-MM-DD"
  return getExpiryDate(ticker).toISOString().split("T")[0];
}

function getDTELabel(ticker) {          // "0DTE" / "1DTE" / ...
  return getDTE(ticker) + "DTE";
}

// "June 12th" from "2026-06-12" (component parse — avoids timezone drift)
var MONTHS = ["January","February","March","April","May","June","July",
              "August","September","October","November","December"];
function formatExpiryLabel(ymd) {
  if (!ymd || ymd.indexOf("-") === -1) return ymd || "";
  var parts = ymd.split("-");
  var month = parseInt(parts[1], 10);
  var day = parseInt(parts[2], 10);
  var ord = (day % 10 === 1 && day !== 11) ? "st"
          : (day % 10 === 2 && day !== 12) ? "nd"
          : (day % 10 === 3 && day !== 13) ? "rd" : "th";
  return MONTHS[month - 1] + " " + day + ord;
}

// "$SPY 729 Call - June 12th"
function contractLabel(ticker, side, strike, ymd) {
  var s = (strike === null || strike === undefined) ? "?" : strike;
  var sideLabel = side === "call" ? "Call" : "Put";
  return "$" + ticker + " " + s + " " + sideLabel + " - " + formatExpiryLabel(ymd);
}

module.exports = { getDTE, getExpiryDate, getExpiry, getDTELabel, formatExpiryLabel, contractLabel };
