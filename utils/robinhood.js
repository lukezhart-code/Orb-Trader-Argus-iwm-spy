// Direct Robinhood API - modern 2026 auth flow
const https = require("https");
const crypto = require("crypto");

const RH_BASE = "api.robinhood.com";
let _token = null;
let _deviceToken = null;

function generateDeviceToken() {
  const rands = Array.from(crypto.randomBytes(16));
  const hexa = Array.from({length: 256}, (_, i) => (i + 256).toString(16).slice(1));
  let token = "";
  rands.forEach((r, i) => {
    token += hexa[r];
    if ([3, 5, 7, 9].includes(i)) token += "-";
  });
  return token;
}

function request(method, path, data, token, contentType) {
  return new Promise((resolve, reject) => {
    const isForm = contentType === "form";
    const body = data
      ? isForm
        ? Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
        : JSON.stringify(data)
      : null;

    const headers = {
      "Accept": "application/json",
      "Accept-Language": "en-US;q=1",
      "X-Robinhood-API-Version": "1.431.4",
      "Connection": "keep-alive",
      "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
    };
    if (isForm) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    } else {
      headers["Content-Type"] = "application/json";
    }
    if (token) headers["Authorization"] = "Bearer " + token;
    if (body) headers["Content-Length"] = Buffer.byteLength(body);

    const options = { hostname: RH_BASE, path, method, headers };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ raw }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(email, password, mfa_code) {
  if (!_deviceToken) _deviceToken = process.env.RH_DEVICE_TOKEN || generateDeviceToken();

  const payload = {
    client_id: "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS",
    expires_in: 86400,
    grant_type: "password",
    password: password,
    scope: "internal",
    username: email,
    device_token: _deviceToken,
    try_passkeys: false,
    token_request_path: "/login",
    create_read_only_secondary_token: true
  };
  if (mfa_code) payload.mfa_code = mfa_code;

  console.log("[AUTH] Attempting Robinhood login...");
  const data = await request("POST", "/oauth2/token/", payload, null, "form");

  if (data.access_token) {
    _token = data.access_token;
    console.log("[AUTH] Login successful");
    return { ok: true, token: _token };
  }

  if (data.verification_workflow) {
    const workflowId = data.verification_workflow.id;
    console.log("[AUTH] Verification required, workflow: " + workflowId);
    return { ok: false, verification_workflow: true, workflow_id: workflowId, device_token: _deviceToken, payload };
  }

  if (data.mfa_required) {
    console.log("[AUTH] MFA required");
    return { ok: false, mfa_required: true };
  }

  console.log("[AUTH_ERROR] " + JSON.stringify(data));
  return { ok: false, error: JSON.stringify(data) };
}

async function handleVerificationWorkflow(deviceToken, workflowId) {
  const pathfinderUrl = "/pathfinder/user_machine/";
  const machinePayload = { device_id: deviceToken, flow: "suv", input: { workflow_id: workflowId } };
  const machineData = await request("POST", pathfinderUrl, machinePayload, null, "json");
  const machineId = machineData.id;
  if (!machineId) throw new Error("No machine ID from pathfinder");
  console.log("[AUTH] Pathfinder machine ID: " + machineId);
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const inquiry = await request("GET", `/pathfinder/inquiries/${machineId}/user_view/`, null, null, "json");
    if (inquiry && inquiry.context && inquiry.context.sheriff_challenge) {
      const challenge = inquiry.context.sheriff_challenge;
      return { challenge_type: challenge.type, challenge_id: challenge.id, challenge_status: challenge.status, machine_id: machineId };
    }
  }
  throw new Error("Verification timeout");
}

async function completeWorkflow(machineId) {
  const payload = { sequence: 0, user_input: { status: "continue" } };
  for (let i = 0; i < 5; i++) {
    const res = await request("POST", `/pathfinder/inquiries/${machineId}/user_view/`, payload, null, "json");
    if (res && res.type_context && res.type_context.result === "workflow_status_approved") return true;
    await sleep(3000);
  }
  return true;
}

async function respondToSmsChallenge(challengeId, code) {
  return await request("POST", `/challenge/${challengeId}/respond/`, { response: code }, null, "json");
}

async function waitForPushApproval(challengeId) {
  const url = `/push/${challengeId}/get_prompts_status/`;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const res = await request("GET", url, null, null, "json");
    if (res && res.challenge_status === "validated") return true;
  }
  return false;
}

function setToken(token) { _token = token; }
function getToken() { return _token; }
function setDeviceToken(dt) { _deviceToken = dt; }

async function getQuote(ticker) {
  const res = await request("GET", `/quotes/${ticker}/`, null, _token, "json");
  return parseFloat(res.last_trade_price || res.ask_price || 0);
}

async function getOptionInstrument(ticker, expiry, strike, optionType) {
  const url = `/options/instruments/?chain_symbol=${ticker}&expiration_dates=${expiry}&strike_price=${strike}&type=${optionType}&state=active`;
  const res = await request("GET", url, null, _token, "json");
  const results = res.results || [];
  if (results.length > 0) return results[0];
  for (const offset of [1, -1, 2, -2, 5, -5]) {
    const url2 = `/options/instruments/?chain_symbol=${ticker}&expiration_dates=${expiry}&strike_price=${strike + offset}&type=${optionType}&state=active`;
    const res2 = await request("GET", url2, null, _token, "json");
    if (res2.results && res2.results.length > 0) return res2.results[0];
  }
  return null;
}

async function placeOptionOrder(ticker, side, contracts, expiry, strike, optionType) {
  const instrument = await getOptionInstrument(ticker, expiry, strike, optionType);
  if (!instrument) throw new Error(`No option found: ${ticker} ${expiry} ${strike} ${optionType}`);

  const instrumentUrl = instrument.url;
  const quoteRes = await request("GET", `/marketdata/options/?instruments=${encodeURIComponent(instrumentUrl)}`, null, _token, "json");
  const askPrice = quoteRes.results?.[0]?.ask_price || "1.00";
  const limitPrice = (parseFloat(askPrice) * 1.05).toFixed(2);

  const order = {
    account: `https://api.robinhood.com/accounts/${process.env.RH_ACCOUNT_NUMBER}/`,
    direction: "debit",
    legs: [{
      option: instrumentUrl,
      position_effect: "open",
      ratio_quantity: 1,
      side: "buy"
    }],
    override_day_trade_checks: false,
    override_dtbp_checks: false,
    price: limitPrice,
    quantity: String(contracts),
    time_in_force: "gfd",
    trigger: "immediate",
    type: "limit",
    ref_id: crypto.randomUUID()
  };

  console.log(`[ORDER] ${ticker} ${optionType} x${contracts} strike=${strike} expiry=${expiry} price=${limitPrice}`);
  const res = await request("POST", "/options/orders/", order, _token, "json");
  if (res.id) {
    console.log(`[ORDER_OK] ${res.id}`);
    return { ok: true, order_id: res.id, price: limitPrice };
  }
  console.log("[ORDER_ERROR]", JSON.stringify(res));
  throw new Error(JSON.stringify(res));
}

async function closeOptionPosition(ticker, contracts, reason) {
  const positions = await request("GET", "/options/positions/?nonzero=true", null, _token, "json");
  const matching = (positions.results || []).filter(p => p.chain_symbol === ticker && parseFloat(p.quantity) > 0);
  if (!matching.length) return { ok: false, error: "No open position found" };

  const pos = matching[0];
  const quoteRes = await request("GET", `/marketdata/options/?instruments=${encodeURIComponent(pos.option)}`, null, _token, "json");
  const bidPrice = quoteRes.results?.[0]?.bid_price || "0.10";
  const limitPrice = (parseFloat(bidPrice) * 0.95).toFixed(2);

  const expiry = pos.expiration_date || pos.option.split("/").slice(-2)[0];
  const strike = pos.strike_price;
  const optionType = pos.option_type;

  const instrument = await getOptionInstrument(ticker, expiry, strike, optionType);
  if (!instrument) return { ok: false, error: "Could not find instrument to close" };

  const order = {
    account: `https://api.robinhood.com/accounts/${process.env.RH_ACCOUNT_NUMBER}/`,
    direction: "credit",
    legs: [{
      option: instrument.url,
      position_effect: "close",
      ratio_quantity: 1,
      side: "sell"
    }],
    price: limitPrice,
    quantity: String(contracts),
    time_in_force: "gfd",
    trigger: "immediate",
    type: "limit",
    ref_id: crypto.randomUUID()
  };

  console.log(`[CLOSE] ${ticker} selling ${contracts}c — ${reason}`);
  const res = await request("POST", "/options/orders/", order, _token, "json");
  if (res.id) return { ok: true, order_id: res.id, contracts, reason };
  console.log("[CLOSE_ERROR]", JSON.stringify(res));
  throw new Error(JSON.stringify(res));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function refreshToken(refreshTokenValue) {
  var payload = {
    client_id: "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS",
    expires_in: 86400,
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    scope: "internal"
  };
  try {
    var data = await request("POST", "/oauth2/token/", payload, null, "form");
    if (data.access_token) {
      _token = data.access_token;
      if (data.refresh_token) process.env.RH_REFRESH_TOKEN = data.refresh_token;
      console.log("[AUTH] Token refreshed successfully");
      return { ok: true, token: _token };
    }
    return { ok: false, error: JSON.stringify(data) };
  } catch(err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  login, setToken, getToken, setDeviceToken, refreshToken,
  handleVerificationWorkflow, completeWorkflow,
  respondToSmsChallenge, waitForPushApproval,
  getQuote, placeOptionOrder, closeOptionPosition
};
