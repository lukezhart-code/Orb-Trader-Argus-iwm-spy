var rh = require("./robinhood");
var stateModule = require("./state");

var pendingWorkflow = null; // stores workflow state waiting for user approval

async function refreshAccessToken() {
  var refreshToken = process.env.RH_REFRESH_TOKEN;
  if (!refreshToken) return false;
  try {
    stateModule.logEvent("AUTH", "Refreshing access token...");
    var result = await rh.refreshToken(refreshToken);
    if (result.ok) {
      stateModule.logEvent("AUTH", "Token refreshed successfully");
      return true;
    }
    stateModule.logEvent("AUTH_ERROR", "Token refresh failed: " + result.error);
    return false;
  } catch(err) {
    stateModule.logEvent("AUTH_ERROR", "Token refresh error: " + err.message);
    return false;
  }
}

async function validateWhopLicense() {
  var licenseKey = process.env.WHOP_LICENSE_KEY;
  var apiKey = process.env.WHOP_API_KEY;
  if (!licenseKey) {
    stateModule.logEvent("LICENSE_ERROR", "WHOP_LICENSE_KEY not set — trading disabled");
    return false;
  }
  if (!apiKey) {
    stateModule.logEvent("LICENSE_ERROR", "WHOP_API_KEY not set — trading disabled");
    return false;
  }
  try {
    var https = require("https");
    var result = await new Promise((resolve, reject) => {
      var options = {
        hostname: "api.whop.com",
        path: "/api/v2/memberships/validate_license",
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json"
        }
      };
      var body = JSON.stringify({ license_key: licenseKey });
      options.headers["Content-Length"] = Buffer.byteLength(body);
      var req = https.request(options, (res) => {
        var raw = "";
        res.on("data", chunk => raw += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch(e) { resolve({ raw }); }
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    if (result.valid === true) {
      stateModule.logEvent("LICENSE_OK", "Whop license valid");
      return true;
    }
    stateModule.logEvent("LICENSE_INVALID", "Invalid license: " + (result.error || result.message || JSON.stringify(result)));
    return false;
  } catch(err) {
    stateModule.logEvent("LICENSE_ERROR", "License check failed: " + err.message);
    return false;
  }
}

async function ensureLoggedIn() {
  if (rh.getToken()) {
    stateModule.logEvent("AUTH", "Already logged in");
    return true;
  }

  // Try refresh token first (never expires, best option)
  var refreshToken = process.env.RH_REFRESH_TOKEN;
  if (refreshToken) {
    var refreshed = await refreshAccessToken();
    if (refreshed) return true;
  }

  // Fall back to stored access token
  var storedToken = process.env.RH_TOKEN;
  if (storedToken) {
    rh.setToken(storedToken);
    stateModule.logEvent("AUTH", "Using stored RH_TOKEN — connected");
    return true;
  }

  var email = process.env.RH_EMAIL;
  var password = process.env.RH_PASSWORD;
  var mfa = process.env.RH_MFA_CODE;

  stateModule.logEvent("AUTH", "Logging into Robinhood...");
  var result = await rh.login(email, password, mfa);

  if (result.ok) {
    stateModule.logEvent("AUTH", "Login successful");
    pendingWorkflow = null;
    return true;
  }

  if (result.verification_workflow) {
    stateModule.logEvent("AUTH", "Robinhood verification required — checking for challenge...");
    try {
      var challenge = await rh.handleVerificationWorkflow(result.device_token, result.workflow_id);
      pendingWorkflow = {
        challenge_id: challenge.challenge_id,
        challenge_type: challenge.challenge_type,
        machine_id: challenge.machine_id,
        device_token: result.device_token,
        workflow_id: result.workflow_id,
        email: email,
        password: password
      };

      if (challenge.challenge_type === "prompt") {
        stateModule.logEvent("AUTH", "Push notification sent to Robinhood app — tap Approve on your phone");
        // Wait for push approval
        var approved = await rh.waitForPushApproval(challenge.challenge_id);
        if (approved) {
          await rh.completeWorkflow(challenge.machine_id);
          var retry = await rh.login(email, password, mfa);
          if (retry.ok) {
            stateModule.logEvent("AUTH", "Login successful after push approval");
            pendingWorkflow = null;
            return true;
          }
        }
      } else if (challenge.challenge_type === "sms" || challenge.challenge_type === "email") {
        stateModule.logEvent("AUTH_CHALLENGE", "SMS/email code required — enter it in the dashboard Reconnect flow");
      }
    } catch(err) {
      stateModule.logEvent("AUTH_ERROR", "Verification failed: " + err.message);
    }
    return false;
  }

  if (result.mfa_required) {
    stateModule.logEvent("AUTH_ERROR", "MFA required — add RH_MFA_CODE to Railway variables");
    return false;
  }

  stateModule.logEvent("AUTH_ERROR", "Login failed: " + result.error);
  return false;
}

async function submitSmsCode(code) {
  if (!pendingWorkflow) return { ok: false, error: "No pending verification" };
  try {
    await rh.respondToSmsChallenge(pendingWorkflow.challenge_id, code);
    await rh.completeWorkflow(pendingWorkflow.machine_id);
    var retry = await rh.login(pendingWorkflow.email, pendingWorkflow.password);
    if (retry.ok) {
      stateModule.logEvent("AUTH", "Login successful after SMS code");
      pendingWorkflow = null;
      return { ok: true };
    }
    return { ok: false, error: "Login failed after SMS code" };
  } catch(err) {
    return { ok: false, error: err.message };
  }
}

function getPendingWorkflow() { return pendingWorkflow; }

function scheduleDailyReauth() {
  stateModule.logEvent("AUTH", "Daily reauth scheduler started");
  function msUntilNext9amET() {
    var now = new Date();
    var target = new Date();
    target.setUTCHours(13, 0, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }
  function scheduleNext() {
    var delay = msUntilNext9amET();
    stateModule.logEvent("AUTH", "Next reauth in " + Math.round(delay / 60000) + " min");
    setTimeout(async function() {
      rh.setToken(null); // force fresh login
      await ensureLoggedIn();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

module.exports = { ensureLoggedIn, submitSmsCode, getPendingWorkflow, scheduleDailyReauth };
