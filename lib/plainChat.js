"use strict";

// Consumes the "!ash ..." line out of ordinary chat.
//
// This is the one command channel a character without staff rights has, and it
// cannot go through chatCommands.executeChatCommand: the client sends every line
// it prefixes with "/" as a slash.SlashCmd call and everything else as a plain
// chat message, which xmppStubServer hands to chatRuntime and then broadcasts
// unconditionally (a plain line never reaches executeChatCommand at all).
//
// The broadcaster is the seam. Its caller wraps the call:
//
//   try { sendResult = chatRuntime.broadcastLocalMessage(session, body); }
//   catch (error) { sendSystemMessageToClient(client, roomJid,
//                     formatChannelAccessError(error, "speak")); return; }
//
// and formatChannelAccessError returns error.message for any error whose code it
// does not recognise. Throwing therefore does exactly what this mod needs: the
// reply goes to the sender alone as a system line and the broadcast, the backlog
// entry and the delivery to everybody else are all skipped. No .code is ever set
// on that error: a recognised code would be translated into a different message.
const OVERLAY_MARKER = Symbol.for("evejs.autoSkyHookDeploy.plainChat");
const OVERLAY_VERSION = "1.0.0";
const FALLBACK_MESSAGE = "autoSkyHookDeploy: the command produced no reply.";

// chatRuntime exports the two entry points the chat layer uses for a player
// message: broadcastLocalMessage(session, message) for the local system channel
// and sendChannelMessage(session, roomName, message) for every other channel.
const CHANNELS = Object.freeze([
  Object.freeze({ name: "broadcastLocalMessage", messageIndex: 1 }),
  Object.freeze({ name: "sendChannelMessage", messageIndex: 2 }),
]);

function install(upstream, options = {}) {
  if (!upstream || typeof upstream !== "object") {
    throw new Error("ASHD_CHAT_RUNTIME_INVALID");
  }
  if (upstream[OVERLAY_MARKER]) {
    return upstream;
  }
  const runtime = options.runtime;
  const config = options.config || {};
  const chatCommand = options.chatCommand;
  const logError = typeof options.logError === "function" ? options.logError : () => {};
  if (!runtime || !chatCommand || typeof chatCommand.matchTrigger !== "function") {
    throw new Error("ASHD_CHAT_RUNTIME_INVALID");
  }

  const hooked = [];
  for (const channel of CHANNELS) {
    const original = upstream[channel.name];
    if (typeof original !== "function" || original[OVERLAY_MARKER] === true) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(upstream, channel.name);
    if (!descriptor || descriptor.writable !== true) {
      continue;
    }
    const wrapped = function autoSkyHookDeployPlainChat() {
      const raw = arguments[channel.messageIndex];
      const trimmed = String(raw == null ? "" : raw).trim();
      const argument = chatCommand.matchTrigger(trimmed, config);
      if (argument === null) {
        return original.apply(this, arguments);
      }
      let message = "";
      try {
        message = chatCommand.handleCommand(runtime, config, arguments[0], argument).message;
      } catch (error) {
        logError(`plain-chat command failed: ${error && error.message}`);
        message = `autoSkyHookDeploy: the command failed (${error && error.message}).`;
      }
      // Deliberately an error with no recognised code: see the note above. It is
      // the reply, not a failure, and it is what keeps the line out of the
      // channel.
      throw new Error(message || FALLBACK_MESSAGE);
    };
    wrapped[OVERLAY_MARKER] = true;
    upstream[channel.name] = wrapped;
    hooked.push(channel.name);
  }
  if (hooked.length === 0) {
    logError(
      "chatRuntime exports neither broadcastLocalMessage nor sendChannelMessage - "
      + "the plain-chat !ash trigger is unavailable and only /ash works",
    );
    return upstream;
  }

  Object.defineProperty(upstream, OVERLAY_MARKER, {
    value: Object.freeze({
      version: OVERLAY_VERSION,
      hooked: Object.freeze(hooked),
    }),
    enumerable: false,
  });
  return upstream;
}

module.exports = {
  CHANNELS,
  FALLBACK_MESSAGE,
  OVERLAY_MARKER,
  OVERLAY_VERSION,
  install,
};
