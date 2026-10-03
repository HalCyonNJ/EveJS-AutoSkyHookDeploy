"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "EVEJS_AUTO_SKYHOOK_DEPLOY";
const CONFIG_FILENAME = "autoSkyHookDeploy.json";
// The third-party EveJS Launcher writes this file into the mod folder from its
// Configure panel (settings.files[] in evejs-launcher.mod.json). It outranks the
// config JSON, and /ash offset writes it rather than the config JSON whenever it
// exists, so a value set in game is not shadowed by the panel's own value.
const SETTINGS_FILENAME = "settings.json";

// Every knob has four spellings: an environment variable, a key in the launcher's
// <mod root>/settings.json, a key in <EveJS root>/config/autoSkyHookDeploy.json, and
// a key in the mod's own .env file beside loader.js. Precedence is
// environment > settings.json > config JSON > .env, because a Docker deployment
// drops **/.env from the image (see .dockerignore) while ./config is bind-mounted, a
// native checkout can use either, and the launcher's Configure panel writes
// settings.json into the mod folder (that ordering is the one its README documents).
// A real environment variable always wins, which is what compose.yaml and
// `docker run -e` expect.
//
// `offsetMeters` is also read - and written - per command
// (`createLiveConfig`), so `/ash offset` takes effect immediately and survives a
// restart with no second file to keep in sync. It writes whichever of the two files
// is actually in force.
const KEYS = Object.freeze({
  enabled: PREFIX,
  verbose: `${PREFIX}_VERBOSE`,
  allowDeploy: `${PREFIX}_ALLOW_DEPLOY`,
  allowRemove: `${PREFIX}_ALLOW_REMOVE`,
  maxPlanetsPerCommand: `${PREFIX}_MAX_PLANETS_PER_COMMAND`,
  regionCountdownSeconds: `${PREFIX}_REGION_COUNTDOWN_SECONDS`,
  regionStepDelayMs: `${PREFIX}_REGION_STEP_DELAY_MS`,
  // Metres past the planet's landing point, so a ship warping in does not
  // materialise inside the Skyhook. Runtime-adjustable with /ash offset.
  offsetMeters: `${PREFIX}_OFFSET_METERS`,
  // Fallback placement only: metres, not kilometres. How far beyond the planet's
  // surface a conjured Skyhook goes when the game has no warp-in point for it.
  // 5,000,000 m is 5,000 km.
  standoffMeters: `${PREFIX}_STANDOFF_METERS`,
  // Fallback placement only: planet radii above the surface, i.e. a ratio, not a
  // distance. A float: 1.5 means one and a half planet radii.
  orbitMargin: `${PREFIX}_ORBIT_MARGIN`,
  ownerMode: `${PREFIX}_OWNER_MODE`,
  requireClaimedSystemOwnership: `${PREFIX}_REQUIRE_CLAIMED_SYSTEM_OWNERSHIP`,
  includeDestroyedInStatus: `${PREFIX}_INCLUDE_DESTROYED_IN_STATUS`,
});

// A hand-written JSON file may spell a key the long way (exactly like the
// environment variable) or the short way used by config.example.json. Both
// resolve to the same setting, so a config never silently falls back to the
// built-in defaults.
const JSON_KEY_BY_ENV = Object.freeze({
  [KEYS.enabled]: "enabled",
  [KEYS.verbose]: "verbose",
  [KEYS.allowDeploy]: "allowDeploy",
  [KEYS.allowRemove]: "allowRemove",
  [KEYS.maxPlanetsPerCommand]: "maxPlanetsPerCommand",
  [KEYS.regionCountdownSeconds]: "regionCountdownSeconds",
  [KEYS.regionStepDelayMs]: "regionStepDelayMs",
  [KEYS.offsetMeters]: "offsetMeters",
  [KEYS.standoffMeters]: "standoffMeters",
  [KEYS.orbitMargin]: "orbitMargin",
  [KEYS.ownerMode]: "ownerMode",
  [KEYS.requireClaimedSystemOwnership]: "requireClaimedSystemOwnership",
  [KEYS.includeDestroyedInStatus]: "includeDestroyedInStatus",
});

const OWNER_MODE_CORPORATION = "corporation";
const OWNER_MODE_CHARACTER = "character";
const OWNER_MODES = Object.freeze([OWNER_MODE_CORPORATION, OWNER_MODE_CHARACTER]);

const DEFAULTS = Object.freeze({
  enabled: true,
  verbose: false,
  allowDeploy: true,
  allowRemove: true,
  // A safety cap on one command: a system with more planets than this is
  // refused outright rather than spending an unbounded amount of time
  // conjuring rows, and a single /ash remove never walks more ids than this.
  maxPlanetsPerCommand: 64,
  // A region run is paced, not a burst: mass-creating structures can stall the
  // game. The run announces this many seconds before it starts (0 = start at once)
  // and waits this long between systems (0 = no delay), and /ash stop cancels it.
  regionCountdownSeconds: 15,
  regionStepDelayMs: 2000,
  // How far past the planet's landing point the Skyhook is placed. 25,000 m
  // (25 km) keeps a ship that warps in clear of the Skyhook's model - the structure
  // is large, and at 5 km a warp to the planet still landed against it; 0 puts the
  // Skyhook exactly on the landing point. Runtime-adjustable
  // with /ash offset, which rewrites this key in the config file itself.
  offsetMeters: 25000,
  // Fallback placement only. Metres beyond the planet's surface. 5,000,000 m is
  // 5,000 km, which is where the operator's own manually deployed Skyhooks sit
  // (4,600,000-7,000,000 m, median 5,202,512 m). The game's own static-scene
  // orbitals use 100,000 m (100 km), which is too close to interact with
  // comfortably. A Skyhook is placed on the planet's warp-in point whenever the
  // vendor has one, and then neither of these keys is used.
  standoffMeters: 5000000,
  // Fallback placement only. How many planet radii above the surface the fallback
  // goes; the larger of this and standoffMeters wins there.
  orbitMargin: 1.0,
  ownerMode: OWNER_MODE_CORPORATION,
  requireClaimedSystemOwnership: false,
  includeDestroyedInStatus: true,
});

const LIMITS = Object.freeze({
  maxPlanetsPerCommand: Object.freeze({ minimum: 1, maximum: 4096 }),
  regionCountdownSeconds: Object.freeze({ minimum: 0, maximum: 120 }),
  regionStepDelayMs: Object.freeze({ minimum: 0, maximum: 60000 }),
  // 0..100,000 m (0..100 km) past the landing point.
  offsetMeters: Object.freeze({ minimum: 0, maximum: 100000 }),
  // 100,000 m (100 km, the game's static default) up to 100,000,000 m (100,000 km).
  standoffMeters: Object.freeze({ minimum: 100000, maximum: 100000000 }),
  // A ratio: 0 disables it (the standoffMeters floor always applies).
  orbitMargin: Object.freeze({ minimum: 0, maximum: 10 }),
});

function readEnvFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ["\"", "'"].includes(value[0]) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function readJsonFile(file, problems) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (_error) {
    return {};
  }
  if (!text.trim()) {
    return {};
  }
  // The label is the file's own name, because there is more than one JSON
  // configuration source now (the launcher's settings.json and the config JSON).
  const label = path.basename(file) || CONFIG_FILENAME;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push(`${label} must contain a JSON object`);
      return {};
    }
    return parsed;
  } catch (error) {
    problems.push(`${label} is not valid JSON: ${error && error.message}`);
    return {};
  }
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

const TRUE_WORDS = Object.freeze(["1", "true", "yes", "on", "enabled"]);
const FALSE_WORDS = Object.freeze(["0", "false", "no", "off", "disabled"]);

// Fail closed: a value that is present but is neither a known true spelling nor
// a known false spelling is a configuration problem, not a silent fallback.
function readBoolean(value, fallback, label, problems) {
  if (isBlank(value)) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_WORDS.includes(normalized)) return true;
  if (FALSE_WORDS.includes(normalized)) return false;
  problems.push(`${label} must be a boolean (${TRUE_WORDS[0]}/${FALSE_WORDS[0]}, true/false, yes/no, on/off)`);
  return fallback;
}

function readInteger(value, fallback, limits, label, problems) {
  if (isBlank(value)) return fallback;
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    problems.push(`${label} must be an integer`);
    return fallback;
  }
  if (limits && (numeric < limits.minimum || numeric > limits.maximum)) {
    problems.push(`${label} must be between ${limits.minimum} and ${limits.maximum}`);
    return fallback;
  }
  return numeric;
}

// A finite number, integer or not: used for the ratios (planet radii) where a
// fraction is meaningful.
function readNumber(value, fallback, limits, label, problems) {
  if (isBlank(value)) return fallback;
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    problems.push(`${label} must be a finite number`);
    return fallback;
  }
  if (limits && (numeric < limits.minimum || numeric > limits.maximum)) {
    problems.push(`${label} must be between ${limits.minimum} and ${limits.maximum}`);
    return fallback;
  }
  return numeric;
}

function readChoice(value, fallback, accepted, label, problems) {
  if (isBlank(value)) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (accepted.includes(normalized)) return normalized;
  problems.push(`${label} must be one of ${accepted.join(", ")}`);
  return fallback;
}

// The mod's own live view of the configuration file. `/ash offset` reads and
// writes this key **in that file**, exactly like the sibling mod does: the value
// is picked up on the next command with no restart, survives a restart, and needs
// no second file to keep in sync. Every other key keeps its boot-time precedence
// and its fail-closed rule; this one is deliberately softer, because it is meant
// to be edited from in game.
//
// Reads tolerate everything: a missing file, an unreadable file, invalid JSON, a
// value of the wrong type or a value out of range all fall back to the last good
// value (the boot value) and report why through the returned `error`. Writes are
// the careful direction: the file is re-read and merged so every other key and the
// comment survive, and an unparsable file is **never** overwritten - the write is
// refused and the error is returned instead of destroying the operator's config.
function readConfigFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { missing: true, error: `${file} could not be read: ${error && error.message}` };
  }
  if (!text.trim()) {
    return { error: `${file} is empty` };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `${file} is not valid JSON: ${error && error.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${file} must contain a JSON object` };
  }
  return { values: parsed };
}

function writeConfigFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`, "utf8");
}

function createLiveConfig(options = {}) {
  const file = options.file;
  const defaults = { ...(options.defaults || {}) };
  const limits = options.limits || {};
  const log = typeof options.log === "function" ? options.log : () => {};
  const logError = typeof options.logError === "function" ? options.logError : () => {};
  // The last value that was known to be good: the boot value, refreshed by every
  // successful read and write, so a file that breaks later cannot take the mod
  // back to a surprise default.
  const lastGood = { ...defaults };

  function readValue(key) {
    const fallback = lastGood[key];
    if (!file) {
      return { value: fallback, error: null };
    }
    const parsed = readConfigFile(file);
    if (parsed.missing) {
      log(`${file} does not exist yet - ${key} is ${fallback}`);
      return { value: fallback, error: null };
    }
    if (parsed.error) {
      log(`${parsed.error} - still using ${key} ${fallback}`);
      return { value: fallback, error: parsed.error };
    }
    const shortKey = JSON_KEY_BY_ENV[key];
    const raw = parsed.values[key] ?? (shortKey ? parsed.values[shortKey] : undefined);
    if (isBlank(raw)) {
      return { value: fallback, error: null };
    }
    const numeric = Number(String(raw).trim());
    const limit = limits[key];
    if (!Number.isFinite(numeric)) {
      const error = `${file} holds a non-numeric ${key} (${raw})`;
      log(`${error} - still using ${fallback}`);
      return { value: fallback, error };
    }
    if (limit && (numeric < limit.minimum || numeric > limit.maximum)) {
      const error = `${file} holds an out-of-range ${key} (${raw}); `
        + `the range is ${limit.minimum}..${limit.maximum}`;
      log(`${error} - still using ${fallback}`);
      return { value: fallback, error };
    }
    lastGood[key] = numeric;
    return { value: numeric, error: null };
  }

  function writeValue(key, value) {
    const shortKey = JSON_KEY_BY_ENV[key] || key;
    if (!file) {
      return { ok: false, error: "no configuration file is configured" };
    }
    const parsed = readConfigFile(file);
    if (parsed.error && !parsed.missing) {
      // Never rewrite a file we could not parse: that would throw away every
      // other key the operator has.
      return { ok: false, error: parsed.error };
    }
    const values = { ...((parsed && parsed.values) || {}) };
    values[shortKey] = value;
    if (key !== shortKey && Object.prototype.hasOwnProperty.call(values, key)) {
      values[key] = value;
    }
    try {
      writeConfigFile(file, values);
    } catch (error) {
      logError(`could not write ${file}: ${error && error.message}`);
      return { ok: false, error: (error && error.message) || "write failed" };
    }
    lastGood[key] = value;
    return { ok: true, file };
  }

  return Object.freeze({
    file,
    defaults: Object.freeze({ ...defaults }),
    readValue,
    writeValue,
    getOffsetMeters: () => readValue("offsetMeters"),
    setOffsetMeters: (meters) => writeValue("offsetMeters", meters),
    _testing: Object.freeze({ lastGood }),
  });
}

function load(modDir, environment = process.env, options = {}) {
  const dir = modDir || __dirname;
  const envFilename = path.join(dir, ".env");
  // The launcher's Configure panel writes this file, in the mod folder, so it is a
  // configuration source like the others - it just outranks the config JSON, which
  // is what the launcher's own README documents.
  const settingsFilename = options.settingsPath || path.join(dir, SETTINGS_FILENAME);
  const jsonFilename = options.configPath
    || path.join(
      options.runtimeRoot || path.resolve(dir, "../.."),
      "config",
      CONFIG_FILENAME,
    );
  const problems = [];
  const fileValues = readEnvFile(envFilename);
  const jsonValues = readJsonFile(jsonFilename, problems);
  // A **missing** settings.json is not a problem at all (the launcher may not have
  // written one yet); a malformed one is, exactly like the config JSON: it is a
  // configuration source, so the fail-closed rule applies to it.
  const settingsValues = fs.existsSync(settingsFilename)
    ? readJsonFile(settingsFilename, problems)
    : {};

  const readSource = (source, key) => {
    if (!source) return undefined;
    const direct = source[key];
    if (!isBlank(direct)) return direct;
    const shortKey = JSON_KEY_BY_ENV[key];
    if (shortKey && shortKey !== key && !isBlank(source[shortKey])) {
      return source[shortKey];
    }
    return undefined;
  };
  // A later source is only consulted when every earlier one is absent, so an
  // explicit empty string in a higher layer means "unset" rather than "false".
  const pick = (key) => {
    for (const source of [environment, settingsValues, jsonValues, fileValues]) {
      const value = readSource(source, key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const sources = [];
  const envNames = Object.values(KEYS);
  if (Object.keys(environment || {}).some((key) => envNames.includes(key))) {
    sources.push("environment");
  }
  if (Object.keys(settingsValues).some((key) => (
    envNames.includes(key) || Object.values(JSON_KEY_BY_ENV).includes(key)
  ))) {
    sources.push(SETTINGS_FILENAME);
  }
  if (Object.keys(jsonValues).some((key) => (
    envNames.includes(key) || Object.values(JSON_KEY_BY_ENV).includes(key)
  ))) {
    sources.push(CONFIG_FILENAME);
  }
  if (Object.keys(fileValues).some((key) => envNames.includes(key))) {
    sources.push(".env");
  }

  return Object.freeze({
    enabled: readBoolean(pick(KEYS.enabled), DEFAULTS.enabled, KEYS.enabled, problems),
    verbose: readBoolean(pick(KEYS.verbose), DEFAULTS.verbose, KEYS.verbose, problems),
    allowDeploy: readBoolean(
      pick(KEYS.allowDeploy), DEFAULTS.allowDeploy, KEYS.allowDeploy, problems,
    ),
    allowRemove: readBoolean(
      pick(KEYS.allowRemove), DEFAULTS.allowRemove, KEYS.allowRemove, problems,
    ),
    maxPlanetsPerCommand: readInteger(
      pick(KEYS.maxPlanetsPerCommand),
      DEFAULTS.maxPlanetsPerCommand,
      LIMITS.maxPlanetsPerCommand,
      KEYS.maxPlanetsPerCommand,
      problems,
    ),
    regionCountdownSeconds: readInteger(
      pick(KEYS.regionCountdownSeconds),
      DEFAULTS.regionCountdownSeconds,
      LIMITS.regionCountdownSeconds,
      KEYS.regionCountdownSeconds,
      problems,
    ),
    regionStepDelayMs: readInteger(
      pick(KEYS.regionStepDelayMs),
      DEFAULTS.regionStepDelayMs,
      LIMITS.regionStepDelayMs,
      KEYS.regionStepDelayMs,
      problems,
    ),    offsetMeters: readNumber(
      pick(KEYS.offsetMeters),
      DEFAULTS.offsetMeters,
      LIMITS.offsetMeters,
      KEYS.offsetMeters,
      problems,
    ),
    standoffMeters: readInteger(
      pick(KEYS.standoffMeters),
      DEFAULTS.standoffMeters,
      LIMITS.standoffMeters,
      KEYS.standoffMeters,
      problems,
    ),
    orbitMargin: readNumber(
      pick(KEYS.orbitMargin),
      DEFAULTS.orbitMargin,
      LIMITS.orbitMargin,
      KEYS.orbitMargin,
      problems,
    ),
    ownerMode: readChoice(
      pick(KEYS.ownerMode), DEFAULTS.ownerMode, OWNER_MODES, KEYS.ownerMode, problems,
    ),
    requireClaimedSystemOwnership: readBoolean(
      pick(KEYS.requireClaimedSystemOwnership),
      DEFAULTS.requireClaimedSystemOwnership,
      KEYS.requireClaimedSystemOwnership,
      problems,
    ),
    includeDestroyedInStatus: readBoolean(
      pick(KEYS.includeDestroyedInStatus),
      DEFAULTS.includeDestroyedInStatus,
      KEYS.includeDestroyedInStatus,
      problems,
    ),
    configFilename: jsonFilename,
    settingsFilename,
    // Where /ash offset writes: the launcher's file when the launcher has written
    // one (it outranks the config JSON), the config JSON otherwise.
    offsetFilename: fs.existsSync(settingsFilename) ? settingsFilename : jsonFilename,
    settingsFilename,
    // Where /ash offset writes: the launcher's file when the launcher has written
    // one (it outranks the config JSON), the config JSON otherwise.
    offsetFilename: fs.existsSync(settingsFilename) ? settingsFilename : jsonFilename,
    sources: Object.freeze(sources),
    problems: Object.freeze(problems),
  });
}

module.exports = {
  CONFIG_FILENAME,
  SETTINGS_FILENAME,
  SETTINGS_FILENAME,
  DEFAULTS,
  JSON_KEY_BY_ENV,
  KEYS,
  LIMITS,
  OWNER_MODE_CHARACTER,
  OWNER_MODE_CORPORATION,
  OWNER_MODES,
  PREFIX,
  createLiveConfig,
  load,
  readBoolean,
  readChoice,
  readConfigFile,
  readEnvFile,
  readInteger,
  readJsonFile,
  readNumber,
  writeConfigFile,
};
