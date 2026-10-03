"use strict";

// The "/ash" command family: anchor, align, remove, unanchor, offset, stop, status, help.
//
// This is the Game Master spelling. The command arrives as a slash.SlashCmd, is
// handed to chatCommands.executeChatCommand, and this module overlays that
// export: a line addressed to this mod is answered here and a line that is not
// is passed to the previous function untouched, so every other command - the
// vendor's and any other loader mod's - keeps working.
//
// The ordinary-chat spelling ("!ash ...") never reaches executeChatCommand at
// all; it is consumed in lib/plainChat.js at the broadcaster instead.

const OVERLAY_MARKER = Symbol.for("evejs.autoSkyHookDeploy.chatCommand");
const OVERLAY_VERSION = "1.0.0";

const COMMAND_NAMES = Object.freeze(["ash"]);
const TRIGGER_NAMES = Object.freeze(["ash"]);
// Every subcommand has exactly two spellings: its word and one short form. The
// single-Skyhook verb is `remove`; the system-wide sweep is `unanchor`, because a
// command that takes an id and a command that takes a system are two commands.
const SUBCOMMANDS = Object.freeze({
  anchor: Object.freeze(["a"]),
  align: Object.freeze(["al"]),
  remove: Object.freeze(["r"]),
  unanchor: Object.freeze(["ua"]),
  offset: Object.freeze(["of"]),
  stop: Object.freeze(["st"]),
  status: Object.freeze(["s"]),
  help: Object.freeze(["h"]),
});
const ROOT_HELP_LINES = Object.freeze([
  "/ash anchor here|system <systemID>|region <regionID>",
  "/ash align [here|system <systemID>|region <regionID>]",
  "/ash remove <skyhookID>|\"<planet name>\"",
  "/ash unanchor here|system <systemID>|region <regionID>",
  "/ash stop",
  "/ash offset [<value>]",
  "/ash status [here|<systemID>]",
  "/ash help",
]);
const HELP_DETAIL_LINES = Object.freeze([
  "  /ash a  = /ash anchor",
  "  /ash al = /ash align",
  "  /ash r  = /ash remove",
  "  /ash ua = /ash unanchor",
  "  /ash st = /ash stop",
  "  /ash of = /ash offset",
  "  /ash s  = /ash status",
  "  /ash h  = /ash help",
  "  align moves the Skyhooks already deployed onto the configured offset, paced like a region",
  "  a region is worked one system at a time, after a countdown: NPC/faction space is "
    + "skipped and named, each system is verified and reported, and /ash stop cancels",
  "  offset takes kilometres (5 or 5km) or metres (5000m) and is saved for the next restart.",
  "Every subcommand also works in ordinary chat as !ash (for example !ash status here).",
]);

function normalizeWord(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function resolveWord(word, words) {
  const token = normalizeWord(word);
  if (!token) return null;
  for (const name of Object.keys(words)) {
    if (name === token || words[name].includes(token)) return name;
  }
  return null;
}

// The command was called `reanchor` (short form `ra`) before 1.0.0. That name is gone,
// deliberately not kept as an alias: an operator who types it from muscle memory gets a
// pointer at the new spelling instead of the generic refusal. Only these two words are
// matched - every other unknown word keeps its own refusal - and neither of them
// resolves to a subcommand, so nothing runs.
const RETIRED_NAMES = Object.freeze(["reanchor", "ra"]);

function retiredNameHint(word) {
  const token = normalizeWord(word);
  return RETIRED_NAMES.includes(token)
    ? `unknown command "${token}" - it is now /ash align (or /ash al)`
    : null;
}

// A single argument, with one layer of matching quotes removed: a name with spaces has
// to be quoted in chat, and the quotes are not part of the name.
function unquote(value) {
  const text = String(value == null ? "" : value).trim();
  const match = text.match(/^(["'])([\s\S]*)\1$/u);
  return (match ? match[2] : text).trim();
}

function buildHelpText(config = {}) {
  const lines = ["autoSkyHookDeploy - /ash", ...ROOT_HELP_LINES.map((line) => `  ${line}`)];
  lines.push(...HELP_DETAIL_LINES);
  if (config.allowDeploy === false) {
    lines.push("  (server: deploy is switched off)");
  }
  if (config.allowRemove === false) {
    lines.push("  (server: remove is switched off)");
  }
  return lines.join("\n");
}

function buildUsageText(problem) {
  return `${problem}\n${buildHelpText({})}`;
}

// "/ash ..." and "!ash ..." both land here. Returns the argument text when the
// line is addressed to this mod, or null when it belongs to somebody else.
function matchTrigger(trimmed, config = {}) {
  if (config.chatTrigger === false) return null;
  const match = String(trimmed == null ? "" : trimmed)
    .match(/^!\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/u);
  if (!match) return null;
  return TRIGGER_NAMES.includes(normalizeWord(match[1])) ? (match[2] || "") : null;
}

function matchCommand(trimmed, config = {}) {
  const text = String(trimmed == null ? "" : trimmed);
  if (text.startsWith("/")) {
    const match = text.slice(1).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s+([\s\S]*))?$/u);
    if (!match) return null;
    return COMMAND_NAMES.includes(normalizeWord(match[1])) ? (match[2] || "") : null;
  }
  return matchTrigger(text, config);
}

// Splits the text after the command name. `token` is deliberately left as typed:
// the runtime decides what "here" and a number mean.
function parseCommand(argumentText) {
  const text = String(argumentText == null ? "" : argumentText).trim();
  if (!text) {
    return { subcommand: null, token: "", rest: "", argumentText: "" };
  }
  const parts = text.split(/\s+/u);
  const subcommand = resolveWord(parts[0], SUBCOMMANDS);
  const token = parts.length > 1 ? parts[1] : "";
  const rest = parts.slice(2).join(" ");
  // Everything after the subcommand word, kept whole: a value that must be a
  // single token (an offset, an id) is validated against this, so trailing
  // rubbish is refused instead of silently ignored.
  const argument = parts.slice(1).join(" ");
  return { subcommand, token, rest, argumentText: argument, typed: parts[0] };
}

// The scope words: `here`, a bare system id, `system <id>` and `region <id>`. The
// runtime owns what a system or a region means; this only splits the words, so a
// missing or non-numeric argument is refused here with text.
function parseScope(parsed) {
  const word = normalizeWord(parsed.token);
  // The retired name is answered before anything is resolved, so `/ash align reanchor`
  // is a pointer rather than a system-id complaint.
  const retired = retiredNameHint(word);
  if (retired) {
    return { ok: false, error: retired };
  }
  if (word === "region") {
    const value = String(parsed.rest || "").trim();
    if (!value) {
      return { ok: false, error: "/ash region needs a region id, for example /ash region 10000043" };
    }
    if (!/^\d+$/u.test(value)) {
      return { ok: false, error: `"${value}" is not a region id (a positive number)` };
    }
    return { ok: true, scope: { kind: "region", regionID: Number(value) } };
  }
  if (word === "system") {
    const value = String(parsed.rest || "").trim();
    if (!value) {
      return { ok: false, error: "/ash system needs a system id, for example /ash system 30000142" };
    }
    if (!/^\d+$/u.test(value)) {
      return { ok: false, error: `"${value}" is not a solar system id (a positive number)` };
    }
    return { ok: true, scope: { kind: "system", token: value } };
  }
  if (parsed.rest) {
    return {
      ok: false,
      error: `/ash takes one system or region, not "${parsed.argumentText}"`,
    };
  }
  return { ok: true, scope: { kind: "system", token: parsed.token } };
}

function handleCommand(runtime, config, session, argumentText) {
  const identity = runtime.callerIdentity(session);
  const parsed = parseCommand(argumentText);

  if (!parsed.subcommand) {
    if (parsed.typed) {
      const retired = retiredNameHint(parsed.typed);
      if (retired) {
        return { message: buildUsageText(`autoSkyHookDeploy: ${retired}.`) };
      }
      return {
        message: buildUsageText(
          `autoSkyHookDeploy: unknown subcommand "${parsed.typed}" `
          + "(anchor, align, remove, unanchor, offset, status or help).",
        ),
      };
    }
    return { message: buildHelpText(config) };
  }

  if (parsed.subcommand === "help") {
    return { message: buildHelpText(config) };
  }

  if (parsed.subcommand === "stop") {
    const result = runtime.stopRegionRun();
    return { message: result.message };
  }

  if (parsed.subcommand === "status") {
    const resolved = runtime.resolveSystemToken(parsed.token || "here", identity);
    if (!resolved.ok) {
      return { message: `autoSkyHookDeploy: ${resolved.error}.` };
    }
    const result = runtime.statusSystem(resolved.solarSystemID, identity);
    const message = runtime.describeStatus(result, {
      includeDestroyed: config.includeDestroyedInStatus !== false,
    });
    // An active run is reported here too, so progress is observable even when the
    // chat channel that carries its follow-ups is not working. The suffix is the same
    // one its per-system lines carry: systems done, time left.
    const run = runtime.regionRunStatus();
    return {
      message: run
        ? `${message}`
          + `\n  run in progress: ${run.kind} on ${run.label}, ${run.phase}, `
          + `${run.progress}`
        : message,
    };
  }

  if (parsed.subcommand === "align") {
    // With no argument this covers every system that holds a Skyhook - including ones
    // a player deployed by hand - so `allowDeploy` does not gate it: nothing is
    // created here, only moved.
    if (config.allowRemove === false) {
      return {
        message: "autoSkyHookDeploy: moving Skyhooks is switched off on this server "
          + "(EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_REMOVE=0).",
      };
    }
    const scoped = parsed.token ? parseScope(parsed) : { ok: true, scope: { kind: "all" } };
    if (!scoped.ok) {
      return { message: `autoSkyHookDeploy: ${scoped.error}.` };
    }
    const scope = runtime.resolveAlignScope(scoped.scope, identity);
    if (!scope.ok) {
      return { message: `autoSkyHookDeploy: ${scope.error}` };
    }
    const started = runtime.startRegionRun(scope, identity, session, "align");
    if (!started.ok) {
      return { message: `autoSkyHookDeploy: ${started.error}` };
    }
    return { message: started.message };
  }

  if (parsed.subcommand === "anchor") {
    if (config.allowDeploy === false) {
      return {
        message: "autoSkyHookDeploy: deploy is switched off on this server "
          + "(EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_DEPLOY=0).",
      };
    }
    if (!parsed.token) {
      return {
        message: buildUsageText(
          "autoSkyHookDeploy: /ash anchor needs here, system <systemID> or region <regionID>.",
        ),
      };
    }
    const scoped = parseScope(parsed);
    if (!scoped.ok) {
      return { message: `autoSkyHookDeploy: ${scoped.error}.` };
    }
    const scope = runtime.resolveScope(scoped.scope, identity);
    if (!scope.ok) {
      return { message: `autoSkyHookDeploy: ${scope.error}` };
    }
    // A region runs paced and abortable: the reply is the plan summary and the
    // countdown, and every later message arrives through the chat hub. A single
    // system is small enough to stay synchronous.
    if (scope.kind === "region") {
      const started = runtime.startRegionRun(scope, identity, session, "deploy");
      if (!started.ok) {
        return { message: `autoSkyHookDeploy: ${started.error}` };
      }
      return { message: started.message };
    }
    const result = runtime.applyScope(scope, identity);
    return { message: runtime.describeScopeDeploy(result) };
  }

  if (config.allowRemove === false) {
    return {
      message: "autoSkyHookDeploy: removal is switched off on this server "
        + "(EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_REMOVE=0).",
    };
  }

  if (parsed.subcommand === "offset") {
    const result = runtime.handleOffsetCommand(parsed.argumentText);
    // A configuration file that cannot be read is reported in text, and the last
    // good value is still shown: this must never throw out of a chat handler.
    const readNote = result.readError
      ? ` cannot read the configuration file: ${result.readError}.`
      : "";
    if (!result.ok) {
      return {
        message: `autoSkyHookDeploy: ${result.error}.${readNote} `
          + runtime.offsetUsageLine(result.meters),
      };
    }
    if (!result.changed) {
      return {
        message: `autoSkyHookDeploy:${readNote} ${runtime.offsetUsageLine(result.meters)}`,
      };
    }
    return {
      message: `autoSkyHookDeploy: offset set to ${runtime.describeOffsetValue(result.meters)} - `
        + "saved in the configuration file, and in effect from the next Skyhook onwards",
    };
  }

  if (parsed.subcommand === "remove") {
    // Either spelling: the Skyhook's own id, or the name of the planet it orbits, which
    // is what `/ash status` shows. A name with spaces is quoted.
    const target = unquote(parsed.argumentText);
    if (!target) {
      return {
        message: buildUsageText(
          "autoSkyHookDeploy: /ash remove needs the id of one Skyhook or the name of the "
          + "planet it orbits, for example /ash remove 9988400003181 or "
          + "/ash remove \"RYQC-I III\". To clear a whole system use /ash unanchor here.",
        ),
      };
    }
    // `here` (or a bare system id) is the sweep, which is a different command now.
    if (/^(here|current)$/iu.test(target)) {
      return {
        message: "autoSkyHookDeploy: /ash remove takes one Skyhook, not a system. "
          + "To clear every Skyhook in this system use /ash unanchor here.",
      };
    }
    const result = runtime.removeSkyhook(target, identity);
    if (!result.ok) {
      return { message: `autoSkyHookDeploy: ${result.error}` };
    }
    return { message: runtime.describeRemoval(result) };
  }

  // unanchor: the sweep, which is what /ash remove here used to be. The scope words
  // are the same as anchor's: here, system <id> or region <id>.
  if (!parsed.token) {
    return {
      message: buildUsageText(
        "autoSkyHookDeploy: /ash unanchor needs here, system <systemID> or region <regionID>.",
      ),
    };
  }
  const scoped = parseScope(parsed);
  if (!scoped.ok) {
    return { message: `autoSkyHookDeploy: ${scoped.error}.` };
  }
  const scope = runtime.resolveScope(scoped.scope, identity);
  if (!scope.ok) {
    return { message: `autoSkyHookDeploy: ${scope.error}` };
  }
  if (scope.kind === "region") {
    const started = runtime.startRegionRun(scope, identity, session, "unanchor");
    if (!started.ok) {
      return { message: `autoSkyHookDeploy: ${started.error}` };
    }
    return { message: started.message };
  }
  const result = runtime.unanchorScope(scope, identity);
  return { message: runtime.describeScopeRemoval(result) };
}

function install(upstream, options = {}) {
  if (!upstream || typeof upstream.executeChatCommand !== "function") {
    throw new Error("ASHD_CHAT_EXPORT_INVALID");
  }
  if (upstream[OVERLAY_MARKER]) {
    return upstream;
  }
  const runtime = options.runtime;
  const config = options.config || {};
  const logError = typeof options.logError === "function" ? options.logError : () => {};
  const onHub = typeof options.onHub === "function" ? options.onHub : () => {};
  if (!runtime || typeof runtime.buildPlan !== "function") {
    throw new Error("ASHD_CHAT_RUNTIME_INVALID");
  }

  const commandDescriptor = Object.getOwnPropertyDescriptor(upstream, "executeChatCommand");
  if (!commandDescriptor || commandDescriptor.writable !== true) {
    logError("chatCommands.executeChatCommand is not writable — no /ash hook installed");
    return upstream;
  }
  const previous = upstream.executeChatCommand;
  const commandList = upstream.AVAILABLE_SLASH_COMMANDS;
  if (Array.isArray(commandList) && Object.isExtensible(commandList)) {
    for (const name of COMMAND_NAMES) {
      if (!commandList.includes(name)) commandList.push(name);
    }
  }
  // A sibling mod may already have coerced this export from the vendor's array
  // into a joined string, so both shapes are handled and the lines are appended.
  const helpDescriptor = Object.getOwnPropertyDescriptor(upstream, "COMMANDS_HELP_TEXT");
  if (helpDescriptor && helpDescriptor.writable) {
    const current = upstream.COMMANDS_HELP_TEXT;
    if (Array.isArray(current)) {
      upstream.COMMANDS_HELP_TEXT = [...current, ...ROOT_HELP_LINES];
    } else {
      upstream.COMMANDS_HELP_TEXT = `${String(current == null ? "" : current)}\n${
        ROOT_HELP_LINES.join("\n")}`;
    }
  }

  function wrapped(session, rawMessage, chatHub, callOptions = {}) {
    let argument = null;
    try {
      argument = matchCommand(rawMessage, config);
    } catch (error) {
      logError(`could not inspect a chat line: ${error && error.message}`);
      return previous.apply(this, arguments);
    }
    if (argument === null) {
      return previous.apply(this, arguments);
    }
    // Report the hub before anything can fail: a paced run started by this command
    // delivers its follow-ups through the same channel this reply uses.
    try {
      onHub(session, chatHub);
    } catch (error) {
      logError(`could not record the chat hub: ${error && error.message}`);
    }
    let message = "";
    try {
      message = handleCommand(runtime, config, session, argument).message;
    } catch (error) {
      logError(`/ash command failed: ${error && error.message}`);
      message = `autoSkyHookDeploy: the command failed (${error && error.message}).`;
    }
    try {
      if (chatHub && session && callOptions.emitChatFeedback !== false) {
        chatHub.sendSystemMessage(
          session,
          message,
          callOptions.feedbackChannel || callOptions.channel || null,
        );
      }
    } catch (error) {
      logError(`could not deliver an /ash reply: ${error && error.message}`);
    }
    return { handled: true, message };
  }
  wrapped[OVERLAY_MARKER] = true;
  upstream.executeChatCommand = wrapped;

  Object.defineProperty(upstream, OVERLAY_MARKER, {
    value: Object.freeze({
      version: OVERLAY_VERSION,
      previous,
      wrapped,
      commands: COMMAND_NAMES,
      triggers: TRIGGER_NAMES,
      subcommands: Object.keys(SUBCOMMANDS),
    }),
    enumerable: false,
  });
  return upstream;
}

module.exports = {
  COMMAND_NAMES,
  HELP_DETAIL_LINES,
  OVERLAY_MARKER,
  OVERLAY_VERSION,
  ROOT_HELP_LINES,
  SUBCOMMANDS,
  TRIGGER_NAMES,
  buildHelpText,
  buildUsageText,
  handleCommand,
  install,
  matchCommand,
  matchTrigger,
  parseCommand,
  resolveWord,
};
