var rh = require("./robinhood");
var stateModule = require("./state");
var expiryUtil = require("./expiry");

function getExpiry(ticker) {
  return expiryUtil.getExpiry(ticker);
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
