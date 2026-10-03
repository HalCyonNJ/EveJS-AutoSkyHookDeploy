"use strict";

/**
 * Auto Skyhook Deploy - installer.
 *
 * The mod itself never edits EveJS source on disk; it is a loader that overlays
 * two exported chat functions in memory. What has to be registered is the
 * preload itself, and each deployment offers a different place to do it:
 *
 *   Docker  docker/entrypoint.sh   --require /app/mods/autoSkyHookDeploy/loader.js
 *   Native  StartServer.bat        NODE_OPTIONS=%NODE_OPTIONS% --require %EVEJS_REPO_ROOT%/mods/...
 *                                  (inherited by both npm start branches)
 *
 * Both registrations are idempotent, both are backed up before being written,
 * and `--server` may be pointed at either kind of checkout. The native one
 * appends to NODE_OPTIONS rather than assigning it, so it composes with other
 * loader mods instead of racing them for the variable.
 *
 * The mod's server configuration is seeded once into
 * <EveJS root>/config/autoSkyHookDeploy.json and never overwritten; an install
 * or update only adds keys a later release introduced.
 *
 * Usage:
 *   node install.js --server "D:\eve\v0.12.9"
 *   node install.js --server "D:\eve\v0.12.9" --dry-run
 *   node install.js --server "D:\eve\v0.12.9" --docker-only
 *   node install.js --status --server "D:\eve\v0.12.9"
 */

const fs = require("node:fs");
const path = require("node:path");

const deployment = require("./lib/deployment");
const register = require("./lib/register");

const INSTALLER_DIR = __dirname;
const COPY_EXCLUDES = new Set(deployment.DEV_ONLY_DIRECTORIES);
const COPY_EXCLUDED_FILES = new Set(deployment.DEV_ONLY_FILES);
const CONFIG_DIRNAME = "config";
const SERVER_CONFIG_FILE = "autoSkyHookDeploy.json";
const CONFIG_TEMPLATE_FILE = "config.example.json";

function out(line = "") {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  out("");
  out(`[FAIL] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    server: "",
    dockerOnly: false,
    nativeOnly: false,
    dryRun: false,
    force: false,
    status: false,
    update: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server" && argv[index + 1]) options.server = argv[(index += 1)];
    else if (arg.startsWith("--server=")) options.server = arg.slice("--server=".length);
    else if (arg === "--docker-only") options.dockerOnly = true;
    else if (arg === "--native-only") options.nativeOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--help" || arg === "-h") {
      out("Usage: node install.js [--server <EveJS root>] [--docker-only|--native-only]");
      out("                      [--dry-run] [--force] [--status] [--update]");
      process.exit(0);
    } else if (!arg.startsWith("--") && !options.server) options.server = arg;
  }
  if (options.dockerOnly && options.nativeOnly) {
    fail("--docker-only and --native-only are mutually exclusive");
  }
  return options;
}

// The payload is the mod folder shipped beside the installer (`mod/` and
// `autoSkyHookDeploy/` are both accepted), and this installer's parent
// directory in the development tree, where the mod is the checkout itself.
function payloadCandidates() {
  return [
    path.join(INSTALLER_DIR, deployment.PAYLOAD_DIRNAME),
    path.join(INSTALLER_DIR, deployment.MOD_ID),
    path.dirname(INSTALLER_DIR),
    path.join(path.dirname(INSTALLER_DIR), deployment.MOD_ID),
    path.dirname(path.dirname(INSTALLER_DIR)),
  ];
}

function resolvePayload() {
  const candidates = payloadCandidates();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "loader.js"))
      && fs.existsSync(path.join(dir, "evejs-launcher.mod.json"))) {
      let version = "unknown";
      try {
        version = JSON.parse(
          fs.readFileSync(path.join(dir, "evejs-launcher.mod.json"), "utf8"),
        ).version || version;
      } catch (_error) {
        version = "unknown";
      }
      return { dir, version };
    }
  }
  return fail("could not find the mod payload (loader.js + evejs-launcher.mod.json) next to this installer");
}

function promptForRoot(roots) {
  if (!process.stdin.isTTY) return "";
  out("Several EveJS installations were found:");
  roots.forEach((root, index) => out(`  [${index + 1}] ${root}`));
  out("  [0] none of these");
  process.stdout.write("  Choose one: ");
  const buffer = Buffer.alloc(64);
  let answer = "";
  try {
    const read = fs.readSync(0, buffer, 0, buffer.length, null);
    answer = buffer.slice(0, read).toString("utf8").trim();
  } catch (_error) {
    return "";
  }
  const choice = Number(answer);
  return Number.isInteger(choice) && choice >= 1 && choice <= roots.length ? roots[choice - 1] : "";
}

function resolveRoot(options) {
  const explicit = options.server || process.env.EVEJS_SERVER || process.env.EVEJS_ROOT || "";
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!deployment.isEveJsRoot(resolved)) {
      fail(`${resolved} does not look like an EveJS 0.12.9 root `
        + "(server/index.js and server/src/services/planet/planetOrbitalState.js must exist)");
    }
    return resolved;
  }

  const starts = [INSTALLER_DIR, process.cwd()];
  let roots = deployment.findEveJsRoots(starts);
  if (roots.length === 0) roots = deployment.findDeeperEveJsRoots(starts);
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) {
    fail("could not find an EveJS installation; pass --server <EveJS root>");
  }
  const chosen = promptForRoot(roots);
  if (chosen) return chosen;
  fail(`several EveJS installations were found; pass --server <root>. Candidates: ${roots.join(", ")}`);
}

function copyPayload(source, target) {
  fs.mkdirSync(target, { recursive: true });
  // Prune development-only leftovers so refreshing an existing install leaves
  // exactly the payload behind.
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name) || COPY_EXCLUDED_FILES.has(entry.name)) {
      fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name) || COPY_EXCLUDED_FILES.has(entry.name)) continue;
    // A local .env is the operator's configuration; never overwrite it on
    // reinstall. Delete it first if the shipped defaults are wanted.
    if (entry.name === ".env" && fs.existsSync(path.join(target, ".env"))) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyPayload(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

// The server configuration lives under <EveJS root>/config, which is
// bind-mounted under Docker: writing it needs a container restart, never an
// image rebuild. Values already there are never touched; only keys this release
// introduced are added.
function seedConfig(root, payload, options, hooks = {}) {
  const configDir = path.join(root, CONFIG_DIRNAME);
  const target = path.join(configDir, SERVER_CONFIG_FILE);
  const template = path.join(payload.dir, CONFIG_TEMPLATE_FILE);
  if (!fs.existsSync(template)) {
    out(`[SKIP] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE}: the payload carries no template`);
    return { created: false, added: [] };
  }
  let example = {};
  try {
    example = JSON.parse(fs.readFileSync(template, "utf8"));
  } catch (error) {
    out(`[WARN] ${CONFIG_TEMPLATE_FILE} is not valid JSON: ${error && error.message}`);
    return { created: false, added: [] };
  }
  const keys = Object.keys(example).filter((key) => !key.startsWith("_"));
  if (!fs.existsSync(target)) {
    if (options.dryRun) {
      out(`[PLAN] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE}: would create it from ${CONFIG_TEMPLATE_FILE}`);
      return { created: true, added: keys };
    }
    deployment.ensureDirectory(configDir);
    fs.writeFileSync(target, `${JSON.stringify(example, null, 2)}\n`, "utf8");
    out(`[ OK ] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE}: created from ${CONFIG_TEMPLATE_FILE}`);
    return { created: true, added: keys };
  }

  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    out(`[WARN] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE} is not valid JSON; left exactly as it is`);
    return { created: false, added: [] };
  }
  const added = keys.filter((key) => !(key in current));
  if (added.length === 0) {
    out(`[SKIP] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE}: present and complete`);
    return { created: false, added: [] };
  }
  if (options.dryRun) {
    out(`[PLAN] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE}: would add ${added.join(", ")}`);
    return { created: false, added };
  }
  const next = { ...current };
  for (const key of added) next[key] = example[key];
  if (typeof hooks.archiveOnce === "function") hooks.archiveOnce(target);
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  out(`[ OK ] ${CONFIG_DIRNAME}/${SERVER_CONFIG_FILE}: added ${added.join(", ")}`);
  return { created: false, added };
}

function applyRegistration(options) {
  const { file, label, result, write } = options;
  if (!result.ok) {
    out(`[WARN] ${label}: ${result.reason}`);
    out(`       ${label} was left untouched; register the preload by hand:`);
    out(`       ${file}`);
    return { changed: false, failed: true };
  }
  if (!result.changed) {
    out(`[SKIP] ${label}: preload already registered`);
    return { changed: false, failed: false };
  }
  if (options.dryRun) {
    out(`[PLAN] ${label}: would ${result.upgraded ? "upgrade" : "add"} ${options.preload}`);
    return { changed: true, failed: false };
  }
  write();
  if (result.upgraded) {
    out(`[ OK ] ${label}: upgraded the preload block to the append-only form`);
  } else {
    out(`[ OK ] ${label}: added ${options.preload}`);
  }
  return { changed: true, failed: false };
}

function reportStatus(root, payload, deployments) {
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const installed = fs.existsSync(path.join(modDir, "loader.js"));
  out(`EveJS root : ${root}`);
  out(`Mod folder : ${modDir}`);
  out(`             ${installed
    ? `installed (${deployment.digestTree(modDir).slice(0, 12)}${
      payload ? `, shipped ${deployment.digestTree(payload.dir).slice(0, 12)}` : ""})`
    : "not installed"}`);
  if (payload) {
    const installedManifest = path.join(modDir, "evejs-launcher.mod.json");
    if (fs.existsSync(installedManifest)) {
      try {
        const version = JSON.parse(deployment.readText(installedManifest)).version;
        out(`Version    : installed v${version}, payload v${payload.version}`);
      } catch (_error) {
        out(`Version    : installed manifest is unreadable, payload v${payload.version}`);
      }
    }
  }
  if (deployments.docker.present) {
    const text = deployment.readText(deployments.docker.entrypoint);
    const registered = register.hasEntrypointPreload(text, {
      requirePath: register.containerRequirePath(deployment.MOD_ID),
    });
    out(`Docker     : ${registered ? "registered" : "NOT registered"} (${deployments.docker.entrypoint})`);
  }
  if (deployments.native.present) {
    const text = deployment.readText(deployments.native.startServerBat);
    const registered = register.hasStartServerPreload(text);
    const current = registered && register.startServerPreloadIsCurrent(text, {
      requirePath: register.nativeRequirePath(deployment.MOD_ID),
      existPath: register.nativeExistPath(deployment.MOD_ID),
    });
    const state = !registered ? "NOT registered" : current ? "registered" : "registered (legacy form)";
    out(`Native     : ${state} (${deployments.native.startServerBat})`);
    if (registered && !current) {
      out("             re-run the installer to upgrade it to the append-only form");
    }
  }
  const configFile = path.join(root, CONFIG_DIRNAME, SERVER_CONFIG_FILE);
  out(`Config     : ${fs.existsSync(configFile) ? configFile : `${configFile} (missing, defaults are in use)`}`);
  return installed;
}

function main(mode = "install") {
  const options = parseArgs(process.argv.slice(2));
  const updating = mode === "update" || options.update === true;
  const payload = resolvePayload();
  const root = resolveRoot(options);
  const deployments = deployment.detectDeployments(root);

  if (options.status) {
    reportStatus(root, payload, deployments);
    return;
  }

  const useDocker = deployments.docker.present && !options.nativeOnly;
  const useNative = deployments.native.present && !options.dockerOnly;
  if (!useDocker && !useNative) {
    fail(`no ${options.dockerOnly ? "Docker" : "native"} integration point found under ${root}`);
  }

  out("============================================================");
  out(`  Auto Skyhook Deploy v${payload.version} - ${updating ? "Updater" : "Installer"}`);
  out("============================================================");
  out(`  EveJS root : ${root}`);
  out(`  Payload    : ${payload.dir}`);
  out(`  Targets    : ${[useDocker ? "docker" : null, useNative ? "native" : null].filter(Boolean).join(" + ")}`);
  if (updating) {
    const installedManifest = path.join(root, "mods", deployment.MOD_ID, "evejs-launcher.mod.json");
    let installedVersion = "";
    if (fs.existsSync(installedManifest)) {
      try {
        installedVersion = JSON.parse(deployment.readText(installedManifest)).version || "";
      } catch (_error) {
        installedVersion = "";
      }
    }
    out(`  Installed  : ${installedVersion ? `v${installedVersion}` : "not installed yet - this is a fresh install"}`);
    out(`  Updating to: v${payload.version}`);
    out("               configuration and a local .env are kept");
  }
  if (options.dryRun) out("  DRY RUN    : nothing will be written");
  out("------------------------------------------------------------");

  const backupRoot = path.join(root, deployment.BACKUP_DIRNAME, deployment.timestamp());
  const archived = new Set();
  const archiveOnce = (target) => {
    if (archived.has(target)) return;
    archived.add(target);
    deployment.archivePath(root, target, backupRoot);
  };

  // 1. The mod folder itself.
  const modDir = path.join(root, "mods", deployment.MOD_ID);
  const existed = fs.existsSync(path.join(modDir, "loader.js"));
  // The payload may BE the target: an installer run from an installed
  // mods/autoSkyHookDeploy. Nothing is copied then, and the report says so
  // rather than claiming an update it did not make.
  const selfInstall = deployment.sameDirectory(payload.dir, modDir);
  if (existed && !options.dryRun && !options.force && !selfInstall) archiveOnce(modDir);
  if (options.dryRun) {
    out(`[PLAN] mods/${deployment.MOD_ID}: would ${
      selfInstall
        ? "stay in place (the installer is running from the installed folder)"
        : `${existed ? "replace" : "create"} from payload`}`);
  } else {
    fs.mkdirSync(path.dirname(modDir), { recursive: true });
    copyPayload(payload.dir, modDir);
    out(`[ OK ] mods/${deployment.MOD_ID}: ${
      selfInstall
        ? "already in place (the installer is running from the installed folder)"
        : `${existed ? "updated" : "installed"}`}`);
  }

  // 2. Docker: preload the loader from docker/entrypoint.sh.
  if (useDocker) {
    const file = deployments.docker.entrypoint;
    const preload = register.containerRequirePath(deployment.MOD_ID);
    const text = deployment.readText(file);
    const result = register.applyEntrypointPreload(text, { requirePath: preload });
    applyRegistration({
      file,
      label: "docker/entrypoint.sh",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        archiveOnce(file);
        deployment.writeText(file, result.text);
      },
    });
  }

  // 3. Native: preload the loader from the Windows launcher.
  if (useNative) {
    const file = deployments.native.startServerBat;
    const preload = register.nativeRequirePath(deployment.MOD_ID);
    const text = deployment.readText(file);
    const result = register.applyStartServerPreload(text, {
      requirePath: preload,
      existPath: register.nativeExistPath(deployment.MOD_ID),
    });
    applyRegistration({
      file,
      label: "StartServer.bat",
      preload,
      result,
      dryRun: options.dryRun,
      write() {
        archiveOnce(file);
        deployment.writeText(file, result.text);
      },
    });
  }

  // 4. The mod's own server configuration, seeded once and never overwritten.
  out("");
  seedConfig(root, payload, options, { archiveOnce, backupRoot });

  out("------------------------------------------------------------");
  if (archived.size > 0) out(`  Backups    : ${backupRoot}`);
  out("");
  out("  Next steps");
  if (useDocker) {
    out("    Docker : docker compose build");
    out("             docker compose up -d --no-deps server");
    out("             (mods/ is inside the image, so a rebuild is required)");
  }
  if (useNative) {
    out("    Native : restart the server with StartServer.bat");
  }
  out("");
  out(`  Confirm a boot line: [autoSkyHookDeploy] v${payload.version} loader ready`);
  out("");
  out("  Configuration");
  out(`    Server    : config/${SERVER_CONFIG_FILE} (created for you, then never`);
  out("                overwritten). ./config is bind-mounted under Docker, so");
  out("                editing it needs a container restart, not a rebuild.");
  out("    Native    : mods/autoSkyHookDeploy/.env");
  out("    Docker    : the server service env in compose.yaml, e.g.");
  out("                EVEJS_AUTO_SKYHOOK_DEPLOY_OWNER_MODE=character");
  out("    Precedence: environment > config/autoSkyHookDeploy.json > .env > defaults.");
  out("    In game   : /ash help, or !ash help from ordinary chat for characters");
  out("                without staff rights.");
}

// A stray require() must never install anything: only a direct
// `node install.js` (or uninstall.js/update.js) is allowed to touch the server
// tree. The test suite imports the pure helpers, not this entry point.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (!process.exitCode) process.exitCode = 1;
    if (process.env.EVEJS_AUTO_SKYHOOK_DEPLOY_DEBUG) out(error.stack);
  }
}

module.exports = { main, reportStatus, seedConfig };
