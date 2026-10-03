"use strict";

// Installer coverage: the registration transforms are pure, so they are
// asserted against fixture text first, and the end-to-end pass then drives
// install.js / update.js / uninstall.js against a throwaway EveJS tree.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MOD_ID = "autoSkyHookDeploy";

const ENTRYPOINT_FIXTURE = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "",
  "build_database() {",
  "  node --max-old-space-size=8192 /app/tools/DatabaseCreator/database-creator.js \\",
  "    --sde-dir /sde \\",
  "    --out /out",
  "}",
  "",
  "run_server() {",
  "  cd /app/server",
  "  exec node \\",
  "    --require /app/mods/fourModeAsteroidBelts/loader.js \\",
  "    --report-on-fatalerror \\",
  "    --max-old-space-size=8192 \\",
  "    .",
  "}",
  "",
  "run_all() {",
  "  build_database",
  "  (cd /app/server && exec node \\",
  "    --report-on-fatalerror \\",
  "    .) &",
  "}",
  "",
  'case "${1:-all}" in',
  "  server) run_server ;;",
  "  all) run_all ;;",
  "esac",
  "",
].join("\n");

// Modelled on the real launcher: the anchor line is the one both npm start
// branches inherit their environment from.
const START_SERVER_FIXTURE = [
  "@echo off",
  "setlocal EnableDelayedExpansion",
  "title EvEJS - Start Server",
  'for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"',
  'set "EVEJS_PROXY_LOCAL_INTERCEPT=1"',
  'if not exist "%EVEJS_REPO_ROOT%\\server\\logs\\node-reports" mkdir "%EVEJS_REPO_ROOT%\\server\\logs\\node-reports" >nul 2>&1',
  'pushd "%EVEJS_REPO_ROOT%\\server"',
  "call npm start",
  "popd",
  "",
].join("\r\n");

function buildFixtureRoot(base) {
  const root = path.join(base, "EveJS");
  const write = (relative, text) => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
  };
  write("server/index.js", '"use strict";\n');
  write("server/src/services/planet/planetOrbitalState.js", "// orbital fixture\n");
  write("docker/entrypoint.sh", ENTRYPOINT_FIXTURE);
  write("StartServer.bat", START_SERVER_FIXTURE);
  write(
    "server/package.json",
    `${JSON.stringify(
      {
        name: "eve.js",
        version: "0.12.9",
        scripts: {
          start:
            "node --report-on-fatalerror --report-uncaught-exception "
            + "--report-dir=./logs/node-reports --max-old-space-size=8192 .",
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

// The installer sources sit beside the mod in the development tree and beside
// the mod payload in the installer package. A mod folder copied straight into
// mods/ has neither, and then this suite steps aside instead of failing.
function resolveInstaller(modDir) {
  const candidates = [
    { installerDir: path.join(modDir, "installer"), lib: path.join(modDir, "installer/lib/register") },
    { installerDir: path.resolve(modDir, ".."), lib: path.resolve(modDir, "../lib/register") },
  ];
  for (const candidate of candidates) {
    try {
      return { installerDir: candidate.installerDir, registerLib: require(candidate.lib) };
    } catch (_error) {
      // Keep looking; the next layout may be the one in use.
    }
  }
  return null;
}

function register(harness) {
  const { test, modDir } = harness;
  const resolved = resolveInstaller(modDir);
  if (!resolved) {
    test("installer: suite available", () => {
      console.log("     SKIP installer sources are not shipped beside this mod");
    });
    return;
  }
  const { installerDir, registerLib } = resolved;
  const deploymentLib = require(path.join(installerDir, "lib/deployment"));
  const containerPath = registerLib.containerRequirePath(MOD_ID);
  const nativePath = registerLib.nativeRequirePath(MOD_ID);
  const nativeExist = registerLib.nativeExistPath(MOD_ID);

  test("installer: docker preload is added to every server launch", () => {
    const result = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    assert.ok(result.ok, result.reason || "expected the fixture entrypoint to be recognised");
    assert.strictEqual(result.launches, 2, "run_server and run_all must both be found");
    assert.strictEqual(result.insertions, 2, "both launches must gain the preload");
    const lines = result.text.split("\n");
    assert.deepStrictEqual(
      lines.filter((line) => line.includes(containerPath)).map((line) => line.trim()),
      [`--require ${containerPath} \\`, `--require ${containerPath} \\`],
    );
    // The two-space block indent plus one level keeps the vendor indentation.
    assert.ok(lines.includes(`    --require ${containerPath} \\`), "preload keeps the vendor indent");
    assert.ok(
      lines.includes("  node --max-old-space-size=8192 /app/tools/DatabaseCreator/database-creator.js \\"),
      "the database builder must not gain a preload",
    );
  });

  test("installer: the docker preload lands last so this wrapper owns the outermost hook", () => {
    // Require order is Module._load hook order: innermost is first in the list, and a *wrapping*
    // hook belongs outermost, i.e. last (AdvancedUtilityDrones/HOW-IT-WORKS.md:217-218). Inserted
    // at the head of the group - which is right for a loader that replaces exports, like
    // autopilotJumpZero - this mod would sit inside every such loader instead of around them.
    const result = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    const lines = result.text.split("\n");
    const flagLine = `    --require ${containerPath} \\`;
    const older = lines.findIndex((line) => line.includes("fourModeAsteroidBelts"));
    assert.ok(older >= 0, "the fixture already preloads another loader");
    const positions = lines
      .map((line, index) => (line === flagLine ? index : -1))
      .filter((index) => index >= 0);
    assert.strictEqual(positions.length, 2, "one flagged line per server launch");
    for (const position of positions) {
      assert.ok(position > older, "the preload must come after the older loader");
      assert.match(
        lines[position + 1].trim(),
        /^\.\)? ?&?$/u,
        "the module path must follow the preload immediately, so nothing loads after it",
      );
    }
  });

  test("installer: docker preload insertion is idempotent", () => {
    const once = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    const twice = registerLib.applyEntrypointPreload(once.text, { requirePath: containerPath });
    assert.strictEqual(twice.changed, false);
    assert.strictEqual(twice.text, once.text);
    assert.ok(registerLib.hasEntrypointPreload(twice.text, { requirePath: containerPath }));
    assert.deepStrictEqual(
      registerLib.describeEntrypointPreloads(twice.text).filter((entry) => entry.includes(MOD_ID)),
      [containerPath, containerPath],
    );
  });

  test("installer: docker preload removal restores the fixture byte for byte", () => {
    const applied = registerLib.applyEntrypointPreload(ENTRYPOINT_FIXTURE, { requirePath: containerPath });
    const removed = registerLib.removeEntrypointPreload(applied.text, { requirePath: containerPath });
    assert.strictEqual(removed.removals, 2);
    assert.strictEqual(removed.text, ENTRYPOINT_FIXTURE);
    assert.strictEqual(registerLib.hasEntrypointPreload(removed.text, { requirePath: containerPath }), false);
  });

  test("installer: docker preload is refused when no server launch exists", () => {
    const result = registerLib.applyEntrypointPreload("#!/usr/bin/env bash\necho hi\n", {
      requirePath: containerPath,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /no server launch/u);
  });

  test("installer: native preload is added to StartServer.bat", () => {
    // Node's NODE_OPTIONS parser consumes backslashes, so the value it receives
    // must be forward-slashed or it collapses to 'D:Eve...'.
    assert.strictEqual(nativePath, `%EVEJS_REPO_ROOT:\\=/%/mods/${MOD_ID}/loader.js`);
    assert.strictEqual(nativeExist, `%EVEJS_REPO_ROOT%\\mods\\${MOD_ID}\\loader.js`);
    const result = registerLib.applyStartServerPreload(START_SERVER_FIXTURE, {
      requirePath: nativePath,
      existPath: nativeExist,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.upgraded, false);
    const lines = result.text.split("\r\n");
    assert.ok(registerLib.hasStartServerPreload(result.text));
    const block = [
      registerLib.START_SERVER_BEGIN,
      `if exist "${nativeExist}" (`,
      "  if defined NODE_OPTIONS (",
      `    set "NODE_OPTIONS=%NODE_OPTIONS% --require="${nativePath}""`,
      "  ) else (",
      `    set "NODE_OPTIONS=--require="${nativePath}""`,
      "  )",
      ")",
      registerLib.START_SERVER_END,
    ];
    const blockStart = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_BEGIN);
    assert.ok(blockStart > 0, "the injected block must be present");
    assert.deepStrictEqual(lines.slice(blockStart, blockStart + block.length), block);
    // Appending is the whole point. An unconditional assignment would drop a
    // loader mod that registered first, and `if not defined` would drop this
    // one as soon as a neighbour jumps ahead of the block.
    assert.ok(
      block.some((line) => line.includes("%NODE_OPTIONS% --require=")),
      "the block must append to an existing NODE_OPTIONS",
    );
    assert.strictEqual(
      result.text.includes("if not defined NODE_OPTIONS"),
      false,
      "the first-writer-wins form must not come back",
    );
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    assert.strictEqual(lines[anchor + 1].trim(), registerLib.START_SERVER_BEGIN);
    assert.strictEqual(result.text.replace(/\r\n/gu, "\n").endsWith("call npm start\npopd\n"), true);
    assert.strictEqual(
      registerLib.applyStartServerPreload(result.text, {
        requirePath: nativePath,
        existPath: nativeExist,
      }).changed,
      false,
      "a second install must not stack a duplicate block",
    );
    assert.strictEqual(registerLib.removeStartServerPreload(result.text).text, START_SERVER_FIXTURE);
  });

  test("installer: the native block lands after every neighbour block, not at the anchor", () => {
    // A registered block is one indivisible unit however many lines of if/else plumbing it carries.
    // Measuring by lines would drop this mod's block inside autopilotJumpZero's `if/else`, where the
    // neighbour's `set` gets the last word; sitting after the neighbour is what makes this wrapper the
    // last --require and therefore the outermost hook.
    const neighbour = [
      "rem --- autopilotJumpZero: preload the server-side loader ---",
      'if exist "%EVEJS_REPO_ROOT%\\mods\\autopilotJumpZero\\loader.js" (',
      "  if defined NODE_OPTIONS (",
      '    set "NODE_OPTIONS=%NODE_OPTIONS% --require=%EVEJS_REPO_ROOT%\\mods\\autopilotJumpZero\\loader.js"',
      "  ) else (",
      '    set "NODE_OPTIONS=--require=%EVEJS_REPO_ROOT%\\mods\\autopilotJumpZero\\loader.js"',
      "  )",
      ")",
      "rem --- autopilotJumpZero: end autopilotJumpZero preload ---",
    ];
    const withNeighbour = [
      "@echo off",
      'set "EVEJS_PROXY_LOCAL_INTERCEPT=1"',
      ...neighbour,
      'set "NODE_OPTIONS=%NODE_OPTIONS% --require=bystander-claim.js"',
      "call npm start",
      "",
    ].join("\r\n");
    const result = registerLib.applyStartServerPreload(withNeighbour, {
      requirePath: nativePath,
      existPath: nativeExist,
    });
    assert.strictEqual(result.ok, true);
    const lines = result.text.split("\r\n");
    const mine = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_BEGIN);
    const neighbourEnd = lines.findIndex(
      (line) => line.trim() === neighbour[neighbour.length - 1],
    );
    const bystander = lines.findIndex((line) => line.includes("bystander-claim.js"));
    assert.ok(mine > neighbourEnd, "the block must follow the marked neighbour block");
    assert.ok(mine > bystander, "the block must follow a bare NODE_OPTIONS writer");
    assert.ok(lines[mine + 1].includes("if exist"), "the block body follows its marker");
  });

  test("installer: native preload refuses a launcher without the anchor", () => {
    const result = registerLib.applyStartServerPreload("@echo off\r\ncall npm start\r\n", {
      requirePath: nativePath,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /EVEJS_PROXY_LOCAL_INTERCEPT/u);
  });

  test("installer: native preload upgrades a block written by an older release", () => {
    const lines = START_SERVER_FIXTURE.split("\r\n");
    const anchor = lines.findIndex((line) => line.trim() === registerLib.START_SERVER_ANCHOR);
    const legacyBlock = [
      registerLib.START_SERVER_BEGIN,
      `if not defined NODE_OPTIONS if exist "${nativeExist}" set "NODE_OPTIONS=--require="${nativePath}""`,
      registerLib.START_SERVER_END,
    ].join("\r\n");
    const legacy = [...lines.slice(0, anchor + 1), legacyBlock, ...lines.slice(anchor + 1)].join("\r\n");

    const result = registerLib.applyStartServerPreload(legacy, {
      requirePath: nativePath,
      existPath: nativeExist,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.upgraded, true);
    assert.strictEqual(result.text.split(registerLib.START_SERVER_BEGIN).length - 1, 1);
    assert.strictEqual(result.text.includes("if not defined NODE_OPTIONS"), false);
    assert.strictEqual(
      registerLib.startServerPreloadIsCurrent(result.text, {
        requirePath: nativePath,
        existPath: nativeExist,
      }),
      true,
    );
    assert.strictEqual(
      registerLib.applyStartServerPreload(result.text, {
        requirePath: nativePath,
        existPath: nativeExist,
      }).changed,
      false,
    );
    assert.strictEqual(registerLib.removeStartServerPreload(result.text).text, START_SERVER_FIXTURE);
  });

  test("installer: native preload refuses a damaged registration", () => {
    const damaged = START_SERVER_FIXTURE.replace(
      "\r\npushd",
      `\r\n${registerLib.START_SERVER_BEGIN}\r\npushd`,
    );
    const result = registerLib.applyStartServerPreload(damaged, {
      requirePath: nativePath,
      existPath: nativeExist,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /no end marker/u);
  });

  test("installer: developer-only paths are pruned from the payload", () => {
    assert.deepStrictEqual(
      [...deploymentLib.DEV_ONLY_DIRECTORIES],
      ["installer", "tools", "dist", "node_modules", ".git"],
    );
    assert.deepStrictEqual([...deploymentLib.DEV_ONLY_FILES], ["ANNOUNCEMENT.md"]);
    assert.ok(
      deploymentLib.DEV_ONLY_DIRECTORIES.includes("installer"),
      "the installer must not copy itself into mods/",
    );
    assert.ok(deploymentLib.DEV_ONLY_FILES.includes("ANNOUNCEMENT.md"));
  });

  test("installer: end to end install, update, reinstall, and uninstall", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "autoskyhookdeploy-"));
    try {
      const root = buildFixtureRoot(workdir);
      const entrypoint = path.join(root, "docker", "entrypoint.sh");
      const startServer = path.join(root, "StartServer.bat");
      const packageJson = path.join(root, "server", "package.json");
      const configFile = path.join(root, "config", "autoSkyHookDeploy.json");
      const target = path.join(root, "mods", MOD_ID);
      const read = (file) => fs.readFileSync(file, "utf8");
      const before = {
        entrypoint: read(entrypoint),
        startServer: read(startServer),
        packageJson: read(packageJson),
      };
      const run = (script, args) => {
        const result = spawnSync(
          process.execPath,
          [path.join(installerDir, script), "--server", root, ...args],
          { encoding: "utf8", timeout: 120000 },
        );
        assert.strictEqual(result.status, 0, `${script} failed:
${result.stdout}
${result.stderr}`);
        return result.stdout;
      };

      // A pre-existing install with leftovers the installer must prune, and a
      // local .env it must never overwrite.
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "loader.js"), "// stale loader\n", "utf8");
      fs.writeFileSync(path.join(target, "ANNOUNCEMENT.md"), "stale announcement\n", "utf8");
      fs.mkdirSync(path.join(target, "installer"), { recursive: true });
      fs.writeFileSync(path.join(target, "installer", "install.js"), "// stale installer\n", "utf8");
      fs.writeFileSync(path.join(target, ".env"), "EVEJS_AUTO_SKYHOOK_DEPLOY=0\n", "utf8");

      const installOutput = run("install.js", []);
      assert.ok(fs.existsSync(path.join(target, "loader.js")), "loader.js must land in mods/");
      assert.match(read(path.join(target, "loader.js")), /autoSkyHookDeployLoaderInstalled/u);
      assert.strictEqual(
        fs.existsSync(path.join(target, "ANNOUNCEMENT.md")),
        false,
        "ANNOUNCEMENT.md is developer-only and must be pruned",
      );
      assert.strictEqual(
        fs.existsSync(path.join(target, "installer")),
        false,
        "installer scaffolding must not be copied into the runtime mod folder",
      );
      assert.strictEqual(read(path.join(target, ".env")), "EVEJS_AUTO_SKYHOOK_DEPLOY=0\n", "a local .env survives");
      assert.strictEqual(read(entrypoint).split(containerPath).length - 1, 2, "both docker launches must preload");
      assert.ok(registerLib.hasStartServerPreload(read(startServer)), "StartServer.bat must preload the loader");
      assert.strictEqual(
        read(packageJson),
        before.packageJson,
        "server/package.json must stay untouched: it is a Docker dependency-layer input",
      );
      assert.match(installOutput, /docker \+ native/u, "both deployments must be detected");
      assert.ok(fs.existsSync(configFile), "config/autoSkyHookDeploy.json must be seeded");
      const seeded = JSON.parse(read(configFile));
      assert.strictEqual(seeded.maxPlanetsPerCommand, 64);
      assert.strictEqual(seeded.ownerMode, "corporation");
      assert.strictEqual(fs.readdirSync(path.join(root, "_autoskyhookdeploy-backup")).length, 1, "one backup per run");

      const afterFirst = {
        entrypoint: read(entrypoint),
        startServer: read(startServer),
        loader: read(path.join(target, "loader.js")),
      };
      const updateOutput = run("update.js", []);
      assert.match(updateOutput, /Updater/u);
      assert.match(updateOutput, /Installed {2}: v1\.0\.0/u);
      assert.match(updateOutput, /Updating to: v1\.0\.0/u);

      run("install.js", []);
      assert.deepStrictEqual(
        {
          entrypoint: read(entrypoint),
          startServer: read(startServer),
          loader: read(path.join(target, "loader.js")),
        },
        afterFirst,
        "a reinstall must not stack a second registration or change the payload",
      );

      // An operator value must survive every later run, and a key a later
      // release introduced must be added without touching the others.
      const edited = { ...JSON.parse(read(configFile)), maxPlanetsPerCommand: 7 };
      delete edited.allowDeploy;
      fs.writeFileSync(configFile, `${JSON.stringify(edited, null, 2)}\n`, "utf8");
      const seededAgain = run("install.js", []);
      assert.match(seededAgain, /added allowDeploy/u);
      const merged = JSON.parse(read(configFile));
      assert.strictEqual(merged.maxPlanetsPerCommand, 7, "an operator value must never be overwritten");
      assert.strictEqual(merged.allowDeploy, true, "a key a later release introduced must be added");

      const statusOutput = run("install.js", ["--status"]);
      assert.match(statusOutput, /Docker {5}: registered/u);
      assert.match(statusOutput, /Native {5}: registered/u);
      assert.match(statusOutput, /Version {4}: installed v1\.0\.0, payload v1\.0\.0/u);

      const dryRun = spawnSync(
        process.execPath,
        [path.join(installerDir, "install.js"), "--server", root, "--dry-run"],
        { encoding: "utf8", timeout: 120000 },
      );
      assert.strictEqual(dryRun.status, 0, dryRun.stderr);
      assert.strictEqual(read(entrypoint), afterFirst.entrypoint, "--dry-run must not write");

      run("uninstall.js", []);
      assert.strictEqual(read(entrypoint), before.entrypoint, "entrypoint must be restored");
      assert.strictEqual(read(startServer), before.startServer, "StartServer.bat must be restored");
      assert.strictEqual(read(packageJson), before.packageJson, "package.json must never have been touched");
      assert.strictEqual(fs.existsSync(target), false, "mod folder must be retired");
      assert.ok(fs.existsSync(configFile), "the operator's configuration must survive an uninstall");
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("installer: a folder that is not an EveJS root is refused", () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "autoskyhookdeploy-notroot-"));
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(installerDir, "install.js"), "--server", workdir],
        { encoding: "utf8", timeout: 60000 },
      );
      assert.notStrictEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /does not look like an EveJS 0\.12\.9 root/u);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("installer: live tree exposes both docker launches", () => {
    const runtimeRoot = path.resolve(modDir, "../..");
    const candidates = [
      process.env.EVEJS_AUTO_SKYHOOK_DEPLOY_TREE,
      runtimeRoot,
      path.join(runtimeRoot, "EveJS"),
    ].filter(Boolean);
    const liveRoot = candidates.find((candidate) => (
      fs.existsSync(path.join(candidate, "docker", "entrypoint.sh"))
    ));
    if (!liveRoot) {
      console.log("     SKIP no EveJS tree found next to this mod");
      return;
    }
    const entrypoint = path.join(liveRoot, "docker", "entrypoint.sh");
    const text = fs.readFileSync(entrypoint, "utf8");
    const result = registerLib.applyEntrypointPreload(text, { requirePath: containerPath });
    assert.ok(result.ok, result.reason || "the live entrypoint must expose a server launch");
    assert.strictEqual(result.launches, 2, "run_server and run_all must both be patchable");
    const present = text.split(containerPath).length - 1;
    assert.strictEqual(
      result.insertions,
      result.launches - present,
      "every launch that still lacks the preload must gain exactly one",
    );
    const reapplied = registerLib.applyEntrypointPreload(result.text, { requirePath: containerPath });
    assert.strictEqual(reapplied.changed, false, "the live entrypoint must be idempotent under the install rule");
    const launcher = path.join(liveRoot, "StartServer.bat");
    if (fs.existsSync(launcher)) {
      const launcherText = fs.readFileSync(launcher, "utf8");
      const launcherResult = registerLib.applyStartServerPreload(launcherText, {
        requirePath: nativePath,
        existPath: nativeExist,
      });
      assert.ok(launcherResult.ok, launcherResult.reason || "the live launcher must expose its anchor line");
      if (!registerLib.hasStartServerPreload(launcherText)) {
        console.log("     SKIP the live launcher carries no native registration to compare");
      } else {
        assert.strictEqual(
          registerLib.removeStartServerPreload(launcherResult.text).text,
          registerLib.removeStartServerPreload(launcherText).text,
          "the block must be the only thing that changes",
        );
      }
    }
  });
}

module.exports = register;
