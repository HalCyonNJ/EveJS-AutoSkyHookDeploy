"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const configModule = require("./config");
const chatCommand = require("./lib/chatCommand");
const plainChat = require("./lib/plainChat");
const { createRuntime, createServerDeps } = require("./lib/runtime");

const MOD_VERSION = "1.1.2";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[autoSkyHookDeploy]";
const INSTALL_FLAG = "__autoSkyHookDeployLoaderInstalled";
const API_SYMBOL = "evejs.autoSkyHookDeploy";
const CHAT_COMMANDS_MARKER = Symbol.for("evejs.autoSkyHookDeploy.chatCommands");
const CHAT_RUNTIME_MARKER = Symbol.for("evejs.autoSkyHookDeploy.chatRuntime");

// Two vendor files are touched, and neither is rewritten on disk: chatCommands
// through its exported executeChatCommand (the slash.SlashCmd path) and
// chatRuntime through its exported broadcastLocalMessage / sendChannelMessage
// (the ordinary-chat path). Every edit happens at load time through Module._load
// chaining, so the other loader mods - including the ones that overlay
// chatCommands themselves - keep working no matter which order they install in.
//
// The skyhook work itself needs no seam at all: it only runs when a command is
// typed, and the vendor modules it calls are required lazily at that moment.
const TARGETS = Object.freeze({
  chatCommands: "server/src/services/chat/chatCommands.js",
  chatRuntime: "server/src/_secondary/chat/chatRuntime.js",
});

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, error = null) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (error && error.stack) {
    console.error(error.stack);
  }
}

function canonicalize(filename, options = {}) {
  const platform = options.platform || process.platform;
  const resolved = path.resolve(String(filename || ""));
  const realpath = options.realpath || (fs.realpathSync.native || fs.realpathSync);
  let canonical;
  try {
    canonical = realpath(resolved);
  } catch (_error) {
    canonical = resolved;
  }
  if (platform === "win32") {
    return path.win32.normalize(canonical.replace(/\//gu, "\\")).toLowerCase();
  }
  return path.posix.normalize(canonical.replace(/\\/gu, "/"));
}

function resolveFilename(request, parent, isMain) {
  try {
    return Module._resolveFilename(request, parent, isMain);
  } catch (_error) {
    return null;
  }
}

function buildTargetMap(runtimeRoot, options = {}) {
  const targetMap = new Map();
  for (const [key, relative] of Object.entries(TARGETS)) {
    const filename = path.resolve(runtimeRoot, ...relative.split("/"));
    targetMap.set(canonicalize(filename, options), Object.freeze({
      key,
      relative,
      filename,
    }));
  }
  return targetMap;
}

// A region run answers with follow-up messages long after the command returned, so the
// loader needs a delivery path that works for the session that started it. Two are
// kept, in this order:
//
//   1. the chat hub the vendor handed to `executeChatCommand(session, message,
//      chatHub)`. The command's own reply travels through it, so it is the one channel
//      proven to reach that session. `chatCommand.install` reports every hub it sees.
//   2. the vendor's `broadcastLocalMessage`, captured when the chatRuntime seam is
//      patched - the ordinary-chat `!ash` path has no hub.
//
// If neither is available the message is logged at error level (never behind verbose)
// and reported as undelivered, so the run can stop instead of stalling silently.
let followUpSender = null;
// Assigned by `install()`; the lazy path must not reach for a binding that only exists
// inside a function (that bug dropped every follow-up until it was found live).
let chatRuntimeFilename = null;
let hubSessionKey = null;
let hubSender = null;

function deliveryTargets() {
  return { hub: hubSender, sender: followUpSender, filename: chatRuntimeFilename };
}

// Deliver one follow-up message (a countdown tick, a per-system result or the summary
// of a paced region run). Returns true only when something actually took it.
function deliverFollowUp(session, message) {
  // 1. The hub this session's command arrived on.
  const key = session && (session.characterID || session.charid || session.characterId);
  if (hubSender && (key == null || hubSessionKey == null || String(key) === String(hubSessionKey))) {
    try {
      hubSender(session, message);
      return true;
    } catch (error) {
      logError(`the chat hub refused a follow-up message: ${error && error.message}`);
    }
  }
  // 2. The vendor's own local broadcaster.
  if (followUpSender) {
    try {
      followUpSender(session, message);
      return true;
    } catch (error) {
      logError(`broadcastLocalMessage refused a follow-up message: ${error && error.message}`);
    }
  }
  // 3. Load the chatRuntime module on demand: patching it captures the broadcaster.
  if (!followUpSender && chatRuntimeFilename) {
    try {
      require(chatRuntimeFilename);
    } catch (error) {
      logError(`could not load the chat runtime for a follow-up message: ${error && error.message}`);
    }
    if (followUpSender) {
      try {
        followUpSender(session, message);
        return true;
      } catch (error) {
        logError(`broadcastLocalMessage refused a follow-up message: ${error && error.message}`);
      }
    }
  }
  // Undeliverable: say so unconditionally, because the operator is otherwise watching a
  // run that will never report anything.
  logError(
    `could not deliver a follow-up message for ${config0Suffix(session)}: no chat hub and no `
    + "broadcast channel is available; the run will be aborted so it cannot stall silently",
  );
  return false;
}

function config0Suffix(session) {
  const key = session && (session.characterID || session.charid || session.characterId);
  const name = session && (session.characterName || session.charName);
  return `${name ? `${name} ` : ""}(character ${key == null ? "unknown" : key})`;
}

function install(options = {}) {
  if (!isMainThread && options.allowWorker !== true) {
    return { active: false, reason: "worker-thread" };
  }
  if (globalThis[INSTALL_FLAG]) {
    return globalThis[INSTALL_FLAG];
  }

  const runtimeRoot = path.resolve(options.runtimeRoot || RUNTIME_ROOT);
  const environment = options.environment || process.env;
  const config = configModule.load(MOD_DIR, environment, { runtimeRoot });
  if (!config.enabled) {
    log("inert — disabled by configuration; /ash and !ash are not installed");
    return { active: false, reason: "disabled", config };
  }
  // Fail closed: a configuration problem installs no hooks at all, so the server
  // behaves exactly like vanilla and the offending key is named in the log.
  if (config.problems.length > 0) {
    for (const problem of config.problems) {
      logError(`invalid configuration: ${problem}`);
    }
    logError("invalid mod-owned configuration — no hooks installed");
    return { active: false, reason: "invalid-config", config };
  }

  const deps = options.deps || createServerDeps(runtimeRoot);
  // `/ash offset` reads and writes the configuration file itself, so a change takes
  // effect on the next command and survives a restart with no second file to keep in
  // sync. Every other key keeps its boot-time precedence.
  const liveConfig = options.liveConfig || configModule.createLiveConfig({
    // Whichever file is in force: the launcher's settings.json when it exists (it
    // outranks the config JSON), the installer's config JSON otherwise. The
    // installer's file is still never written while a settings.json is present.
    file: config.offsetFilename || config.configFilename,
    defaults: { offsetMeters: config.offsetMeters },
    limits: { offsetMeters: configModule.LIMITS.offsetMeters },
    log: config.verbose ? log : () => {},
    logError: (message, error) => logError(message, error),
  });
  const runtime = createRuntime({
    config,
    deps,
    liveConfig,
    sendTo: deliverFollowUp,
    version: `autoSkyHookDeploy v${MOD_VERSION}`,
    log: config.verbose ? log : () => {},
    logError: (message, error) => logError(message, error),
  });
  const targetMap = buildTargetMap(runtimeRoot, options);
  // The lazy fallback needs the chatRuntime filename at module scope: reaching for
  // `targetMap` inside a module-level function was the live bug this replaces.
  const chatRuntimeTarget = [...targetMap.values()].find((entry) => entry.key === "chatRuntime");
  chatRuntimeFilename = chatRuntimeTarget ? chatRuntimeTarget.filename : null;
  const previousLoad = Module._load;
  const applied = new Set();

  function applyTarget(target, exported) {
    if (!exported || typeof exported !== "object") {
      return exported;
    }
    if (target.key === "chatCommands") {
      return overlayChatCommands(exported);
    }
    return overlayChatRuntime(exported);
  }

  function overlayChatCommands(exported) {
    if (exported[CHAT_COMMANDS_MARKER] === true) {
      return exported;
    }
    try {
      chatCommand.install(exported, {
        runtime,
        config,
        logError: (message) => logError(message),
        // Every hub the vendor hands to a slash command is recorded: the command's own
        // reply travels through it, which makes it the proven channel for follow-ups.
        onHub: (session, chatHub) => {
          if (!chatHub || typeof chatHub.sendSystemMessage !== "function") return;
          hubSender = (target, message) => chatHub.sendSystemMessage(target, message, null);
          const key = session && (session.characterID || session.charid || session.characterId);
          hubSessionKey = key == null ? null : String(key);
        },
      });
      exported[CHAT_COMMANDS_MARKER] = true;
      if (!applied.has("chatCommands")) {
        applied.add("chatCommands");
        log(
          `slash command overlay installed — /${chatCommand.COMMAND_NAMES[0]} works for every `
          + "character and needs no staff rights",
        );
      }
    } catch (error) {
      logError(`slash command overlay failed: ${error && error.message}`);
    }
    return exported;
  }

  // The ordinary-chat path. A line without a leading "/" never becomes a
  // slash.SlashCmd call, so the !trigger has to be consumed where the message
  // would otherwise be broadcast; lib/plainChat.js explains why the thrown error
  // there is the reply rather than a failure.
  function overlayChatRuntime(exported) {
    if (exported[CHAT_RUNTIME_MARKER] === true) {
      return exported;
    }
    // Capture the vendor's own broadcaster **before** wrapping it: that is the
    // follow-up delivery path for a paced region run.
    try {
      const original = exported.broadcastLocalMessage;
      if (typeof original === "function") {
        followUpSender = (session, message) => original.call(exported, session, message);
      }
    } catch (error) {
      logError(`could not capture the chat broadcaster: ${error && error.message}`);
    }
    try {
      plainChat.install(exported, {
        runtime,
        config,
        chatCommand,
        logError: (message) => logError(message),
      });
      exported[CHAT_RUNTIME_MARKER] = true;
      if (!applied.has("chatRuntime")) {
        applied.add("chatRuntime");
        log(
          `plain-chat trigger installed — !${chatCommand.TRIGGER_NAMES[0]} works for every `
          + "character, staff or not, and the line is never broadcast",
        );
      }
    } catch (error) {
      logError(`plain-chat overlay failed: ${error && error.message}`);
    }
    return exported;
  }

  function tryApplyCachedTargets() {
    for (const filename of Object.keys(Module._cache)) {
      const target = targetMap.get(canonicalize(filename, options));
      if (!target) {
        continue;
      }
      const cached = Module._cache[filename];
      if (cached && cached.exports) {
        try {
          applyTarget(target, cached.exports);
        } catch (error) {
          logError(`cached target patch failed: ${error && error.message}`);
        }
      }
    }
  }

  function hookedLoad(request, parent, isMain) {
    const exported = previousLoad.apply(this, arguments);
    if (Module.isBuiltin(request)) {
      return exported;
    }
    const filename = resolveFilename(request, parent, isMain);
    if (!filename) {
      return exported;
    }
    const target = targetMap.get(canonicalize(filename, options));
    if (!target) {
      return exported;
    }
    try {
      return applyTarget(target, exported) || exported;
    } catch (error) {
      logError(`target patch failed: ${error && error.message}`);
      return exported;
    }
  }

  Module._load = hookedLoad;
  tryApplyCachedTargets();

  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    runtime,
    liveConfig,
    targets: Object.freeze({ ...TARGETS }),
    applied: () => [...applied],
  });
  const installState = Object.freeze({
    active: true,
    reason: null,
    config,
    runtime,
    liveConfig,
    targetMap,
    previousLoad,
    hookedLoad,
    api,
  });
  globalThis[API_SYMBOL] = api;
  globalThis[INSTALL_FLAG] = installState;
  log(
    `v${MOD_VERSION} loader ready — /${chatCommand.COMMAND_NAMES[0]} `
    + `anchor|align|remove|unanchor|stop|offset|status|help `
    + `and !${chatCommand.TRIGGER_NAMES[0]} work for every character; settings come from `
    + `${configModule.SETTINGS_FILENAME}, config/${configModule.CONFIG_FILENAME}, `
    + "the mod's .env or "
    + `${configModule.KEYS.enabled}`
    + (config.sources.length > 0 ? ` (read: ${config.sources.join(", ")})` : ""),
  );
  return installState;
}

let installResult = null;
try {
  installResult = install();
} catch (error) {
  logError("loader failed before activation", error);
  installResult = { active: false, reason: "exception", error };
}

module.exports = {
  API_SYMBOL,
  INSTALL_FLAG,
  LOG_PREFIX,
  MOD_DIR,
  MOD_VERSION,
  RUNTIME_ROOT,
  TARGETS,
  installResult,
  install,
  deliverFollowUp,
  _testing: Object.freeze({
    deliverFollowUp,
    buildTargetMap,
    canonicalize,
  }),
};
