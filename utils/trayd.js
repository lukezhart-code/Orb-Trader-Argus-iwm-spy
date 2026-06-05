var rh = require("./robinhood");
var stateModule = require("./state");

function getExpiry(ticker) {
  var target = new Date();
  if (ticker === "SPY") {
    target.setDate(target.getDate() + 1);
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }
  }
  return target.toISOString().split("T")[0];
}

async function placeOrder(opts) {
  var expiry = getExpiry(opts.ticker);
  var price = await rh.getQuote(opts.ticker);
  var strike = Math.round(price);
  console.log("[ORDER] " + opts.ticker + " " + opts.side + " x" + opts.contracts + " strike=" + strike + " expiry=" + expiry);
  var result = await rh.placeOptionOrder(opts.ticker, opts.side, opts.contracts, expiry, strike, opts.side);
  return { ticker: opts.ticker, side: opts.side, strike: strike, expiry: expiry, contracts: opts.contracts, result: result };
}

async function closePartialPosition(opts) {
  console.log("[CLOSE] " + opts.ticker + " selling " + opts.contracts + "c: " + opts.reason);
  return await rh.closeOptionPosition(opts.ticker, opts.contracts, opts.reason);
}

module.exports = { placeOrder: placeOrder, closePartialPosition: closePartialPosition };
