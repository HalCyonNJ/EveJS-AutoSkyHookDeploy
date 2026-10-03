"use strict";

/**
 * Auto Skyhook Deploy - updater.
 *
 * A reinstall is already an upgrade: install.js archives the mod folder it is
 * about to replace, copies the new payload over it, re-applies the same
 * idempotent preload registration and leaves everything the operator owns alone
 * - config/autoSkyHookDeploy.json and a local .env are only ever created when
 * they are missing. This entry point exists so that the run reports the version
 * it moved from and to, instead of asking the operator to uninstall first.
 *
 * Usage:
 *   node update.js                     (EveJS is found on this machine)
 *   node update.js --server "C:\path\to\EveJS"
 *   node update.js --server "C:\path\to\EveJS" --dry-run
 */

const { main } = require("./install");

if (require.main === module) {
  try {
    main("update");
  } catch (error) {
    if (!process.exitCode) process.exitCode = 1;
    if (process.env.EVEJS_AUTO_SKYHOOK_DEPLOY_DEBUG) process.stdout.write(`${error.stack}\n`);
  }
}
