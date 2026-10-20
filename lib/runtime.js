"use strict";

// Everything this mod does to a solar system, in one place, behind injected
// vendor accessors. Nothing here requires an EveJS module at load time: the
// loader builds a memoising accessor table (createServerDeps) and the vendor
// modules are pulled in on first use, inside the command that needs them. The
// vendor has real require cycles around the space runtime, which is exactly why
// planetOrbitalState defers its own space-runtime require to call time.
//
// The module is deliberately free of EveJS types: tests drive it with fixture
// deps that implement the same handful of methods, so the plan builder can be
// exercised without a server, a scene or a game database.

const path = require("node:path");
const regionNames = require("./regionNames.js");

const SKYHOOK_TYPE_ID = 81080;
const CATEGORY_ORBITAL = 46;
// EveJS 261018.1 retired the synthetic per-planet ledger slot the 0.12.9 line
// minted (`SKYHOOK_ITEM_ID_OFFSET + planetID`). Ledger rows now exist only for
// real deployments: `sovModernState.readDeployedSkyhookOrbitals` derives them
// from orbitals that carry `deployedItem`, so a row that is not destroyed is
// occupancy and there is no "free slot" row to look for.
const OWNER_MODE_CORPORATION = "corporation";
const OWNER_MODE_CHARACTER = "character";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function positiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

// A destroyed record is a marker, not a failure. The vendor's bootstrap only
// re-mints a claimed planet's default skyhook when **no** row is left for that
// planet, so a row carrying `destroyed: true` is the whole reason a destroyed
// Skyhook stays destroyed across a restart
// (`sovModernState.js:713-718`, "Destroyed Skyhooks are a persistent player
// decision"). The mod therefore never lists them one by one and never counts
// them as skips: it reports how many it left alone, in one line, and says why.
const DESTROYED_MARKER_NOTE = "a destroyed skyhook stays destroyed until something is "
  + "deployed on that planet again";

function describeDestroyedMarkers(count) {
  return `${positiveInt(count, 0)} (${DESTROYED_MARKER_NOTE})`;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  if (!isPlainObject(value)) return { ...fallback };
  return {
    x: Number.isFinite(Number(value.x)) ? Number(value.x) : fallback.x,
    y: Number.isFinite(Number(value.y)) ? Number(value.y) : fallback.y,
    z: Number.isFinite(Number(value.z)) ? Number(value.z) : fallback.z,
  };
}

// The vendor entry points, loaded on first use and memoised by relative path.
// This mirrors the pattern the sibling mods use: `require` happens at call
// time, never while loader.js itself is being evaluated.
function createServerDeps(runtimeRoot) {
  const cache = new Map();
  const load = (relative) => {
    let loaded = cache.get(relative);
    if (!loaded) {
      loaded = require(path.join(runtimeRoot, relative));
      cache.set(relative, loaded);
    }
    return loaded;
  };
  return Object.freeze({
    getPlanetOrbitalState: () => load("server/src/services/planet/planetOrbitalState.js"),
    getItemStore: () => load("server/src/services/inventory/itemStore.js"),
    getWorldData: () => load("server/src/space/worldData.js"),
    getSpaceRuntime: () => load("server/src/space/runtime.js"),
    getSovModernState: () => load("server/src/services/sovereignty/sovModernState.js"),
    getStructureState: () => load("server/src/services/structure/structureState.js"),
    getCharacterState: () => load("server/src/services/character/characterState.js"),
    getWarpInPointParity: () => load("server/src/space/destiny/simulation/warpInPointParity.js"),
    getIdentityAllocator: () => load("server/src/services/_shared/identityAllocator.js"),
    getGameStore: () => load("server/src/gameStore/index.js"),
    getSovSystemRules: () => load("server/src/services/sovereignty/sovSystemRules.js"),
    // The anchor safety gate: is this still the caller's live session, and is it
    // docked? Both are the vendor's own predicates, never a guess at session fields.
    getSessionRegistry: () => load("server/src/services/chat/sessionRegistry.js"),
    getStructureLocation: () => load("server/src/services/structure/structureLocation.js"),
  });
}

// The moving averages behind the run-time estimates. They are deliberately module
// scope rather than per-runtime: one server process keeps one set, so the estimate
// improves with every region or align run the server performs.
const processTiming = {
  planetMs: 48,
  systemMs: 200,
  planetsPerSystem: 7,
  planetSamples: 0,
  systemSamples: 0,
};

function createRuntime(options = {}) {
  const config = options.config || {};
  const deps = options.deps || {};
  const version = String(options.version || "");
  const log = typeof options.log === "function" ? options.log : () => {};
  const logError = typeof options.logError === "function" ? options.logError : () => {};
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  // The mod's live view of its own configuration file: `/ash offset` reads and
  // writes that file, so a change needs no restart. Absent in most tests and in any
  // caller without a config file; the boot value is then used as-is.
  const liveConfig = options.liveConfig || null;

  // A vendor accessor that throws (a missing file, a broken cycle) degrades to
  // null and is reported: the caller then answers with text instead of a stack.
  function vendor(name) {
    const getter = deps[name];
    if (typeof getter !== "function") {
      logError(`vendor accessor ${name} is missing`);
      return null;
    }
    try {
      return getter();
    } catch (error) {
      logError(`${name} could not be loaded: ${error && error.message}`);
      return null;
    }
  }

  function guard(what, operation, fallback = null) {
    try {
      return operation();
    } catch (error) {
      logError(`${what} failed: ${error && error.message}`);
      return fallback;
    }
  }

  function maxPlanets() {
    const value = toInt(config.maxPlanetsPerCommand, 64);
    return value > 0 ? value : 64;
  }

  function skyhookStructureRecords(systemID) {
    const structureState = vendor("getStructureState");
    if (!structureState || typeof structureState.listStructuresForSystem !== "function") {
      return [];
    }
    const records = guard(
      `structureState.listStructuresForSystem(${systemID})`,
      () => structureState.listStructuresForSystem(systemID, { includeDestroyed: true }),
      [],
    );
    return (Array.isArray(records) ? records : [])
      .filter((record) => toInt(record && record.typeID, 0) === SKYHOOK_TYPE_ID);
  }

  // A structure-shaped skyhook carries no planetID, so it is attributed through
  // the celestial it orbits (moonID, the field the structure store uses for the
  // body a flex structure sits at) and, failing that, through the vendor's own
  // nearest-planet resolver. An entry that cannot be attributed blocks the whole
  // system: nothing may be built where an unattributable one might already be.
  function attributeStructure(record, systemID, planetIDs) {
    const moonID = positiveInt(record && record.moonID, 0);
    if (moonID && planetIDs.has(moonID)) {
      return { planetID: moonID, source: "moonID" };
    }
    const orbitalState = vendor("getPlanetOrbitalState");
    const resolver = orbitalState && orbitalState._testing
      ? orbitalState._testing.findNearestPlanetID
      : null;
    if (typeof resolver === "function" && record && record.position) {
      const nearest = toInt(
        guard("findNearestPlanetID", () => resolver(systemID, record.position), 0),
        0,
      );
      if (nearest && planetIDs.has(nearest)) {
        return { planetID: nearest, source: "position" };
      }
    }
    return { planetID: 0, source: "unattributed" };
  }

  function readSkyhookRow(sov, skyhookID, identity) {
    if (!sov || typeof sov.getSkyhook !== "function" || !skyhookID) {
      return null;
    }
    const result = guard(
      `sovModernState.getSkyhook(${skyhookID})`,
      () => sov.getSkyhook(skyhookID, identity),
      null,
    );
    if (!isPlainObject(result)) return null;
    // The vendor answers 404/403 with the record attached when it has one, so a
    // refused read is still a read.
    const row = isPlainObject(result.skyhook) ? result.skyhook : null;
    if (!row) return null;
    return row;
  }

  // Occupancy from the ledger. Since 261018.1 a ledger row exists only for a real
  // deployment (or a raid-retained tombstone), so any row that is not destroyed
  // occupies the planet. A destroyed row is history, not occupancy - the game lets
  // a new Skyhook be placed on a planet whose old one was destroyed. Nothing here
  // ever clears one.
  function ledgerRowOccupies(row) {
    return row.destroyed !== true;
  }

  function addLedgerRow(index, row, source) {
    const planetID = positiveInt(row && row.planetID, 0);
    if (!planetID) return;
    const skyhookID = positiveInt(row && row.skyhookID, 0);
    const entry = index.byPlanet.get(planetID);
    // A row that is already indexed from an orbital is the better record: it is
    // the object the game will actually show.
    const rank = (candidate) => (
      candidate.source === "orbital" ? 3 : candidate.source === "local" ? 2 : 1
    );
    if (entry && rank(entry) > rank({ source })) return;
    index.byPlanet.set(planetID, {
      source,
      skyhookID,
      planetID,
      destroyed: row.destroyed === true,
      deployedItem: row.deployedItem === true,
      occupies: ledgerRowOccupies(row),
      active: row.active === true,
      corporationID: positiveInt(row.corporationID, 0),
      allianceID: positiveInt(row.allianceID, 0),
    });
  }

  function buildLedgerIndex(systemID, identity, planets, orbitalsByPlanet) {
    const index = { byPlanet: new Map(), claim: null };
    const sov = vendor("getSovModernState");
    if (!sov) return index;

    // listLocalSkyhooks is aimed by identity.solarSystemID and nothing else, so
    // it only says anything when the caller is already in the target system.
    if (toInt(identity && identity.solarSystemID, 0) === systemID
      && typeof sov.listLocalSkyhooks === "function") {
      const local = guard(
        "sovModernState.listLocalSkyhooks",
        () => sov.listLocalSkyhooks(identity),
        null,
      );
      for (const row of (local && Array.isArray(local.skyhooks) ? local.skyhooks : [])) {
        if (positiveInt(row && row.solarSystemID, 0) === systemID) addLedgerRow(index, row, "local");
      }
    }

    for (const planet of planets) {
      const planetID = positiveInt(planet && planet.planetID, 0);
      if (!planetID) continue;
      for (const orbital of (orbitalsByPlanet.get(planetID) || [])) {
        const itemID = positiveInt(orbital && orbital.itemID, 0);
        if (!itemID) continue;
        const deployedRow = readSkyhookRow(sov, itemID, identity);
        if (deployedRow && positiveInt(deployedRow.planetID, 0) === planetID) {
          addLedgerRow(index, deployedRow, "orbital");
        }
      }
    }

    for (const entry of index.byPlanet.values()) {
      if (!index.claim || entry.deployedItem) index.claim = entry;
      if (entry.deployedItem) break;
    }
    // 261018.1 no longer mints a ledger row per planet, so a claimed system with
    // no deployed Skyhook has no ledger row at all - and with the ownership gate
    // on, that would read as "not claimed". Fall back to the system row itself.
    if (!index.claim) {
      const gameStore = vendor("getGameStore");
      if (gameStore && typeof gameStore.read === "function") {
        const read = guard(
          "gameStore.read sovereignty/system",
          () => gameStore.read("sovereignty", `/systems/${systemID}`),
          null,
        );
        const system = read && read.success === true ? read.data : null;
        if (system) {
          index.claim = {
            source: "system",
            skyhookID: 0,
            planetID: 0,
            destroyed: false,
            deployedItem: false,
            occupies: false,
            active: false,
            corporationID: positiveInt(system.corporationID, 0),
            allianceID: positiveInt(system.allianceID, 0),
          };
        }
      }
    }
    return index;
  }

  function isDestroyedOrbital(orbitalState, record) {
    if (toInt(record && record.destroyedAtMs, 0) > 0) return true;
    const probe = orbitalState && typeof orbitalState.isOrbitalRecordDestroyed === "function"
      ? orbitalState.isOrbitalRecordDestroyed
      : null;
    return probe ? probe(record) === true : false;
  }

  function inspectPlanet(context, planet) {
    const { systemID, orbitalState, structures, ledger, identity } = context;
    const planetID = positiveInt(planet && planet.planetID, 0);
    const entry = {
      planetID,
      itemName: String((planet && planet.itemName) || `Planet ${planetID}`),
      celestialIndex: toInt(planet && planet.celestialIndex, 0),
      position: normalizeVector(planet && planet.position),
      radius: toFiniteNumber(planet && planet.radius, 0),
      state: "free",
      reason: "free",
      itemID: 0,
      destroyedAtMs: 0,
      detail: null,
      overDestroyed: false,
      tombstone: null,
    };
    if (!planetID) {
      entry.state = "occupied";
      entry.reason = "invalid-planet";
      return entry;
    }

    const orbitals = (context.orbitalsByPlanet.get(planetID) || []);
    const live = orbitals.find((record) => !isDestroyedOrbital(orbitalState, record));
    if (live) {
      entry.state = "occupied";
      entry.reason = "live";
      entry.itemID = positiveInt(live.itemID, 0);
      entry.detail = "live skyhook";
      addLedgerRowIfMissing(ledger, identity, live);
      return entry;
    }
    // A destroyed orbital record is history, not a "no": the planet may be
    // deployed on again, and the record itself is never deleted or cleared - the
    // new Skyhook gets its own item id and its own orbital record beside it. The
    // tombstone only stops the vendor's bootstrap from re-minting the default
    // slot for a claimed planet.
    const tombstone = orbitals.find((record) => isDestroyedOrbital(orbitalState, record));
    if (tombstone) {
      entry.overDestroyed = true;
      entry.itemID = positiveInt(tombstone.itemID, 0);
      entry.destroyedAtMs = toInt(tombstone.destroyedAtMs, 0);
      entry.tombstone = {
        kind: "orbital",
        itemID: entry.itemID,
        destroyedAtMs: entry.destroyedAtMs,
      };
      entry.detail = "over a destroyed skyhook tombstone";
    }

    const row = ledger.byPlanet.get(planetID) || null;
    if (row && row.occupies) {
      entry.state = "occupied";
      entry.reason = "ledger";
      entry.itemID = row.skyhookID;
      entry.detail = row.deployedItem
        ? "sovereignty ledger row (deployed)"
        : "sovereignty ledger row";
      return entry;
    }
    if (row && row.destroyed) {
      // A destroyed deployment record is history as well.
      if (!entry.tombstone) {
        entry.overDestroyed = true;
        entry.itemID = row.skyhookID;
        entry.tombstone = {
          kind: "ledger",
          itemID: row.skyhookID,
          destroyedAtMs: 0,
        };
        entry.detail = "over a destroyed skyhook record";
      }
    }

    const structure = structures.byPlanet.get(planetID) || null;
    if (structure) {
      entry.state = "occupied";
      entry.reason = "structure";
      entry.itemID = positiveInt(structure.structureID, 0);
      entry.detail = "structure-shaped skyhook";
      return entry;
    }

    return entry;
  }

  // A live orbital found by inspection may not be in the index when the ledger
  // read was refused; it only matters for the reported claim, so the row is
  // filled in from the orbital record itself.
  function addLedgerRowIfMissing(ledger, identity, orbital) {
    const planetID = positiveInt(orbital && orbital.planetID, 0);
    if (!planetID || ledger.byPlanet.has(planetID)) return;
    addLedgerRow(ledger, {
      skyhookID: orbital.itemID,
      planetID,
      solarSystemID: orbital.solarSystemID,
      destroyed: false,
      deployedItem: true,
      corporationID: orbital.corporationID,
      allianceID: orbital.allianceID,
    }, "orbital");
  }

  function inspectSystem(systemID, identity) {
    const orbitalState = vendor("getPlanetOrbitalState");
    if (!orbitalState || !orbitalState._testing
      || typeof orbitalState._testing.listPlanetsForSystem !== "function") {
      return { ok: false, error: "the planet catalogue is unavailable; see the server log" };
    }
    const planets = guard(
      `listPlanetsForSystem(${systemID})`,
      () => orbitalState._testing.listPlanetsForSystem(systemID),
      [],
    );
    if (!Array.isArray(planets) || planets.length === 0) {
      return { ok: false, error: `solar system ${systemID} has no planets (is that a system id?)` };
    }
    const planetIDs = new Set(planets.map((planet) => positiveInt(planet && planet.planetID, 0)));
    planetIDs.delete(0);

    const orbitalsByPlanet = new Map();
    for (const planetID of planetIDs) {
      const records = guard(
        `listOrbitalsForPlanet(${planetID})`,
        () => orbitalState.listOrbitalsForPlanet(planetID),
        [],
      );
      orbitalsByPlanet.set(
        planetID,
        (Array.isArray(records) ? records : [])
          .filter((record) => toInt(record && record.typeID, 0) === SKYHOOK_TYPE_ID),
      );
    }

    const structures = { records: [], byPlanet: new Map(), unattributed: [] };
    for (const record of skyhookStructureRecords(systemID)) {
      const attributed = attributeStructure(record, systemID, planetIDs);
      const shaped = {
        structureID: positiveInt(record && record.structureID, 0),
        name: String((record && (record.itemName || record.name)) || ""),
        planetID: attributed.planetID,
        source: attributed.source,
      };
      structures.records.push(shaped);
      if (shaped.planetID) structures.byPlanet.set(shaped.planetID, shaped);
      else structures.unattributed.push(shaped);
    }

    const ledger = buildLedgerIndex(systemID, identity, planets, orbitalsByPlanet);
    const context = { systemID, orbitalState, structures, ledger, identity, orbitalsByPlanet };
    const entries = planets.map((planet) => inspectPlanet(context, planet));

    return {
      ok: true,
      solarSystemID: systemID,
      label: describeSystemLabel(systemID),
      planets: entries,
      claim: ledger.claim,
      structures,
      maxPlanetsPerCommand: maxPlanets(),
    };
  }

  // A label is a convenience for the reply, and it carries the system's name only:
  // a report is meant to be read, and a name plus an id is noise. The id itself is
  // still named wherever an operator may have to type it (`system <id>` scopes,
  // usage text, log lines); the reply labels do not repeat it.
  function describeSystemLabel(systemID) {
    const worldData = vendor("getWorldData");
    if (worldData && typeof worldData.getSolarSystemByID === "function") {
      const row = guard(
        `getSolarSystemByID(${systemID})`,
        () => worldData.getSolarSystemByID(systemID),
        null,
      );
      const name = row && String(row.solarSystemName || row.name || "").trim();
      if (name) return name;
    }
    return `system ${systemID}`;
  }

  // A planet's name, from the row already in hand when it carries one, otherwise from
  // the vendor's celestial catalogue. "an unnamed planet" is the honest fallback: it
  // reads as a place, and an item id never appears in a message.
  function planetNameFor(planetID, row) {
    const given = String((row && (row.itemName || row.name)) || "").trim();
    if (given) return given;
    const id = positiveInt(planetID, 0);
    if (!id) return "an unnamed planet";
    const worldData = vendor("getWorldData");
    if (worldData && typeof worldData.getCelestialByID === "function") {
      const celestial = guard(
        `getCelestialByID(${id})`,
        () => worldData.getCelestialByID(id),
        null,
      );
      const name = String((celestial && (celestial.itemName || celestial.name)) || "").trim();
      if (name) return name;
    }
    return "an unnamed planet";
  }

  // What the operator reads instead of an id. This mod only ever moves or destroys
  // Skyhooks, so the object needs no further qualification than the planet it orbits.
  function skyhookLabel(planetName) {
    const name = String(planetName == null ? "" : planetName).trim();
    return `orbital skyhook at ${name || "an unnamed planet"}`;
  }

  function callerIdentity(session) {
    const characterID = positiveInt(
      session && (session.characterID || session.charid || session.characterId),
      0,
    );
    let corporationID = positiveInt(
      session && (session.corporationID || session.corpid || session.corporationId),
      0,
    );
    let allianceID = positiveInt(
      session && (session.allianceID || session.allianceid || session.allianceId),
      0,
    );
    if (characterID && (!corporationID || !allianceID)) {
      const characterState = vendor("getCharacterState");
      const record = characterState && typeof characterState.peekCharacterRecord === "function"
        ? guard("peekCharacterRecord", () => characterState.peekCharacterRecord(characterID), null)
        : null;
      if (record) {
        if (!corporationID) corporationID = positiveInt(record.corporationID, 0);
        if (!allianceID) allianceID = positiveInt(record.allianceID, 0);
      }
    }
    const solarSystemID = positiveInt(
      session && (session.solarsystemid2 || session.solarsystemid
        || session.solarSystemID || session.solarSystemId),
      0,
    );
    const characterName = String(
      (session && (session.characterName || session.charName || session.character_name)) || "",
    ).trim();
    return { characterID, corporationID, allianceID, solarSystemID, characterName };
  }

  // "here" and a bare numeric system id are the only two tokens accepted. A
  // missing token is not defaulted here: the subcommand decides, so /ash anchor
  // with no argument is a usage error while /ash status with no argument means
  // the caller's own system.
  function resolveSystemToken(token, identity) {
    const text = String(token == null ? "" : token).trim().toLowerCase();
    if (!text || text === "here" || text === "current") {
      const solarSystemID = positiveInt(identity && identity.solarSystemID, 0);
      if (!solarSystemID) {
        return {
          ok: false,
          error: "no current solar system on this session; name a system id instead",
        };
      }
      return { ok: true, solarSystemID, token: "here" };
    }
    if (!/^\d+$/u.test(text)) {
      return { ok: false, error: `"${token}" is not a solar system id (use here or a number)` };
    }
    const solarSystemID = positiveInt(text, 0);
    if (!solarSystemID) {
      return { ok: false, error: "a solar system id must be a positive number" };
    }
    return { ok: true, solarSystemID, token: text };
  }

  function ownershipRefusal(claim, identity) {
    const corporationID = positiveInt(identity && identity.corporationID, 0);
    const allianceID = positiveInt(identity && identity.allianceID, 0);
    if (!claim) {
      return "that system is not claimed, and this server only deploys into a system its "
        + "owner corporation or alliance already holds";
    }
    const corpMatch = corporationID > 0 && claim.corporationID === corporationID;
    const allianceMatch = allianceID > 0 && claim.allianceID === allianceID;
    if (corpMatch || allianceMatch) return null;
    return "that system belongs to another corporation or alliance, and this server only "
      + "deploys into a system its owner already holds";
  }

  function ownerIDFor(identity) {
    const corporationID = positiveInt(identity && identity.corporationID, 0);
    const characterID = positiveInt(identity && identity.characterID, 0);
    if (config.ownerMode === OWNER_MODE_CHARACTER) {
      return characterID;
    }
    return corporationID || characterID;
  }

  function buildPlan(systemID, identity) {
    const inspection = inspectSystem(systemID, identity);
    if (!inspection.ok) return inspection;
    const cap = inspection.maxPlanetsPerCommand;
    if (inspection.planets.length > cap) {
      return {
        ok: false,
        error: `${inspection.label} has ${inspection.planets.length} planets, above the configured `
          + `maxPlanetsPerCommand (${cap}); raise the cap to work on this system`,
      };
    }
    const deployable = inspection.planets.filter((entry) => entry.state === "free");
    // Free planets that carry a destroyed record. They are deployed on like any
    // other free planet; the count exists so the reply can say it happened.
    const overDestroyed = deployable.filter((entry) => entry.overDestroyed === true);
    const skippedPresent = inspection.planets.filter((entry) => entry.state === "occupied");
    const ownerID = ownerIDFor(identity);
    let error = null;
    if (inspection.structures.unattributed.length > 0) {
      error = `${inspection.label} already holds a structure-shaped skyhook `
        + `(${inspection.structures.unattributed.map((entry) => entry.structureID).join(", ")}) `
        + "that is not tied to a planet; refusing to build anywhere in that system";
    } else if (config.requireClaimedSystemOwnership) {
      error = ownershipRefusal(inspection.claim, identity);
    } else if (ownerID <= 0) {
      error = "this session has no corporation or character to own a skyhook";
    } else if (deployable.length === 0) {
      error = `${inspection.label}: all ${inspection.planets.length} planets already have a `
        + `skyhook (${skippedPresent.length} present); nothing to deploy`;
    }
    return {
      ok: true,
      solarSystemID: systemID,
      label: inspection.label,
      planets: inspection.planets,
      deployable,
      overDestroyed,
      skippedPresent,
      structures: inspection.structures,
      claim: inspection.claim,
      ownerID,
      maxPlanetsPerCommand: cap,
      error,
    };
  }

  function readPlanetPosition(entry) {
    if (entry.position && (entry.position.x || entry.position.y || entry.position.z)) {
      return entry.position;
    }
    const celestial = readCelestialRow(entry.planetID);
    if (celestial && celestial.position) return normalizeVector(celestial.position);
    return normalizeVector(null);
  }

  // The planet's own celestial row, straight from the vendor's catalogue
  // (`worldData.getCelestialByID`). It carries `itemID`, `radius`, `position`,
  // `groupID` and `kind`, which is exactly the shape the warp-in point function
  // wants (the game's own structure placement builds the same object by hand at
  // `structureDeploymentPlacement.js:280-287`).
  function readCelestialRow(planetID) {
    const worldData = vendor("getWorldData");
    if (!worldData || typeof worldData.getCelestialByID !== "function") {
      return null;
    }
    const celestial = guard(
      `getCelestialByID(${planetID})`,
      () => worldData.getCelestialByID(planetID),
      null,
    );
    return isPlainObject(celestial) ? celestial : null;
  }

  // Where a warp to this planet actually lands.
  //
  // A warp to a planet in this game is deterministic and always lands on the same
  // point, whatever angle the ship approaches from. The vendor owns that point:
  // `getPlanetWarpInPoint` (`warpInPointParity.js:208`) derives the angle from
  // `createPythonRandom(planet.itemID)` (`:223`) and lands at
  // `radius + 1_000_000 + radius * dd` with a deliberate vertical component
  // (`y = planet.y + radius * Math.sin(rr) * 0.5`, `:239`) - so it is neither
  // horizontal nor a simple multiple of the radius. `getClientParityWarpInPoint`
  // (`:256`) dispatches to it for planets and returns null when the target has no
  // warp-in point at all (`hasClientWarpInPoint`, `:170`: no radius, radius below
  // `MIN_WARP_IN_POINT_RADIUS` (90,000), an asteroid belt, a wreck, or a category
  // that is not a celestial).
  //
  // The game itself uses this point for structure placement
  // (`structureDeploymentPlacement.js:276-294`) and warps players to exactly it
  // (`warpCommands.js:523-528`). Placing the Skyhook here is therefore what makes
  // it visible from the landing spot: an earlier build placed it 5,000 km off in
  // an arbitrary direction, which is not where the player arrives. The 12,500 km
  // streaming correlation the previous build was based on was a red herring.
  function readWarpInPoint(celestial) {
    const parity = vendor("getWarpInPointParity");
    if (!parity || typeof parity.getClientParityWarpInPoint !== "function") {
      log("warpInPointParity exports no getClientParityWarpInPoint - using the fallback placement");
      return null;
    }
    const point = guard(
      "getClientParityWarpInPoint",
      () => parity.getClientParityWarpInPoint(celestial),
      null,
    );
    if (!point) {
      return null;
    }
    const x = Number(point.x);
    const y = Number(point.y);
    const z = Number(point.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      log("the warp-in point is not a finite vector - using the fallback placement");
      return null;
    }
    return { x, y, z };
  }

  function unitVector(from, to) {
    const x = to.x - from.x;
    const y = to.y - from.y;
    const z = to.z - from.z;
    const length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length <= 0) {
      return null;
    }
    return { x: x / length, y: y / length, z: z / length };
  }

  // The system's star, read through the vendor's celestial catalogue
  // (`worldData.getCelestialsForSystem`, exported at worldData.js:292). A sun row
  // carries `position`; it is identified by `kind === "sun"` or `groupID === 6`.
  // The 258 MB celestials file is never parsed by this mod.
  function readStarPosition(systemID) {
    const worldData = vendor("getWorldData");
    if (!worldData || typeof worldData.getCelestialsForSystem !== "function") {
      log("the celestial catalogue has no getCelestialsForSystem - using the fallback direction");
      return null;
    }
    const celestials = guard(
      `getCelestialsForSystem(${systemID})`,
      () => worldData.getCelestialsForSystem(systemID),
      [],
    );
    for (const celestial of (Array.isArray(celestials) ? celestials : [])) {
      const kind = String((celestial && celestial.kind) || "").trim().toLowerCase();
      const groupID = toInt(celestial && celestial.groupID, 0);
      if (kind !== "sun" && groupID !== 6) continue;
      if (!celestial || !celestial.position) continue;
      return normalizeVector(celestial.position);
    }
    log(`solar system ${systemID} has no star row - using the fallback direction`);
    return null;
  }

  // A Skyhook is placed horizontally, on the star-facing side of its planet.
  //
  // The vendor's own static-scene direction (`staticSceneEntity.js:618-635`) is
  // derived from the planet id and is vertical by 10%, 57% or even 88% depending
  // on the id, which puts Skyhooks directly above or below their planet - a live
  // test showed the operator could not find them and read the layout as broken.
  // Measured manual deployments have a vertical component of only 1-4%, so the
  // offset is kept exactly in the ecliptic plane (y = 0) and pointed at the star,
  // which is both horizontal and predictable: the sunlit side of the planet.
  //
  // If the star cannot be read, or the planet sits on top of it, the direction
  // falls back to +X - horizontal as well. A vertical component is never
  // reintroduced.
  function horizontalDirection(systemID, planetPosition, planetID) {
    const star = readStarPosition(systemID);
    if (star) {
      const x = star.x - planetPosition.x;
      const z = star.z - planetPosition.z;
      const length = Math.hypot(x, z);
      if (length > 0) {
        return { x: x / length, y: 0, z: z / length };
      }
      log(`planet ${planetID} sits on its star - using the fallback direction`);
    }
    return { x: 1, y: 0, z: 0 };
  }

  // ─── the landing-point offset, adjustable from chat ─────────────────────────
  //
  // The value lives in the mod's own configuration file, so `/ash offset 5km` takes
  // effect on the next deploy and survives a restart. It is read **at command time**,
  // which means a hand edit of that file is picked up too. A file that has been
  // broken since boot is reported in text and the last good value is used: this
  // setting never fails closed and never throws out of a chat handler.
  const OFFSET_MIN_METERS = 0;
  const OFFSET_MAX_METERS = 100000;

  function configOffsetMeters() {
    return Math.max(0, toFiniteNumber(config.offsetMeters, 25000));
  }

  function readOffsetMeters() {
    const fallback = configOffsetMeters();
    if (!liveConfig || typeof liveConfig.getOffsetMeters !== "function") {
      return { meters: fallback, error: null };
    }
    const read = guard("liveConfig.getOffsetMeters", () => liveConfig.getOffsetMeters(), null);
    if (read === null) {
      return { meters: fallback, error: null };
    }
    // A reader that answers with a bare number is tolerated as well.
    if (typeof read === "number") {
      return Number.isFinite(read)
        ? { meters: read, error: null }
        : { meters: fallback, error: null };
    }
    const meters = Number(read.value);
    return {
      meters: Number.isFinite(meters) ? meters : fallback,
      error: read.error ? String(read.error) : null,
    };
  }

  function resolveOffsetMeters() {
    return readOffsetMeters().meters;
  }

  // "5" and "5km" are kilometres (the operator's phrasing), "5000m" is metres.
  // A bare number is kilometres, so "5000" is 5,000 km and out of range - the
  // reply says so rather than guessing.
  function parseOffsetMeters(text) {
    const raw = String(text == null ? "" : text).trim().toLowerCase();
    if (!raw) {
      return { ok: false, error: "no value given" };
    }
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(km|m)?$/u);
    if (!match) {
      return {
        ok: false,
        error: `"${text}" is not an offset; give kilometres (5 or 5km) or metres (5000m)`,
      };
    }
    const amount = Number(match[1]);
    const unit = match[2] || "km";
    const meters = unit === "m" ? amount : amount * 1000;
    if (!Number.isFinite(meters) || !Number.isInteger(meters)) {
      return { ok: false, error: `"${text}" does not resolve to a whole number of metres` };
    }
    if (meters < OFFSET_MIN_METERS || meters > OFFSET_MAX_METERS) {
      return {
        ok: false,
        error: `offset must be between 0 km and 100 km `
          + `(${OFFSET_MIN_METERS}..${OFFSET_MAX_METERS} m), so "${text}" is out of range`,
      };
    }
    return { ok: true, meters, km: meters / 1000, unit };
  }

  function describeOffsetValue(meters) {
    const km = meters / 1000;
    return `${Number.isInteger(km) ? km : Math.round(km * 1000) / 1000} km (${Math.round(meters)} m)`;
  }

  function offsetUsageLine(meters) {
    return `offset: ${describeOffsetValue(meters)} - a Skyhook sits this far past the `
      + "planet's landing point so a ship warping in does not materialise inside it";
  }

  // The one entry point the chat command uses: no argument reads, an argument
  // writes the config file. Never throws, and a file that cannot be read is
  // reported in text rather than throwing out of the handler.
  function handleOffsetCommand(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) {
      const read = readOffsetMeters();
      return { ok: true, changed: false, meters: read.meters, readError: read.error };
    }
    const parsed = parseOffsetMeters(raw);
    if (!parsed.ok) {
      const read = readOffsetMeters();
      return {
        ok: false,
        changed: false,
        error: parsed.error,
        meters: read.meters,
        readError: read.error,
      };
    }
    if (!liveConfig || typeof liveConfig.setOffsetMeters !== "function") {
      return {
        ok: false,
        changed: false,
        meters: resolveOffsetMeters(),
        error: "no configuration file is available, so the offset cannot be saved",
      };
    }
    const written = guard(
      "liveConfig.setOffsetMeters",
      () => liveConfig.setOffsetMeters(parsed.meters),
      null,
    );
    if (!written || written.ok !== true) {
      return {
        ok: false,
        changed: false,
        meters: resolveOffsetMeters(),
        error: `the offset could not be saved (${(written && written.error) || "write failed"})`,
      };
    }
    log(`offset set to ${parsed.meters} m and saved in ${liveConfig.file}`);
    return { ok: true, changed: true, meters: parsed.meters, file: liveConfig.file };
  }

  // ─── where the Skyhook goes ─────────────────────────────────────────────────
  //
  // The rule: **the planet's warp-in point**, `offsetMeters` further out along the
  // same bearing, so a ship that warps in materialises beside the Skyhook instead
  // of inside its model. `readWarpInPoint` documents the vendor provenance.
  // `direction` is the unit vector from the planet's centre to the landing point,
  // which carries the point's deliberate small vertical component -
  // `direction.y === 0` is a property of the fallback below, not of this rule.
  //
  // The fallback, used only when the vendor has no warp-in point for the celestial
  // (or the lookup failed, or the point is unusable), is the earlier heuristic:
  // `planetRadius + beyondSurface` from the centre, horizontally on the star-facing
  // side, with `beyondSurface = max(standoffMeters, planetRadius * orbitMargin)`.
  // Both keys are documented as the fallback's inputs. The 12,500 km
  // nearby-visibility correlation that motivated the scaling turned out to be a red
  // herring - what actually mattered was landing where the ship lands.
  function buildOrbitalSlot(entry, placement = {}) {
    const planetPosition = readPlanetPosition(entry);
    const planetRadius = Math.max(1_000, toFiniteNumber(entry.radius, 0));
    const standoff = Math.max(0, toFiniteNumber(placement.standoffMeters, 5_000_000));
    const orbitMargin = Math.max(0, toFiniteNumber(placement.orbitMargin, 1));

    // 1. The vendor's landing point for this planet. The celestial row is passed
    // as the vendor's own call sites build it, with the planet id guaranteed to
    // be there: `getClientParityWarpInPoint` seeds its RNG from `target.itemID`,
    // so a row without one would silently produce a different point rather than
    // no point at all.
    const celestialRow = readCelestialRow(entry.planetID);
    const warpInPoint = readWarpInPoint(celestialRow
      ? { ...celestialRow, itemID: positiveInt(celestialRow.itemID, entry.planetID) }
      : {
        itemID: entry.planetID,
        radius: planetRadius,
        position: planetPosition,
        groupID: 7,
        kind: "planet",
      });
    if (warpInPoint) {
      const direction = unitVector(planetPosition, warpInPoint);
      if (direction) {
        // The Skyhook sits `offsetMeters` further out along the same bearing, so a
        // ship that warps in materialises beside it instead of inside its model.
        // The direction is unchanged: only the position moves.
        const offset = resolveOffsetMeters();
        const position = {
          x: warpInPoint.x + (direction.x * offset),
          y: warpInPoint.y + (direction.y * offset),
          z: warpInPoint.z + (direction.z * offset),
        };
        const distance = Math.hypot(
          position.x - planetPosition.x,
          position.y - planetPosition.y,
          position.z - planetPosition.z,
        );
        return {
          planetRadius,
          standoff,
          orbitMargin,
          offsetMeters: offset,
          beyondSurface: distance - planetRadius,
          distance,
          source: "warp-in",
          direction,
          position,
        };
      }
      log(`planet ${entry.planetID} has a warp-in point at its own centre - using the fallback`);
    } else {
      log(`planet ${entry.planetID} has no usable warp-in point - using the fallback placement`);
    }

    // 2. Fallback: the horizontal, star-facing heuristic. The offset does not apply
    // here: it exists to keep a ship clear of the landing point, and there is no
    // landing point in this branch.
    const direction = horizontalDirection(placement.systemID, planetPosition, entry.planetID);
    // The larger of the two wins, so a small planet is unchanged and a big one
    // is pushed proportionally further out.
    const beyondSurface = Math.max(standoff, planetRadius * orbitMargin);
    const distance = planetRadius + beyondSurface;
    return {
      planetRadius,
      standoff,
      orbitMargin,
      offsetMeters: 0,
      beyondSurface,
      distance,
      source: "fallback",
      direction,
      position: {
        x: planetPosition.x + direction.x * distance,
        y: planetPosition.y + direction.y * distance,
        z: planetPosition.z + direction.z * distance,
      },
    };
  }

  // A launched Skyhook carries the type's radius in `spaceRadius`
  // (`orbitalLaunchRuntime.js:427-437`: `currentItem.spaceRadius ||
  // currentItem.radius || null`), and that is the only field a mod-created row
  // was missing. `createSpaceItemForOwner` fills the field only from
  // `options.spaceRadius > 0` (itemStore.js:3558-3560, resolver at :3467-3485),
  // so the radius is read from the item metadata (itemStore.js:1841, exported at
  // :7636) and passed explicitly - never hard-coded.
  function readSpaceRadius(itemStore) {
    if (!itemStore || typeof itemStore.getItemMetadata !== "function") {
      log("the item store exports no getItemMetadata - spaceRadius is left unset");
      return 0;
    }
    const metadata = guard(
      `getItemMetadata(${SKYHOOK_TYPE_ID})`,
      () => itemStore.getItemMetadata(SKYHOOK_TYPE_ID),
      null,
    );
    return metadata ? Math.max(0, toFiniteNumber(metadata.radius, 0)) : 0;
  }

  function applyPlan(plan, identity) {
    if (!plan || plan.ok !== true) {
      return { ok: false, error: (plan && plan.error) || "no plan" };
    }
    if (plan.error) {
      return { ok: false, error: plan.error, plan };
    }
    const itemStore = vendor("getItemStore");
    const orbitalState = vendor("getPlanetOrbitalState");
    if (!itemStore || typeof itemStore.createSpaceItemForOwner !== "function"
      || !orbitalState || typeof orbitalState.ensureOrbitalForItem !== "function") {
      return {
        ok: false,
        error: "the vendor inventory/planet-orbital services are unavailable; see the server log",
        plan,
      };
    }
    const spaceRuntime = vendor("getSpaceRuntime");
    const sov = vendor("getSovModernState");
    const deployed = [];
    const failures = [];
    // Read once: every row in this plan gets the same type radius.
    const spaceRadius = readSpaceRadius(itemStore);

    for (const entry of plan.deployable) {
      let itemID = 0;
      try {
        const slot = buildOrbitalSlot(entry, {
          standoffMeters: config.standoffMeters,
          orbitMargin: config.orbitMargin,
          systemID: plan.solarSystemID,
        });
        const created = itemStore.createSpaceItemForOwner(
          plan.ownerID,
          plan.solarSystemID,
          SKYHOOK_TYPE_ID,
          {
            position: slot.position,
            direction: slot.direction,
            targetPoint: slot.position,
            mode: "STOP",
            createdAtMs: now(),
            // Only when the metadata gave a radius: the vendor's own resolver
            // reads `options.spaceRadius > 0`, so passing 0 would be the same as
            // passing nothing.
            ...(spaceRadius > 0 ? { spaceRadius } : {}),
          },
        );
        if (!created || created.success !== true || !created.data) {
          failures.push({
            planetID: entry.planetID,
            itemName: entry.itemName,
            errorMsg: (created && created.errorMsg) || "CREATE_FAILED",
          });
          continue;
        }
        const item = created.data;
        itemID = positiveInt(item.itemID, 0);
        if (!itemID) {
          failures.push({
            planetID: entry.planetID,
            itemName: entry.itemName,
            errorMsg: "CREATE_RETURNED_NO_ITEM_ID",
          });
          continue;
        }
        // The per-planet cost of a run is measured here: everything from the item row
        // to the orbital record. It feeds the moving average the next estimate uses.
        const planetStartedAtMs = now();
        // planetID is passed explicitly: without it the vendor picks the
        // nearest planet to the position, which is not necessarily this one.
        const record = orbitalState.ensureOrbitalForItem(item, {
          solarSystemID: plan.solarSystemID,
          planetID: entry.planetID,
          ownerID: plan.ownerID,
          corporationID: plan.ownerID,
          allianceID: positiveInt(identity && identity.allianceID, 0) || null,
        });
        if (!record) {
          failures.push({
            planetID: entry.planetID,
            itemName: entry.itemName,
            itemID,
            errorMsg: "ORBITAL_NOT_ATTACHED",
          });
          continue;
        }
        noteTiming({ planetMs: now() - planetStartedAtMs, planets: 1 });
        deployed.push({
          planetID: entry.planetID,
          itemName: entry.itemName,
          itemID,
          state: toInt(record.state, 0),
          // "warp-in" when the Skyhook sits on the planet's landing point,
          // "fallback" when the vendor had none and the heuristic was used.
          placement: slot.source,
          spawn: "skipped",
        });
      } catch (error) {
        failures.push({
          planetID: entry.planetID,
          itemName: entry.itemName,
          itemID,
          errorMsg: (error && error.message) || String(error),
        });
        logError(`deploy at planet ${entry.planetID} failed: ${error && error.message}`);
        continue;
      }

      // The row and the orbital record are durable by now. A scene failure is
      // reported, never fatal, and never undoes them.
      if (spaceRuntime) {
        try {
          spaceRuntime.ensureScene(plan.solarSystemID);
          const spawn = spaceRuntime.spawnDynamicInventoryEntity(plan.solarSystemID, itemID);
          if (!spawn || spawn.success === false) {
            logError(
              `skyhook ${itemID} spawned into no scene: ${(spawn && spawn.errorMsg) || "no result"}`,
            );
          } else {
            const record = deployed[deployed.length - 1];
            record.spawn = "ok";
          }
        } catch (error) {
          logError(`skyhook ${itemID} could not be placed in its scene: ${error && error.message}`);
        }
      }
      // Reading the derived ledger row is what makes it exist immediately; the
      // row is never written by hand. 261018.1 only derives a row when the item
      // still matches its orbital exactly (type 81080, flag 0, owner and location
      // in this system, no private scope), so a refused read means this skyhook
      // will not appear in sovereignty. Report it loudly instead of claiming a
      // clean deploy.
      if (sov && typeof sov.getSkyhook === "function") {
        const read = guard("getSkyhook after deploy", () => sov.getSkyhook(itemID, identity), null);
        const record = deployed[deployed.length - 1];
        record.ledger = Boolean(read && read.ok === true);
        if (!record.ledger) {
          logError(
            `skyhook ${itemID} on planet ${entry.planetID} is in the world but not in the ` +
            "sovereignty ledger; check its item row (type 81080, flag 0, owner and system)",
          );
        }
      }
    }
    return { ok: true, solarSystemID: plan.solarSystemID, label: plan.label, deployed, failures, plan };
  }

  // ─── removal ────────────────────────────────────────────────────────────────
  //
  // The vendor's destruction triple, for one skyhook id, in the order that works
  // on 261018.1: orbital tombstone -> ledger tombstone -> scene entity (which
  // removes the items row). The ledger step has to precede the entity removal
  // because the ledger row is derived from the live item; doing it after leaves
  // the tombstone a no-op. Shared by `/ash remove <id>` and `/ash unanchor`, so
  // both paths behave identically.
  function destroyOneSkyhook(context, itemID, planetID) {
    const { orbitalState, spaceRuntime, sov, systemID } = context;
    // 1. orbital tombstone
    let marked = null;
    try {
      marked = orbitalState.markOrbitalDestroyed(itemID);
    } catch (error) {
      return {
        ok: false,
        failure: { itemID, planetID, errorMsg: (error && error.message) || String(error) },
      };
    }
    if (!marked || marked.success === false) {
      return {
        ok: false,
        failure: {
          itemID,
          planetID,
          errorMsg: (marked && marked.errorMsg) || "MARK_DESTROYED_FAILED",
        },
      };
    }
    // 2. ledger tombstone, and it has to happen BEFORE the items row goes away.
    // 261018.1 derives its ledger rows from live `deployedItem` orbitals, so once
    // the scene entity (and the item row behind it) is destroyed the row can no
    // longer be derived and the tombstone would be a no-op. Marking it destroyed
    // first also keeps the vendor's reconcile from pruning it: a destroyed row is
    // retained as history, a non-destroyed stale one is deleted.
    let ledgerTombstoned = false;
    try {
      if (sov && typeof sov.destroySkyhooks === "function") {
        const processed = sov.destroySkyhooks([itemID]);
        ledgerTombstoned = Array.isArray(processed) && processed.includes(itemID);
      }
    } catch (error) {
      logError(`ledger tombstone for skyhook ${itemID} failed: ${error && error.message}`);
    }
    // 3. scene entity (and the items row behind it)
    let entityNote = null;
    try {
      if (spaceRuntime) {
        spaceRuntime.ensureScene(systemID);
        const removal = spaceRuntime.destroyDynamicInventoryEntity(systemID, itemID, {
          suppressExplosion: true,
        });
        if (removal && removal.success === false
          && removal.errorMsg !== "DYNAMIC_ENTITY_NOT_FOUND") {
          entityNote = String(removal.errorMsg || "DESTROY_ENTITY_FAILED");
        }
      } else {
        entityNote = "SPACE_RUNTIME_UNAVAILABLE";
      }
    } catch (error) {
      entityNote = (error && error.message) || String(error);
    }
    return { ok: true, destroyed: { itemID, planetID, entityNote, ledgerTombstoned } };
  }

  // ─── the item-id counter, calibrated once per removal command ───────────────
  //
  // A removal deletes an items row, so the operator wants the game's own
  // "next item id" counter re-synced to make sure a freed id can never be handed
  // out again. The counter is only moved when it is actually behind the highest
  // referenced id: `reserveItemIDs` consumes an id (it advances the counter past
  // what it returns), so calling it when the counter is already correct would leak
  // one id per command. Nothing here writes the store directly - the forward move
  // goes through the vendor's own `reserveItemIDs`, which is exactly what the
  // vendor uses for this (`max(state.nextItemID, highWater + 1)`, then a
  // synchronous flush).
  function readStoredItemIDCounter(allocator) {
    const gameStore = vendor("getGameStore");
    const table = allocator && allocator.IDENTITY_TABLE;
    if (!gameStore || typeof gameStore.read !== "function" || !table) {
      return null;
    }
    const result = guard(
      `gameStore.read(${table})`,
      () => gameStore.read(table, "/"),
      null,
    );
    const state = result && result.success !== false ? result.data : null;
    const counter = positiveInt(state && state.nextItemID, 0);
    return counter > 0 ? counter : null;
  }

  function calibrateItemIDCounter() {
    const allocator = vendor("getIdentityAllocator");
    if (!allocator
      || typeof allocator.getItemReferenceHighWaterMark !== "function"
      || typeof allocator.reserveItemIDs !== "function") {
      log("identityAllocator is unavailable - the item id counter was not calibrated");
      return null;
    }
    const highWater = positiveInt(guard(
      "getItemReferenceHighWaterMark",
      () => allocator.getItemReferenceHighWaterMark(),
      null,
    ), 0);
    const counter = readStoredItemIDCounter(allocator);
    if (!counter || !highWater) {
      log("the item id counter could not be read - it was not calibrated");
      return null;
    }
    if (counter > highWater) {
      return { calibrated: false, counter, highWater };
    }
    const reserved = guard("reserveItemIDs", () => allocator.reserveItemIDs(1), null);
    const firstID = Array.isArray(reserved) && reserved.length > 0
      ? positiveInt(reserved[0], 0)
      : 0;
    if (!firstID) {
      logError("reserveItemIDs did not return an id - the counter was not calibrated");
      return null;
    }
    log(`item id counter calibrated: ${counter} -> ${firstID + 1} (highest id was ${highWater})`);
    return {
      calibrated: true,
      previous: counter,
      counter: firstID + 1,
      firstID,
      highWater,
    };
  }

  function describeCounter(counter) {
    if (!counter) return null;
    if (counter.calibrated) {
      return `item id counter: raised to ${counter.counter} `
        + `(was ${counter.previous}, highest id ${counter.highWater})`;
    }
    return `item id counter: ${counter.counter} (already ahead of the highest id)`;
  }

  // One Skyhook, by the id the scanner shows or by the name of the planet it orbits.
  // A refusal is always text; an id that is already a tombstone is answered gracefully.
  function removeSkyhook(target, identity) {
    const typed = String(target == null ? "" : target).trim();
    // The spelling an operator reads off the screen is the planet's name ("RYQC-I III"),
    // so that is accepted beside the raw id. A name is resolved inside the caller's own
    // system: it can only ever name a Skyhook the caller could see.
    if (typed && !/^\d+$/u.test(typed)) {
      const resolved = resolveSkyhookByPlanetName(typed, identity);
      if (!resolved.ok) return resolved;
      return removeSkyhookByID(resolved.itemID, identity);
    }
    const id = positiveInt(typed, 0);
    if (!id) {
      return {
        ok: false,
        error: "a Skyhook id or the name of the planet it orbits is needed "
          + "(for example /ash remove 9988400003181 or /ash remove \"RYQC-I III\")",
      };
    }
    return removeSkyhookByID(id, identity);
  }

  // A planet's name (or the name of the Skyhook on it) as typed, resolved to that one
  // Skyhook. Only the caller's own system is searched, and a name matching nothing, or
  // a planet with no Skyhook, is refused in words rather than by id.
  function resolveSkyhookByPlanetName(name, identity) {
    const wanted = normalizeLookupText(name);
    const systemID = positiveInt(identity && identity.solarSystemID, 0);
    if (!wanted) {
      return { ok: false, error: "the planet name is empty" };
    }
    if (!systemID) {
      return {
        ok: false,
        error: "a planet name only resolves in the solar system you are in; "
          + "name the Skyhook by id instead",
      };
    }
    const orbitalState = vendor("getPlanetOrbitalState");
    const worldData = vendor("getWorldData");
    if (!worldData || typeof worldData.getCelestialsForSystem !== "function") {
      return { ok: false, error: "the celestial catalogue is unavailable; see the server log" };
    }
    const listed = guard(
      `listPlanetsForSystem(${systemID})`,
      () => (orbitalState && orbitalState._testing && orbitalState._testing.listPlanetsForSystem
        ? orbitalState._testing.listPlanetsForSystem(systemID)
        : []),
      [],
    );
    const rowByID = new Map();
    for (const row of (Array.isArray(listed) ? listed : [])) {
      rowByID.set(positiveInt(row && row.planetID, 0), row);
    }
    const celestials = guard(
      `getCelestialsForSystem(${systemID})`,
      () => worldData.getCelestialsForSystem(systemID),
      [],
    );
    const matches = [];
    for (const celestial of (Array.isArray(celestials) ? celestials : [])) {
      const planetID = positiveInt(
        celestial && (celestial.itemID ?? celestial.planetID ?? celestial.celestialID),
        0,
      );
      if (!planetID || planetID === systemID) continue;
      const label = planetNameFor(planetID, rowByID.get(planetID) || celestial);
      if (normalizeLookupText(label) === wanted) matches.push({ planetID, label });
    }
    if (matches.length === 0) {
      return {
        ok: false,
        error: `no planet named "${name}" is in ${describeSystemLabel(systemID)}; `
          + "check the spelling, or name the Skyhook by id",
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `"${name}" names ${matches.length} planets in `
          + `${describeSystemLabel(systemID)}; name the Skyhook by id instead`,
      };
    }
    const planetID = matches[0].planetID;
    if (!orbitalState || typeof orbitalState.listOrbitalsForPlanet !== "function") {
      return { ok: false, error: "the planet-orbital service is unavailable; see the server log" };
    }
    const orbitals = guard(
      `listOrbitalsForPlanet(${planetID})`,
      () => orbitalState.listOrbitalsForPlanet(planetID),
      [],
    );
    const live = (Array.isArray(orbitals) ? orbitals : [])
      .filter((record) => toInt(record && record.typeID, 0) === SKYHOOK_TYPE_ID)
      .filter((record) => !isDestroyedOrbital(orbitalState, record));
    if (live.length === 0) {
      return {
        ok: false,
        error: `${skyhookLabel(matches[0].label)} is not deployed in `
          + `${describeSystemLabel(systemID)} (nothing there to remove)`,
      };
    }
    if (live.length > 1) {
      return {
        ok: false,
        error: `${skyhookLabel(matches[0].label)} matches `
          + `${live.length} live Skyhooks; use /ash status to see the system, then remove by id`,
      };
    }
    return { ok: true, itemID: positiveInt(live[0].itemID, 0), planetID };
  }

  function normalizeLookupText(value) {
    return String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/gu, " ");
  }

  function removeSkyhookByID(id, identity) {
    const orbitalState = vendor("getPlanetOrbitalState");
    if (!orbitalState || typeof orbitalState.getOrbitalByID !== "function") {
      return { ok: false, error: "the planet-orbital service is unavailable; see the server log" };
    }

    // A structure-shaped Skyhook is a structure, not an orbital record, so it is
    // recognised by its own store - and never touched. Checking it by id first
    // means the refusal works even when no orbital record names the system.
    const structureState = vendor("getStructureState");
    if (structureState && typeof structureState.getStructureByID === "function") {
      const structure = guard(
        `getStructureByID(${id})`,
        () => structureState.getStructureByID(id),
        null,
      );
      if (structure) {
        const structureTypeID = toInt(structure.typeID, 0);
        const systemID = positiveInt(structure.solarSystemID, 0);
        return {
          ok: false,
          error: structureTypeID === SKYHOOK_TYPE_ID
            ? `that id is a structure-shaped Skyhook${
              systemID ? ` in ${describeSystemLabel(systemID)}` : ""}; `
              + "this command never destroys those"
            : `that id is a structure (typeID ${structureTypeID}), not an orbital Skyhook`,
        };
      }
    }

    const record = guard(
      `getOrbitalByID(${id})`,
      () => orbitalState.getOrbitalByID(id),
      null,
    );
    const known = record && toInt(record.typeID, 0) === SKYHOOK_TYPE_ID ? record : null;

    // The system is needed for the scene calls; the orbital record carries it, and
    // the derived ledger row is the fallback read.
    const sov = vendor("getSovModernState");
    let systemID = known ? positiveInt(known.solarSystemID, 0) : 0;
    let ledgerRow = null;
    if (!systemID) {
      ledgerRow = readSkyhookRow(sov, id, identity);
      if (ledgerRow) systemID = positiveInt(ledgerRow.solarSystemID, 0);
    }

    if (!known) {
      // A system id rather than a Skyhook id is the mistake worth naming, because
      // the sweep moved to /ash unanchor.
      const planets = guard(
        `listPlanetsForSystem(${id})`,
        () => (orbitalState._testing && orbitalState._testing.listPlanetsForSystem
          ? orbitalState._testing.listPlanetsForSystem(id)
          : []),
        [],
      );
      if (Array.isArray(planets) && planets.length > 0) {
        return {
          ok: false,
          error: `${id} is a solar system, not a Skyhook id; to clear a whole system use `
            + `/ash unanchor ${id}`,
        };
      }
      if (ledgerRow && ledgerRow.destroyed === true) {
        return { ok: false, error: `Skyhook ${id} is already a destroyed tombstone (kept)` };
      }
      return { ok: false, error: `no Skyhook with id ${id} is known to this server` };
    }

    const planetID = positiveInt(known.planetID, 0);
    if (isDestroyedOrbital(orbitalState, known)) {
      return {
        ok: true,
        solarSystemID: systemID,
        label: describeSystemLabel(systemID),
        destroyed: [],
        alreadyDestroyed: [{ itemID: id, planetID }],
        failures: [],
        untouchedStructures: [],
        counter: calibrateItemIDCounter(),
      };
    }

    const context = {
      orbitalState,
      spaceRuntime: vendor("getSpaceRuntime"),
      sov,
      systemID,
    };
    const result = destroyOneSkyhook(context, id, planetID);
    if (!result.ok) {
      return {
        ok: true,
        solarSystemID: systemID,
        label: describeSystemLabel(systemID),
        destroyed: [],
        alreadyDestroyed: [],
        failures: [result.failure],
        untouchedStructures: [],
        counter: calibrateItemIDCounter(),
      };
    }
    return {
      ok: true,
      solarSystemID: systemID,
      label: describeSystemLabel(systemID),
      destroyed: [result.destroyed],
      alreadyDestroyed: [],
      failures: result.destroyed.entityNote
        ? [{ itemID: id, planetID, errorMsg: `scene entity: ${result.destroyed.entityNote}` }]
        : [],
      untouchedStructures: [],
      counter: calibrateItemIDCounter(),
    };
  }

  // `/ash unanchor here|<systemID>`: every Skyhook in the system, whoever deployed
  // it. This is the behaviour `/ash remove here` used to have. `options.calibrate`
  // is false when a region scope is driving this: the counter is then calibrated
  // once for the whole command, not once per system.
  function unanchorSystem(systemID, identity, options = {}) {
    const orbitalState = vendor("getPlanetOrbitalState");
    if (!orbitalState || typeof orbitalState.listOrbitalsForSystem !== "function") {
      return { ok: false, error: "the planet-orbital service is unavailable; see the server log" };
    }
    const orbitals = guard(
      `listOrbitalsForSystem(${systemID})`,
      () => orbitalState.listOrbitalsForSystem(systemID),
      [],
    );
    const skyhooks = (Array.isArray(orbitals) ? orbitals : [])
      .filter((record) => toInt(record && record.typeID, 0) === SKYHOOK_TYPE_ID);
    const structures = skyhookStructureRecords(systemID);
    const cap = maxPlanets();
    if (skyhooks.length + structures.length > cap) {
      return {
        ok: false,
        error: `solar system ${systemID} holds ${skyhooks.length + structures.length} skyhook `
          + `entries, above the configured maxPlanetsPerCommand (${cap}); raise the cap to clear it`,
      };
    }

    const context = {
      orbitalState,
      spaceRuntime: vendor("getSpaceRuntime"),
      sov: vendor("getSovModernState"),
      systemID,
    };
    const destroyed = [];
    const alreadyDestroyed = [];
    const failures = [];
    const untouchedStructures = structures.map((record) => ({
      structureID: positiveInt(record && record.structureID, 0),
      name: String((record && (record.itemName || record.name)) || ""),
      planetID: positiveInt(record && (record.moonID || record.planetID), 0),
    }));

    for (const record of skyhooks) {
      const itemID = positiveInt(record && record.itemID, 0);
      const planetID = positiveInt(record && record.planetID, 0);
      if (!itemID) continue;
      if (isDestroyedOrbital(orbitalState, record)) {
        // The tombstone stays exactly where it is: deleting a destroyed
        // skyhook's orbital row makes the vendor mint a fresh default. The reply
        // counts markers, so the id of each one is only written to the verbose log.
        log(`unanchor: leaving destroyed marker ${itemID} on planet ${planetID} alone`);
        alreadyDestroyed.push({ itemID, planetID });
        continue;
      }
      const result = destroyOneSkyhook(context, itemID, planetID);
      if (!result.ok) {
        failures.push(result.failure);
        continue;
      }
      destroyed.push(result.destroyed);
      if (result.destroyed.entityNote) {
        failures.push({
          itemID,
          planetID,
          errorMsg: `scene entity: ${result.destroyed.entityNote}`,
        });
      }
    }

    return {
      ok: true,
      solarSystemID: systemID,
      label: describeSystemLabel(systemID),
      destroyed,
      alreadyDestroyed,
      failures,
      untouchedStructures,
      counter: options.calibrate === false ? null : calibrateItemIDCounter(),
    };
  }

  // ─── scoping: one system, or a whole region ──────────────────────────────────
  //
  // Which systems may be worked on is decided by the vendor's own rule, never by a
  // reimplementation: `isSovereigntyClaimableSolarSystem`
  // (`server/src/services/sovereignty/sovSystemRules.js:46`) returns false for faction
  // space (`:67`), for high-sec and low-sec (`security > 0`, `:71-72`), for Zarzakh
  // (`:55`) and for the regions the game never lets anyone claim
  // (`NON_CLAIMABLE_REGION_IDS`, `:63`). A system is workable exactly when that
  // function says it is claimable; if the rule cannot be loaded at all, a scoped
  // command refuses instead of building Skyhooks in space that is not ours.
  function isClaimableSystem(rowOrID) {
    const rules = vendor("getSovSystemRules");
    if (!rules || typeof rules.isSovereigntyClaimableSolarSystem !== "function") {
      log("sovSystemRules exports no isSovereigntyClaimableSolarSystem");
      return null;
    }
    // A rule that throws is "unknown", not "not claimable": both refuse, but only
    // the first is honest about why, and the refusal text differs.
    try {
      return rules.isSovereigntyClaimableSolarSystem(rowOrID) === true;
    } catch (error) {
      logError(`isSovereigntyClaimableSolarSystem failed: ${error && error.message}`);
      return null;
    }
  }

  function readSystemRow(systemID) {
    const worldData = vendor("getWorldData");
    if (!worldData || typeof worldData.getSolarSystemByID !== "function") {
      return { available: false, row: null };
    }
    const row = guard(
      `getSolarSystemByID(${systemID})`,
      () => worldData.getSolarSystemByID(systemID),
      null,
    );
    return { available: true, row: isPlainObject(row) ? row : null };
  }

  // The region's name, from the generated table (`lib/regionNames.js`, built from CCP's
  // public ESI `universe/regions` endpoints). An id the table does not know falls back
  // to "region <id>" rather than printing nothing.
  function describeRegion(regionID) {
    const id = positiveInt(regionID, 0);
    if (!id) return "an unknown region";
    const name = regionNames[id];
    return name ? String(name) : `region ${id}`;
  }

  // The label a region-scoped reply uses. The vendor's own rows are read first (a row
  // that carries a region name is authoritative for that server), and the generated
  // table answers when they do not; an unknown id still says "region <id>" so a typo
  // is visible rather than silent.
  function describeRegionLabel(regionID, rows) {
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const name = String((row && (row.regionName || row.name)) || "").trim();
      if (name) return name;
    }
    return describeRegion(regionID);
  }

  function describeSystemDetail(row) {
    if (!row) return "";
    const parts = [];
    const security = Number(row.security);
    if (Number.isFinite(security)) parts.push(`security ${security}`);
    const factionID = positiveInt(row.factionID, 0);
    if (factionID) parts.push(`faction ${factionID}`);
    return parts.length > 0 ? ` (${parts.join(", ")})` : "";
  }

  // Region -> systems comes from the vendor's static table
  // (`worldData.getSolarSystems`, exported at `worldData.js:277`, ~8,490 rows). The
  // derived map is built once and kept for the life of the process: the table does
  // not change at runtime, and rebuilding it per command would be wasteful.
  let regionIndex = null;
  function systemsInRegion(regionID) {
    if (!regionIndex) {
      const worldData = vendor("getWorldData");
      if (!worldData || typeof worldData.getSolarSystems !== "function") {
        return null;
      }
      const rows = guard("getSolarSystems", () => worldData.getSolarSystems(), []);
      const index = new Map();
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const id = positiveInt(row && (row.regionID ?? row.regionId), 0);
        const systemID = positiveInt(row && row.solarSystemID, 0);
        if (!id || !systemID) continue;
        if (!index.has(id)) index.set(id, []);
        index.get(id).push(row);
      }
      regionIndex = index;
      log(`indexed ${index.size} region(s) from the vendor's system table`);
    }
    return regionIndex.get(regionID) || [];
  }

  // A scope is what one command acts on: one system, or every workable system in a
  // region. A single system in NPC space is refused outright; inside a region those
  // systems are skipped and named in the reply.
  function resolveScope(scope, identity) {
    const kind = scope && scope.kind === "region" ? "region" : "system";

    if (kind === "region") {
      const regionID = positiveInt(scope && scope.regionID, 0);
      if (!regionID) {
        return { ok: false, error: "a region id must be a positive number" };
      }
      const rows = systemsInRegion(regionID);
      if (rows === null) {
        return { ok: false, error: "the system catalogue is unavailable; see the server log" };
      }
      if (rows.length === 0) {
        return {
          ok: false,
          error: `region ${regionID} holds no solar systems (is that a region id?)`,
        };
      }
      const label = describeRegionLabel(regionID, rows);
      const workable = [];
      const npc = [];
      for (const row of rows) {
        const systemID = positiveInt(row && row.solarSystemID, 0);
        if (!systemID) continue;
        const claimable = isClaimableSystem(row);
        if (claimable === null) {
          return {
            ok: false,
            error: "the sovereignty system rules are unavailable; see the server log",
          };
        }
        (claimable ? workable : npc).push({ solarSystemID: systemID, row });
      }
      if (workable.length === 0) {
        return {
          ok: false,
          error: `${label} is NPC/faction space (none of its ${rows.length} systems is `
            + "sovereignty-claimable): nothing was touched",
        };
      }
      return { ok: true, kind, regionID, label, systems: rows.length, workable, npc };
    }

    const resolved = resolveSystemToken(scope && scope.token, identity);
    if (!resolved.ok) return resolved;
    const systemID = resolved.solarSystemID;
    const { available, row } = readSystemRow(systemID);
    if (available && !row) {
      return {
        ok: false,
        error: `solar system ${systemID} was not found in the system catalogue`,
      };
    }
    const claimable = isClaimableSystem(row || systemID);
    if (claimable === null) {
      return {
        ok: false,
        error: "the sovereignty system rules are unavailable; see the server log",
      };
    }
    const label = describeSystemLabel(systemID);
    if (!claimable) {
      return {
        ok: false,
        error: `${label} is NPC/faction space (not sovereignty-claimable)`
          + `${describeSystemDetail(row)}: nothing was touched`,
      };
    }
    return {
      ok: true,
      kind,
      label,
      systems: 1,
      workable: [{ solarSystemID: systemID, row }],
      npc: [],
    };
  }

  // Deploy across a scope. Each system keeps its own plan, counts and refusals, and a
  // failure in one system never aborts the rest.
  function applyScope(scope, identity) {
    const systems = [];
    const totals = { deployed: 0, skippedPresent: 0, overDestroyed: 0, failures: 0 };
    const failures = [];
    for (const entry of scope.workable) {
      const systemID = entry.solarSystemID;
      const label = describeSystemLabel(systemID);
      let plan = null;
      let result = null;
      let error = null;
      try {
        plan = buildPlan(systemID, identity);
        if (!plan || plan.ok !== true) {
          error = (plan && plan.error) || "the system could not be read";
        } else if (plan.error) {
          error = plan.error;
        } else {
          result = applyPlan(plan, identity);
          if (!result || result.ok !== true) {
            error = (result && result.error) || "the deployment failed";
          }
        }
      } catch (thrown) {
        error = (thrown && thrown.message) || String(thrown);
        logError(`system ${systemID} failed: ${error}`);
      }
      if (error) {
        failures.push({ solarSystemID: systemID, label, errorMsg: error });
        systems.push({ solarSystemID: systemID, label, plan, result, error });
        continue;
      }
      totals.deployed += result.deployed.length;
      totals.skippedPresent += plan.skippedPresent.length;
      totals.overDestroyed += plan.overDestroyed.length;
      totals.failures += result.failures.length;
      systems.push({ solarSystemID: systemID, label, plan, result, error: null });
    }
    return { ok: true, scope, systems, totals, failures };
  }

  // The sweep across a scope, calibrating the item-id counter once for the command.
  function unanchorScope(scope, identity) {
    const systems = [];
    const totals = { destroyed: 0, alreadyDestroyed: 0, structures: 0, failures: 0 };
    const failures = [];
    for (const entry of scope.workable) {
      const systemID = entry.solarSystemID;
      const label = describeSystemLabel(systemID);
      let result = null;
      let error = null;
      try {
        result = unanchorSystem(systemID, identity, { calibrate: false });
        if (!result || result.ok !== true) {
          error = (result && result.error) || "the sweep failed";
        }
      } catch (thrown) {
        error = (thrown && thrown.message) || String(thrown);
        logError(`sweeping system ${systemID} failed: ${error}`);
      }
      if (error) {
        failures.push({ solarSystemID: systemID, label, errorMsg: error });
        systems.push({ solarSystemID: systemID, label, result, error });
        continue;
      }
      totals.destroyed += result.destroyed.length;
      totals.alreadyDestroyed += result.alreadyDestroyed.length;
      totals.structures += result.untouchedStructures.length;
      totals.failures += result.failures.length;
      systems.push({ solarSystemID: systemID, label, result, error: null });
    }
    return {
      ok: true,
      scope,
      systems,
      totals,
      failures,
      counter: calibrateItemIDCounter(),
    };
  }

  // ─── align: move already-deployed Skyhooks onto the configured offset ────────
  //
  // Changing `offsetMeters` only affects new deploys, so this command walks the
  // Skyhooks that already exist and moves each one onto the placement a fresh deploy
  // would produce. It reuses `buildOrbitalSlot` - the same function a deploy uses - so
  // the landing point and the offset are never computed twice in two places, and it
  // writes through the vendor's own `updateInventoryItem`, never a direct store write.
  //
  // Everything is discovered from the orbital records, so a Skyhook a player deployed
  // by hand is included: they are all orbital records of typeID 81080.

  function allSkyhookRecords() {
    const orbitalState = vendor("getPlanetOrbitalState");
    if (!orbitalState || typeof orbitalState.readState !== "function") {
      log("planetOrbitalState exposes no readState - every Skyhook could not be listed");
      return null;
    }
    const state = guard("readState", () => orbitalState.readState({ repair: true }), null);
    const byID = state && isPlainObject(state.orbitalsByID) ? state.orbitalsByID : null;
    if (!byID) return [];
    const normalize = orbitalState._testing && orbitalState._testing.normalizeOrbitalRecord;
    const records = [];
    for (const raw of Object.values(byID)) {
      const record = typeof normalize === "function"
        ? guard("normalizeOrbitalRecord", () => normalize(raw), null)
        : raw;
      if (!record || toInt(record.typeID, 0) !== SKYHOOK_TYPE_ID) continue;
      const itemID = positiveInt(record.itemID, 0);
      const systemID = positiveInt(record.solarSystemID, 0);
      const planetID = positiveInt(record.planetID, 0);
      if (!itemID || !systemID || !planetID) continue;
      records.push({
        itemID,
        systemID,
        planetID,
        destroyed: isDestroyedOrbital(orbitalState, record),
      });
    }
    return records;
  }

  // The scope of an align run: every system that holds a Skyhook by default, or the one
  // system / region the operator named. The NPC rule is deliberately not applied here:
  // it exists to stop this mod *creating* structures in space that is not ours, and
  // this command only moves what is already in the world.
  function resolveAlignScope(scope, identity) {
    const kind = scope && (scope.kind === "region" || scope.kind === "system") ? scope.kind : "all";
    const records = allSkyhookRecords();
    if (records === null) {
      return { ok: false, error: "the orbital catalogue is unavailable; see the server log" };
    }
    let wanted = null;
    let label = "all systems with a Skyhook";
    let systemCount = null;
    if (kind === "system") {
      const resolved = resolveSystemToken(scope.token, identity);
      if (!resolved.ok) return resolved;
      wanted = new Set([resolved.solarSystemID]);
      label = describeSystemLabel(resolved.solarSystemID);
      systemCount = 1;
    } else if (kind === "region") {
      const regionID = positiveInt(scope.regionID, 0);
      if (!regionID) return { ok: false, error: "a region id must be a positive number" };
      const rows = systemsInRegion(regionID);
      if (rows === null) {
        return { ok: false, error: "the system catalogue is unavailable; see the server log" };
      }
      if (rows.length === 0) {
        return {
          ok: false,
          error: `region ${regionID} holds no solar systems (is that a region id?)`,
        };
      }
      wanted = new Set(rows.map((row) => positiveInt(row && row.solarSystemID, 0)));
      label = describeRegionLabel(regionID, rows);
      systemCount = rows.length;
    }
    const bySystem = new Map();
    for (const record of records) {
      if (wanted && !wanted.has(record.systemID)) continue;
      if (!bySystem.has(record.systemID)) bySystem.set(record.systemID, []);
      bySystem.get(record.systemID).push(record);
    }
    const workable = [...bySystem.entries()]
      .map(([solarSystemID, skyhooks]) => ({ solarSystemID, skyhooks }))
      .sort((left, right) => left.solarSystemID - right.solarSystemID);
    const total = workable.reduce((sum, entry) => sum + entry.skyhooks.length, 0);
    if (total === 0) {
      return {
        ok: false,
        error: `${label}: no Skyhook is deployed there, so there is nothing to move`,
      };
    }
    return {
      ok: true,
      kind: "align",
      label,
      systems: systemCount == null ? workable.length : systemCount,
      workable,
      npc: [],
      skyhooks: total,
    };
  }

  // The scene of a solar system, but only when that scene is **already loaded**, and
  // never by creating one. The vendor's `ensureScene` bootstraps a scene - it constructs
  // the `SolarSystemScene`, realises its inventory-backed entities and runs the whole
  // startup materialisation - so a read that called it loaded every system it asked
  // about. That is the live failure: a `/ash align region` over 40 systems reported
  // all 40 as "in use" and moved nothing, because the mod had just loaded every one of
  // them itself.
  //
  // `isSolarSystemSceneLoaded` only reads the vendor's scene registry
  // (`space/runtime/spaceRuntime/sceneRegistry.js`), so the check cannot change the world.
  // The scene is then fetched with the non-creating `getSceneByDescriptor`
  // (`space/runtime/spaceRuntime/sceneDisposal.js`), whose registry lookup carries the
  // same no-create guarantee. A vendor missing either accessor falls through to the
  // store-only path rather than being asked to load anything.
  function loadedScene(systemID) {
    const spaceRuntime = vendor("getSpaceRuntime");
    if (!spaceRuntime || typeof spaceRuntime.isSolarSystemSceneLoaded !== "function") {
      return null;
    }
    const loaded = guard(
      `isSolarSystemSceneLoaded(${systemID})`,
      () => spaceRuntime.isSolarSystemSceneLoaded(systemID),
      false,
    );
    if (loaded !== true) return null;
    if (typeof spaceRuntime.getSceneByDescriptor === "function") {
      const scene = guard(
        `getSceneByDescriptor(${systemID})`,
        () => spaceRuntime.getSceneByDescriptor(systemID),
        null,
      );
      if (scene) return scene;
    }
    // A vendor without that accessor still exposes the scene registry itself; reading
    // it creates nothing either.
    const registry = spaceRuntime.scenes;
    if (registry && typeof registry.get === "function") {
      return guard(`scenes.get(${systemID})`, () => registry.get(systemID), null) || null;
    }
    return null;
  }

  // The scene an entity would live in - only when that scene was already loaded - and the
  // entity itself if it is realised there. A loaded scene is authoritative: a store write
  // alone is lost for an item that is realised in it, which is exactly what the live test
  // showed (twelve systems with no scene moved perfectly, the one the operator was
  // standing in moved not at all). When no scene is loaded the store row is the only
  // authority, and that path needs no scene at all.
  function readRealisedEntity(systemID, itemID) {
    const scene = loadedScene(systemID);
    if (!scene || typeof scene.getEntityByID !== "function") {
      return { scene, entity: null, available: false };
    }
    const entity = guard(
      `getEntityByID(${itemID})`,
      () => scene.getEntityByID(itemID),
      null,
    );
    return { scene, entity: entity || null, available: true };
  }

  // The position writer a loaded scene owns. In this vendor the scene **is** the clock:
  // `space/runtime/solarSystemScene.js:140` installs `this.positionAuthority` on it, and
  // the methods of `space/runtime/scene/clock.js` - `setEntityPosition` among them - are
  // mixed into `SolarSystemScene.prototype`. There is no `scene.clock`, which is why the
  // first version of this path said "exposes no position authority" for every system in
  // the live log: it read a property that does not exist. The scene's own method is
  // preferred; the raw authority is the documented fallback for a vendor that only
  // exposes that. The writer is returned as a closure so the receiver is always the
  // scene (or the authority) itself.
  function scenePositionWriter(scene) {
    if (!scene) return null;
    if (typeof scene.setEntityPosition === "function") {
      return (itemID, position, options) => scene.setEntityPosition(itemID, position, options);
    }
    const authority = scene.positionAuthority;
    if (authority && typeof authority.setEntityPosition === "function") {
      return (itemID, position, options) => authority.setEntityPosition(itemID, position, options);
    }
    return null;
  }

  function readEntityPosition(entity) {
    if (!entity) return null;
    const raw = entity.position || (entity.spaceState && entity.spaceState.position) || null;
    const vector = normalizeVector(raw);
    return Number.isFinite(vector.x) || Number.isFinite(vector.y) || Number.isFinite(vector.z)
      ? vector
      : null;
  }

  function driftFrom(position, target) {
    if (!position || !target) return null;
    return Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
  }

  // One Skyhook onto its landing point plus the configured offset. Returns a move (with
  // the position written, and whether the item was realised in a loaded scene) or a skip
  // with the reason - never an error.
  function moveSkyhookToOffset(entry, planetRow) {
    const skyhook = skyhookLabel(planetNameFor(entry.planetID, planetRow));
    const itemStore = vendor("getItemStore");
    if (!itemStore || typeof itemStore.updateInventoryItem !== "function") {
      return { skipped: "the item store cannot update items" };
    }
    if (typeof itemStore.findItemById !== "function") {
      return { skipped: "the item store cannot read items" };
    }
    const item = guard(
      `findItemById(${entry.itemID})`,
      () => itemStore.findItemById(entry.itemID),
      null,
    );
    if (!item) {
      return { skipped: `${skyhook} has no item row` };
    }
    const slot = buildOrbitalSlot(planetRow, {
      standoffMeters: config.standoffMeters,
      orbitMargin: config.orbitMargin,
      systemID: entry.systemID,
    });
    // A planet with no usable warp-in point is skipped, not moved onto the heuristic
    // fallback: this command exists to reproduce a fresh deploy's placement, and a
    // fresh deploy would have used the fallback only because it had to.
    if (!slot || slot.source !== "warp-in" || !slot.position) {
      return {
        skipped: `${skyhook} has no usable landing point`,
      };
    }
    const position = slot.position;
    const direction = slot.direction;
    const { scene, entity, available } = readRealisedEntity(entry.systemID, entry.itemID);
    const realised = Boolean(entity);

    // 1. A realised item is moved on the authority the scene owns, or the move would be
    //    overwritten by the entity that is already there. In this vendor that authority
    //    lives on the scene itself (`scene.setEntityPosition`); `scene.clock` does not
    //    exist.
    if (realised) {
      const writePosition = scenePositionWriter(scene);
      if (!writePosition) {
        return {
          skipped: `${skyhook} is realised in the loaded scene of its solar system, `
            + "which exposes no position authority - its move would be lost",
          blockedByScene: true,
        };
      }
      const applied = guard(
        `setEntityPosition(${entry.itemID})`,
        () => writePosition(entry.itemID, { ...position }, {
          reason: "autoSkyHookDeploy:align",
          velocity: { x: 0, y: 0, z: 0 },
        }),
        null,
      );
      // Two honest refusals from the vendor's own authority: the `{ success: false }`
      // result some callers return, and the `{ available: false, reason }` result the
      // scene position authority returns when it cannot resolve the entity.
      if (applied && (applied.success === false || applied.available === false)) {
        return {
          skipped: `${skyhook} could not be moved in its loaded scene `
            + `(${applied.errorMsg || applied.reason || "POSITION_WRITE_FAILED"})`,
          blockedByScene: true,
        };
      }
      const after = readRealisedEntity(entry.systemID, entry.itemID).entity;
      const drift = driftFrom(readEntityPosition(after), position);
      if (drift === null || !(drift <= 1)) {
        return {
          skipped: `${skyhook}: the loaded scene of its solar system kept its own position`,
          blockedByScene: true,
        };
      }
    }

    // 2. The store row: the authority for an unloaded scene, and the persisted record of
    //    the move either way.
    const updated = guard(
      `updateInventoryItem(${entry.itemID})`,
      () => itemStore.updateInventoryItem(entry.itemID, (current) => ({
        ...current,
        spaceState: {
          ...(isPlainObject(current && current.spaceState) ? current.spaceState : {}),
          position: { ...position },
          direction: { ...direction },
          targetPoint: { ...position },
        },
      })),
      null,
    );
    if (!updated || updated.success === false) {
      return {
        skipped: `${skyhook} could not be updated `
          + `(${(updated && updated.errorMsg) || "WRITE_FAILED"})`,
      };
    }

    // 3. A connected client only sees the new position if the presentation is refreshed;
    //    a server without that hook simply logs it and carries on.
    const spaceRuntime = vendor("getSpaceRuntime");
    if (spaceRuntime && typeof spaceRuntime.refreshInventoryBackedEntityPresentation === "function") {
      guard(
        `refreshInventoryBackedEntityPresentation(${entry.itemID})`,
        () => spaceRuntime.refreshInventoryBackedEntityPresentation(entry.systemID, entry.itemID),
        null,
      );
    } else if (available) {
      log("spaceRuntime exposes no refreshInventoryBackedEntityPresentation - clients will "
        + "see the move on their next refresh");
    }
    return {
      moved: true,
      itemID: entry.itemID,
      planetID: entry.planetID,
      position,
      direction,
      realised,
    };
  }

  // Verify a move by re-reading what now holds the position: the realised entity when the
  // item is in a loaded scene (that is what the client sees), the store row otherwise.
  function verifyMovedSkyhook(move, planetRow, systemID) {
    const skyhook = skyhookLabel(planetNameFor(move.planetID, planetRow));
    const expected = buildOrbitalSlot(planetRow, {
      standoffMeters: config.standoffMeters,
      orbitMargin: config.orbitMargin,
      systemID,
    });
    const target = expected && expected.position ? expected.position : null;
    if (!target) {
      return [`${skyhook}: the expected landing point could not be recomputed`];
    }
    const { entity } = readRealisedEntity(systemID, move.itemID);
    let written = null;
    let source = "the item row";
    if (entity) {
      written = readEntityPosition(entity);
      source = "the loaded scene entity";
    } else {
      const itemStore = vendor("getItemStore");
      if (!itemStore || typeof itemStore.findItemById !== "function") {
        return [`${skyhook}: the written position could not be verified`];
      }
      const item = guard(
        `findItemById(${move.itemID})`,
        () => itemStore.findItemById(move.itemID),
        null,
      );
      if (!item) return [`${skyhook} has no item row after the move`];
      written = normalizeVector(
        item.spaceState && item.spaceState.position ? item.spaceState.position : item.position,
      );
    }
    const drift = driftFrom(written, target);
    if (drift === null) {
      return [`${skyhook}: ${source} reported no position after the move`];
    }
    if (!(drift <= 1)) {
      return [
        `${skyhook} sits ${formatMeters(drift)} from the landing point `
        + `+ ${describeOffsetForRun()} (read back from ${source})`,
      ];
    }
    return [];
  }


  //
  // Mass-creating structures can stall the game, so a `/ash anchor region` (or
  // `unanchor region`) never runs in one burst. The run announces a countdown, then
  // works **one system per timer tick** using the same single-system path a targeted
  // command uses, verifies what that system wrote, reports it, and waits before the
  // next one. Nothing here blocks the event loop: every step is a `setTimeout`
  // callback, and each system is committed as a whole, so a stop, a crash or a
  // restart can never leave a system half-done.
  //
  // `/ash stop` cancels during the countdown (nothing has been touched) and stops
  // cleanly after the system currently being worked (that one is completed and
  // verified first). The job lives in this closure, i.e. one run per process, and
  // only in memory: a server restart simply ends a run.
  const timers = options.timers || {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
  const sendTo = typeof options.sendTo === "function" ? options.sendTo : null;
  let activeRun = null;

  // ─── timing: what a run costs, measured rather than guessed ─────────────────
  //
  // A process-level exponentially weighted average of the real cost of the work: the
  // per-planet stretch of a deploy, a whole system's step, and how many planets a
  // system holds. It starts from the operator's observed order of magnitude (a
  // 9-planet system completes in well under a second), so the *first* estimate is
  // approximate and every run after it is closer.
  const DEFAULT_PLANET_MS = 48;
  const DEFAULT_SYSTEM_MS = 200;
  const DEFAULT_PLANETS_PER_SYSTEM = 7;
  const TIMING_WEIGHT = 0.3;
  // Process-level: the averages live outside the runtime instance, so every run this
  // server does improves the next estimate.
  const timing = processTiming;

  function blend(current, sample) {
    return (current * (1 - TIMING_WEIGHT)) + (sample * TIMING_WEIGHT);
  }

  function noteTiming(sample = {}) {
    if (Number.isFinite(sample.planetMs) && sample.planetMs >= 0) {
      timing.planetMs = blend(timing.planetMs, sample.planetMs);
      timing.planetSamples += 1;
    }
    if (Number.isFinite(sample.systemMs) && sample.systemMs >= 0) {
      timing.systemMs = blend(timing.systemMs, sample.systemMs);
      timing.systemSamples += 1;
    }
    if (Number.isFinite(sample.planets) && sample.planets > 0) {
      timing.planetsPerSystem = blend(timing.planetsPerSystem, sample.planets);
    }
  }

  function resetTiming() {
    timing.planetMs = DEFAULT_PLANET_MS;
    timing.systemMs = DEFAULT_SYSTEM_MS;
    timing.planetsPerSystem = DEFAULT_PLANETS_PER_SYSTEM;
    timing.planetSamples = 0;
    timing.systemSamples = 0;
  }

  function describeTiming() {
    return {
      planetMs: Math.round(timing.planetMs),
      systemMs: Math.round(timing.systemMs),
      planetsPerSystem: timing.planetsPerSystem,
      planetSamples: timing.planetSamples,
      systemSamples: timing.systemSamples,
      measured: timing.planetSamples > 0,
    };
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
    if (totalSeconds < 60) return `${totalSeconds} s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes} m ${String(seconds).padStart(2, "0")} s`;
  }

  // Metres read as metres, with the thousands separated: "10,506 m" is a distance an
  // operator can take in at a glance, "10506 m" is not.
  function formatMeters(meters) {
    const value = Number(meters);
    const rounded = Number.isFinite(value) ? Math.round(value) : 0;
    const sign = rounded < 0 ? "-" : "";
    return `${sign}${String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",")} m`;
  }

  // The estimate is the countdown, every system's own step, every planet inside those
  // steps, and the gaps between systems - the gaps dominate a big run, so they are
  // never left out. `plan.gaps` overrides the derived gap count, and `plan.countdownMs`
  // overrides the countdown: the progress suffix estimates only what is still ahead,
  // where the countdown is long past and the gaps are the ones not yet waited out.
  function estimateRunMs(plan) {
    const systems = Math.max(0, toInt(plan && plan.systems, 0));
    const planets = Math.max(0, toInt(plan && plan.planets, 0));
    const gaps = plan && Number.isFinite(Number(plan.gaps))
      ? Math.max(0, toInt(plan.gaps, 0))
      : Math.max(0, systems - 1);
    const countdownMs = plan && Number.isFinite(Number(plan.countdownMs))
      ? Math.max(0, toInt(plan.countdownMs, 0))
      : countdownSeconds() * 1000;
    return countdownMs
      + (systems * timing.systemMs)
      + (planets * timing.planetMs)
      + (gaps * stepDelayMs());
  }

  function describeEstimate(plan) {
    const systems = Math.max(0, toInt(plan && plan.systems, 0));
    const planets = Math.max(0, toInt(plan && plan.planets, 0));
    const measured = timing.planetSamples > 0
      ? `measured ${Math.round(timing.planetMs)} ms per planet so far`
      : `first run, so this uses the default ${DEFAULT_PLANET_MS} ms per planet`;
    return `estimated ${formatDuration(estimateRunMs(plan))}: ${systems} `
      + `${systems === 1 ? "system" : "systems"}, ${planets} `
      + `${planets === 1 ? "planet" : "planets"}, ${Math.max(0, systems - 1)} x `
      + `${stepDelayMs()} ms step delay, ${countdownSeconds()} s countdown (${measured})`;
  }

  // What is still ahead of a run: the systems not started, the planets (or Skyhooks, for
  // an align run) they hold, the step delays between them, and the countdown while it is
  // still running. One shape feeds both `estimateRunMs` and the progress suffix, so the
  // number in "about X remaining" is the same number the estimate machinery uses.
  function remainingPlanFor(run) {
    const systems = Math.max(0, run.scope.workable.length - run.index);
    // An align run counts the Skyhooks it has not reached (`skyhooksDone` is advanced by
    // each system as it finishes); every other run counts the planets a remaining system
    // is expected to hold, from the measured average.
    const planets = run.kind === "align"
      ? Math.max(0, positiveInt(run.scope.skyhooks, 0) - positiveInt(run.skyhooksDone, 0))
      : Math.max(0, Math.round(systems * timing.planetsPerSystem));
    return {
      systems,
      planets,
      gaps: Math.max(0, systems - 1),
      countdownMs: run.phase === "countdown" ? countdownSeconds() * 1000 : 0,
    };
  }

  // How far a run is and what it has left, in the units the run itself moves: systems
  // for a deploy or a sweep, Skyhooks for an align run. `left` for an align run is passed in
  // because the system that just reported has already advanced `skyhooksDone`.
  function outstandingFor(run, skyhooksLeft = 0) {
    const total = run.scope.workable.length;
    return {
      done: run.index,
      total,
      left: run.kind === "align"
        ? positiveInt(skyhooksLeft, 0)
        : Math.max(0, total - run.index),
      noun: run.kind === "align" ? "skyhooks" : "systems",
    };
  }

  // The progress every report carries: how far the run is, what is still to come, and
  // how long that is expected to take.
  function progressSuffix(run, outstanding) {
    const counts = outstanding || outstandingFor(run);
    const noun = counts.left === 1 ? counts.noun.replace(/s$/u, "") : counts.noun;
    return `[${counts.done}/${counts.total} systems done, `
      + `${counts.left} ${noun} left, `
      + `about ${formatDuration(estimateRunMs(remainingPlanFor(run)))} remaining]`;
  }

  function countdownSeconds() {
    const value = toInt(config.regionCountdownSeconds, 15);
    return value >= 0 ? value : 15;
  }

  function stepDelayMs() {
    const value = toInt(config.regionStepDelayMs, 2000);
    return value >= 0 ? value : 2000;
  }

  // Follow-up messages (countdown ticks, per-system results, the summary) go back
  // through the same chat hub the command arrived on.
  function sendFollowUp(session, message) {
    if (!sendTo) {
      logError("no chat delivery path is available for a follow-up message");
      return false;
    }
    try {
      // The delivery path answers false when it could not hand the message over: a run
      // must never continue with no way to report what it is doing.
      return sendTo(session, message) !== false;
    } catch (error) {
      logError(`could not deliver a follow-up message: ${error && error.message}`);
      return false;
    }
  }

  // The first follow-up that cannot be delivered ends the run: working systems for
  // minutes while the operator sees nothing is worse than stopping and saying so. The
  // system already finished stays committed and verified (each system is a whole), so
  // nothing is left half-done.
  function abortRunForDelivery(run, what) {
    if (activeRun === run) activeRun = null;
    if (run.timer) timers.clearTimeout(run.timer);
    run.timer = null;
    run.phase = "done";
    run.aborted = "delivery";
    logError(
      `region run on ${run.scope.label} aborted: ${what} could not be delivered, so the run `
      + `was stopped after ${run.index} of ${run.scope.workable.length} systems rather than `
      + "continuing with no way to report progress",
    );
    return { ok: false, error: "delivery", run: regionRunStatus() };
  }

  // ─── the anchor safety gate ─────────────────────────────────────────────────
  //
  // Two facts drive this. First, a Skyhook created by this mod has no raid/silo
  // record, and the vendor initialises one for every such Skyhook the first time it
  // boots afterwards - one at a time, with a full table scan and a synchronous
  // flush each - so the first restart after anchoring can take a very long time.
  // Second, that restart is the operator's own decision; it must not happen while
  // they are in space, and a run must not be abandoned half-way because they
  // undocked or disconnected.
  //
  // So an anchor refuses to start unless the caller is docked and online, a running
  // anchor polls both and stops on the first violation, and every anchor reply says
  // the restart is coming and should be done on purpose.
  const ANCHOR_WARNING_TITLE = "###WARNING### ###WARNING### ###WARNING###";
  const ANCHOR_WARNING_LINES = Object.freeze([
    "Every Skyhook created here has to be initialised by the server on the next",
    "restart, one at a time, and each one costs seconds. A whole region can turn",
    "the next boot into a very long one. That is expected, not a hang, and later",
    "restarts are fast again.",
  ]);
  const ANCHOR_DOCK_LINES = Object.freeze([
    "STAY DOCKED while this runs, and do not log off.",
    "If you undock or drop, the run stops immediately.",
    "Afterwards, restart the game server once yourself, at a time you choose.",
  ]);

  function anchorWarningText() {
    return [
      ANCHOR_WARNING_TITLE,
      ...ANCHOR_WARNING_LINES,
      "###WARNING### enter a station or structure, and stay docked. ###WARNING###",
      ...ANCHOR_DOCK_LINES,
      ANCHOR_WARNING_TITLE,
    ].join("\n");
  }

  function anchorRestartAdvice() {
    return [
      ANCHOR_WARNING_TITLE,
      "Restart the game server once now, while you are docked.",
      "The first restart after creating Skyhooks is the slow one: the server",
      "initialises each new Skyhook's silo on that boot (seconds per Skyhook), so it",
      "can take a very long time. Later restarts are fast again. Doing it now, at a",
      "time you choose, is better than being surprised by it later.",
      ANCHOR_WARNING_TITLE,
    ].join("\n");
  }

  function anchorPresenceRefusal(presence) {
    const why = presence.online === false
      ? "your client is not online"
      : "your ship is not docked";
    return [
      ANCHOR_WARNING_TITLE,
      `anchor refused: ${why}.`,
      ...ANCHOR_WARNING_LINES,
      "Dock at a station or structure first, then run it again. Keep the client",
      "online and stay docked for the whole run.",
      ANCHOR_WARNING_TITLE,
    ].join("\n");
  }

  // Whether the caller is still the same, still registered session and still docked.
  // Any answer other than a positive "docked" is a refusal: this gate exists so the
  // operator is never in space when the slow restart happens.
  //
  // `strict` is for a run already in flight: it demands the very session object the run
  // started with, so a disconnect - or a relog, which mints a new session - ends the
  // run at its next step. The chat entry point is not strict: a vendor call path may
  // hand it an equivalent session object, so it also accepts a live lookup by
  // character id before refusing.
  function callerPresence(session, options = {}) {
    const registry = vendor("getSessionRegistry");
    const location = vendor("getStructureLocation");
    const strict = options.strict === true;
    let liveSession = null;
    if (registry && typeof registry.isRegisteredSession === "function") {
      if (registry.isRegisteredSession(session) === true) {
        liveSession = session;
      } else if (!strict && typeof registry.findSessionByCharacterID === "function") {
        const characterID = positiveInt(
          session && (session.characterID ?? session.charid ?? session.charID),
          0,
        );
        const found = characterID > 0
          ? guard("findSessionByCharacterID", () => registry.findSessionByCharacterID(characterID), null)
          : null;
        if (found) liveSession = found;
      }
    } else {
      // No registry to ask: the command could only arrive through a live session, so
      // treat it as online and still enforce the dock half of the gate.
      liveSession = session || null;
    }
    let docked = false;
    if (liveSession) {
      if (location && typeof location.isDockedSession === "function") {
        docked = location.isDockedSession(liveSession) === true;
      } else {
        docked = positiveInt(
          liveSession.stationid ?? liveSession.stationID ?? liveSession.stationId, 0,
        ) > 0 || positiveInt(
          liveSession.structureid ?? liveSession.structureID ?? liveSession.structureId, 0,
        ) > 0;
      }
    }
    return {
      ok: Boolean(liveSession) && docked,
      online: Boolean(liveSession),
      docked,
    };
  }

  function abortRunForPresence(run, presence) {
    if (activeRun === run) activeRun = null;
    if (run.timer) timers.clearTimeout(run.timer);
    run.timer = null;
    run.phase = "done";
    run.aborted = "presence";
    const why = presence.online === false ? "your client went offline" : "you left the station";
    const message = [
      ANCHOR_WARNING_TITLE,
      `anchor run stopped immediately: ${why}.`,
      `${run.index} of ${run.scope.workable.length} systems were completed and verified; `
        + "nothing was left half-done, and nothing further will be built.",
      "Dock and run it again if you want the rest.",
      ANCHOR_WARNING_TITLE,
    ].join("\n");
    if (!sendFollowUp(run.session, message)) {
      logError(
        `anchor run stopped (${why}) after ${run.index} of `
        + `${run.scope.workable.length} systems; the stop message could not be delivered`,
      );
    }
    return { ok: false, error: "presence", run: regionRunStatus() };
  }

  function regionRunStatus() {
    if (!activeRun) return null;
    return {
      kind: activeRun.kind,
      label: activeRun.scope.label,
      phase: activeRun.phase,
      worked: activeRun.index,
      toWork: activeRun.scope.workable.length,
      remainingSeconds: activeRun.remainingSeconds,
      stopping: activeRun.stopping,
      estimateMs: activeRun.estimatedMs,
      estimate: describeEstimate(activeRun.estimatePlan),
      // The same bracket every progress line carries, so /ash status and the run's own
      // reports say the same thing in the same words.
      progress: progressSuffix(activeRun, outstandingFor(activeRun)),
    };
  }

  function describeOffsetForRun() {
    const meters = resolveOffsetMeters();
    return `${Math.round(meters)} m`;
  }

  // Re-read one deployed Skyhook: the item row still exists, the orbital record is
  // live, and the position written is the landing point plus the configured offset.
  // Every line names the Skyhook by the planet it orbits and never by its item id.
  function verifyDeployedSkyhook(entry, planetEntry) {
    const anomalies = [];
    const label = skyhookLabel(planetNameFor(entry.planetID, planetEntry));
    const itemStore = vendor("getItemStore");
    const orbitalState = vendor("getPlanetOrbitalState");
    const canReadItems = Boolean(itemStore && typeof itemStore.findItemById === "function");
    if (!canReadItems) {
      log("the item store has no findItemById - the written position could not be verified");
    }
    const item = canReadItems
      ? guard(`findItemById(${entry.itemID})`, () => itemStore.findItemById(entry.itemID), null)
      : null;
    if (canReadItems && !item) {
      anomalies.push(`${label} has no item row`);
    } else if (item) {
      const written = normalizeVector(
        item.spaceState && item.spaceState.position
          ? item.spaceState.position
          : item.position,
      );
      const slot = buildOrbitalSlot(planetEntry, {
        standoffMeters: config.standoffMeters,
        orbitMargin: config.orbitMargin,
        systemID: entry.solarSystemID,
      });
      const expected = slot && slot.position ? slot.position : null;
      if (!expected) {
        anomalies.push(`${label}: the expected landing point could not be computed`);
      } else {
        const drift = Math.hypot(
          written.x - expected.x,
          written.y - expected.y,
          written.z - expected.z,
        );
        // 1 m of tolerance: everything here is a straight vector addition, so any
        // real difference is a difference in what was written.
        if (!(drift <= 1)) {
          anomalies.push(
            `${label} sits ${formatMeters(drift)} from the landing point `
            + `+ ${describeOffsetForRun()}`,
          );
        }
      }
    }
    const record = orbitalState && typeof orbitalState.getOrbitalByID === "function"
      ? guard(`getOrbitalByID(${entry.itemID})`, () => orbitalState.getOrbitalByID(entry.itemID), null)
      : null;
    if (!record) {
      anomalies.push(`${label} has no orbital record`);
    } else {
      if (toInt(record.typeID, 0) !== SKYHOOK_TYPE_ID) {
        anomalies.push(`${label} is not a Skyhook (typeID ${toInt(record.typeID, 0)})`);
      }
      if (isDestroyedOrbital(orbitalState, record)) {
        anomalies.push(`${label} is a tombstone right after deployment`);
      }
      if (positiveInt(record.planetID, 0) !== entry.planetID) {
        anomalies.push(`${label} is attached to a different planet than the one it was deployed over`);
      }
    }
    return anomalies;
  }

  function verifySystemDeploy(systemID, deployed) {
    const anomalies = [];
    const planets = guard(
      `listPlanetsForSystem(${systemID})`,
      () => {
        const orbitalState = vendor("getPlanetOrbitalState");
        return orbitalState && orbitalState._testing
          ? orbitalState._testing.listPlanetsForSystem(systemID)
          : [];
      },
      [],
    );
    const byPlanet = new Map();
    for (const planet of (Array.isArray(planets) ? planets : [])) {
      byPlanet.set(positiveInt(planet && planet.planetID, 0), planet);
    }
    for (const entry of deployed) {
      const planetEntry = byPlanet.get(entry.planetID) || { planetID: entry.planetID };
      anomalies.push(...verifyDeployedSkyhook(entry, planetEntry));
    }
    return anomalies;
  }

  function verifySystemUnanchor(systemID, destroyed) {
    const anomalies = [];
    const orbitalState = vendor("getPlanetOrbitalState");
    const remaining = orbitalState && typeof orbitalState.listOrbitalsForSystem === "function"
      ? guard(
        `listOrbitalsForSystem(${systemID})`,
        () => orbitalState.listOrbitalsForSystem(systemID),
        [],
      )
      : [];
    const live = (Array.isArray(remaining) ? remaining : [])
      .filter((record) => toInt(record && record.typeID, 0) === SKYHOOK_TYPE_ID)
      .filter((record) => !isDestroyedOrbital(orbitalState, record));
    for (const record of live) {
      anomalies.push(
        `${skyhookLabel(planetNameFor(record.planetID))} is still a live orbital record`,
      );
    }
    const itemStore = vendor("getItemStore");
    if (itemStore && typeof itemStore.findItemById === "function") {
      for (const entry of destroyed) {
        const item = guard(
          `findItemById(${entry.itemID})`,
          () => itemStore.findItemById(entry.itemID),
          null,
        );
        if (item) {
          anomalies.push(
            `${skyhookLabel(planetNameFor(entry.planetID))} still has an item row after removal`,
          );
        }
      }
    }
    return anomalies;
  }

  // One system, end to end: the same plan/apply path a targeted command uses, then a
  // re-read of what it wrote. An anomaly or a failure is reported, never thrown, and
  // never aborts the rest of the run.
  function workOneSystem(run, systemID) {
    const label = describeSystemLabel(systemID);
    if (run.kind === "align") {
      return workOneAlignSystem(run, systemID);
    }
    if (run.kind === "unanchor") {
      const result = unanchorSystem(systemID, run.identity, { calibrate: false });
      if (!result || result.ok !== true) {
        return {
          message: `${label}: FAILED ${(result && result.error) || "the sweep failed"}`,
          totals: null,
          failure: true,
        };
      }
      const anomalies = verifySystemUnanchor(systemID, result.destroyed);
      const message = `${label}: destroyed ${result.destroyed.length}, `
        + `verified ${result.destroyed.length - anomalies.length} gone, `
        + `${anomalies.length} anomalies`;
      return {
        message,
        anomalyLines: anomalies.map((line) => `  ANOMALY ${line}`),
        totals: {
          destroyed: result.destroyed.length,
          alreadyDestroyed: result.alreadyDestroyed.length,
          structures: result.untouchedStructures.length,
          failures: result.failures.length,
        },
        anomalies: anomalies.length,
        failure: false,
      };
    }
    const plan = buildPlan(systemID, run.identity);
    if (!plan || plan.ok !== true) {
      return {
        message: `${label}: FAILED ${(plan && plan.error) || "the system could not be read"}`,
        totals: null,
        failure: true,
      };
    }
    if (plan.error) {
      return { message: `${label}: nothing to deploy: ${plan.error}`, totals: null, failure: false };
    }
    const result = applyPlan(plan, run.identity);
    if (!result || result.ok !== true) {
      return {
        message: `${label}: FAILED ${(result && result.error) || "the deployment failed"}`,
        totals: null,
        failure: true,
      };
    }
    const anomalies = verifySystemDeploy(systemID, result.deployed);
    const verified = result.deployed.length - anomalies.length;
    const message = `${label}: deployed ${result.deployed.length}, `
      + `verified ${verified} at the landing point + ${describeOffsetForRun()}, `
      + `${anomalies.length} anomalies`;
    return {
      message,
      anomalyLines: anomalies.map((line) => `  ANOMALY ${line}`),
      totals: {
        deployed: result.deployed.length,
        skippedPresent: plan.skippedPresent.length,
        overDestroyed: plan.overDestroyed.length,
        failures: result.failures.length,
      },
      anomalies: anomalies.length,
      failure: false,
    };
  }

  function finishRegionRun(run) {
    if (activeRun === run) activeRun = null;
    run.phase = "done";
    const remaining = run.scope.workable.length - run.index;
    // The closing line speaks the same language as the progress lines: systems done,
    // systems left, and what it really cost against what the countdown promised.
    const lines = [
      `${prefix()} ${run.scope.label}: ${run.stopping ? "stopped" : "finished"} - `
      + `${run.index} of ${run.scope.workable.length} systems done, ${remaining} left, `
      + `in ${formatDuration(now() - run.startedAtMs)} (including the countdown; `
      + `estimated ${formatDuration(run.estimatedMs)}; `
      + `${Math.round(timing.planetMs)} ms per planet measured)`,
    ];
    const totals = run.totals;
    if (run.kind === "align") {
      // Markers and skips are separate columns here too: a destroyed tombstone the
      // run walked past is not a Skyhook that could not be moved.
      lines.push(
        `  moved ${totals.moved} Skyhook(s) onto the landing point + ${describeOffsetForRun()}, `
        + `${totals.destroyedMarkers} destroyed markers left alone, skipped ${totals.skipped}`,
      );
    } else if (run.kind === "deploy") {
      lines.push(
        `  deployed ${totals.deployed}, skipped ${totals.skippedPresent} already present, `
        + `${totals.overDestroyed} over a destroyed skyhook`,
      );
    } else {
      lines.push(
        `  destroyed ${totals.destroyed}, already destroyed ${totals.alreadyDestroyed}, `
        + `left alone ${totals.structures} structure-shaped`,
      );
    }
    lines.push(`  ${totals.anomalies} anomalies, ${totals.failures} failed system(s)`);
    if (run.kind === "unanchor") {
      // Once for the whole run, not once per system.
      const counter = describeCounter(calibrateItemIDCounter());
      if (counter) lines.push(`  ${counter}`);
    }
    lines.push(run.stopping
      ? "  the system being worked was finished and verified before stopping; nothing is "
        + "half-done and no state is inconsistent"
      : "  every system was verified as it finished; the run is over, and a restart would "
        + "simply end it - nothing resumes by itself");
    if (run.kind === "deploy" && positiveInt(totals.deployed, 0) > 0) {
      lines.push("", anchorRestartAdvice());
    }
    sendFollowUp(run.session, lines.join("\n"));
    return lines.join("\n");
  }

  // One system of an align run: move every Skyhook it holds, verify each move, and
  // report in the same shape the other runs use. A Skyhook that cannot be moved (no
  // item row, no usable landing point, a scene that keeps its own position) is a skip
  // with a reason. A destroyed tombstone is not a skip: it is a marker the mod leaves
  // alone on purpose, counted in its own column and never listed one by one.
  function workOneAlignSystem(run, systemID) {
    const label = describeSystemLabel(systemID);
    const entry = run.scope.workable.find((candidate) => candidate.solarSystemID === systemID);
    const skyhooks = entry && Array.isArray(entry.skyhooks) ? entry.skyhooks : [];
    const planets = guard(
      `listPlanetsForSystem(${systemID})`,
      () => {
        const orbitalState = vendor("getPlanetOrbitalState");
        return orbitalState && orbitalState._testing
          ? orbitalState._testing.listPlanetsForSystem(systemID)
          : [];
      },
      [],
    );
    const planetByID = new Map();
    for (const planet of (Array.isArray(planets) ? planets : [])) {
      planetByID.set(positiveInt(planet && planet.planetID, 0), planet);
    }
    const moved = [];
    const skips = [];
    const anomalies = [];
    let destroyedMarkers = 0;
    let blockedByScene = false;
    for (const record of skyhooks) {
      const skyhook = skyhookLabel(planetNameFor(record.planetID, planetByID.get(record.planetID)));
      if (record.destroyed) {
        // Not a skip, and never named one by one in a reply: the marker is left
        // exactly where it is, the system report carries one line with the count,
        // and the per-marker id stays in the verbose log where a developer reads it.
        log(`align: leaving destroyed marker ${record.itemID} on planet `
          + `${record.planetID} alone`);
        destroyedMarkers += 1;
        continue;
      }
      const planetRow = planetByID.get(record.planetID);
      if (!planetRow) {
        skips.push(`${skyhook} has no planet row in this system`);
        continue;
      }
      let outcome = null;
      try {
        outcome = moveSkyhookToOffset(record, planetRow);
      } catch (error) {
        logError(`moving skyhook ${record.itemID} failed: ${error && error.message}`);
        outcome = {
          skipped: `${skyhook}: ${(error && error.message) || "unknown failure"}`,
        };
      }
      if (!outcome || outcome.skipped) {
        if (outcome && outcome.blockedByScene) blockedByScene = true;
        skips.push((outcome && outcome.skipped) || `${skyhook} could not be moved`);
        continue;
      }
      moved.push(outcome);
      for (const anomaly of verifyMovedSkyhook(outcome, planetRow, systemID)) {
        anomalies.push(anomaly);
      }
    }
    // The counts are what the verification confirms, never what was attempted: a run must
    // not be able to say "moved 10, verified 0". `attempted` is kept in the report so a
    // skip is never mistaken for work that was never there.
    const attempted = skyhooks.filter((record) => !record.destroyed).length;
    const verified = moved.length - anomalies.length;
    const message = `${label}: ${moved.length} orbital skyhooks moved (of ${attempted} attempted), `
      + `${verified} verified at the landing point + ${describeOffsetForRun()}, `
      + `${skips.length} skipped, ${destroyedMarkers} destroyed markers, `
      + `${anomalies.length} anomalies`;
    const extraLines = [];
    // The marker line sits above the skips: it explains a deliberate no-op, while a
    // skip is work that was asked for and could not be done.
    if (destroyedMarkers > 0) {
      extraLines.push(`    destroyed markers left alone: ${describeDestroyedMarkers(destroyedMarkers)}`);
    }
    // A genuine loaded-scene refusal is a diagnostic, not a routine outcome: the scene
    // was already loaded when the run reached this system (a deploy or a removal in the
    // same session legitimately left it loaded, or somebody is in the system) and it
    // would not accept the write. The note never claims the system is "in use" - the
    // live log said exactly that for 40 systems the align run itself had just loaded - and
    // an anomaly in the store-only path is a different failure that must not be dressed
    // up as a scene refusal either.
    if (blockedByScene) {
      extraLines.push(
        `    solar system ${label}: its scene is loaded and would not accept the move; `
        + "the vendor unloads an empty scene on its own, so try again later",
      );
    }
    for (const skip of skips) {
      extraLines.push(`    skipped: ${skip}`);
    }
    for (const anomaly of anomalies) {
      extraLines.push(`    ANOMALY ${anomaly}`);
    }
    // The batch is finished: every Skyhook of this system is behind the run now, so
    // the progress suffix of the following systems counts the rest of the region.
    if (run.kind === "align") run.skyhooksDone += skyhooks.length;
    return {
      message,
      extraLines,
      anomalyLines: extraLines.filter((line) => line.includes("ANOMALY")),
      totals: {
        moved: moved.length,
        skipped: skips.length,
        destroyedMarkers,
        attempted,
      },
      anomalies: anomalies.length,
      failure: false,
    };
  }

  function workNextSystem(run) {
    if (activeRun !== run) return;
    if (run.checksPresence) {
      const presence = callerPresence(run.session, { strict: true });
      if (!presence.ok) {
        abortRunForPresence(run, presence);
        return;
      }
    }
    if (run.stopping || run.index >= run.scope.workable.length) {
      finishRegionRun(run);
      return;
    }
    const systemID = run.scope.workable[run.index].solarSystemID;
    const systemStartedAtMs = now();
    let outcome = null;
    try {
      outcome = workOneSystem(run, systemID);
    } catch (error) {
      logError(`system ${systemID} failed: ${error && error.message}`);
      outcome = {
        message: `${describeSystemLabel(systemID)}: FAILED `
          + `${(error && error.message) || "unknown failure"}`,
        totals: null,
        failure: true,
      };
    }
    run.index += 1;
    noteTiming({
      systemMs: now() - systemStartedAtMs,
      planets: outcome.totals
        ? (outcome.totals.deployed || 0) + (outcome.totals.destroyed || 0)
          + (outcome.totals.moved || 0) + (outcome.totals.skipped || 0)
          + (outcome.totals.destroyedMarkers || 0)
        : 0,
    });
    run.totals.failures += outcome.failure ? 1 : 0;
    run.totals.anomalies += outcome.anomalies || 0;
    if (outcome.totals) {
      for (const [key, value] of Object.entries(outcome.totals)) {
        run.totals[key] = (run.totals[key] || 0) + value;
      }
    }
    // An align run reports the Skyhooks it has not reached yet, the other runs report the
    // systems: whatever the run moves is what "left" is about. `run.skyhooksDone` was
    // already advanced by the system that just finished, so this is what remains.
    const skyhooksLeft = Math.max(
      0,
      positiveInt(run.scope.skyhooks, 0) - positiveInt(run.skyhooksDone, 0),
    );
    const suffix = progressSuffix(run, outstandingFor(run, skyhooksLeft));
    outcome.message = `${outcome.message}  ${suffix}`;
    const lines = [`${prefix()} ${outcome.message}`];
    if (outcome.extraLines && outcome.extraLines.length > 0) {
      lines.push(...outcome.extraLines);
    } else if (outcome.anomalyLines && outcome.anomalyLines.length > 0) {
      lines.push(...outcome.anomalyLines);
    }
    if (run.stopping) {
      lines.push("  stopping here as asked: this system was completed and verified first");
    }
    if (!sendFollowUp(run.session, lines.join("\n"))) {
      abortRunForDelivery(run, "a system report");
      return;
    }

    if (run.stopping || run.index >= run.scope.workable.length) {
      finishRegionRun(run);
      return;
    }
    const delay = stepDelayMs();
    run.timer = timers.setTimeout(() => {
      run.timer = null;
      workNextSystem(run);
    }, delay);
  }

  function scheduleCountdownTick(run) {
    run.timer = timers.setTimeout(() => {
      run.timer = null;
      if (activeRun !== run || run.stopping) return;
      if (run.checksPresence) {
        const presence = callerPresence(run.session, { strict: true });
        if (!presence.ok) {
          abortRunForPresence(run, presence);
          return;
        }
      }
      run.remainingSeconds -= 1;
      if (run.remainingSeconds === 10 || run.remainingSeconds === 5) {
        if (!sendFollowUp(
          run.session,
          `${prefix()} ${run.scope.label}: starting in ${run.remainingSeconds} s, `
          + "type /ash stop to cancel",
        )) {
          abortRunForDelivery(run, `the ${run.remainingSeconds} s countdown tick`);
          return;
        }
      }
      if (run.remainingSeconds <= 0) {
        run.phase = "working";
        if (!sendFollowUp(run.session, `${prefix()} ${run.scope.label}: starting now`)) {
          abortRunForDelivery(run, "the starting message");
          return;
        }
        workNextSystem(run);
        return;
      }
      scheduleCountdownTick(run);
    }, 1000);
  }

  // The immediate reply is the plan summary plus the countdown; everything after it
  // is a follow-up through the chat hub.
  function startRegionRun(scope, identity, session, kind) {
    if (activeRun) {
      return {
        ok: false,
        error: `a region run is already in progress (${activeRun.kind} on `
          + `${activeRun.scope.label}, ${activeRun.index} of `
          + `${activeRun.scope.workable.length} systems done); use /ash stop to cancel it`,
      };
    }
    const run = {
      kind: kind === "unanchor" || kind === "align" ? kind : "deploy",
      scope,
      identity,
      session,
      startedAtMs: now(),
      index: 0,
      phase: "countdown",
      stopping: false,
      // An anchor is the only run that creates Skyhooks, so it is the only one that
      // pays the slow first restart and the only one that has to keep the caller
      // docked for its whole length.
      checksPresence: kind !== "unanchor" && kind !== "align",
      timer: null,
      remainingSeconds: countdownSeconds(),
      // How many Skyhooks of an align run are behind it: what is left is the run's
      // own outstanding count, not a per-system guess.
      skyhooksDone: 0,
      // What the estimate was based on, kept so the summary can compare it with the
      // time the run actually took.
      estimatePlan: null,
      estimatedMs: 0,
      totals: {
        deployed: 0,
        skippedPresent: 0,
        overDestroyed: 0,
        destroyed: 0,
        alreadyDestroyed: 0,
        structures: 0,
        moved: 0,
        skipped: 0,
        destroyedMarkers: 0,
        anomalies: 0,
        failures: 0,
      },
    };
    run.estimatePlan = remainingPlanFor(run);
    run.estimatedMs = estimateRunMs(run.estimatePlan);
    activeRun = run;
    const lines = [];
    if (run.checksPresence) {
      // The operator sees this before the plan and the countdown: it is the one thing
      // they must act on before the run starts.
      lines.push(anchorWarningText(), "");
    }
    lines.push(
      `${prefix()} ${scope.label}: ${scope.workable.length} `
      + (run.kind === "align"
        ? `system(s) to work, ${scope.skyhooks} Skyhook(s) to move, `
        : `systems to work, ${scope.npc.length} NPC/faction space skipped - `)
      + (run.remainingSeconds > 0
        ? `starting in ${run.remainingSeconds} s, type /ash stop to cancel`
        : "starting now, type /ash stop to cancel"),
    );
    if (scope.npc.length > 0) {
      lines.push(
        `  skipped NPC/faction space: ${
          scope.npc.map((entry) => describeSystemLabel(entry.solarSystemID)).join(", ")}`,
      );
    }
    lines.push(
      "please stay in game and avoid jumping or logging off until the run finishes; "
      + "type /ash stop to cancel",
    );
    lines.push(`  ${describeEstimate(run.estimatePlan)}`);
    if (run.remainingSeconds > 0) {
      scheduleCountdownTick(run);
    } else {
      run.phase = "working";
      sendFollowUp(run.session, `${prefix()} ${scope.label}: starting now`);
      workNextSystem(run);
    }
    return { ok: true, message: lines.join("\n"), run: regionRunStatus() };
  }

  function stopRegionRun() {
    if (!activeRun) {
      return { ok: true, stopped: "none", message: `${prefix()} nothing to stop` };
    }
    const run = activeRun;
    if (run.phase === "countdown") {
      if (run.timer) timers.clearTimeout(run.timer);
      run.timer = null;
      activeRun = null;
      run.phase = "done";
      const message = `${prefix()} ${run.scope.label}: cancelled during the countdown - `
        + "nothing was deployed and no system was touched";
      sendFollowUp(run.session, message);
      return { ok: true, stopped: "countdown", message, run: null };
    }
    // In the loop: the system being worked is finished and verified first.
    run.stopping = true;
    return {
      ok: true,
      stopped: "loop",
      message: `${prefix()} ${run.scope.label}: stopping after the system being worked `
        + "(it is completed and verified first)",
      run: regionRunStatus(),
    };
  }

  function statusSystem(systemID, identity) {
    const inspection = inspectSystem(systemID, identity);
    if (!inspection.ok) return inspection;
    const cap = inspection.maxPlanetsPerCommand;
    return {
      ok: true,
      solarSystemID: systemID,
      label: inspection.label,
      planets: inspection.planets,
      claim: inspection.claim,
      structures: inspection.structures,
      listed: inspection.planets.slice(0, cap),
      omitted: Math.max(0, inspection.planets.length - cap),
      maxPlanetsPerCommand: cap,
    };
  }

  // The detail lines under a deploy header. `indent` exists so a region reply can
  // nest one system's detail under that system's own line; the single-system reply
  // uses the default and is unchanged.
  function planDetailLines(plan, result, indent = "  ") {
    const lines = [];
    if (result.deployed.length > 0) {
      lines.push(`${indent}deployed: ${result.deployed.map((entry) => (
        skyhookLabel(planetNameFor(entry.planetID, entry))
      )).join("; ")}`);
      lines.push(
        `${indent}each one starts ONLINING with the vendor's own 60 s activation timer `
        + "and settles to IDLE by itself",
      );
    }
    if (plan.skippedPresent.length > 0) {
      lines.push(`${indent}already present: ${plan.skippedPresent.map((entry) => (
        `${skyhookLabel(planetNameFor(entry.planetID, entry))} (${entry.detail})`
      )).join("; ")}`);
    }
    if (plan.overDestroyed.length > 0) {
      const tombstoneLabel = (entry) => {
        const kind = entry.tombstone && entry.tombstone.kind;
        return kind === "orbital" ? "orbital tombstone" : "ledger tombstone";
      };
      lines.push(`${indent}over a destroyed skyhook: ${plan.overDestroyed.map((entry) => (
        `${skyhookLabel(planetNameFor(entry.planetID, entry))} (old ${
          tombstoneLabel(entry)} - kept as history)`
      )).join("; ")}`);
    }
    for (const failure of result.failures) {
      lines.push(
        `${indent}FAILED ${skyhookLabel(planetNameFor(failure.planetID, failure))}: `
        + `${failure.errorMsg}`,
      );
    }
    return lines;
  }

  function describePlan(plan, result) {
    if (plan && plan.ok !== true) {
      return `${prefix()} ${plan.error}`;
    }
    if (plan && plan.error) {
      return `${prefix()} nothing to deploy: ${plan.error}`;
    }
    if (!result || result.ok !== true) {
      return `${prefix()} nothing deployed: ${(result && result.error) || "unknown failure"}`;
    }
    const lines = [];
    lines.push(
      `${prefix()} ${plan.label}: deployed ${result.deployed.length}, `
      + `skipped ${plan.skippedPresent.length} already present, `
      + `${plan.overDestroyed.length} over a destroyed skyhook`,
    );
    lines.push(...planDetailLines(plan, result));
    if (result.deployed.length === 0 && result.failures.length > 0) {
      lines[0] = `${prefix()} ${plan.label}: deployed 0, skipped `
        + `${plan.skippedPresent.length} already present, `
        + `${plan.overDestroyed.length} over a destroyed skyhook`;
    }
    return lines.join("\n");
  }

  // The detail lines under a removal header, with the same indent contract. A line the
  // command actually did something to names the Skyhook by the planet it orbits; the
  // item id it was destroyed at stays in the log, not in the reply. Destroyed markers
  // are one count, never one line each.
  function removalDetailLines(result, indent = "  ") {
    const lines = [];
    for (const entry of result.destroyed) {
      lines.push(
        `${indent}destroyed ${skyhookLabel(planetNameFor(entry.planetID, entry))}`
        + `${entry.ledgerTombstoned ? ", ledger tombstoned" : ", ledger row was absent"}`
        + `${entry.entityNote ? `, scene entity: ${entry.entityNote}` : ""}`,
      );
    }
    if (result.alreadyDestroyed.length > 0) {
      // One line with a count, never one line per marker: the Skyhook is gone, the
      // marker stays, and the planet can be deployed on again. Naming each marker
      // only turned a deliberate no-op into eleven lines of noise.
      lines.push(
        `${indent}destroyed markers left alone: ${
          describeDestroyedMarkers(result.alreadyDestroyed.length)} - the skyhook is already `
        + "gone, and the planet can be deployed on again",
      );
    }
    if (result.untouchedStructures.length > 0) {
      lines.push(`${indent}not touched (structure-shaped, this command never destroys those): ${
        result.untouchedStructures.map((entry) => `structureID ${entry.structureID}`).join("; ")}`);
    }
    for (const failure of result.failures) {
      lines.push(
        `${indent}FAILED ${skyhookLabel(planetNameFor(failure.planetID, failure))}: `
        + `${failure.errorMsg}`,
      );
    }
    return lines;
  }

  function removalHeader(result) {
    return `${prefix()} ${result.label}: destroyed ${result.destroyed.length}, `
      + `already destroyed ${result.alreadyDestroyed.length}, `
      + `left alone ${result.untouchedStructures.length} structure-shaped`;
  }

  function describeRemoval(result) {
    if (result && result.ok !== true) {
      return `${prefix()} nothing removed: ${(result && result.error) || "unknown failure"}`;
    }
    const lines = [removalHeader(result), ...removalDetailLines(result)];
    const counter = describeCounter(result.counter);
    if (counter) {
      lines.push(`  ${counter}`);
    }
    return lines.join("\n");
  }

  // A scoped deploy. One system keeps the exact single-system reply; a region gets a
  // summary first, then one block per system it worked.
  function describeScopeDeploy(scopeResult) {
    if (!scopeResult || scopeResult.ok !== true) {
      return `${prefix()} nothing deployed: ${
        (scopeResult && scopeResult.error) || "unknown failure"}`;
    }
    const { scope, systems } = scopeResult;
    if (scope.kind !== "region") {
      const only = systems[0];
      if (only && only.error) {
        return `${prefix()} nothing to deploy: ${only.label}: ${only.error}`;
      }
      return describePlan(only.plan, only.result);
    }
    const lines = [];
    lines.push(
      `${prefix()} ${scope.label}: ${scope.systems} systems, `
      + `${scope.npc.length} NPC/faction space (skipped), ${systems.length} worked - `
      + `deployed ${scopeResult.totals.deployed}, `
      + `skipped ${scopeResult.totals.skippedPresent} already present, `
      + `${scopeResult.totals.overDestroyed} over a destroyed skyhook`,
    );
    for (const entry of systems) {
      if (entry.error) {
        lines.push(`  ${entry.label}: FAILED ${entry.error}`);
        continue;
      }
      lines.push(
        `  ${entry.label}: deployed ${entry.result.deployed.length}, `
        + `skipped ${entry.plan.skippedPresent.length} already present, `
        + `${entry.plan.overDestroyed.length} over a destroyed skyhook`,
      );
      lines.push(...planDetailLines(entry.plan, entry.result, "    "));
    }
    if (scope.npc.length > 0) {
      lines.push(
        `  skipped NPC/faction space: ${scope.npc.map((entry) => entry.solarSystemID).join(", ")}`,
      );
    }
    return lines.join("\n");
  }

  // A scoped sweep, the same shape as the scoped deploy.
  function describeScopeRemoval(scopeResult) {
    if (!scopeResult || scopeResult.ok !== true) {
      return `${prefix()} nothing removed: ${
        (scopeResult && scopeResult.error) || "unknown failure"}`;
    }
    const { scope, systems } = scopeResult;
    const totals = scopeResult.totals;
    if (scope.kind !== "region") {
      const only = systems[0];
      if (only && only.error) {
        return `${prefix()} nothing removed: ${only.label}: ${only.error}`;
      }
      return describeRemoval({ ...only.result, counter: scopeResult.counter });
    }
    const lines = [];
    lines.push(
      `${prefix()} ${scope.label}: ${scope.systems} systems, `
      + `${scope.npc.length} NPC/faction space (skipped), ${systems.length} worked - `
      + `destroyed ${totals.destroyed}, already destroyed ${totals.alreadyDestroyed}, `
      + `left alone ${totals.structures} structure-shaped`,
    );
    for (const entry of systems) {
      if (entry.error) {
        lines.push(`  ${entry.label}: FAILED ${entry.error}`);
        continue;
      }
      lines.push(`  ${removalHeader(entry.result).replace(`${prefix()} `, "")}`);
      lines.push(...removalDetailLines(entry.result, "    "));
    }
    if (scope.npc.length > 0) {
      lines.push(
        `  skipped NPC/faction space: ${scope.npc.map((entry) => entry.solarSystemID).join(", ")}`,
      );
    }
    const counter = describeCounter(scopeResult.counter);
    if (counter) {
      lines.push(`  ${counter}`);
    }
    return lines.join("\n");
  }

  function describeStatus(result, options = {}) {
    if (result && result.ok !== true) {
      return `${prefix()} ${(result && result.error) || "unknown failure"}`;
    }
    const includeDestroyed = options.includeDestroyed !== false;
    const lines = [`${prefix()} ${result.label}`];
    let live = 0;
    let destroyed = 0;
    let free = 0;
    const describeFree = (entry) => {
      if (entry.overDestroyed && includeDestroyed) {
        return "free (destroyed skyhook tombstone - a new one may be placed here)";
      }
      return "free";
    };
    for (const entry of result.listed) {
      if (entry.state === "free") {
        if (entry.overDestroyed) destroyed += 1;
        else free += 1;
        lines.push(`  ${entry.itemName}: ${describeFree(entry)}`);
        continue;
      }
      live += 1;
      lines.push(
        `  ${entry.itemName}: orbital skyhook present (${entry.detail})`,
      );
    }
    // The counts cover the whole system even when the listing is truncated.
    for (const entry of result.planets.slice(result.listed.length)) {
      if (entry.state !== "free") live += 1;
      else if (entry.overDestroyed) destroyed += 1;
      else free += 1;
    }
    if (destroyed > 0) {
      // One count, never one line per marker. `includeDestroyedInStatus` still decides
      // whether the planet above carries the "may be placed here" annotation; the
      // count itself is always there, because the marker is what keeps a claimed
      // planet's default from being re-minted.
      lines.push(`  destroyed markers left alone: ${describeDestroyedMarkers(destroyed)}`);
    }
    lines.push(
      `  ${result.planets.length} planet(s): ${live} with a skyhook, `
      + `${destroyed} free over a destroyed skyhook${
        includeDestroyed || destroyed === 0 ? " (deployable)" : " (history not shown)"}, `
      + `${free} free`,
    );
    if (result.omitted > 0) {
      lines.push(`  (listing stops at maxPlanetsPerCommand=${result.maxPlanetsPerCommand}; `
        + `${result.omitted} more planet(s) not shown)`);
    }
    if (result.structures.unattributed.length > 0) {
      lines.push("  system-wide structure-shaped skyhook(s) not tied to a planet: "
        + `${result.structures.unattributed.length}`);
    }
    const claim = result.claim;
    lines.push(claim
      ? `  sovereignty ledger: claimed (corporation ${claim.corporationID || "unknown"}, `
        + `alliance ${claim.allianceID || "none"})`
      : "  sovereignty ledger: no row for this system (unclaimed)");
    return lines.join("\n");
  }

  function prefix() {
    return version ? `${version}:` : "autoSkyHookDeploy:";
  }

  return Object.freeze({
    OFFSET_MAX_METERS,
    OFFSET_MIN_METERS,
    SKYHOOK_TYPE_ID,
    anchorPresenceRefusal,
    anchorRestartAdvice,
    anchorWarningText,
    applyPlan,
    applyScope,
    buildPlan,
    calibrateItemIDCounter,
    callerIdentity,
    callerPresence,
    describeCounter,
    describeOffsetValue,
    describePlan,
    describeRegion,
    describeRegionLabel,
    describeRemoval,
    describeScopeDeploy,
    describeEstimate,
    describeScopeRemoval,
    describeStatus,
    describeSystemLabel,
    formatMeters,
    handleOffsetCommand,
    inspectSystem,
    offsetUsageLine,
    ownerIDFor,
    parseOffsetMeters,
    planetNameFor,
    progressSuffix,
    removeSkyhook,
    resolveOffsetMeters,
    resolveAlignScope,
    resolveScope,
    resolveSystemToken,
    skyhookLabel,
    estimateRunMs,
    formatDuration,
    regionRunStatus,
    startRegionRun,
    statusSystem,
    stopRegionRun,
    unanchorScope,
    unanchorSystem,
    prefix,
    _testing: Object.freeze({
      buildLedgerIndex,
      inspectPlanet,
      moveSkyhookToOffset,
      allSkyhookRecords,
      timing,
      noteTiming,
      describeTiming,
      resetTiming,
      maxPlanets,
      ownerIDFor,
      readStoredItemIDCounter,
      workOneSystem,
    }),
  });
}

module.exports = {
  CATEGORY_ORBITAL,
  OWNER_MODE_CHARACTER,
  OWNER_MODE_CORPORATION,
  SKYHOOK_TYPE_ID,
  createRuntime,
  createServerDeps,
  normalizeVector,
  toInt,
};
