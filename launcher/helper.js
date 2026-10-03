"use strict";

// The EveJS Launcher's helper protocol, implemented for this mod.
//
// The launcher runs this file as `node launcher/helper.js --request <json file>
// --result <json file>`, handing over an envelope like
//
//   { protocol: 1, requestId: "...", action: "verify",
//     runtime: { evejsRoot, clientRoot, backend, ... } }
//
// and reading back
//
//   { protocol, requestId, success, state, message,
//     restartRequired: [], contributions: [], environment: {}, arguments: [] }
//
// Every action answers, always with the request id, and a failure is reported in
// the result rather than thrown: a helper that throws leaves the launcher with no
// answer at all.
//
// This mod is **server-side only**. It installs as an ordinary loader mod (the
// launcher enables the manifest entry; there is no payload renaming and no vendor
// file to patch), and it has no client component, so there is nothing to deliver to
// a client and nothing to undo outside the mod folder.

const fs = require("node:fs");
const path = require("node:path");

const PROTOCOL = 1;
const ACTIONS = Object.freeze([
  "install",
  "verify",
  "prepare_profile",
  "prepare_disable",
  "prepare_remove",
  "recover",
]);
// The only host feature this helper reacts to. Advertised by the launcher in
// EVEJS_LAUNCHER_HELPER_FEATURES; when it is absent the envelope simply carries no
// clientScriptDelivery field.
const CLIENT_SCRIPT_DELIVERY_FEATURE = "client-script-delivery-v1";

const READY_MESSAGE = "autoSkyHookDeploy is ready: server-side /ash commands that conjure "
  + "and remove Orbital Skyhooks (typeID 81080). No client component, no vendor file "
  + "patched, nothing to restore.";
const NO_CLIENT_MESSAGE = "autoSkyHookDeploy is server-side only: there is no client "
  + "delivery, no login handshake and no client file to write.";

function readModVersion(modRoot) {
  try {
    const text = fs.readFileSync(path.join(modRoot, "loader.js"), "utf8");
    const match = /const MOD_VERSION = "([^"]+)"/u.exec(text);
    return match ? match[1] : "unknown";
  } catch (_error) {
    return "unknown";
  }
}

function baseResult(request, state, message) {
  return {
    protocol: PROTOCOL,
    requestId: request && request.requestId,
    success: true,
    state,
    message,
    restartRequired: [],
    contributions: [],
    environment: {},
    arguments: [],
  };
}

// Exported so the suite can drive the protocol without spawning a process.
function execute(request, features = process.env.EVEJS_LAUNCHER_HELPER_FEATURES || "", modRoot = path.resolve(__dirname, "..")) {
  const envelope = request && typeof request === "object" ? request : {};
  const action = String(envelope.action || "");
  try {
    if (!ACTIONS.includes(action)) {
      const result = baseResult(envelope, "error", `unsupported helper action "${action}"`);
      result.success = false;
      return result;
    }
    const hostSupportsClientDelivery = String(features)
      .split(",")
      .map((entry) => entry.trim())
      .includes(CLIENT_SCRIPT_DELIVERY_FEATURE);
    const version = readModVersion(modRoot);
    const runtime = envelope.runtime && typeof envelope.runtime === "object" ? envelope.runtime : {};
    const backend = String(runtime.backend || "unknown");

    if (action === "prepare_profile") {
      // Nothing to write on the client side. The envelope still carries the field
      // when the host advertises the feature, because that is how the launcher knows
      // there is nothing to deliver.
      const result = baseResult(envelope, "ready", NO_CLIENT_MESSAGE);
      if (hostSupportsClientDelivery) result.clientScriptDelivery = "none";
      return result;
    }

    if (action === "prepare_disable" || action === "prepare_remove") {
      // The mod owns exactly one folder and writes nothing else: no preload entry of
      // its own to strip (the launcher owns that), no vendor file patched, no client
      // file touched, no database row. So there is nothing to undo here.
      const result = baseResult(
        envelope,
        "ready",
        `autoSkyHookDeploy v${version}: nothing outside the mod folder needs undoing - no `
        + "client file, no vendor file and no database row is modified. Skyhooks that are "
        + "already deployed stay in the game world; they are game state, not mod state.",
      );
      result.restartRequired = ["game_server"];
      return result;
    }

    // install / verify / recover
    const result = baseResult(
      envelope,
      "ready",
      `${READY_MESSAGE} version ${version}, backend ${backend}.`,
    );
    if (action === "install") {
      // The launcher enables the manifest entry and starts the server; the mod needs
      // no preload registration of its own, so nothing is contributed here.
      result.message += " Configuration is optional: settings.json (or the environment) "
        + "overrides config/autoSkyHookDeploy.json.";
    }
    if (action === "recover") {
      result.message += " A region run never resumes by itself, and every system it "
        + "worked was committed as a whole, so nothing is left half-done to recover.";
    }
    return result;
  } catch (error) {
    // Last resort: answer, never throw.
    const result = baseResult(envelope, "error", `helper failed: ${(error && error.message) || error}`);
    result.success = false;
    return result;
  }
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (require.main === module) {
  const requestFile = readArgument("--request");
  const resultFile = readArgument("--result");
  let request = null;
  let readError = null;
  try {
    request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  } catch (error) {
    readError = (error && error.message) || String(error);
  }
  let result = null;
  if (readError) {
    result = execute(null);
    result.message = `the request file could not be read: ${readError}`;
  } else {
    result = execute(request);
  }
  if (resultFile) {
    try {
      fs.writeFileSync(resultFile, JSON.stringify(result));
    } catch (_writeError) {
      console.error(JSON.stringify(result));
    }
  } else {
    console.log(JSON.stringify(result));
  }
}

module.exports = { ACTIONS, PROTOCOL, execute };
