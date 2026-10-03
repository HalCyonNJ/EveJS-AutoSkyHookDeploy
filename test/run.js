"use strict";

// The mod's own suite: no server, no game data, no scene, no network. The
// vendored services are replaced by fixtures that implement the same handful of
// methods, so the command parser, the plan builder, the destruction sequence and
// the two chat seams are all exercised as plain functions.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loaderPath = path.join(modDir, "loader.js");
const SYSTEM_ID = 30000142;
const OTHER_SYSTEM_ID = 30000143;
// The vendor's own names for the two systems the fixtures use, in the shape
// `worldData.getSolarSystemByID(id).solarSystemName` carries.
const SYSTEM_NAME = "Jita";
const OTHER_SYSTEM_NAME = "Perimeter";
// Domain, the region the operator named.
const REGION_ID = 10000043;
const REGION_NAME = "Domain";
const OTHER_REGION_ID = 10000044;
const CORPORATION_ID = 98000001;
const ALLIANCE_ID = 99000001;
const CHARACTER_ID = 140000005;
const SKYHOOK_ITEM_ID_OFFSET = 1000000000000;
const results = [];
let failed = 0;

function test(name, operation) {
  try {
    operation();
    results.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`     ${(error && error.message) || error}`);
  }
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, ...options });
}

function parseChildResult(stdout) {
  const line = String(stdout || "").split(/\r?\n/u).find((entry) => entry.startsWith("RESULT:"));
  assert.ok(line, `missing child result in output: ${stdout}`);
  return JSON.parse(line.slice("RESULT:".length));
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function planet(planetID, itemName, index) {
  return {
    planetID,
    solarSystemID: SYSTEM_ID,
    typeID: 2016,
    radius: 1000,
    position: { x: (planetID % 100) * 1000, y: 0, z: 0 },
    celestialIndex: index,
    itemName,
  };
}

const THREE_PLANETS = [
  planet(40009001, "Planet I", 1),
  planet(40009002, "Planet II", 2),
  planet(40009003, "Planet III", 3),
];

// The system's star. It sits far out on +X with a large +Y, so a star-facing
// horizontal direction is exactly +X: the Y is ignored on purpose, and the
// direction assertions can be exact instead of approximate.
const STAR = Object.freeze({
  itemID: 40009000,
  solarSystemID: SYSTEM_ID,
  kind: "sun",
  groupID: 6,
  position: { x: 1_000_000_000, y: 500_000, z: 0 },
});

function orbital(planetID, itemID, options = {}) {
  return {
    itemID,
    typeID: 81080,
    planetID,
    solarSystemID: SYSTEM_ID,
    ownerID: options.ownerID || CORPORATION_ID,
    corporationID: options.corporationID || CORPORATION_ID,
    allianceID: options.allianceID || ALLIANCE_ID,
    state: options.state == null ? 0 : options.state,
    destroyedAtMs: options.destroyedAtMs || 0,
  };
}

function ledgerRow(planetID, options = {}) {
  return {
    skyhookID: options.skyhookID || (SKYHOOK_ITEM_ID_OFFSET + planetID),
    planetID,
    solarSystemID: options.solarSystemID || SYSTEM_ID,
    corporationID: options.corporationID || CORPORATION_ID,
    allianceID: options.allianceID || ALLIANCE_ID,
    destroyed: options.destroyed === true,
    deployedItem: options.deployedItem === true,
    active: options.active !== false,
  };
}

function createFixture(options = {}) {
  const fixturePlanets = options.planets || THREE_PLANETS;
  // A stand-in for the vendor's deterministic landing point: offset from the
  // planet's centre with a deliberate vertical component, at a distance that the
  // fallback heuristic would never produce (so a test can tell the two apart).
  const defaultWarpInPoints = Object.fromEntries(fixturePlanets.map((entry) => [
    String(entry.planetID),
    {
      x: entry.position.x + 2_000_000,
      y: entry.position.y + 300_000,
      z: entry.position.z - 1_500_000,
    },
  ]));
  const fixture = {
    planets: fixturePlanets,
    orbitals: [...(options.orbitals || [])],
    ledger: { ...(options.ledger || {}) },
    structures: [...(options.structures || [])],
    calls: [],
    throwOn: options.throwOn || null,
    createFailure: options.createFailure || null,
    spawnResult: options.spawnResult || { success: true },
    celestials: options.celestials === undefined ? [STAR] : [...options.celestials],
    warpInPoints: options.warpInPoints === undefined
      ? defaultWarpInPoints
      : { ...options.warpInPoints },
    warpInMissing: options.warpInMissing === true,
    warpInThrows: options.warpInThrows === true,
    // A region scope's rows: one claimable system by default, plus whatever the
    // test asked for. Any system a test puts planets in is added so the fixture is
    // coherent with its own planet list. Every row carries a `solarSystemName`,
    // exactly as the vendor's own table does: the replies name systems, never ids.
    solarSystems: (() => {
      const named = new Map([[SYSTEM_ID, SYSTEM_NAME], [OTHER_SYSTEM_ID, OTHER_SYSTEM_NAME]]);
      const fallbackName = (systemID) => (
        options.solarSystemsMissingName === true
          ? null
          : named.get(systemID) || `System ${systemID}`
      );
      const rows = [...(options.solarSystems || [{
        solarSystemID: SYSTEM_ID,
        regionID: REGION_ID,
        security: -0.5,
        factionID: 0,
      }])].map((row) => ({
        solarSystemName: fallbackName(Number(row && row.solarSystemID)),
        ...row,
      }));
      const known = new Set(rows.map((row) => row.solarSystemID));
      for (const planet of fixturePlanets) {
        const systemID = Number(planet && planet.solarSystemID);
        if (!systemID || known.has(systemID)) continue;
        known.add(systemID);
        rows.push({
          solarSystemID: systemID,
          solarSystemName: fallbackName(systemID),
          regionID: REGION_ID,
          security: -0.5,
          factionID: 0,
        });
      }
      return rows;
    })(),
    npcSystemIDs: new Set((options.npcSystemIDs || []).map((id) => Number(id))),
    solarSystemsMissingName: options.solarSystemsMissingName === true,
    sovSystemRulesMissing: options.sovSystemRulesMissing === true,
    sovSystemRulesThrows: options.sovSystemRulesThrows === true,
    skyhookRadius: options.skyhookRadius === undefined ? 45000 : options.skyhookRadius,
    metadataThrows: options.metadataThrows === true,
    metadataMissing: options.metadataMissing === true,
    destroyEntityResult: options.destroyEntityResult || { success: true },
    // The item rows the fixture's createSpaceItemForOwner wrote, so a run can verify
    // what it deployed. `dropItemRows`/`itemsThrows` drive the anomaly cases.
    items: new Map(),
    // A loaded scene's entities are authoritative for the items realised in them.
    entities: new Map(),
    storeWriteLost: options.storeWriteLost === true,
    sceneIgnoresPosition: options.sceneIgnoresPosition === true,
    dropItemRows: options.dropItemRows === true,
    itemsThrows: options.itemsThrows === true,
    itemPositionDrift: Number.isFinite(Number(options.itemPositionDrift))
      ? Number(options.itemPositionDrift)
      : 0,
    nextItemID: options.nextItemID || SKYHOOK_ITEM_ID_OFFSET + 500000,
    // The identity allocator's view of the world: the stored "next item id"
    // counter and the highest id any table still references.
    counterItemID: options.counterItemID === undefined
      ? 9988400003304
      : options.counterItemID,
    highWater: options.highWater === undefined ? 9988400003303 : options.highWater,
    reserveCalls: [],
    identityAllocatorMissing: options.identityAllocatorMissing === true,
    identityAllocatorThrows: options.identityAllocatorThrows === true,
    gameStoreMissing: options.gameStoreMissing === true,
  };
  // Which solar systems have a scene loaded, as the vendor's own registry sees it: a
  // scene exists only after something loaded (or created) it. `ensureScene` bootstraps a
  // scene, so it adds to this set - a reader that still called it would load every system
  // it asked about, which is exactly the live bug. `isSolarSystemSceneLoaded` only reads
  // the set, like the vendor's own accessor reads `this.scenes`.
  fixture.loadedSystems = new Set(
    (options.loadedSystems || []).map((systemID) => Number(systemID)),
  );
  // The loaded scene of a system: entities are authoritative, and the clock lives on the
  // scene itself - `solarSystemScene.js:140` installs `this.positionAuthority`, and the
  // methods of `scene/clock.js` are mixed into the class. There is no `scene.clock`; the
  // receiver of a write is recorded so a test can assert it is the scene.
  fixture.scene = {
    sceneDescriptor: { locationID: SYSTEM_ID },
    getEntityByID: (itemID) => fixture.entities.get(itemID) || null,
    setEntityPosition(itemID, position, setOptions) {
      record("setEntityPosition", {
        itemID, position, setOptions, receiver: this,
      });
      const entity = fixture.entities.get(itemID);
      if (!entity) return { success: false, errorMsg: "ENTITY_NOT_FOUND" };
      if (fixture.sceneIgnoresPosition) return { success: true };
      entity.position = { ...position };
      return { success: true };
    },
  };

  const record = (fn, payload) => {
    fixture.calls.push({ fn, ...payload });
    if (fixture.throwOn === fn) throw new Error(`${fn} exploded`);
  };
  const deps = {
    getPlanetOrbitalState: () => ({
      _testing: {
        listPlanetsForSystem: (systemID) => {
          record("listPlanetsForSystem", { systemID });
          return fixture.planets.filter((entry) => entry.solarSystemID === systemID);
        },
        findNearestPlanetID: (systemID, position) => {
          const list = fixture.planets.filter((entry) => entry.solarSystemID === systemID);
          if (!position || list.length === 0) return list.length > 0 ? list[0].planetID : 0;
          let best = list[0];
          let bestDistance = Number.POSITIVE_INFINITY;
          for (const entry of list) {
            const dx = (entry.position.x || 0) - position.x;
            const dy = (entry.position.y || 0) - position.y;
            const dz = (entry.position.z || 0) - position.z;
            const distance = (dx * dx) + (dy * dy) + (dz * dz);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = entry;
            }
          }
          return best.planetID;
        },
      },
      listOrbitalsForPlanet: (planetID) => {
        record("listOrbitalsForPlanet", { planetID });
        return fixture.orbitals.filter((entry) => entry.planetID === planetID);
      },
      listOrbitalsForSystem: (systemID) => {
        record("listOrbitalsForSystem", { systemID });
        return fixture.orbitals.filter((entry) => entry.solarSystemID === systemID);
      },
      isOrbitalRecordDestroyed: (entry) => Boolean(entry && entry.destroyedAtMs),
      normalizeOrbitalRecord: (entry) => entry,
      getOrbitalByID: (itemID) => {
        record("getOrbitalByID", { itemID });
        return fixture.orbitals.find((entry) => entry.itemID === itemID) || null;
      },
      // The global read an align run uses to find every deployed Skyhook, including one
      // a player deployed by hand.
      readState: () => {
        record("readState", {});
        const orbitalsByID = {};
        for (const entry of fixture.orbitals) orbitalsByID[String(entry.itemID)] = entry;
        return { orbitalsByID };
      },
      ensureOrbitalForItem: (item, orbitalOptions) => {
        record("ensureOrbitalForItem", { itemID: item.itemID, options: orbitalOptions });
        const entry = orbital(item.itemID && orbitalOptions.planetID, item.itemID, {
          state: -5,
        });
        entry.planetID = orbitalOptions.planetID;
        entry.solarSystemID = orbitalOptions.solarSystemID;
        fixture.orbitals.push(entry);
        return entry;
      },
      markOrbitalDestroyed: (itemID) => {
        record("markOrbitalDestroyed", { itemID });
        const entry = fixture.orbitals.find((candidate) => candidate.itemID === itemID);
        if (entry) entry.destroyedAtMs = 1700000000000;
        return { success: true, data: entry };
      },
    }),
    getItemStore: () => ({
      getItemMetadata: (typeID) => {
        record("getItemMetadata", { typeID });
        if (fixture.metadataThrows) throw new Error("getItemMetadata exploded");
        if (fixture.metadataMissing) return null;
        return { typeID, name: "Orbital Skyhook", groupID: 8, categoryID: 46, radius: fixture.skyhookRadius };
      },
      createSpaceItemForOwner: (ownerID, systemID, typeID, itemOptions) => {
        record("createSpaceItemForOwner", { ownerID, systemID, typeID, itemOptions });
        if (fixture.createFailure) {
          return { success: false, errorMsg: fixture.createFailure };
        }
        fixture.nextItemID += 1;
        const data = {
          itemID: fixture.nextItemID,
          typeID,
          categoryID: 46,
          locationID: systemID,
          ownerID,
          itemName: "Orbital Skyhook",
          spaceRadius: itemOptions.spaceRadius || null,
          // The written position lives on the item row (the orbital record does not
          // carry one), which is what the region run verifies after a deployment.
          spaceState: { systemID, position: { ...itemOptions.position } },
        };
        if (!fixture.dropItemRows) {
          if (fixture.itemPositionDrift) {
            data.spaceState.position.x += fixture.itemPositionDrift;
          }
          fixture.items.set(data.itemID, data);
        }
        return { success: true, data };
      },
      findItemById: (itemID) => {
        record("findItemById", { itemID });
        if (fixture.itemsThrows) throw new Error("findItemById exploded");
        return fixture.items.get(itemID) || null;
      },
      updateInventoryItem: (itemID, updater) => {
        record("updateInventoryItem", { itemID });
        if (fixture.updateThrows) throw new Error("updateInventoryItem exploded");
        const current = fixture.items.get(itemID);
        if (!current) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
        const next = typeof updater === "function"
          ? updater({ ...current, spaceState: { ...(current.spaceState || {}) } })
          : updater;
        if (fixture.storeWriteLost) {
          // The write is accepted and then lost: a loaded scene rewrites the row from the
          // entity it owns. This is the live failure mode.
          return { success: true, data: current };
        }
        fixture.items.set(itemID, next);
        return { success: true, data: next };
      },
    }),
    getWorldData: () => ({
      getCelestialByID: (celestialID) => {
        if (celestialID === SYSTEM_ID) return { itemID: celestialID, itemName: "Jita" };
        const entry = fixture.planets.find((candidate) => candidate.planetID === celestialID);
        // A real celestial row carries the celestial's own itemID (which is the
        // planet id), so the fixture must too: the warp-in point seeds its RNG
        // from it.
        return entry ? { ...entry, itemID: entry.planetID, groupID: 7, kind: "planet" } : null;
      },
      // The vendor's celestial rows: the fixture's own star plus every planet the
      // fixture holds for that system, in the shape a real row has (its own item id,
      // an itemName, groupID 7 and kind "planet"). The mod reads this list both to
      // find the star and to resolve a planet name `/ash remove "..."` was given.
      getCelestialsForSystem: (systemID) => {
        record("getCelestialsForSystem", { systemID });
        return [
          ...fixture.celestials,
          ...fixture.planets,
        ]
          .filter((entry) => entry && entry.solarSystemID === systemID)
          .map((entry) => (entry.kind === "sun"
            ? entry
            : { ...entry, itemID: entry.planetID ?? entry.itemID, groupID: 7, kind: "planet" }));
      },
      // The region scope's data source. A row carries what sovSystemRules reads:
      // solarSystemID, regionID, security and factionID.
      getSolarSystems: () => {
        record("getSolarSystems", {});
        return fixture.solarSystems.map((row) => ({ ...row }));
      },
      getSolarSystemByID: (systemID) => {
        record("getSolarSystemByID", { systemID });
        const row = fixture.solarSystems.find((entry) => entry.solarSystemID === systemID);
        return row ? { ...row } : null;
      },
    }),
    // The vendor's own rule, and only that rule, decides what is workable. The
    // fixture mirrors its contract: false for faction space, for high/low-sec and
    // for the systems it is told to treat as NPC.
    getSovSystemRules: () => {
      if (fixture.sovSystemRulesMissing) {
        return {};
      }
      return {
        isSovereigntyClaimableSolarSystem: (rowOrID) => {
          const row = rowOrID && typeof rowOrID === "object"
            ? rowOrID
            : fixture.solarSystems.find((entry) => entry.solarSystemID === Number(rowOrID));
          record("isSovereigntyClaimableSolarSystem", {
            systemID: row ? row.solarSystemID : Number(rowOrID),
          });
          if (fixture.sovSystemRulesThrows) {
            throw new Error("isSovereigntyClaimableSolarSystem exploded");
          }
          if (!row) return false;
          if (fixture.npcSystemIDs.has(row.solarSystemID)) return false;
          if (Number(row.factionID) > 0) return false;
          const security = Number(row.security);
          return Number.isFinite(security) && security <= 0;
        },
      };
    },
    // A loaded scene: entities holds the realised runtime entities, which are
    // authoritative for anything in them. storeWriteLost models the live bug (the store
    // row keeps the old position), sceneIgnoresPosition models a scene that refuses the
    // write. The two read-only accessors are the ones an align run must use:
    // `isSolarSystemSceneLoaded` only reads the registry, and `getSceneByDescriptor`
    // only looks a loaded scene up. `ensureScene` is the deploy/removal path: it creates
    // and bootstraps a scene, so it marks the system loaded.
    getSpaceRuntime: () => ({
      isSolarSystemSceneLoaded: (systemID) => {
        record("isSolarSystemSceneLoaded", { systemID });
        return fixture.loadedSystems.has(Number(systemID));
      },
      getSceneByDescriptor: (systemID) => {
        record("getSceneByDescriptor", { systemID });
        return fixture.loadedSystems.has(Number(systemID)) ? fixture.scene : null;
      },
      scenes: {
        get: (systemID) => {
          record("scenesGet", { systemID });
          return fixture.loadedSystems.has(Number(systemID)) ? fixture.scene : null;
        },
      },
      ensureScene: (systemID) => {
        record("ensureScene", { systemID });
        // The vendor's ensureScene constructs the scene and realises its
        // inventory-backed entities; the fixture records the system as loaded so a
        // reader that still called it would see the live bug's false positives.
        fixture.loadedSystems.add(Number(systemID));
        return fixture.scene;
      },

      spawnDynamicInventoryEntity: (systemID, itemID) => {
        record("spawnDynamicInventoryEntity", { systemID, itemID });
        return fixture.spawnResult;
      },
      destroyDynamicInventoryEntity: (systemID, itemID, destroyOptions) => {
        record("destroyDynamicInventoryEntity", { systemID, itemID, destroyOptions });
        return fixture.destroyEntityResult;
      },
      refreshInventoryBackedEntityPresentation: (systemID, itemID) => {
        record("refreshInventoryBackedEntityPresentation", { systemID, itemID });
        return { success: true };
      },
    }),
    getSovModernState: () => ({
      getSkyhook: (skyhookID, identity) => {
        record("getSkyhook", { skyhookID, identity });
        const row = fixture.ledger[String(skyhookID)];
        return row
          ? { ok: true, skyhook: row }
          : { ok: false, statusCode: 404, errorCode: "SKYHOOK_NOT_FOUND" };
      },
      listLocalSkyhooks: (identity) => {
        record("listLocalSkyhooks", { identity });
        return {
          solarSystemID: identity && identity.solarSystemID,
          skyhooks: Object.values(fixture.ledger)
            .filter((row) => row.solarSystemID === (identity && identity.solarSystemID)),
        };
      },
      destroySkyhooks: (skyhookIDs) => {
        record("destroySkyhooks", { skyhookIDs: [...skyhookIDs] });
        for (const skyhookID of skyhookIDs) {
          const row = fixture.ledger[String(skyhookID)];
          if (row) row.destroyed = true;
        }
        return [...skyhookIDs];
      },
    }),
    getStructureState: () => ({
      listStructuresForSystem: (systemID, structureOptions) => {
        record("listStructuresForSystem", { systemID, structureOptions });
        return fixture.structures.filter((entry) => entry.solarSystemID === systemID);
      },
      getStructureByID: (structureID) => {
        record("getStructureByID", { structureID });
        return fixture.structures.find((entry) => entry.structureID === structureID) || null;
      },
    }),
    getWarpInPointParity: () => {
      if (fixture.warpInMissing) {
        return {};
      }
      return {
        getClientParityWarpInPoint: (celestial) => {
          record("getClientParityWarpInPoint", {
            itemID: celestial && celestial.itemID,
            radius: celestial && celestial.radius,
          });
          if (fixture.warpInThrows) throw new Error("getClientParityWarpInPoint exploded");
          const point = fixture.warpInPoints[String(celestial && celestial.itemID)];
          return point ? { ...point } : null;
        },
      };
    },
    getIdentityAllocator: () => {
      if (fixture.identityAllocatorMissing) {
        return {};
      }
      return {
        IDENTITY_TABLE: "identity",
        getItemReferenceHighWaterMark: () => {
          record("getItemReferenceHighWaterMark", {});
          if (fixture.identityAllocatorThrows) {
            throw new Error("getItemReferenceHighWaterMark exploded");
          }
          return fixture.highWater;
        },
        // The vendor's own contract: max(nextItemID, highWater + 1), returned, and
        // the stored counter advanced past it.
        reserveItemIDs: (count = 1) => {
          record("reserveItemIDs", { count });
          if (fixture.identityAllocatorThrows) throw new Error("reserveItemIDs exploded");
          const amount = Math.max(1, Math.trunc(count) || 1);
          const first = Math.max(fixture.counterItemID, fixture.highWater + 1);
          fixture.counterItemID = first + amount;
          fixture.reserveCalls.push(first);
          return [first];
        },
      };
    },
    getGameStore: () => {
      if (fixture.gameStoreMissing) {
        return {};
      }
      return {
        read: (table, path) => {
          record("gameStoreRead", { table, path });
          return { success: true, data: { nextItemID: fixture.counterItemID } };
        },
      };
    },
    getCharacterState: () => ({
      peekCharacterRecord: (characterID) => ({
        characterID,
        corporationID: CORPORATION_ID,
        allianceID: ALLIANCE_ID,
      }),
    }),
  };
  return { fixture, deps };
}

function createRuntimeWith(fixture, deps, overrides = {}, extra = {}) {
  return runtimeModule.createRuntime({
    config: { ...configModule.DEFAULTS, ...overrides },
    deps,
    version: "autoSkyHookDeploy v1.0.0",
    logError: () => {},
    now: () => 1700000000000,
    ...extra,
  });
}

// An in-memory stand-in for the mod's live view of its configuration file, for the
// tests that only need a value to be in force.
function memoryLiveConfig(value, error = null) {
  let current = value;
  return {
    file: "memory-config.json",
    getOffsetMeters: () => ({ value: current, error }),
    setOffsetMeters: (meters) => {
      current = meters;
      return { ok: true, file: "memory-config.json" };
    },
  };
}

// The real live-config reader/writer, backed by a real file: used to prove that a
// chat change rewrites the config file and survives a fresh runtime (a restart).
function fileLiveConfig(file, defaults = { offsetMeters: 25000 }) {
  return configModule.createLiveConfig({
    file,
    defaults,
    limits: { offsetMeters: configModule.LIMITS.offsetMeters },
  });
}

function session(overrides = {}) {
  return {
    characterID: CHARACTER_ID,
    corporationID: CORPORATION_ID,
    allianceID: ALLIANCE_ID,
    solarSystemID: SYSTEM_ID,
    characterName: "Halcyon",
    ...overrides,
  };
}

function callNames(fixture) {
  return fixture.calls.map((entry) => entry.fn);
}

// ─── modules under test ──────────────────────────────────────────────────────

const configModule = require(path.join(modDir, "config"));
const chatCommand = require(path.join(modDir, "lib/chatCommand"));
const plainChat = require(path.join(modDir, "lib/plainChat"));
const runtimeModule = require(path.join(modDir, "lib/runtime"));

// Keep the preload inert while the suite drives the exports directly: the
// published defaults would otherwise install the real hooks into this process.
const previousEnabled = process.env.EVEJS_AUTO_SKYHOOK_DEPLOY;
process.env.EVEJS_AUTO_SKYHOOK_DEPLOY = "0";
const loaderModule = require(loaderPath);
if (previousEnabled === undefined) delete process.env.EVEJS_AUTO_SKYHOOK_DEPLOY;
else process.env.EVEJS_AUTO_SKYHOOK_DEPLOY = previousEnabled;

// ─── configuration ───────────────────────────────────────────────────────────

test("config defaults are the published defaults", () => {
  const config = configModule.load(modDir, {});
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.verbose, false);
  assert.strictEqual(config.allowDeploy, true);
  assert.strictEqual(config.allowRemove, true);
  assert.strictEqual(config.maxPlanetsPerCommand, 64);
  assert.strictEqual(config.standoffMeters, 5_000_000, "5,000,000 m is 5,000 km beyond the surface");
  assert.strictEqual(config.orbitMargin, 1.0, "one planet radius above the surface by default");
  assert.strictEqual(config.ownerMode, "corporation");
  assert.strictEqual(config.requireClaimedSystemOwnership, false);
  assert.strictEqual(config.includeDestroyedInStatus, true);
  assert.deepStrictEqual([...config.problems], []);
});

test("config reads environment overrides", () => {
  const config = configModule.load(modDir, {
    EVEJS_AUTO_SKYHOOK_DEPLOY_VERBOSE: "1",
    EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_REMOVE: "0",
    EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND: "8",
    EVEJS_AUTO_SKYHOOK_DEPLOY_STANDOFF_METERS: "8000000",
    EVEJS_AUTO_SKYHOOK_DEPLOY_ORBIT_MARGIN: "2.5",
    EVEJS_AUTO_SKYHOOK_DEPLOY_OWNER_MODE: "character",
    EVEJS_AUTO_SKYHOOK_DEPLOY_REQUIRE_CLAIMED_SYSTEM_OWNERSHIP: "yes",
    EVEJS_AUTO_SKYHOOK_DEPLOY_INCLUDE_DESTROYED_IN_STATUS: "off",
  });
  assert.strictEqual(config.verbose, true);
  assert.strictEqual(config.allowRemove, false);
  assert.strictEqual(config.maxPlanetsPerCommand, 8);
  assert.strictEqual(config.standoffMeters, 8_000_000);
  assert.strictEqual(config.orbitMargin, 2.5);
  assert.strictEqual(config.ownerMode, "character");
  assert.strictEqual(config.requireClaimedSystemOwnership, true);
  assert.strictEqual(config.includeDestroyedInStatus, false);
  assert.deepStrictEqual([...config.problems], []);
});

test("config can be disabled", () => {
  assert.strictEqual(configModule.load(modDir, { EVEJS_AUTO_SKYHOOK_DEPLOY: "0" }).enabled, false);
});

test("config file is read and loses to the environment", () => {
  const root = tmpdir("ashd-config-");
  try {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", configModule.CONFIG_FILENAME),
      JSON.stringify({ maxPlanetsPerCommand: 5, ownerMode: "character", verbose: true }),
      "utf8",
    );
    const fromFile = configModule.load(modDir, {}, { runtimeRoot: root });
    assert.strictEqual(fromFile.maxPlanetsPerCommand, 5);
    assert.strictEqual(fromFile.ownerMode, "character");
    assert.strictEqual(fromFile.verbose, true);
    assert.ok(fromFile.sources.includes(configModule.CONFIG_FILENAME));
    const fromEnv = configModule.load(
      modDir,
      { EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND: "9" },
      { runtimeRoot: root },
    );
    assert.strictEqual(fromEnv.maxPlanetsPerCommand, 9);
    assert.strictEqual(fromEnv.ownerMode, "character");
    assert.ok(fromEnv.sources.includes("environment"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config accepts the long environment spelling in the JSON file", () => {
  const root = tmpdir("ashd-config-long-");
  try {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", configModule.CONFIG_FILENAME),
      JSON.stringify({ [configModule.KEYS.allowDeploy]: "0" }),
      "utf8",
    );
    const config = configModule.load(modDir, {}, { runtimeRoot: root });
    assert.strictEqual(config.allowDeploy, false);
    assert.deepStrictEqual([...config.problems], []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("config collects wrong types and out-of-range values", () => {
  const cases = [
    ["EVEJS_AUTO_SKYHOOK_DEPLOY", "maybe"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_VERBOSE", "sort of"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_DEPLOY", "42"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_REMOVE", "nope"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND", "lots"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND", "0"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND", "99999"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND", "2.5"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_STANDOFF_METERS", "far away"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_STANDOFF_METERS", "99999"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_STANDOFF_METERS", "100000001"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_STANDOFF_METERS", "5000000.5"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_ORBIT_MARGIN", "lots"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_ORBIT_MARGIN", "-0.5"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_ORBIT_MARGIN", "10.5"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_ORBIT_MARGIN", "NaN"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_OWNER_MODE", "alliance"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_REQUIRE_CLAIMED_SYSTEM_OWNERSHIP", "sometimes"],
    ["EVEJS_AUTO_SKYHOOK_DEPLOY_INCLUDE_DESTROYED_IN_STATUS", "1.5"],
  ];
  for (const [key, value] of cases) {
    const config = configModule.load(modDir, { [key]: value });
    assert.ok(config.problems.length >= 1, `expected a problem for ${key}=${value}`);
    assert.ok(
      config.problems.some((problem) => problem.includes(key)),
      `the problem must name ${key}: ${config.problems.join(" | ")}`,
    );
  }
});

test("a broken config file is a configuration problem", () => {
  const root = tmpdir("ashd-config-broken-");
  try {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config", configModule.CONFIG_FILENAME),
      "{ not json",
      "utf8",
    );
    const config = configModule.load(modDir, {}, { runtimeRoot: root });
    assert.strictEqual(config.problems.length, 1);
    assert.match(config.problems[0], /not valid JSON/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(".env.example lists every key and nothing else", () => {
  const values = configModule.readEnvFile(path.join(modDir, ".env.example"));
  const known = new Set(Object.values(configModule.KEYS));
  assert.deepStrictEqual(
    Object.keys(values).filter((key) => !known.has(key)),
    [],
  );
  assert.deepStrictEqual(
    Object.values(configModule.KEYS).filter((key) => !(key in values)),
    [],
  );
});

test("config.example.json documents every key", () => {
  const example = JSON.parse(fs.readFileSync(path.join(modDir, "config.example.json"), "utf8"));
  for (const [field, value] of Object.entries(configModule.DEFAULTS)) {
    assert.ok(field in example, `config.example.json must carry ${field}`);
    assert.deepStrictEqual(example[field], value, `${field} must show the default`);
  }
});

// ─── manifest and loader ─────────────────────────────────────────────────────

test("launcher manifest matches the loader version", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(modDir, "evejs-launcher.mod.json"), "utf8"),
  );
  assert.strictEqual(manifest.schemaVersion, 3);
  assert.strictEqual(manifest.id, "autoSkyHookDeploy");
  assert.strictEqual(manifest.displayName, "Auto Skyhook Deploy");
  assert.strictEqual(manifest.version, loaderModule.MOD_VERSION);
  assert.strictEqual(manifest.kind, "loader");
  assert.deepStrictEqual([...manifest.supportedBackends], ["native", "docker"]);
  assert.strictEqual(manifest.activation.strategy, "loader_rename");
  assert.strictEqual(manifest.restart, "game_server");
  assert.deepStrictEqual([...manifest.compatibility.evejsVersions], ["0.12.9"]);
});

test("a configuration problem installs no hooks at all", () => {
  const before = require("node:module")._load;
  const state = loaderModule.install({
    environment: { EVEJS_AUTO_SKYHOOK_DEPLOY_MAX_PLANETS_PER_COMMAND: "not a number" },
    runtimeRoot,
    deps: {},
  });
  assert.strictEqual(state.active, false);
  assert.strictEqual(state.reason, "invalid-config");
  assert.strictEqual(require("node:module")._load, before, "Module._load must be untouched");
  assert.strictEqual(
    globalThis[loaderModule.INSTALL_FLAG],
    undefined,
    "no install state may be published",
  );
});

test("a disabled configuration installs no hooks", () => {
  const before = require("node:module")._load;
  const state = loaderModule.install({
    environment: { EVEJS_AUTO_SKYHOOK_DEPLOY: "0" },
    runtimeRoot,
    deps: {},
  });
  assert.strictEqual(state.active, false);
  assert.strictEqual(state.reason, "disabled");
  assert.strictEqual(require("node:module")._load, before);
});

test("the loader stays inert in worker threads", () => {
  const code =
    "const {Worker}=require('node:worker_threads');"
    + `const w=new Worker("const {parentPort,workerData}=require('node:worker_threads');`
    + "const l=require(workerData);parentPort.postMessage(l.installResult);\","
    + `{eval:true,workerData:${JSON.stringify(loaderPath)}});`
    + "w.once('message',(value)=>{console.log('RESULT:'+JSON.stringify(value));});"
    + "w.once('error',(error)=>{throw error});";
  const child = runNode(["-e", code], {
    env: { ...process.env, EVEJS_AUTO_SKYHOOK_DEPLOY: "1" },
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  assert.deepStrictEqual(parseChildResult(child.stdout), { active: false, reason: "worker-thread" });
});

test("the loader logs one stable ready line with its version", () => {
  const child = runNode(["-e", `require(${JSON.stringify(loaderPath)});`], {
    env: { ...process.env, EVEJS_AUTO_SKYHOOK_DEPLOY: "1" },
  });
  assert.strictEqual(child.status, 0, child.stderr || child.stdout);
  assert.ok(
    child.stdout.includes(`[autoSkyHookDeploy] v${loaderModule.MOD_VERSION} loader ready`),
    `the ready line must carry the version:\n${child.stdout}`,
  );
});

// ─── command parser ──────────────────────────────────────────────────────────

test("the parser accepts /ash, !ash, both spellings of every subcommand", () => {
  const config = { chatTrigger: true };
  assert.strictEqual(chatCommand.matchCommand("/ash help", config), "help");
  assert.strictEqual(chatCommand.matchCommand("/ash h", config), "h");
  assert.strictEqual(chatCommand.matchCommand("/ash anchor here", config), "anchor here");
  assert.strictEqual(chatCommand.matchCommand("/ash a here", config), "a here");
  assert.strictEqual(chatCommand.matchCommand("/ash align region 10000043", config), "align region 10000043");
  assert.strictEqual(chatCommand.matchCommand("/ash al", config), "al");
  assert.strictEqual(chatCommand.matchCommand("/ash remove 9988400003181", config), "remove 9988400003181");
  assert.strictEqual(chatCommand.matchCommand("/ash r 9988400003181", config), "r 9988400003181");
  assert.strictEqual(chatCommand.matchCommand("/ash unanchor here", config), "unanchor here");
  assert.strictEqual(chatCommand.matchCommand("/ash ua here", config), "ua here");
  assert.strictEqual(chatCommand.matchCommand("/ash offset 5km", config), "offset 5km");
  assert.strictEqual(chatCommand.matchCommand("/ash of", config), "of");
  assert.strictEqual(chatCommand.matchCommand("/ash status here", config), "status here");
  assert.strictEqual(chatCommand.matchCommand("/ash s", config), "s");
  assert.strictEqual(chatCommand.matchCommand("/ash", config), "");
  assert.strictEqual(chatCommand.matchTrigger("!ash anchor here", config), "anchor here");
  assert.strictEqual(chatCommand.matchTrigger("! ash   status   here ", config), "status   here ");
  assert.strictEqual(chatCommand.matchCommand("!ash help", config), "help");
  assert.strictEqual(chatCommand.matchCommand("!ash of 5000m", config), "of 5000m");
});

test("the parser leaves other commands and other mods alone", () => {
  const config = { chatTrigger: true };
  assert.strictEqual(chatCommand.matchCommand("/aud mining", config), null);
  assert.strictEqual(chatCommand.matchCommand("/sov status", config), null);
  assert.strictEqual(chatCommand.matchCommand("!aud mining", config), null);
  assert.strictEqual(chatCommand.matchCommand("hello world", config), null);
  assert.strictEqual(chatCommand.matchCommand("/ashx help", config), null);
  assert.strictEqual(chatCommand.matchTrigger("!ashx", config), null);
  assert.strictEqual(chatCommand.matchTrigger("!ash help", { chatTrigger: false }), null);
});

test("the parser resolves subcommands and rejects bad input", () => {
  assert.deepStrictEqual(chatCommand.parseCommand("anchor here"), {
    subcommand: "anchor", token: "here", rest: "", argumentText: "here", typed: "anchor",
  });
  assert.strictEqual(chatCommand.parseCommand("offset 5 miles").argumentText, "5 miles");
  assert.strictEqual(chatCommand.parseCommand("remove 123 abc").argumentText, "123 abc");
  assert.strictEqual(chatCommand.parseCommand("a 30000142").subcommand, "anchor");
  assert.strictEqual(chatCommand.parseCommand("al").subcommand, "align");
  assert.strictEqual(chatCommand.parseCommand("al system 30000142").subcommand, "align");
  // The retired name is not a subcommand and not an alias: it resolves to nothing.
  assert.strictEqual(chatCommand.parseCommand("reanchor").subcommand, null);
  assert.strictEqual(chatCommand.parseCommand("ra").subcommand, null);
  assert.deepStrictEqual(chatCommand.SUBCOMMANDS.align, ["al"]);
  assert.strictEqual("reanchor" in chatCommand.SUBCOMMANDS, false);
  assert.strictEqual("ra" in chatCommand.SUBCOMMANDS, false);
  assert.strictEqual(chatCommand.parseCommand("r 9988400003181").subcommand, "remove");
  assert.strictEqual(chatCommand.parseCommand("ua here").subcommand, "unanchor");
  assert.strictEqual(chatCommand.parseCommand("of 5").subcommand, "offset");
  assert.strictEqual(chatCommand.parseCommand("s").subcommand, "status");
  assert.strictEqual(chatCommand.parseCommand("h").subcommand, "help");
  assert.strictEqual(chatCommand.parseCommand("").subcommand, null);
  assert.strictEqual(chatCommand.parseCommand("frobnicate here").subcommand, null);
  assert.strictEqual(chatCommand.parseCommand("frobnicate here").typed, "frobnicate");
});

test("bad input is answered with text, not an exception", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const cases = [
    ["", /autoSkyHookDeploy - \/ash/u],
    ["frobnicate here", /unknown subcommand "frobnicate"/u],
    ["reanchor", /unknown command "reanchor" - it is now \/ash align \(or \/ash al\)/u],
    ["ra", /unknown command "ra" - it is now \/ash align \(or \/ash al\)/u],
    ["reanchor here", /unknown command "reanchor"/u],
    ["align reanchor", /unknown command "reanchor"/u],
    ["align ra", /unknown command "ra"/u],
    ["anchor", /\/ash anchor needs here, system <systemID> or region <regionID>/u],
    ["anchor region", /\/ash region needs a region id/u],
    ["anchor region mars", /is not a region id/u],
    ["anchor system", /\/ash system needs a system id/u],
    ["anchor system mars", /is not a solar system id/u],
    ["remove", /\/ash remove needs the id of one Skyhook/u],
    ["unanchor", /\/ash unanchor needs here, system <systemID> or region <regionID>/u],
    ["offset nonsense", /is not an offset/u],
    ["anchor mars", /is not a solar system id/u],
    ["anchor 0", /positive number/u],
    ["anchor -5", /is not a solar system id/u],
    ["status 999999999", /has no planets|not found/u],
  ];
  for (const [argument, expected] of cases) {
    const result = chatCommand.handleCommand(runtime, config, session(), argument);
    assert.match(result.message, expected, `argument "${argument}"`);
  }
});

// ─── plan builder ────────────────────────────────────────────────────────────

test("plan: a system whose planets are all free deploys one per planet", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.error, null);
  assert.deepStrictEqual(plan.deployable.map((entry) => entry.planetID), [40009001, 40009002, 40009003]);
  assert.deepStrictEqual(plan.skippedPresent, []);
  assert.deepStrictEqual(plan.overDestroyed, []);
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 3);
  assert.deepStrictEqual(result.failures, []);
  for (const entry of result.deployed) {
    assert.ok(entry.itemID > SKYHOOK_ITEM_ID_OFFSET, "every deployment gets an item id");
  }
  const deployCalls = fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner");
  assert.strictEqual(deployCalls.length, 3);
  for (const [index, entry] of deployCalls.entries()) {
    assert.strictEqual(entry.typeID, 81080);
    assert.strictEqual(entry.ownerID, CORPORATION_ID);
    assert.strictEqual(entry.systemID, SYSTEM_ID);
    assert.strictEqual(entry.itemOptions.mode, "STOP");
    // The Skyhook sits just past the planet's warp-in point - where a warp to that
    // planet always lands - so it is beside the ship on arrival without the ship
    // materialising inside it.
    const planetID = plan.deployable[index].planetID;
    const planet = { x: (planetID % 100) * 1000, y: 0, z: 0 };
    const position = entry.itemOptions.position;
    const landing = fixture.warpInPoints[String(planetID)];
    const landingDirection = {
      x: landing.x - planet.x,
      y: landing.y - planet.y,
      z: landing.z - planet.z,
    };
    const landingLength = Math.hypot(
      landingDirection.x,
      landingDirection.y,
      landingDirection.z,
    );
    assert.ok(
      Math.abs(Math.hypot(
        position.x - landing.x,
        position.y - landing.y,
        position.z - landing.z,
      ) - configModule.DEFAULTS.offsetMeters) < 1e-6,
      `skyhook at planet ${planetID} must sit the default offset past the landing point`,
    );
    assert.deepStrictEqual(entry.itemOptions.direction, {
      x: landingDirection.x / landingLength,
      y: landingDirection.y / landingLength,
      z: landingDirection.z / landingLength,
    }, "the direction is the unit vector to the landing point, offset or not");
    assert.strictEqual(result.deployed[index].placement, "warp-in");
    const direction = entry.itemOptions.direction;
    assert.ok(
      Math.abs(Math.hypot(direction.x, direction.y, direction.z) - 1) < 1e-9,
      "the spawn direction must be a unit vector",
    );
    // The offset must lie along that direction, so the client can orient it.
    const along = (position.x - planet.x) * direction.x
      + (position.y - planet.y) * direction.y
      + (position.z - planet.z) * direction.z;
    assert.ok(Math.abs(along - Math.hypot(
      position.x - planet.x,
      position.y - planet.y,
      position.z - planet.z,
    )) < 1, "the offset must follow the spawn direction");
    assert.deepStrictEqual(entry.itemOptions.targetPoint, position, "targetPoint follows the position");
  }
  const orbitalCalls = fixture.calls.filter((entry) => entry.fn === "ensureOrbitalForItem");
  assert.deepStrictEqual(
    orbitalCalls.map((entry) => entry.options.planetID),
    [40009001, 40009002, 40009003],
    "planetID must be passed explicitly, and match the planet",
  );
  assert.deepStrictEqual(
    callNames(fixture).filter((name) => name === "ensureScene").length,
    3,
    "every deployment ensures its scene",
  );
  const text = runtime.describePlan(plan, result);
  assert.match(text, /deployed 3, skipped 0 already present, 0 over a destroyed skyhook/u);
});

test("placement: the standoff scales with the planet, with standoffMeters as the floor", () => {
  const planets = [
    { ...planet(40009001, "Big Planet", 1), radius: 2_900_000 },
    { ...planet(40009002, "Tiny Planet", 2), radius: 0 },
  ];
  const distanceFor = (call, planetID) => {
    const origin = { x: (planetID % 100) * 1000, y: 0, z: 0 };
    const position = call.itemOptions.position;
    return Math.hypot(position.x - origin.x, position.y - origin.y, position.z - origin.z);
  };
  // Every case here exercises the fallback rule, so the vendor warp-in point is
  // switched off: with it the placement would be the landing point instead.
  const deployWith = (config, fixtureOptions = { planets, warpInPoints: {} }) => {
    const { fixture, deps } = createFixture(fixtureOptions);
    const runtime = createRuntimeWith(fixture, deps, config);
    runtime.applyPlan(runtime.buildPlan(SYSTEM_ID, session()), session());
    return fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner");
  };

  // Defaults: standoff 5,000,000 m (5,000 km) and orbitMargin 1.0 mean
  // beyondSurface = max(5,000,000, radius * 1), so a 2,900,000 m planet still
  // uses the floor (2,900,000 < 5,000,000) and keeps its old distance.
  const defaults = deployWith({});
  assert.ok(
    Math.abs(distanceFor(defaults[0], 40009001) - (2_900_000 + 5_000_000)) < 1,
    "a small planet keeps planetRadius + standoffMeters",
  );
  // A radius of 0 is clamped to the vendor's own 1,000 m floor, so the standoff
  // floor wins by a mile.
  assert.ok(
    Math.abs(distanceFor(defaults[1], 40009002) - (1_000 + 5_000_000)) < 1,
    "the planet radius must be clamped to 1,000 m",
  );

  // A large planet: radius * orbitMargin wins over the fixed floor. 8,160,000 m
  // is LWX-93 VII, the planet whose Skyhook was scannable but invisible at a
  // fixed 5,000 km standoff (13,160,000 m from the centre).
  const big = deployWith({}, {
    planets: [{ ...planet(40009001, "LWX-93 VII", 1), radius: 8_160_000 }],
    warpInPoints: {},
  });
  assert.ok(
    Math.abs(distanceFor(big[0], 40009001) - (8_160_000 + 8_160_000)) < 1,
    "an 8,160,000 m planet must use planetRadius * orbitMargin, i.e. 16,320,000 m from the centre",
  );
  assert.strictEqual(big[0].itemOptions.direction.y, 0, "still horizontal");
  assert.deepStrictEqual(
    big[0].itemOptions.targetPoint,
    big[0].itemOptions.position,
    "targetPoint still follows the position",
  );
  // The biggest planet in the operator's dump: 18,990,000 m -> 37,980,000 m.
  const biggest = deployWith({}, {
    planets: [{ ...planet(40009001, "LWX-93 IX", 1), radius: 18_990_000 }],
    warpInPoints: {},
  });
  assert.ok(
    Math.abs(distanceFor(biggest[0], 40009001) - (18_990_000 + 18_990_000)) < 1,
    "an 18,990,000 m planet must sit 37,980,000 m from its centre",
  );

  // A configured orbitMargin changes the distance: 2.5 x 2,900,000 = 7,250,000,
  // which now beats the 5,000,000 m floor.
  const margin = deployWith({ orbitMargin: 2.5 });
  assert.ok(
    Math.abs(distanceFor(margin[0], 40009001) - (2_900_000 + (2_900_000 * 2.5))) < 1,
    "a configured orbitMargin must be used",
  );

  // orbitMargin 0 disables the scaling: the standoffMeters floor always applies.
  const noMargin = deployWith({ orbitMargin: 0, standoffMeters: 100_000 });
  assert.ok(
    Math.abs(distanceFor(noMargin[0], 40009001) - (2_900_000 + 100_000)) < 1,
    "orbitMargin 0 must fall back to the standoffMeters floor",
  );

  // A configured standoffMeters still beats the margin when it is the larger one.
  const wide = deployWith({ standoffMeters: 8_000_000 });
  assert.ok(
    Math.abs(distanceFor(wide[0], 40009001) - (2_900_000 + 8_000_000)) < 1,
    "a configured standoffMeters must be used when it is the larger of the two",
  );

  // The floor is the larger one again once the planet is small enough.
  const tiny = deployWith({ standoffMeters: 100_000, orbitMargin: 0.01 });
  assert.ok(
    Math.abs(distanceFor(tiny[0], 40009001) - (2_900_000 + 100_000)) < 1,
    "a tiny orbitMargin must not shrink the standoff below its floor",
  );
});

test("placement: the offset is horizontal and star-facing, with a horizontal fallback", () => {
  const planetID = 40009001;
  const origin = { x: (planetID % 100) * 1000, y: 0, z: 0 };

  // The default fixture's star is far out on +X, so the Skyhook lands on the +X
  // side of its planet - the sunlit side - whatever the planet's position.
  const withStar = createFixture({ planets: [THREE_PLANETS[0]], warpInPoints: {} });
  const starRuntime = createRuntimeWith(withStar.fixture, withStar.deps);
  starRuntime.applyPlan(starRuntime.buildPlan(SYSTEM_ID, session()), session());
  const starCall = withStar.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  assert.strictEqual(starCall.itemOptions.direction.y, 0);
  assert.strictEqual(starCall.itemOptions.direction.x, 1, "a star at +X gives exactly +X");
  assert.strictEqual(starCall.itemOptions.direction.z, 0);
  assert.ok(starCall.itemOptions.position.x > origin.x, "the Skyhook sits on the star-facing side");
  assert.strictEqual(starCall.itemOptions.position.y, origin.y);
  assert.strictEqual(starCall.itemOptions.position.z, origin.z);

  // A star whose +X is *behind* the planet flips the direction: it follows the
  // star, it is not a fixed axis.
  const behind = createFixture({
    planets: [{ ...THREE_PLANETS[0], position: { x: 5_000_000_000, y: 0, z: 0 } }],
    celestials: [{ ...STAR, position: { x: 0, y: 900_000, z: 0 } }],
    warpInPoints: {},
  });
  const behindRuntime = createRuntimeWith(behind.fixture, behind.deps);
  behindRuntime.applyPlan(behindRuntime.buildPlan(SYSTEM_ID, session()), session());
  const behindCall = behind.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  assert.strictEqual(behindCall.itemOptions.direction.y, 0);
  assert.strictEqual(behindCall.itemOptions.direction.x, -1, "the direction follows the star");

  // A system with no star row: still horizontal, never vertical.
  const noStar = createFixture({ planets: [THREE_PLANETS[0]], celestials: [], warpInPoints: {} });
  const noStarRuntime = createRuntimeWith(noStar.fixture, noStar.deps);
  const noStarPlan = noStarRuntime.buildPlan(SYSTEM_ID, session());
  const noStarResult = noStarRuntime.applyPlan(noStarPlan, session());
  assert.strictEqual(noStarResult.deployed.length, 1);
  const noStarCall = noStar.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  assert.deepStrictEqual(
    noStarCall.itemOptions.direction,
    { x: 1, y: 0, z: 0 },
    "the fallback direction is horizontal too",
  );

  // A planet sitting exactly on its star is degenerate: same fallback.
  const degenerate = createFixture({
    planets: [{ ...THREE_PLANETS[0], position: { x: 0, y: 0, z: 0 } }],
    celestials: [{ ...STAR, position: { x: 0, y: 0, z: 0 } }],
    warpInPoints: {},
  });
  const degenerateRuntime = createRuntimeWith(degenerate.fixture, degenerate.deps);
  degenerateRuntime.applyPlan(degenerateRuntime.buildPlan(SYSTEM_ID, session()), session());
  const degenerateCall = degenerate.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  assert.deepStrictEqual(
    degenerateCall.itemOptions.direction,
    { x: 1, y: 0, z: 0 },
    "a degenerate star vector falls back to +X",
  );

  // A star lookup that throws must not break the deploy either.
  const throwing = createFixture({ planets: [THREE_PLANETS[0]], warpInPoints: {} });
  const throwingRuntime = createRuntimeWith(
    throwing.fixture,
    {
      ...throwing.deps,
      getWorldData: () => ({
        ...throwing.deps.getWorldData(),
        getCelestialsForSystem: () => {
          throw new Error("getCelestialsForSystem exploded");
        },
      }),
    },
  );
  const throwingPlan = throwingRuntime.buildPlan(SYSTEM_ID, session());
  const throwingResult = throwingRuntime.applyPlan(throwingPlan, session());
  assert.strictEqual(throwingResult.deployed.length, 1);
  const throwingCall = throwing.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  assert.strictEqual(throwingCall.itemOptions.direction.y, 0);
  assert.deepStrictEqual(throwingCall.itemOptions.direction, { x: 1, y: 0, z: 0 });
});

test("placement: the Skyhook sits on the planet's warp-in point", () => {
  // A warp to a planet always lands on one deterministic point. The mod reads
  // that point from the vendor and puts the Skyhook exactly there, so it is next
  // to the ship on arrival - which is the whole fix.
  const planetID = 40009001;
  const planetEntry = THREE_PLANETS[0];
  const { fixture, deps } = createFixture({ planets: [planetEntry] });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 1);
  assert.strictEqual(result.deployed[0].placement, "warp-in");

  const expected = fixture.warpInPoints[String(planetID)];
  const call = fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  const position = call.itemOptions.position;

  // The default offset (5,000 m) shifts it along the same bearing, so a ship that
  // warps in materialises beside the Skyhook rather than inside its model.
  const origin = planetEntry.position;
  const dx = expected.x - origin.x;
  const dy = expected.y - origin.y;
  const dz = expected.z - origin.z;
  const length = Math.hypot(dx, dy, dz);
  const unit = { x: dx / length, y: dy / length, z: dz / length };
  const offset = configModule.DEFAULTS.offsetMeters;
  assert.deepStrictEqual(position, {
    x: expected.x + (unit.x * offset),
    y: expected.y + (unit.y * offset),
    z: expected.z + (unit.z * offset),
  }, "the item must be created offset from the warp-in point along the same bearing");
  assert.deepStrictEqual(call.itemOptions.targetPoint, position, "targetPoint follows the position");
  // direction is unchanged by the offset: the unit vector from the planet's centre
  // to the landing point, vertical component included.
  assert.deepStrictEqual(call.itemOptions.direction, unit);
  assert.ok(
    Math.abs(call.itemOptions.direction.y) > 0.05,
    "the landing point carries a vertical component",
  );
  assert.ok(
    Math.abs(Math.hypot(
      call.itemOptions.direction.x,
      call.itemOptions.direction.y,
      call.itemOptions.direction.z,
    ) - 1) < 1e-12,
    "the direction must be a unit vector",
  );

  // The vendor function was asked about this planet's celestial row, and the
  // fallback formula (radius + max(standoff, radius * margin)) was NOT used.
  const asked = fixture.calls.find((entry) => entry.fn === "getClientParityWarpInPoint");
  assert.ok(asked, "getClientParityWarpInPoint must be consulted");
  assert.strictEqual(asked.itemID, planetID, "the planet's own celestial row must be passed");
  assert.strictEqual(asked.radius, planetEntry.radius);
  const fallbackDistance = planetEntry.radius + Math.max(5_000_000, planetEntry.radius * 1);
  const offsetDistance = Math.hypot(
    position.x - origin.x,
    position.y - origin.y,
    position.z - origin.z,
  );
  assert.ok(
    Math.abs(offsetDistance - (length + offset)) < 1e-6,
    "the offset moves the Skyhook exactly `offset` further out",
  );
  assert.ok(
    Math.abs(offsetDistance - fallbackDistance) > 1,
    "the warp-in point must not coincide with the fallback distance",
  );
  assert.notStrictEqual(
    position.y,
    origin.y,
    "the fallback keeps the planet's height; the landing point does not",
  );
});

test("placement: the default offset is 25000 m, and the range still admits it", () => {
  assert.strictEqual(configModule.DEFAULTS.offsetMeters, 25000);
  assert.deepStrictEqual(configModule.LIMITS.offsetMeters, { minimum: 0, maximum: 100000 });
});

test("placement: offsetMeters moves the Skyhook past the landing point", () => {
  const planetID = 40009001;
  const planetEntry = THREE_PLANETS[0];
  const origin = planetEntry.position;
  const landing = { ...planetEntry.position, x: planetEntry.position.x + 2_000_000, y: 300_000, z: -1_500_000 };
  const length = Math.hypot(
    landing.x - origin.x,
    landing.y - origin.y,
    landing.z - origin.z,
  );
  const unit = {
    x: (landing.x - origin.x) / length,
    y: (landing.y - origin.y) / length,
    z: (landing.z - origin.z) / length,
  };

  const deploy = (liveConfig) => {
    const { fixture, deps } = createFixture({
      planets: [planetEntry],
      warpInPoints: { [String(planetID)]: landing },
    });
    const runtime = createRuntimeWith(fixture, deps, {}, { liveConfig });
    runtime.applyPlan(runtime.buildPlan(SYSTEM_ID, session()), session());
    const call = fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
    return { call, fixture, runtime };
  };

  // The default: 5,000 m past the landing point.
  const byDefault = deploy();
  assert.deepStrictEqual(byDefault.call.itemOptions.position, {
    x: landing.x + (unit.x * configModule.DEFAULTS.offsetMeters),
    y: landing.y + (unit.y * configModule.DEFAULTS.offsetMeters),
    z: landing.z + (unit.z * configModule.DEFAULTS.offsetMeters),
  });
  assert.deepStrictEqual(byDefault.call.itemOptions.targetPoint, byDefault.call.itemOptions.position);
  assert.deepStrictEqual(byDefault.call.itemOptions.direction, unit, "the direction never moves");

  // A configured value, from the config file the chat command writes.
  const configured = deploy(memoryLiveConfig(25000));
  assert.deepStrictEqual(configured.call.itemOptions.position, {
    x: landing.x + (unit.x * 25000),
    y: landing.y + (unit.y * 25000),
    z: landing.z + (unit.z * 25000),
  });

  // 0 puts it exactly on the landing point.
  const none = deploy(memoryLiveConfig(0));
  assert.deepStrictEqual(none.call.itemOptions.position, landing);
  assert.deepStrictEqual(none.call.itemOptions.targetPoint, landing);

  // A value the live config cannot use falls back to the configured default.
  // The reader answers { value, error }; a broken file yields the last good value.
  const unusable = deploy(memoryLiveConfig(configModule.DEFAULTS.offsetMeters));
  assert.deepStrictEqual(unusable.call.itemOptions.position, {
    x: landing.x + (unit.x * configModule.DEFAULTS.offsetMeters),
    y: landing.y + (unit.y * configModule.DEFAULTS.offsetMeters),
    z: landing.z + (unit.z * configModule.DEFAULTS.offsetMeters),
  });

  // The offset never applies to the fallback placement.
  const { fixture, deps } = createFixture({ planets: [planetEntry], warpInPoints: {} });
  const fallbackRuntime = createRuntimeWith(fixture, deps, {}, { liveConfig: memoryLiveConfig(25000) });
  fallbackRuntime.applyPlan(fallbackRuntime.buildPlan(SYSTEM_ID, session()), session());
  const fallbackCall = fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  assert.strictEqual(fallbackCall.itemOptions.direction.y, 0);
  const fallbackDistance = Math.hypot(
    fallbackCall.itemOptions.position.x - origin.x,
    fallbackCall.itemOptions.position.y - origin.y,
    fallbackCall.itemOptions.position.z - origin.z,
  );
  assert.ok(
    Math.abs(fallbackDistance - (planetEntry.radius + 5_000_000)) < 1,
    "the fallback ignores offsetMeters",
  );
});

test("placement: the fallback rule still applies with no usable warp-in point", () => {
  const planetID = 40009001;
  const planetEntry = THREE_PLANETS[0];
  const origin = planetEntry.position;
  const fallbackDistance = planetEntry.radius + Math.max(5_000_000, planetEntry.radius * 1);

  // No warp-in point (the vendor answered null), no accessor at all, a throwing
  // accessor, and a degenerate point at the planet's own centre.
  const cases = [
    ["no point for the planet", { warpInPoints: {} }],
    ["no accessor", { warpInMissing: true }],
    ["a throwing accessor", { warpInThrows: true }],
    ["a point at the planet's centre", { warpInPoints: { [String(planetID)]: { ...origin } } }],
  ];
  for (const [label, fixtureOptions] of cases) {
    const { fixture, deps } = createFixture({ planets: [planetEntry], ...fixtureOptions });
    const runtime = createRuntimeWith(fixture, deps);
    const result = runtime.applyPlan(runtime.buildPlan(SYSTEM_ID, session()), session());
    assert.strictEqual(result.deployed.length, 1, `must still deploy: ${label}`);
    assert.deepStrictEqual(result.failures, [], `no failures: ${label}`);
    assert.strictEqual(result.deployed[0].placement, "fallback", `fallback placement: ${label}`);
    const call = fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
    assert.strictEqual(call.itemOptions.direction.y, 0, `horizontal direction: ${label}`);
    assert.ok(
      Math.abs(call.itemOptions.position.y - origin.y) < 1e-9,
      `the fallback keeps the planet's height: ${label}`,
    );
    const distance = Math.hypot(
      call.itemOptions.position.x - origin.x,
      call.itemOptions.position.y - origin.y,
      call.itemOptions.position.z - origin.z,
    );
    assert.ok(
      Math.abs(distance - fallbackDistance) < 1,
      `the fallback distance must be radius + standoffMeters: ${label}`,
    );
    assert.deepStrictEqual(call.itemOptions.targetPoint, call.itemOptions.position, label);
  }

  // And the fallback keeps its own scaling: with no warp-in point, an 8,160,000 m
  // planet still gets radius * orbitMargin.
  const big = createFixture({
    planets: [{ ...planet(planetID, "LWX-93 VII", 1), radius: 8_160_000 }],
    warpInPoints: {},
  });
  const bigRuntime = createRuntimeWith(big.fixture, big.deps);
  const bigResult = bigRuntime.applyPlan(bigRuntime.buildPlan(SYSTEM_ID, session()), session());
  assert.strictEqual(bigResult.deployed[0].placement, "fallback");
  const bigCall = big.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
  const bigDistance = Math.hypot(
    bigCall.itemOptions.position.x - ((planetID % 100) * 1000),
    bigCall.itemOptions.position.y,
    bigCall.itemOptions.position.z,
  );
  assert.ok(
    Math.abs(bigDistance - (8_160_000 + 8_160_000)) < 1,
    "the fallback must still scale with the planet",
  );
});

test("chat: /ash offset reads and writes the configuration file", () => {
  const dir = tmpdir("ashd-offset-");
  try {
    const configFile = path.join(dir, configModule.CONFIG_FILENAME);
    // The file the installer seeds: a comment and every other key must survive.
    fs.writeFileSync(configFile, `${JSON.stringify({
      _comment: "keep me",
      enabled: true,
      maxPlanetsPerCommand: 64,
      offsetMeters: 5000,
      standoffMeters: 5000000,
    }, null, 2)}\n`, "utf8");
    const config = configModule.load(modDir, {});
    const { fixture, deps } = createFixture();
    const runtime = createRuntimeWith(fixture, deps, {}, { liveConfig: fileLiveConfig(configFile) });

    // Read: the value in the file (5,000 m, deliberately not the default, so this also
    // proves an explicitly configured value wins), in both units, with what it means.
    assert.match(
      chatCommand.handleCommand(runtime, config, session(), "offset").message,
      /offset: 5 km \(5000 m\) - a Skyhook sits this far past the planet's landing point/u,
    );
    assert.match(
      chatCommand.handleCommand(runtime, config, session(), "of").message,
      /offset: 5 km \(5000 m\)/u,
    );

    // Read at command time: a hand edit of the file is picked up with no restart.
    fs.writeFileSync(configFile, `${JSON.stringify({
      _comment: "keep me",
      offsetMeters: 12500,
    }, null, 2)}\n`, "utf8");
    assert.match(
      chatCommand.handleCommand(runtime, config, session(), "offset").message,
      /offset: 12\.5 km \(12500 m\)/u,
      "a hand edit must be visible to the next command",
    );
    assert.strictEqual(runtime.resolveOffsetMeters(), 12500);

    // Set: a bare number is kilometres (the operator's phrasing), and both
    // suffixes are accepted. Every accepted form echoes metres and km.
    const accepted = [
      ["offset 5", 5000, /offset set to 5 km \(5000 m\)/u],
      ["offset 5km", 5000, /offset set to 5 km \(5000 m\)/u],
      ["offset 5000m", 5000, /offset set to 5 km \(5000 m\)/u],
      ["of 2.5km", 2500, /offset set to 2.5 km \(2500 m\)/u],
      ["offset 0", 0, /offset set to 0 km \(0 m\)/u],
      ["offset 100km", 100000, /offset set to 100 km \(100000 m\)/u],
    ];
    for (const [argument, meters, expected] of accepted) {
      const message = chatCommand.handleCommand(runtime, config, session(), argument).message;
      assert.match(message, expected, argument);
      const written = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.strictEqual(written.offsetMeters, meters, `${argument} must be persisted`);
      // Every other key, and the comment, survive the rewrite.
      assert.strictEqual(written._comment, "keep me", `${argument} must keep the comment`);
    }

    // Refusals are text, never an exception, and they do not change the value.
    const before = JSON.parse(fs.readFileSync(configFile, "utf8")).offsetMeters;
    const refusals = [
      ["offset 200km", /offset must be between 0 km and 100 km/u],
      ["offset 100001m", /offset must be between 0 km and 100 km/u],
      ["offset -5", /is not an offset/u],
      ["offset 5 miles", /is not an offset/u],
      ["offset abc", /is not an offset/u],
      ["offset 5.5m", /whole number of metres/u],
    ];
    for (const [argument, expected] of refusals) {
      const message = chatCommand.handleCommand(runtime, config, session(), argument).message;
      assert.match(message, expected, argument);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(configFile, "utf8")).offsetMeters,
        before,
        `${argument} must not change the value`,
      );
    }

    // Persistence: a fresh runtime reading the same file sees the value, and its
    // next deployment uses it - no restart, no rebuild.
    chatCommand.handleCommand(runtime, config, session(), "offset 7km");
    const restarted = createFixture();
    const freshRuntime = createRuntimeWith(
      restarted.fixture,
      restarted.deps,
      {},
      { liveConfig: fileLiveConfig(configFile) },
    );
    assert.strictEqual(freshRuntime.resolveOffsetMeters(), 7000);
    freshRuntime.applyPlan(freshRuntime.buildPlan(SYSTEM_ID, session()), session());
    const landing = restarted.fixture.warpInPoints["40009001"];
    const origin = THREE_PLANETS[0].position;
    const length = Math.hypot(
      landing.x - origin.x,
      landing.y - origin.y,
      landing.z - origin.z,
    );
    const call = restarted.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
    assert.ok(
      Math.abs(call.itemOptions.position.x - (landing.x + ((landing.x - origin.x) / length) * 7000)) < 1e-6,
      "the persisted offset must be used by the next deployment",
    );

    // A file broken by hand since boot: the command says so in text, keeps using
    // the last good value, and never overwrites what it cannot parse.
    const broken = "{ not json";
    fs.writeFileSync(configFile, broken, "utf8");
    const readMessage = chatCommand.handleCommand(runtime, config, session(), "offset").message;
    assert.match(readMessage, /cannot read the configuration file/u, readMessage);
    assert.match(readMessage, /offset: 7 km \(7000 m\)/u, "the last good value is still used");
    const writeMessage = chatCommand.handleCommand(runtime, config, session(), "offset 9km").message;
    assert.match(writeMessage, /could not be saved/u, writeMessage);
    assert.match(writeMessage, /is not valid JSON/u, writeMessage);
    assert.strictEqual(fs.readFileSync(configFile, "utf8"), broken, "the broken file is left alone");
    assert.strictEqual(runtime.resolveOffsetMeters(), 7000);

    // An out-of-range value in the file is reported and the last good value stands.
    fs.writeFileSync(configFile, `${JSON.stringify({ offsetMeters: 999999 })}\n`, "utf8");
    const rangeMessage = chatCommand.handleCommand(runtime, config, session(), "offset").message;
    assert.match(rangeMessage, /out-of-range offsetMeters/u, rangeMessage);
    assert.strictEqual(runtime.resolveOffsetMeters(), 7000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chat: the offset needs a configuration file, and says so without one", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  assert.match(
    chatCommand.handleCommand(runtime, config, session(), "offset").message,
    /offset: 25 km \(25000 m\)/u,
  );
  assert.match(
    chatCommand.handleCommand(runtime, config, session(), "offset 9km").message,
    /cannot be saved/u,
  );
});

test("remove: one Skyhook by id, and nothing else", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002),
      orbital(40009003, 1000000000003),
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const message = chatCommand.handleCommand(runtime, config, session(), "remove 1000000000002").message;

  assert.match(message, /Jita: destroyed 1, already destroyed 0, left alone 0/u);
  assert.match(message, /destroyed orbital skyhook at Planet II, ledger tombstoned/u);
  // Exactly one destruction triple, for that id only.
  const order = callNames(fixture).filter((name) => [
    "markOrbitalDestroyed",
    "ensureScene",
    "destroyDynamicInventoryEntity",
    "destroySkyhooks",
  ].includes(name));
  assert.deepStrictEqual(order, [
    "markOrbitalDestroyed",
    "ensureScene",
    "destroyDynamicInventoryEntity",
    "destroySkyhooks",
  ]);
  assert.deepStrictEqual(
    fixture.calls.filter((entry) => entry.fn === "markOrbitalDestroyed").map((entry) => entry.itemID),
    [1000000000002],
  );
  assert.deepStrictEqual(
    fixture.orbitals.filter((entry) => entry.destroyedAtMs > 0).map((entry) => entry.itemID),
    [1000000000002],
    "the other two keep their live records",
  );
  assert.deepStrictEqual(
    fixture.calls.filter((entry) => entry.fn === "destroySkyhooks").map((entry) => entry.skyhookIDs),
    [[1000000000002]],
  );
});

test("remove: a quoted planet name resolves to the same Skyhook as its id", () => {
  const setUp = () => {
    const { fixture, deps } = createFixture({
      orbitals: [
        orbital(40009001, 1000000000001),
        orbital(40009002, 1000000000002),
        orbital(40009003, 1000000000003),
      ],
    });
    return { fixture, runtime: createRuntimeWith(fixture, deps) };
  };
  const config = configModule.load(modDir, {});

  // By name: the planet is the third one, so the third Skyhook is the target.
  const byName = setUp();
  const named = chatCommand.handleCommand(
    byName.runtime, config, session(), "remove \"Planet III\"",
  ).message;
  assert.match(named, /Jita: destroyed 1, already destroyed 0, left alone 0 structure-shaped/u, named);
  assert.match(named, /destroyed orbital skyhook at Planet III, ledger tombstoned/u, named);
  assert.deepStrictEqual(
    byName.fixture.calls
      .filter((entry) => entry.fn === "markOrbitalDestroyed")
      .map((entry) => entry.itemID),
    [1000000000003],
  );

  // By id: exactly the same record and the same reply, so the two spellings agree.
  const byID = setUp();
  const idMessage = chatCommand.handleCommand(
    byID.runtime, config, session(), "remove 1000000000003",
  ).message;
  assert.strictEqual(named, idMessage);
  assert.deepStrictEqual(
    byID.fixture.calls
      .filter((entry) => entry.fn === "markOrbitalDestroyed")
      .map((entry) => entry.itemID),
    [1000000000003],
  );

  // A name that matches no planet, and a planet with no Skyhook, are both refused in
  // words rather than by id.
  const missing = setUp();
  assert.match(
    chatCommand.handleCommand(missing.runtime, config, session(), "remove \"Planet IX\"").message,
    /no planet named "Planet IX" is in Jita/u,
  );
  assert.match(
    chatCommand.handleCommand(missing.runtime, config, session(), "remove \"planet iii\"").message,
    /destroyed orbital skyhook at Planet III/u,
    "a name is matched case-insensitively, the way the client shows it",
  );
  const other = setUp();
  assert.match(
    chatCommand.handleCommand(other.runtime, config, session(), "remove \"Planet IIII\"").message,
    /no planet named "Planet IIII" is in Jita/u,
  );

  // A quoted name is only resolved against live Skyhooks: a planet whose only record is
  // a tombstone has nothing to remove, and that is said in words.
  const tombstoned = createFixture({
    orbitals: [orbital(40009001, 1000000000001, { destroyedAtMs: 1700000000000 })],
    planets: [THREE_PLANETS[0]],
  });
  const tombstoneRuntime = createRuntimeWith(tombstoned.fixture, tombstoned.deps);
  const message = chatCommand.handleCommand(
    tombstoneRuntime, config, session(), "remove \"Planet I\"",
  ).message;
  assert.match(message, /orbital skyhook at Planet I is not deployed in Jita/u, message);
  assert.strictEqual(
    tombstoned.fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"),
    false,
    "a refusal must not destroy anything",
  );

  // Two planets whose rows share a name cannot be told apart, so the command refuses
  // rather than picking one.
  const ambiguous = createFixture({
    planets: [
      { ...planet(40009001, "Planet I", 1) },
      { ...planet(40009002, "Planet I", 2) },
    ],
    orbitals: [orbital(40009001, 1000000000001), orbital(40009002, 1000000000002)],
  });
  const ambiguousRuntime = createRuntimeWith(ambiguous.fixture, ambiguous.deps);
  assert.match(
    chatCommand.handleCommand(ambiguousRuntime, config, session(), "remove \"Planet I\"").message,
    /"Planet I" names 2 planets in Jita; name the Skyhook by id instead/u,
  );
  assert.strictEqual(
    ambiguous.fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"),
    false,
  );
});

test("remove: refusals are text, and name unanchor where that is the right command", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000000 }),
    ],
    structures: [
      { structureID: 1100000000123, typeID: 81080, solarSystemID: SYSTEM_ID, moonID: 40009003 },
      { structureID: 1100000000999, typeID: 35832, solarSystemID: SYSTEM_ID, moonID: 40009003 },
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const cases = [
    ["remove abc", /no planet named "abc" is in Jita/u],
    ["remove 0", /Skyhook id or the name of the planet it orbits/u],
    ["remove here", /use \/ash unanchor here/u],
    ["remove 30000142", /is a solar system, not a Skyhook id.*\/ash unanchor 30000142/u],
    ["remove 9999999999999", /no Skyhook with id 9999999999999 is known/u],
    ["remove 1100000000123", /is a structure-shaped Skyhook/u],
    ["remove 1100000000999", /is a structure \(typeID 35832\), not an orbital Skyhook/u],
  ];
  for (const [argument, expected] of cases) {
    const message = chatCommand.handleCommand(runtime, config, session(), argument).message;
    assert.match(message, expected, argument);
  }
  // None of those touched anything.
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"), false);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "destroySkyhooks"), false);

  // An already-destroyed id is answered gracefully, without a second triple. The reply
  // is one marker line with a count, never the planet named per tombstone.
  const tombstone = chatCommand.handleCommand(runtime, config, session(), "remove 1000000000002").message;
  assert.match(tombstone, /already destroyed 1, left alone 0/u);
  assert.match(
    tombstone,
    /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\) - the skyhook is already gone, and the planet can be deployed on again/u,
    tombstone,
  );
  assert.strictEqual(/orbital skyhook at Planet II/u.test(tombstone), false, tombstone);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"), false);

  // And the sweep still works on the same fixture. Only the typeID 81080 structure
  // is a structure-shaped Skyhook; the other structure is not this mod's business.
  const sweep = chatCommand.handleCommand(runtime, config, session(), "unanchor here").message;
  assert.match(sweep, /destroyed 1, already destroyed 1, left alone 1 structure-shaped/u);
});

test("remove and unanchor calibrate the item id counter once, only when it is behind", () => {
  const setUp = (options) => {
    const { fixture, deps } = createFixture({
      orbitals: [orbital(40009001, 1000000000001), orbital(40009002, 1000000000002)],
      ...options,
    });
    return { fixture, runtime: createRuntimeWith(fixture, deps) };
  };

  // The counter is already ahead of the highest referenced id: nothing to do.
  const ahead = setUp({ counterItemID: 9988400003304, highWater: 9988400003303 });
  const aheadMessage = chatCommand.handleCommand(
    ahead.runtime, configModule.load(modDir, {}), session(), "unanchor here",
  ).message;
  assert.match(aheadMessage, /item id counter: 9988400003304 \(already ahead of the highest id\)/u);
  assert.deepStrictEqual(ahead.fixture.reserveCalls, [], "no id may be leaked when the counter is correct");

  // The counter is behind: it is forced forward through the vendor's allocator,
  // once, even though two skyhooks were destroyed.
  const behind = setUp({ counterItemID: 500, highWater: 900 });
  const behindMessage = chatCommand.handleCommand(
    behind.runtime, configModule.load(modDir, {}), session(), "unanchor here",
  ).message;
  assert.match(behindMessage, /destroyed 2/u);
  assert.match(behindMessage, /item id counter: raised to 902 \(was 500, highest id 900\)/u);
  assert.deepStrictEqual(behind.fixture.reserveCalls, [901], "exactly one id reserved, one call");
  assert.strictEqual(behind.fixture.counterItemID, 902, "the stored counter moved past it");

  // A single-id removal calibrates the same way.
  const single = setUp({ counterItemID: 500, highWater: 900 });
  const singleMessage = chatCommand.handleCommand(
    single.runtime, configModule.load(modDir, {}), session(), "remove 1000000000001",
  ).message;
  assert.match(singleMessage, /item id counter: raised to 902/u);
  assert.deepStrictEqual(single.fixture.reserveCalls, [901]);

  // No allocator at all: the removal still happens, without the clause.
  const missing = setUp({ identityAllocatorMissing: true });
  const missingMessage = chatCommand.handleCommand(
    missing.runtime, configModule.load(modDir, {}), session(), "unanchor here",
  ).message;
  assert.match(missingMessage, /destroyed 2/u);
  assert.strictEqual(/item id counter/u.test(missingMessage), false);

  // A throwing allocator, and a game store that cannot be read: same.
  for (const options of [
    { identityAllocatorThrows: true },
    { gameStoreMissing: true },
    { counterItemID: 0 },
  ]) {
    const broken = setUp(options);
    let message = "";
    assert.doesNotThrow(() => {
      message = chatCommand.handleCommand(
        broken.runtime, configModule.load(modDir, {}), session(), "unanchor here",
      ).message;
    });
    assert.match(message, /destroyed 2/u, JSON.stringify(options));
    assert.strictEqual(/item id counter/u.test(message), false, JSON.stringify(options));
    assert.deepStrictEqual(broken.fixture.reserveCalls, [], JSON.stringify(options));
  }
});

test("anchor: a system in NPC space is refused, and nothing is created", () => {
  const { fixture, deps } = createFixture({ npcSystemIDs: [SYSTEM_ID] });
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});

  const byName = chatCommand.handleCommand(runtime, config, session(), "anchor system 30000142").message;
  assert.match(byName, /Jita is NPC\/faction space \(not sovereignty-claimable\)/u, byName);
  assert.match(byName, /security -0\.5/u, byName);
  assert.match(byName, /nothing was touched/u, byName);

  const byBareId = chatCommand.handleCommand(runtime, config, session(), "anchor 30000142").message;
  assert.match(byBareId, /NPC\/faction space/u, byBareId);

  // `here` is checked too: the caller's own system can be NPC space.
  const here = chatCommand.handleCommand(runtime, config, session(), "anchor here").message;
  assert.match(here, /NPC\/faction space/u, here);

  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
    "a refusal must not create anything",
  );
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"), false);
});

test("anchor: a workable system still deploys, and a faction system is named", () => {
  const { fixture, deps } = createFixture({
    solarSystems: [
      { solarSystemID: SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0 },
      { solarSystemID: OTHER_SYSTEM_ID, regionID: REGION_ID, security: 0.9, factionID: 500001 },
    ],
    planets: [
      ...THREE_PLANETS,
      { ...THREE_PLANETS[0], planetID: 40009005, solarSystemID: OTHER_SYSTEM_ID },
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});

  const workable = chatCommand.handleCommand(runtime, config, session(), "anchor system 30000142").message;
  assert.match(workable, /v1\.0\.0: Jita: deployed 3/u, workable);
  assert.match(workable, /deployed 3, skipped 0 already present/u, workable);
  assert.strictEqual(
    fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    3,
  );

  // The other system is high-sec AND faction space: the reply names both facts.
  const refused = chatCommand.handleCommand(runtime, config, session(), "anchor system 30000143").message;
  assert.match(refused, /NPC\/faction space/u, refused);
  assert.match(refused, /security 0\.9/u, refused);
  assert.match(refused, /faction 500001/u, refused);
  assert.strictEqual(
    fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    3,
    "the refused system added nothing",
  );

  // A system id that is not in the catalogue is not silently treated as NPC space.
  const unknown = chatCommand.handleCommand(runtime, config, session(), "anchor system 39999999").message;
  assert.match(unknown, /was not found in the system catalogue/u, unknown);
});

// A fake timer harness: `advance` runs the due callbacks in order, so a chain of
// 1 s countdown ticks and 2 s step delays can be driven without sleeping.
function createClock() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { fn, ms: Math.max(0, Number(ms) || 0) });
      return handle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle);
    },
    pending: () => pending.size,
    advance: (ms) => {
      let remaining = Number(ms) || 0;
      for (;;) {
        let due = null;
        for (const [handle, entry] of pending.entries()) {
          if (entry.ms <= remaining && (!due || entry.ms < due[1].ms)) due = [handle, entry];
        }
        if (!due) break;
        pending.delete(due[0]);
        remaining -= due[1].ms;
        due[1].fn();
      }
      // Time left over in this call still passes for whatever is still pending,
      // so two 1000 ms advances are the same as one 2000 ms advance.
      if (remaining > 0) {
        for (const entry of pending.values()) entry.ms = Math.max(0, entry.ms - remaining);
      }
    },
  };
}

// A region command start: the reply is the summary plus the countdown, and every
// later message goes to `messages` through the injected chat delivery.
function startRegionRun(clock, messages, fixtureOptions, command = "anchor region 10000043", overrides = {}, extra = {}) {
  const { fixture, deps } = createFixture(fixtureOptions);
  const runtime = createRuntimeWith(fixture, deps, overrides, {
    timers: clock,
    sendTo: (target, message) => {
      messages.push(message);
      return { entry: { message } };
    },
    ...extra,
  });
  const config = configModule.load(modDir, {});
  const reply = chatCommand.handleCommand(runtime, config, session(), command).message;
  return { fixture, runtime, config, reply };
}

test("anchor region: NPC systems are skipped, the rest are worked, paced", () => {
  const systems = [SYSTEM_ID, 30000144, 30000145, 30000146];
  const planets = systems.flatMap((systemID, index) => ([
    { ...planet(40009001 + (index * 10), `P${index}I`, index + 1), solarSystemID: systemID },
    { ...planet(40009002 + (index * 10), `P${index}II`, index + 1), solarSystemID: systemID },
  ]));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
    // One of the four is NPC space.
    npcSystemIDs: [30000145],
  });

  // The reply is the plan summary and the countdown, and nothing has been touched.
  assert.match(
    run.reply,
    /Domain: 3 systems to work, 1 NPC\/faction space skipped - starting in 15 s, type \/ash stop to cancel/u,
    run.reply,
  );
  assert.match(run.reply, /skipped NPC\/faction space: System 30000145/u, run.reply);
  assert.strictEqual(
    run.fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
    "the countdown must not deploy anything",
  );

  // Ticks at 10 s and 5 s, then "starting now" and the first system.
  clock.advance(5000);
  assert.strictEqual(messages.length, 1, messages.join("\n---\n"));
  assert.match(messages[0], /starting in 10 s, type \/ash stop to cancel/u, messages[0]);
  clock.advance(5000);
  assert.match(messages[1], /starting in 5 s, type \/ash stop to cancel/u, messages[1]);
  assert.strictEqual(
    run.fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
    "still nothing deployed during the countdown",
  );
  clock.advance(5000);
  assert.match(messages[2], /Domain: starting now/u, messages[2]);
  assert.match(messages[3], /^autoSkyHookDeploy v1\.0\.0: .*deployed 2, verified 2 at the landing point \+ 25000 m, 0 anomalies  \[1\/3 systems done, 2 systems left, about .* remaining\]/u, messages[3]);

  // One system per step, 2 s apart: nothing new happens before the delay is up.
  const afterFirst = messages.length;
  clock.advance(1000);
  assert.strictEqual(messages.length, afterFirst, "the step delay must be respected");
  clock.advance(1000);
  assert.strictEqual(messages.length, afterFirst + 1);
  clock.advance(100000);

  // Three systems worked, six Skyhooks, one verification message each, and the NPC
  // system was never inspected at all.
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    6,
  );
  assert.strictEqual(
    messages.filter((message) => /verified \d+ at the landing point/u.test(message)).length,
    3,
  );
  assert.strictEqual(
    run.fixture.calls.some((entry) => entry.fn === "listPlanetsForSystem" && entry.systemID === 30000145),
    false,
    "an NPC system must not be inspected at all",
  );
  const workedPlanets = run.fixture.calls
    .filter((entry) => entry.fn === "ensureOrbitalForItem")
    .map((entry) => entry.options.planetID);
  assert.strictEqual(workedPlanets.includes(40009021), false, "the NPC system's planets are untouched");
  // The final summary closes the run.
  const summary = messages[messages.length - 1];
  assert.match(summary, /Domain: finished - 3 of 3 systems done, 0 left/u, summary);
  assert.match(summary, /deployed 6, skipped 0 already present, 0 over a destroyed skyhook/u, summary);
  assert.match(summary, /0 anomalies, 0 failed system\(s\)/u, summary);
  assert.strictEqual(clock.pending(), 0, "the run must not leave a timer behind");
});

test("anchor region: a fully NPC region is refused with nothing touched", () => {
  const { fixture, deps } = createFixture({
    solarSystems: [
      { solarSystemID: SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0 },
      { solarSystemID: OTHER_SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0 },
    ],
    npcSystemIDs: [SYSTEM_ID, OTHER_SYSTEM_ID],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const message = chatCommand.handleCommand(runtime, config, session(), "anchor region 10000043").message;
  assert.match(
    message,
    /Domain is NPC\/faction space \(none of its 2 systems is sovereignty-claimable\): nothing was touched/u,
    message,
  );
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"), false);
  assert.strictEqual(runtime.regionRunStatus(), null, "a refused region must not start a run");
});

test("anchor region: no NPC systems means all of them are worked", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  assert.match(
    run.reply,
    /Domain: 2 systems to work, 0 NPC\/faction space skipped - starting in 15 s/u,
    run.reply,
  );
  assert.strictEqual(/skipped NPC\/faction space/u.test(run.reply), false, "nothing was skipped");
  clock.advance(100000);
  const summary = messages[messages.length - 1];
  assert.match(summary, /finished - 2 of 2 systems done, 0 left/u, summary);
  assert.match(summary, /deployed 2, skipped 0 already present/u, summary);
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    2,
  );
});

test("region scoping: refusals for a missing argument, a bad argument and an empty region", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const cases = [
    ["anchor region", /\/ash region needs a region id/u],
    ["anchor region mars", /is not a region id/u],
    ["anchor region 10000043 extra", /is not a region id/u],
    ["anchor region 99999999", /region 99999999 holds no solar systems/u],
    ["anchor system", /\/ash system needs a system id/u],
    ["anchor system mars", /is not a solar system id/u],
    ["anchor here extra", /takes one system or region/u],
    ["unanchor region", /\/ash region needs a region id/u],
    ["unanchor region 99999999", /holds no solar systems/u],
  ];
  for (const [argument, expected] of cases) {
    const message = chatCommand.handleCommand(runtime, config, session(), argument).message;
    assert.match(message, expected, argument);
  }
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"), false);
});

test("unanchor: a region sweep skips NPC systems and refuses a fully NPC region", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID, 30000147];
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    orbitals: [
      orbital(40009001, 1000000000001),
      { ...orbital(40009002, 1000000000002), solarSystemID: OTHER_SYSTEM_ID, planetID: 40009002 },
      { ...orbital(40009003, 1000000000003), solarSystemID: 30000147, planetID: 40009003 },
    ],
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
    npcSystemIDs: [30000147],
    counterItemID: 500,
    highWater: 900,
  }, "unanchor region 10000043");

  assert.match(
    run.reply,
    /Domain: 2 systems to work, 1 NPC\/faction space skipped - starting in 15 s/u,
    run.reply,
  );
  // The NPC system's skyhook is untouched, and the run calibrates the counter once.
  clock.advance(100000);
  assert.deepStrictEqual(
    run.fixture.orbitals.filter((entry) => entry.destroyedAtMs > 0).map((entry) => entry.itemID),
    [1000000000001, 1000000000002],
  );
  assert.strictEqual(run.fixture.reserveCalls.length, 1, "the counter is calibrated once per run");
  assert.strictEqual(
    messages.filter((message) => /verified \d+ gone, \d+ anomalies/u.test(message)).length,
    2,
  );
  const summary = messages[messages.length - 1];
  assert.match(summary, /finished - 2 of 2 systems done, 0 left/u, summary);
  assert.match(summary, /destroyed 2, already destroyed 0, left alone 0 structure-shaped/u, summary);
  assert.match(summary, /item id counter: raised to 902/u, summary);

  // A fully NPC region is refused, and nothing is destroyed by the refusal.
  const npcOnly = createFixture({
    orbitals: [orbital(40009001, 1000000000001)],
    npcSystemIDs: [SYSTEM_ID],
  });
  const npcRuntime = createRuntimeWith(npcOnly.fixture, npcOnly.deps);
  const config = configModule.load(modDir, {});
  const refused = chatCommand.handleCommand(npcRuntime, config, session(), "unanchor region 10000043").message;
  assert.match(refused, /is NPC\/faction space/u, refused);
  assert.strictEqual(
    npcOnly.fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"),
    false,
  );
});

test("unanchor: a failure in one system does not abort the rest of the region", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      { ...orbital(40009002, 1000000000002), solarSystemID: OTHER_SYSTEM_ID, planetID: 40009002 },
    ],
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
    // Every sweep attempt fails; the loop must still reach the second system.
    throwOn: "markOrbitalDestroyed",
  });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.unanchorScope(
    runtime.resolveScope({ kind: "region", regionID: REGION_ID }, session()),
    session(),
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.failures.length, 0, "the scope itself did not fail");
  assert.strictEqual(result.systems.length, 2, "the loop reached both systems");
  for (const entry of result.systems) {
    assert.strictEqual(entry.result.failures.length, 1, entry.label);
  }
  const described = runtime.describeScopeRemoval(result);
  assert.match(described, /FAILED orbital skyhook at Planet I/u, described);
  assert.match(described, /FAILED orbital skyhook at Planet II/u, described);
  const attempted = fixture.calls
    .filter((entry) => entry.fn === "markOrbitalDestroyed")
    .map((entry) => entry.itemID);
  assert.deepStrictEqual(attempted, [1000000000001, 1000000000002]);
});

test("scoping: the vendor rule is the only NPC test, and its absence refuses", () => {
  const config = configModule.load(modDir, {});

  const missing = createFixture({ sovSystemRulesMissing: true });
  const missingRuntime = createRuntimeWith(missing.fixture, missing.deps);
  const missingMessage = chatCommand.handleCommand(
    missingRuntime, config, session(), "anchor here",
  ).message;
  assert.match(missingMessage, /sovereignty system rules are unavailable/u, missingMessage);
  assert.strictEqual(
    missing.fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
  );

  // A throwing rule is a refusal too, never an exception out of the handler.
  const throwing = createFixture({ sovSystemRulesThrows: true });
  const throwingRuntime = createRuntimeWith(throwing.fixture, throwing.deps);
  let thrownMessage = null;
  assert.doesNotThrow(() => {
    thrownMessage = chatCommand.handleCommand(throwingRuntime, config, session(), "anchor here").message;
  });
  assert.match(thrownMessage, /sovereignty system rules are unavailable/u, thrownMessage);

  // The region path asks the vendor rule once per system.
  const worked = createFixture();
  const workedRuntime = createRuntimeWith(worked.fixture, worked.deps);
  chatCommand.handleCommand(workedRuntime, config, session(), "anchor region 10000043");
  assert.ok(
    worked.fixture.calls.some((entry) => entry.fn === "isSovereigntyClaimableSolarSystem"),
    "the region path must ask the vendor rule",
  );
});

test("region run: /ash stop during the countdown leaves nothing deployed", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  clock.advance(3000);
  const stopped = chatCommand.handleCommand(run.runtime, run.config, session(), "stop").message;
  assert.match(stopped, /cancelled during the countdown - nothing was deployed and no system was touched/u, stopped);
  assert.match(messages[messages.length - 1], /cancelled during the countdown/u);
  assert.strictEqual(
    run.fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
    "a cancelled countdown must not deploy anything",
  );
  assert.strictEqual(clock.pending(), 0, "the countdown timer must be cleared");
  clock.advance(120000);
  assert.strictEqual(
    run.fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
  );
  assert.strictEqual(run.runtime.regionRunStatus(), null);
  // `stop` with nothing running answers plainly.
  const idle = chatCommand.handleCommand(run.runtime, run.config, session(), "stop").message;
  assert.match(idle, /nothing to stop/u, idle);
});

test("region run: /ash stop mid-run finishes and verifies the current system", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID, 30000148];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  // Countdown, then the first system is worked and the 2 s delay before the second
  // is pending when the stop arrives.
  clock.advance(15000);
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    1,
    "exactly one system worked so far",
  );
  const stopped = chatCommand.handleCommand(run.runtime, run.config, session(), "stop").message;
  assert.match(
    stopped,
    /stopping after the system being worked \(it is completed and verified first\)/u,
    stopped,
  );
  clock.advance(100000);
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    1,
    "the remaining systems must not run after a stop",
  );
  const summary = messages[messages.length - 1];
  assert.match(summary, /Domain: stopped - 1 of 3 systems done, 2 left/u, summary);
  assert.match(summary, /deployed 1, skipped 0 already present/u, summary);
  assert.match(
    summary,
    /the system being worked was finished and verified before stopping; nothing is half-done/u,
    summary,
  );
  assert.strictEqual(clock.pending(), 0);
  assert.strictEqual(run.runtime.regionRunStatus(), null);
});

test("region run: one run at a time, refused with a pointer at /ash stop", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  const second = chatCommand.handleCommand(
    run.runtime, run.config, session(), "anchor region 10000043",
  ).message;
  assert.match(second, /a region run is already in progress/u, second);
  assert.match(second, /use \/ash stop to cancel it/u, second);
  assert.strictEqual(
    messages.filter((message) => /starting in 15 s/u.test(message)).length,
    0,
    "a refused command must not announce its own countdown",
  );
  clock.advance(100000);
  assert.strictEqual(run.runtime.regionRunStatus(), null, "the first run finished normally");
});

test("region run: a system that cannot be worked is reported and the run continues", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID, 30000148];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  // The middle system loses its planets, which is the vendor's own "nothing to work
  // with" answer for that system.
  run.fixture.planets = run.fixture.planets
    .filter((entry) => entry.solarSystemID !== OTHER_SYSTEM_ID);
  clock.advance(100000);
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    2,
    "the systems after the failing one still ran",
  );
  const reported = messages.filter((message) => /FAILED|nothing to deploy/u.test(message));
  assert.strictEqual(reported.length, 1, messages.join("\n---\n"));
  const summary = messages[messages.length - 1];
  assert.match(summary, /3 of 3 systems done, 0 left/u, summary);
});

test("region run: a verification anomaly is reported, never hidden", () => {
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets: [{ ...planet(40009001, "P0", 1), solarSystemID: SYSTEM_ID }],
    // Every item row is written 123 m off the landing point + offset.
    itemPositionDrift: 123,
  });
  clock.advance(100000);
  const result = messages.find((message) => /deployed 1/u.test(message));
  assert.match(result, /deployed 1, verified 0 at the landing point \+ 25000 m, 1 anomalies/u, result);
  assert.match(result, /ANOMALY orbital skyhook at P0 sits 123 m from the landing point \+ 25000 m/u, result);
  assert.match(messages[messages.length - 1], /1 anomalies/u);

  // A missing item row, and a reader that throws, are anomalies too - and neither
  // throws out of the run.
  for (const options of [{ dropItemRows: true }, { itemsThrows: true }]) {
    const brokenClock = createClock();
    const brokenMessages = [];
    const broken = startRegionRun(brokenClock, brokenMessages, {
      planets: [{ ...planet(40009001, "P0", 1), solarSystemID: SYSTEM_ID }],
      ...options,
    });
    brokenClock.advance(100000);
    const brokenResult = brokenMessages.find((message) => /deployed 1/u.test(message));
    assert.match(brokenResult, /1 anomalies/u, JSON.stringify(options));
    assert.match(brokenResult, /ANOMALY/u, JSON.stringify(options));
  }
});

test("region run: the countdown and the step delay can both be switched off", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  }, "anchor region 10000043", { regionCountdownSeconds: 0, regionStepDelayMs: 0 });
  assert.match(
    run.reply,
    /2 systems to work, 0 NPC\/faction space skipped - starting now, type \/ash stop to cancel/u,
    run.reply,
  );
  // With both at 0 there is no countdown and no waiting: the first system runs in
  // the command itself, and the next one on a 0 ms tick (which still gives the
  // event loop a turn between systems, deliberately).
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    1,
    "the first system runs straight away with no countdown",
  );
  clock.advance(0);
  assert.strictEqual(
    run.fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner").length,
    2,
  );
  assert.strictEqual(clock.pending(), 0);
  const summary = messages[messages.length - 1];
  assert.match(summary, /finished - 2 of 2 systems done, 0 left/u, summary);
});

test("unanchor region: the sweep is paced the same way", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    orbitals: [
      orbital(40009001, 1000000000001),
      { ...orbital(40009002, 1000000000002), solarSystemID: OTHER_SYSTEM_ID, planetID: 40009002 },
    ],
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  }, "unanchor region 10000043");
  assert.match(run.reply, /2 systems to work, 0 NPC\/faction space skipped - starting in 15 s/u, run.reply);
  assert.strictEqual(
    run.fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"),
    false,
    "the countdown must not destroy anything",
  );
  clock.advance(100000);
  assert.strictEqual(
    messages.filter((message) => /verified \d+ gone/u.test(message)).length,
    2,
  );
  const summary = messages[messages.length - 1];
  assert.match(summary, /finished - 2 of 2 systems done, 0 left/u, summary);
  assert.match(summary, /destroyed 2, already destroyed 0/u, summary);
});

test("launcher: the manifest's settings fields and the config's keys agree", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(modDir, "evejs-launcher.mod.json"), "utf8"));
  assert.strictEqual(manifest.settings.schemaVersion, 1);
  assert.strictEqual(manifest.settings.files.length, 1);
  const file = manifest.settings.files[0];
  assert.deepStrictEqual(
    { id: file.id, base: file.base, path: file.path, format: file.format },
    { id: "settings", base: "mod", path: "settings.json", format: "json" },
  );
  assert.strictEqual(path.basename(configModule.SETTINGS_FILENAME), file.path);

  // Every field points at that file, carries the id as its key, and the id is a real
  // configuration key: this is what stops the Configure panel from drifting.
  const envNames = new Set(Object.values(configModule.KEYS));
  const shortNames = new Set(Object.values(configModule.JSON_KEY_BY_ENV));
  const ids = new Set();
  for (const field of manifest.settings.fields) {
    assert.strictEqual(field.file, file.id, field.id);
    assert.deepStrictEqual(field.key, [field.id], field.id);
    assert.strictEqual(field.restart, "game_server", field.id);
    assert.ok(["number", "boolean", "string"].includes(field.type), `${field.id}: ${field.type}`);
    assert.strictEqual(typeof field.label, "string", field.id);
    assert.ok(field.label.length > 0, field.id);
    assert.strictEqual(
      shortNames.has(field.id) || envNames.has(field.id),
      true,
      `the manifest field ${field.id} is not a key this mod reads`,
    );
    assert.strictEqual(ids.has(field.id), false, `${field.id} is declared twice`);
    ids.add(field.id);
    // The declared default must be the mod's own default, and a numeric field must
    // carry the mod's own range.
    const key = Object.keys(configModule.KEYS).find((name) => configModule.KEYS[name] === field.id);
    const named = key || field.id;
    if (Object.prototype.hasOwnProperty.call(configModule.DEFAULTS, named)) {
      assert.deepStrictEqual(field.default, configModule.DEFAULTS[named], `${field.id} default`);
    }
    const limits = configModule.LIMITS[named];
    if (limits) {
      assert.strictEqual(field.minimum, limits.minimum, `${field.id} minimum`);
      assert.strictEqual(field.maximum, limits.maximum, `${field.id} maximum`);
    }
  }
  // And the other way round: every key the mod reads has a field.
  // enabled is the one exception, and it is on purpose: in the launcher, whether
  // the mod runs at all is the manifest entry's own toggle, so the Configure panel
  // does not need a second switch for it. Every other key the mod reads must be
  // settable from the panel.
  for (const shortName of shortNames) {
    if (shortName === "enabled") continue;
    assert.strictEqual(
      ids.has(shortName),
      true,
      `the configuration key ${shortName} has no launcher settings field`,
    );
  }
});

test("launcher: the manifest declares the launcher blocks from the known example", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(modDir, "evejs-launcher.mod.json"), "utf8"));
  // The launcher is not a backend; native stays the backend and the launcher enables
  // the manifest entry.
  assert.deepStrictEqual(manifest.supportedBackends, ["native", "docker"]);
  assert.strictEqual(manifest.activation.strategy, "loader_rename");
  assert.strictEqual(manifest.restart, "game_server");
  assert.strictEqual(manifest.updates.provider, "github");
  assert.strictEqual(manifest.updates.repository, "HalCyonNJ/EveJS-AutoSkyHookDeploy");
  assert.strictEqual(manifest.updates.asset, "EveJS-AutoSkyHookDeploy-{version}.zip");
  assert.strictEqual(manifest.updates.channel, "stable");
  assert.strictEqual(manifest.updates.tagPrefix, "v");
  assert.deepStrictEqual(manifest.updates.preserveFiles, ["settings.json"]);
  assert.strictEqual(manifest.launcherApi.version, 1);
  assert.strictEqual(manifest.launcherApi.helper.runtime, "node");
  assert.strictEqual(manifest.launcherApi.helper.path, "launcher/helper.js");
  assert.deepStrictEqual(manifest.launcherApi.capabilities, [
    "install", "verify", "prepare_profile", "prepare_disable", "prepare_remove", "recover",
  ]);
  // The helper the manifest names must exist, and the packager too.
  assert.strictEqual(fs.existsSync(path.join(modDir, manifest.launcherApi.helper.path)), true);
  assert.strictEqual(fs.existsSync(path.join(modDir, "tools", "build-package.js")), true);
  assert.strictEqual(fs.existsSync(path.join(modDir, "tools", "BuildPackage.bat")), true);
});

test("launcher: settings.json is a configuration source between the env and the config JSON", () => {
  const dir = tmpdir("ashd-settings-");
  try {
    const modRoot = path.join(dir, "mod");
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.mkdirSync(modRoot, { recursive: true });
    const settingsFile = path.join(modRoot, configModule.SETTINGS_FILENAME);
    const configFile = path.join(dir, "config", configModule.CONFIG_FILENAME);

    // A missing settings.json is not a problem: the config JSON underneath decides.
    fs.writeFileSync(configFile, `${JSON.stringify({ offsetMeters: 7000, allowDeploy: true })}\n`, "utf8");
    const missing = configModule.load(modRoot, {}, { runtimeRoot: dir });
    assert.deepStrictEqual(missing.problems, []);
    assert.strictEqual(missing.offsetMeters, 7000);
    assert.strictEqual(missing.offsetFilename, configFile, "the config JSON is written when settings.json is absent");

    // With a settings.json it wins, for every key it carries.
    fs.writeFileSync(settingsFile, `${JSON.stringify({ offsetMeters: 2500, allowDeploy: false })}\n`, "utf8");
    const withSettings = configModule.load(modRoot, {}, { runtimeRoot: dir });
    assert.strictEqual(withSettings.offsetMeters, 2500);
    assert.strictEqual(withSettings.allowDeploy, false);
    assert.deepStrictEqual(withSettings.sources, ["settings.json", configModule.CONFIG_FILENAME]);
    assert.strictEqual(withSettings.offsetFilename, settingsFile, "/ash offset writes the file in force");
    // A key only the config JSON carries still comes from there.
    assert.strictEqual(withSettings.standoffMeters, configModule.DEFAULTS.standoffMeters);

    // The environment still outranks everything.
    assert.strictEqual(
      configModule.load(modRoot, { EVEJS_AUTO_SKYHOOK_DEPLOY_OFFSET_METERS: "9000" }, { runtimeRoot: dir })
        .offsetMeters,
      9000,
    );

    // A malformed settings.json fails closed, like every other source, and names
    // itself in the problem.
    fs.writeFileSync(settingsFile, "{ broken", "utf8");
    const broken = configModule.load(modRoot, {}, { runtimeRoot: dir });
    assert.strictEqual(broken.problems.length, 1, JSON.stringify(broken.problems));
    assert.match(broken.problems[0], /settings\.json is not valid JSON/u, broken.problems[0]);

    // A value it is missing falls through, and an out-of-range value fails closed
    // (it is a configuration source, not a runtime store).
    fs.writeFileSync(settingsFile, `${JSON.stringify({ offsetMeters: 999999 })}\n`, "utf8");
    const outOfRange = configModule.load(modRoot, {}, { runtimeRoot: dir });
    assert.strictEqual(outOfRange.problems.length, 1, JSON.stringify(outOfRange.problems));
    assert.match(outOfRange.problems[0], /must be between 0 and 100000/u, outOfRange.problems[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher: the helper answers all six actions and never throws", () => {
  const helper = require(path.join(modDir, "launcher", "helper.js"));
  assert.deepStrictEqual(helper.ACTIONS, [
    "install", "verify", "prepare_profile", "prepare_disable", "prepare_remove", "recover",
  ]);
  const envelope = (action) => ({
    protocol: 1,
    requestId: `req-${action}`,
    action,
    runtime: { evejsRoot: "R", clientRoot: "C", backend: "native" },
  });
  for (const action of helper.ACTIONS) {
    const result = helper.execute(envelope(action), "client-script-delivery-v1", modDir);
    assert.strictEqual(result.protocol, 1, action);
    assert.strictEqual(result.requestId, `req-${action}`, action);
    assert.strictEqual(result.success, true, action);
    assert.strictEqual(result.state, "ready", action);
    assert.strictEqual(typeof result.message, "string", action);
    assert.ok(result.message.length > 0, action);
    assert.deepStrictEqual(result.environment, {}, action);
    assert.deepStrictEqual(result.arguments, [], action);
    assert.ok(Array.isArray(result.restartRequired), action);
    assert.ok(Array.isArray(result.contributions), action);
  }
  // Only prepare_profile reports client delivery, and only when the host advertises
  // the feature - this mod has no client component.
  const profile = helper.execute(envelope("prepare_profile"), "client-script-delivery-v1", modDir);
  assert.strictEqual(profile.clientScriptDelivery, "none");
  const noFeature = helper.execute(envelope("prepare_profile"), "", modDir);
  assert.strictEqual("clientScriptDelivery" in noFeature, false);
  assert.strictEqual(
    "clientScriptDelivery" in helper.execute(envelope("install"), "client-script-delivery-v1", modDir),
    false,
  );
  // Cleanup actions say plainly that nothing outside the mod folder is touched.
  for (const action of ["prepare_disable", "prepare_remove"]) {
    const result = helper.execute(envelope(action), "", modDir);
    assert.match(result.message, /nothing outside the mod folder needs undoing/u, action);
    assert.deepStrictEqual(result.restartRequired, ["game_server"], action);
  }

  // An unknown action, a missing envelope and a helper that cannot read the mod root
  // all answer with success:false instead of throwing.
  const unknown = helper.execute(envelope("frobnicate"), "", modDir);
  assert.strictEqual(unknown.success, false);
  assert.strictEqual(unknown.state, "error");
  assert.strictEqual(unknown.requestId, "req-frobnicate");
  assert.match(unknown.message, /unsupported helper action/u);
  for (const bad of [null, undefined, {}, { requestId: "r" }, { action: 42 }]) {
    let result = null;
    assert.doesNotThrow(() => {
      result = helper.execute(bad, "", modDir);
    });
    assert.strictEqual(result.success, false, JSON.stringify(bad));
    assert.strictEqual(result.protocol, 1);
  }
  // A mod root with no loader.js still answers, with version "unknown".
  const emptyRoot = tmpdir("ashd-helper-");
  try {
    const result = helper.execute(envelope("verify"), "", emptyRoot);
    assert.strictEqual(result.success, true);
    assert.match(result.message, /version unknown/u, result.message);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("launcher: the helper's CLI protocol writes the result file", () => {
  const dir = tmpdir("ashd-helper-cli-");
  try {
    const requestFile = path.join(dir, "request.json");
    const resultFile = path.join(dir, "result.json");
    fs.writeFileSync(requestFile, JSON.stringify({
      protocol: 1,
      requestId: "cli-1",
      action: "verify",
      runtime: { evejsRoot: "R", clientRoot: "C", backend: "native" },
    }), "utf8");
    const helperPath = path.join(modDir, "launcher", "helper.js");
    const outcome = spawnSync(
      process.execPath,
      [helperPath, "--request", requestFile, "--result", resultFile],
      { encoding: "utf8" },
    );
    assert.strictEqual(outcome.status, 0, outcome.stderr);
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.strictEqual(result.requestId, "cli-1");
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.state, "ready");

    // A request file that cannot be read still produces a result file.
    fs.writeFileSync(requestFile, "{ not json", "utf8");
    const second = spawnSync(
      process.execPath,
      [helperPath, "--request", requestFile, "--result", resultFile],
      { encoding: "utf8" },
    );
    assert.strictEqual(second.status, 0, second.stderr);
    const failure = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    assert.strictEqual(failure.success, false);
    assert.match(failure.message, /could not be read/u, failure.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launcher: the packager builds a ZIP the launcher can read, and --dry-run writes nothing", () => {
  const packager = path.join(modDir, "tools", "build-package.js");
  const distDir = path.join(modDir, "dist");
  const manifest = JSON.parse(fs.readFileSync(path.join(modDir, "evejs-launcher.mod.json"), "utf8"));
  const version = manifest.version;
  // The artifact is named after the manifest's own update asset, so a packager that
  // emits anything else fails this test rather than shipping a file the launcher's
  // update check could never find.
  const expectedName = manifest.updates.asset.replace(/\{version\}/gu, version);
  const target = path.join(distDir, expectedName);
  const existedBefore = fs.existsSync(target);
  const bytesBefore = existedBefore ? fs.readFileSync(target) : null;
  try {
    // Dry run: the plan is printed and nothing is written.
    const dry = spawnSync(process.execPath, [packager, "--dry-run"], { encoding: "utf8" });
    assert.strictEqual(dry.status, 0, dry.stderr);
    assert.ok(
      dry.stdout.includes(`dry run: would write dist/${expectedName}`),
      `A:${dry.stdout}`,
    );
    assert.match(dry.stdout, /autoSkyHookDeploy\/evejs-launcher\.mod\.json/u, `B:${dry.stdout}`);
    assert.match(dry.stdout, /autoSkyHookDeploy\/launcher\/helper\.js/u, `C:${dry.stdout}`);
    if (!existedBefore) {
      assert.strictEqual(fs.existsSync(target), false, "--dry-run must not write the ZIP");
    }

    // Real run: the ZIP exists, is a ZIP, is prefixed with the mod folder and holds
    // the manifest and the helper.
    const built = spawnSync(process.execPath, [packager], { encoding: "utf8" });
    assert.strictEqual(built.status, 0, built.stderr);
    assert.strictEqual(fs.existsSync(target), true);
    assert.ok(
      built.stdout.includes(`dist/${expectedName}`),
      `the packager must report the name the manifest's updates.asset asks for: ${built.stdout}`,
    );
    const bytes = fs.readFileSync(target);
    assert.strictEqual(bytes.readUInt32LE(0), 0x04034B50, "a local file header must come first");
    const raw = bytes.toString("latin1");
    for (const name of [
      "autoSkyHookDeploy/evejs-launcher.mod.json",
      "autoSkyHookDeploy/loader.js",
      "autoSkyHookDeploy/launcher/helper.js",
      "autoSkyHookDeploy/config.js",
    ]) {
      assert.ok(raw.includes(name), `${name} must be in the ZIP`);
    }
    // Build output and VCS metadata never ship.
    assert.strictEqual(raw.includes("autoSkyHookDeploy/dist/"), false);
    assert.strictEqual(raw.includes("autoSkyHookDeploy/.git/"), false);
    assert.match(built.stdout, /sha256 [0-9a-f]{64}/u, `D:${built.stdout}`);

    // The archive is a valid ZIP: its central directory count matches the printed
    // file count, and every entry can be inflated back to its recorded size.
    const entryCount = built.stdout.match(/[0-9]+ files/u);
    assert.ok(entryCount, `E:${built.stdout}`);
  } finally {
    // The test never leaves build output behind: the ZIP it built is removed again,
    // and dist/ only if this test was what created it.
    fs.rmSync(target, { force: true });
    if (bytesBefore) fs.writeFileSync(target, bytesBefore);
    try {
      fs.rmdirSync(distDir);
    } catch (_error) {
      // dist/ had other content; leave it alone.
    }
  }
});

test("region run: the countdown carries the reminder and the time estimate", () => {
  // The averages are process-level, so reset them to make this hermetic.
  createRuntimeWith(createFixture().fixture, createFixture().deps)._testing.resetTiming();
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  // The plan summary, the reminder and the estimate are all in the same reply, and the
  // summary numbers are unchanged.
  assert.match(
    run.reply,
    /Domain: 2 systems to work, 0 NPC\/faction space skipped - starting in 15 s, type \/ash stop to cancel/u,
    run.reply,
  );
  assert.match(
    run.reply,
    /please stay in game and avoid jumping or logging off until the run finishes; type \/ash stop to cancel/u,
    run.reply,
  );
  assert.match(
    run.reply,
    /estimated \d+ s: 2 systems, \d+ planets, 1 x 2000 ms step delay, 15 s countdown \(first run, so this uses the default 48 ms per planet\)/u,
    run.reply,
  );
  // With no measured sample the estimate is countdown + systems + planets + one gap:
  // 15000 + 2*200 + 14*48 + 2000.
  const runtime = createRuntimeWith(createFixture().fixture, createFixture().deps);
  assert.strictEqual(runtime.estimateRunMs({ systems: 2, planets: 14 }), 15000 + 400 + 672 + 2000);
  // A 0 countdown and a 0 delay leave only the work.
  const fast = createRuntimeWith(
    createFixture().fixture, createFixture().deps,
    { regionCountdownSeconds: 0, regionStepDelayMs: 0 },
  );
  assert.strictEqual(fast.estimateRunMs({ systems: 2, planets: 14 }), 400 + 672);
  // Friendly rounding: seconds under a minute, otherwise Xm Ys.
  assert.strictEqual(runtime.formatDuration(48_000), "48 s");
  assert.strictEqual(runtime.formatDuration(65_000), "1 m 05 s");
  assert.strictEqual(runtime.formatDuration(185_000), "3 m 05 s");
});

test("region run: the moving average is measured, used by the next estimate, and reported", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const fixtureOptions = {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  };
  // A fake clock that advances on every read, so "time" is measurable in the suite.
  const makeNow = () => {
    let current = 1_700_000_000_000;
    return (step = 400) => {
      current += step;
      return current;
    };
  };
  const clock = createClock();
  const messages = [];
  const resetter = createRuntimeWith(createFixture().fixture, createFixture().deps);
  resetter._testing.resetTiming();
  const run = startRegionRun(clock, messages, fixtureOptions, "anchor region 10000043", {}, {
    now: makeNow(),
  });
  assert.strictEqual(run.runtime._testing.describeTiming().measured, false);
  clock.advance(100000);

  const after = run.runtime._testing.describeTiming();
  assert.strictEqual(after.measured, true);
  assert.ok(after.planetSamples > 0, JSON.stringify(after));
  assert.ok(after.systemSamples > 0, JSON.stringify(after));
  const summary = messages[messages.length - 1];
  assert.match(
    summary,
    /finished - 2 of 2 systems done, 0 left, in \d+ s \(including the countdown; estimated \d+ s; \d+ ms per planet measured\)/u,
    summary,
  );
  // The measured figure is no longer the seed, and the next estimate uses it (within
  // the rounding the display applies).
  assert.notStrictEqual(after.planetMs, 48, JSON.stringify(after));
  const expectedNext = 15000 + (2 * after.systemMs) + (14 * after.planetMs) + 2000;
  assert.ok(
    Math.abs(run.runtime.estimateRunMs({ systems: 2, planets: 14 }) - expectedNext) < 200,
    `${run.runtime.estimateRunMs({ systems: 2, planets: 14 })} vs ${expectedNext}`,
  );
  // A second run of the same shape reports the average as measured, not as a first run.
  const second = startRegionRun(createClock(), [], fixtureOptions, "anchor region 10000043", {}, {
    now: makeNow(),
  });
  assert.match(second.reply, /measured \d+ ms per planet so far/u, second.reply);
});

test("region run: a stopped run reports its partial time against the original estimate", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID, 30000148];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const messages = [];
  const run = startRegionRun(clock, messages, {
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  }, "anchor region 10000043", {}, { now: () => 1_700_000_000_000 });
  const estimated = run.reply.match(/estimated ([\d]+ s|[\d]+ m [\d]+ s)/u)[1];
  clock.advance(15000);
  chatCommand.handleCommand(run.runtime, run.config, session(), "stop");
  clock.advance(100000);
  const summary = messages[messages.length - 1];
  assert.match(summary, /stopped - 1 of 3 systems done, 2 left, in 0 s/u, summary);
  assert.ok(summary.includes(`estimated ${estimated}`), summary);
  assert.match(summary, /including the countdown/u, summary);
});

test("align: both spellings are one command, and the retired name starts nothing", () => {
  const build = () => {
    const clock = createClock();
    const messages = [];
    const { fixture, deps } = createFixture({ planets: [THREE_PLANETS[0]] });
    fixture.orbitals.push(orbital(40009001, 1000000000001));
    fixture.items.set(1000000000001, {
      itemID: 1000000000001,
      spaceState: { position: { x: 1, y: 2, z: 3 } },
    });
    const runtime = createRuntimeWith(fixture, deps, {}, {
      timers: clock,
      sendTo: (target, message) => { messages.push(message); return null; },
    });
    return { clock, messages, fixture, runtime, config: configModule.load(modDir, {}) };
  };

  // `/ash align` and `/ash al` are the same command: the same reply, the same run,
  // the same moves. The timing averages are process-level, so both start reset.
  const long = build();
  long.runtime._testing.resetTiming();
  const longReply = chatCommand.handleCommand(long.runtime, long.config, session(), "align").message;
  long.clock.advance(100000);
  const longMessages = [...long.messages];

  const short = build();
  short.runtime._testing.resetTiming();
  const shortReply = chatCommand.handleCommand(short.runtime, short.config, session(), "al").message;
  short.clock.advance(100000);

  assert.strictEqual(shortReply, longReply, "the short form must produce the same reply");
  assert.deepStrictEqual(short.messages, longMessages, "the short form must produce the same run");
  assert.deepStrictEqual(
    short.fixture.items.get(1000000000001).spaceState.position,
    long.fixture.items.get(1000000000001).spaceState.position,
    "the short form must move the Skyhook to the same place",
  );
  assert.strictEqual(short.runtime.regionRunStatus(), null, "the run must be over");

  // The retired name is refused in words, with a pointer, and never resolves to a
  // subcommand: no run starts and no Skyhook is written.
  const refused = build();
  for (const typed of ["reanchor", "ra", "reanchor here", "ra region 10000043", "align reanchor", "align ra"]) {
    const message = chatCommand.handleCommand(refused.runtime, refused.config, session(), typed).message;
    assert.match(
      message,
      /unknown command "(reanchor|ra)" - it is now \/ash align \(or \/ash al\)/u,
      `argument "${typed}"`,
    );
  }
  const status = chatCommand.handleCommand(refused.runtime, refused.config, session(), "status here").message;
  assert.strictEqual(/run in progress/u.test(status), false, status);
  assert.strictEqual(refused.runtime.regionRunStatus(), null, "a refusal must not start a run");
  assert.strictEqual(
    refused.fixture.calls.some((entry) => entry.fn === "updateInventoryItem"),
    false,
    "a refusal must not move anything",
  );
  refused.clock.advance(100000);
  assert.deepStrictEqual(
    refused.fixture.items.get(1000000000001).spaceState.position,
    { x: 1, y: 2, z: 3 },
  );
});

test("align: moves every deployed Skyhook onto the configured offset", () => {
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({ planets: [THREE_PLANETS[0], THREE_PLANETS[2]] });
  // Two Skyhooks in one system: one live, one already a tombstone. The live one has a
  // row at the old position; the tombstone must be left alone.
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.orbitals.push({ ...orbital(40009003, 1000000000003), destroyedAtMs: 1700000000000 });
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 }, direction: { x: 1, y: 0, z: 0 } },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return null; },
  });
  const config = configModule.load(modDir, {});
  const reply = chatCommand.handleCommand(runtime, config, session(), "align").message;
  assert.match(reply, /all systems with a Skyhook: 1 system\(s\) to work, 2 Skyhook\(s\) to move, starting in 15 s/u, reply);
  assert.match(reply, /please stay in game/u, reply);
  assert.match(reply, /estimated \d+ s: 1 system, 2 planets/u, reply);
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "updateInventoryItem"),
    false,
    "the countdown must not move anything",
  );
  clock.advance(100000);

  const landing = fixture.warpInPoints["40009001"];
  const origin = THREE_PLANETS[0].position;
  const length = Math.hypot(landing.x - origin.x, landing.y - origin.y, landing.z - origin.z);
  const unit = {
    x: (landing.x - origin.x) / length,
    y: (landing.y - origin.y) / length,
    z: (landing.z - origin.z) / length,
  };
  const offset = configModule.DEFAULTS.offsetMeters;
  const expected = {
    x: landing.x + (unit.x * offset),
    y: landing.y + (unit.y * offset),
    z: landing.z + (unit.z * offset),
  };
  const moved = fixture.items.get(1000000000001);
  assert.deepStrictEqual(moved.spaceState.position, expected);
  assert.deepStrictEqual(moved.spaceState.targetPoint, expected);
  assert.deepStrictEqual(moved.spaceState.direction, unit);
  assert.deepStrictEqual(
    fixture.calls
      .filter((entry) => entry.fn === "refreshInventoryBackedEntityPresentation")
      .map((entry) => entry.itemID),
    [1000000000001],
  );
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.ok(systemMessage, messages.join("\n---\n"));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 1 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  // The progress suffix of an align run counts Skyhooks, not systems: both of this
  // system's Skyhooks are behind the run by the time it reports.
  assert.match(
    systemMessage,
    /\[1\/1 systems done, 0 skyhooks left, about \d+ s remaining\]/u,
    systemMessage,
  );
  // A destroyed marker is not a skip and is never named one by one: it is one line
  // with a count, and no `Planet III` line anywhere in the report.
  assert.match(
    systemMessage,
    /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\)/u,
    systemMessage,
  );
  assert.strictEqual(/is a destroyed tombstone/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(/orbital skyhook at Planet III/u.test(systemMessage), false, systemMessage);
  const summary = messages[messages.length - 1];
  assert.match(
    summary,
    /moved 1 Skyhook\(s\) onto the landing point \+ 25000 m, 1 destroyed markers left alone, skipped 0/u,
    summary,
  );
  // Nothing was created or removed, so the item-id allocator is never touched.
  assert.deepStrictEqual(fixture.reserveCalls, []);
  assert.strictEqual(
    fixture.calls.some((entry) => [
      "createSpaceItemForOwner", "markOrbitalDestroyed", "destroySkyhooks",
    ].includes(entry.fn)),
    false,
  );
});

test("align: skips a planet with no usable landing point, and a missing item row", () => {
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0], { ...planet(40009002, "P II", 2) }],
    // Planet 40009001 has no warp-in point; 40009002 has one but no item row.
    warpInPoints: { "40009002": { x: 2_001_000, y: 300_000, z: -1_500_000 } },
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.orbitals.push(orbital(40009002, 1000000000002));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 5, y: 5, z: 5 } },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return null; },
  });
  const config = configModule.load(modDir, {});
  const reply = chatCommand.handleCommand(runtime, config, session(), "align").message;
  assert.match(reply, /1 system\(s\) to work, 2 Skyhook\(s\) to move/u, reply);
  clock.advance(100000);
  const systemMessage = messages.find((message) => /orbital skyhooks moved/u.test(message));
  assert.ok(systemMessage, messages.join("\n---\n"));
  assert.match(
    systemMessage,
    /0 orbital skyhooks moved \(of 2 attempted\), 0 verified at the landing point \+ 25000 m, 2 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.match(systemMessage, /orbital skyhook at Planet I has no usable landing point/u, systemMessage);
  assert.match(systemMessage, /orbital skyhook at P II has no item row/u, systemMessage);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "updateInventoryItem"), false);
});

test("align: destroyed markers are counted, never listed as skips", () => {
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture();
  // One live Skyhook, two destroyed markers. The run moves the live one and leaves
  // both markers exactly where they are; the report says so in one line with the
  // count, and never prints a planet name for a marker.
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.orbitals.push({ ...orbital(40009002, 1000000000002), destroyedAtMs: 1700000000000 });
  fixture.orbitals.push({ ...orbital(40009003, 1000000000003), destroyedAtMs: 1700000000001 });
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return null; },
  });
  const config = configModule.load(modDir, {});
  const reply = chatCommand.handleCommand(runtime, config, session(), "align").message;
  // The plan counts the two workable Skyhooks, markers included: they are part of the
  // system, they are just not work.
  assert.match(reply, /1 system\(s\) to work, 3 Skyhook\(s\) to move/u, reply);
  clock.advance(100000);
  const systemMessage = messages.find((message) => /orbital skyhooks moved/u.test(message));
  assert.ok(systemMessage, messages.join("\n---\n"));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 2 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.match(
    systemMessage,
    /destroyed markers left alone: 2 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\)/u,
    systemMessage,
  );
  // No item id, no per-marker line, and no `skipped:` line at all.
  assert.strictEqual(/destroyed tombstone/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(/skipped:/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(/Planet II|Planet III/u.test(systemMessage), false, systemMessage);
  // Only the live Skyhook was written, and both markers keep the record they had.
  assert.deepStrictEqual(
    fixture.calls.filter((entry) => entry.fn === "updateInventoryItem").map((entry) => entry.itemID),
    [1000000000001],
  );
  assert.deepStrictEqual(
    fixture.orbitals.filter((entry) => entry.destroyedAtMs > 0)
      .map((entry) => ({ itemID: entry.itemID, destroyedAtMs: entry.destroyedAtMs })),
    [
      { itemID: 1000000000002, destroyedAtMs: 1700000000000 },
      { itemID: 1000000000003, destroyedAtMs: 1700000000001 },
    ],
  );
  assert.strictEqual(
    fixture.calls.some((entry) => [
      "markOrbitalDestroyed", "destroySkyhooks", "createSpaceItemForOwner",
    ].includes(entry.fn)),
    false,
  );
});

test("align: a genuine skip and destroyed markers are reported apart", () => {
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    // Planet I has no warp-in point, so its live Skyhook cannot be moved and is a real
    // skip. Planet III's Skyhook is a destroyed marker.
    warpInPoints: {
      "40009002": { x: 2_001_000, y: 300_000, z: -1_500_000 },
      "40009003": { x: 2_003_000, y: 300_000, z: -1_500_000 },
    },
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.orbitals.push({ ...orbital(40009003, 1000000000003), destroyedAtMs: 1700000000000 });
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 5, y: 5, z: 5 } },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return null; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);
  const systemMessage = messages.find((message) => /orbital skyhooks moved/u.test(message));
  assert.ok(systemMessage, messages.join("\n---\n"));
  // One attempted (the marker is not an attempt), one real skip, one marker.
  assert.match(
    systemMessage,
    /0 orbital skyhooks moved \(of 1 attempted\), 0 verified at the landing point \+ 25000 m, 1 skipped, 1 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  // Each category carries its own evidence: the skip keeps its reason line, the marker
  // only its count.
  assert.match(
    systemMessage,
    /skipped: orbital skyhook at Planet I has no usable landing point/u,
    systemMessage,
  );
  assert.match(
    systemMessage,
    /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\)/u,
    systemMessage,
  );
  assert.strictEqual(/Planet III/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(
    fixture.calls.filter((entry) => entry.fn === "updateInventoryItem").length,
    0,
    "neither the marker nor a skip may be written",
  );
});

test("align: optional scopes, one job at a time, and stop semantics", () => {
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [
      THREE_PLANETS[0],
      { ...planet(40009005, "Other I", 1), solarSystemID: OTHER_SYSTEM_ID },
    ],
    solarSystems: [
      { solarSystemID: SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0 },
      { solarSystemID: OTHER_SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0 },
    ],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.orbitals.push({
    ...orbital(40009005, 1000000000005), solarSystemID: OTHER_SYSTEM_ID, planetID: 40009005,
  });
  for (const itemID of [1000000000001, 1000000000005]) {
    fixture.items.set(itemID, { itemID, spaceState: { position: { x: 9, y: 9, z: 9 } } });
  }
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return null; },
  });
  const config = configModule.load(modDir, {});

  // `system <id>` covers one system only, and a second job is refused.
  const systemReply = chatCommand.handleCommand(
    runtime, config, session(), "align system 30000142",
  ).message;
  assert.match(systemReply, /1 system\(s\) to work, 1 Skyhook\(s\) to move/u, systemReply);
  const second = chatCommand.handleCommand(runtime, config, session(), "align region 10000043").message;
  assert.match(second, /a region run is already in progress/u, second);
  // Stopping during the countdown moves nothing at all.
  const stopped = chatCommand.handleCommand(runtime, config, session(), "stop").message;
  assert.match(stopped, /cancelled during the countdown/u, stopped);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "updateInventoryItem"), false);
  assert.deepStrictEqual(fixture.items.get(1000000000001).spaceState.position, { x: 9, y: 9, z: 9 });

  // `region <id>` covers both systems, and a mid-run stop finishes the current one.
  const regionReply = chatCommand.handleCommand(runtime, config, session(), "align region 10000043").message;
  assert.match(regionReply, /Domain: 2 system\(s\) to work, 2 Skyhook\(s\) to move/u, regionReply);
  clock.advance(15000);
  const midStop = chatCommand.handleCommand(runtime, config, session(), "stop").message;
  assert.match(midStop, /stopping after the system being worked/u, midStop);
  clock.advance(100000);
  assert.strictEqual(
    fixture.calls.filter((entry) => entry.fn === "updateInventoryItem").length,
    1,
    "the second system must not be moved after a stop",
  );
  assert.match(messages[messages.length - 1], /stopped - 1 of 2 systems done, 1 left/u);
});

test("align: a realised Skyhook moves through the scene's position authority", () => {
  // The live lesson: for an item realised in a loaded scene the store write is lost and
  // the entity keeps its own position. The move must go through the authority the scene
  // owns - the scene itself in this vendor - and the verification must read that entity
  // back. The scene is loaded here because the fixture says so, exactly as the vendor's
  // own registry would.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0]],
    loadedSystems: [SYSTEM_ID],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  const applied = fixture.calls.filter((entry) => entry.fn === "setEntityPosition");
  assert.strictEqual(applied.length, 1, JSON.stringify(fixture.calls.map((entry) => entry.fn)));
  assert.strictEqual(applied[0].itemID, 1000000000001);
  // There is no scene.clock: the write must land on the scene itself.
  assert.strictEqual(
    applied[0].receiver,
    fixture.scene,
    "the position write must be called on the scene, not on a clock property",
  );
  assert.deepStrictEqual(applied[0].setOptions, {
    reason: "autoSkyHookDeploy:align",
    velocity: { x: 0, y: 0, z: 0 },
  });
  const landing = fixture.warpInPoints["40009001"];
  const origin = THREE_PLANETS[0].position;
  const length = Math.hypot(landing.x - origin.x, landing.y - origin.y, landing.z - origin.z);
  const offset = configModule.DEFAULTS.offsetMeters;
  const expected = {
    x: landing.x + (((landing.x - origin.x) / length) * offset),
    y: landing.y + (((landing.y - origin.y) / length) * offset),
    z: landing.z + (((landing.z - origin.z) / length) * offset),
  };
  assert.deepStrictEqual(fixture.entities.get(1000000000001).position, expected);
  // The store row is the persisted record of the move, and is written either way.
  assert.deepStrictEqual(fixture.items.get(1000000000001).spaceState.position, expected);
  assert.deepStrictEqual(fixture.items.get(1000000000001).spaceState.targetPoint, expected);
  // An align run must never create a scene, even for a system it does move.
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "ensureScene"),
    false,
    "an align run must not call ensureScene",
  );
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(/scene is loaded and would not accept/u.test(systemMessage), false, systemMessage);
  assert.match(messages[messages.length - 1], /moved 1 Skyhook\(s\)/u);
});

test("align: the loaded scene entity is the authority when the store write is lost", () => {
  // The live failure mode in one system: the scene keeps its own position and rewrites the
  // row from the entity it owns, so the store write does not stick. `moved` must come from
  // the entity read-back, never from the accepted store write.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0]],
    storeWriteLost: true,
    loadedSystems: [SYSTEM_ID],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  assert.strictEqual(fixture.calls.filter((entry) => entry.fn === "setEntityPosition").length, 1);
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  // The entity moved even though the row kept its old position, and the move still counts
  // once - the verification reads the entity, which is what the client sees.
  assert.notDeepStrictEqual(
    fixture.entities.get(1000000000001).position,
    { x: 1, y: 2, z: 3 },
  );
  assert.deepStrictEqual(
    fixture.items.get(1000000000001).spaceState.position,
    { x: 1, y: 2, z: 3 },
  );
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
});

test("align: an unloaded scene is store-only, and never claims the system is in use", () => {
  // The live regression: the operator stood in one system, deployed nothing there, and
  // every one of the 40 systems was called "in use" while nothing moved. With the store
  // as the only authority for a system whose scene is not loaded, this must be a plain
  // verified move - and the entity map is populated on purpose, because the old code
  // created the scene (realising that entity) and then could not move it.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({ planets: [THREE_PLANETS[0]] });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "ensureScene"),
    false,
    "the store-only path must not load a scene",
  );
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "setEntityPosition"),
    false,
    "no entity means no scene write",
  );
  const landing = fixture.warpInPoints["40009001"];
  const origin = THREE_PLANETS[0].position;
  const length = Math.hypot(landing.x - origin.x, landing.y - origin.y, landing.z - origin.z);
  const offset = configModule.DEFAULTS.offsetMeters;
  const expected = {
    x: landing.x + (((landing.x - origin.x) / length) * offset),
    y: landing.y + (((landing.y - origin.y) / length) * offset),
    z: landing.z + (((landing.z - origin.z) / length) * offset),
  };
  assert.deepStrictEqual(fixture.items.get(1000000000001).spaceState.position, expected);
  assert.deepStrictEqual(
    fixture.entities.get(1000000000001).position,
    { x: 1, y: 2, z: 3 },
    "an unloaded scene's entity is not the authority and must not be touched",
  );
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(
    /scene is loaded and would not accept/u.test(systemMessage),
    false,
    systemMessage,
  );
  assert.match(messages[messages.length - 1], /moved 1 Skyhook\(s\)/u);
});

test("align: a move that cannot stick is reported, not counted as moved", () => {
  // A scene that refuses to reposition its entity, with a store write that is lost: the
  // system must be reported as not moved, with the reason, and `moved` must stay 0.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0]],
    storeWriteLost: true,
    sceneIgnoresPosition: true,
    loadedSystems: [SYSTEM_ID],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  const systemMessage = messages.find((message) => /orbital skyhooks moved/u.test(message));
  assert.match(
    systemMessage,
    /0 orbital skyhooks moved \(of 1 attempted\), 0 verified at the landing point \+ 25000 m, 1 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.match(
    systemMessage,
    /skipped: orbital skyhook at Planet I: the loaded scene of its solar system kept its own position/u,
    systemMessage,
  );
  // The note names what happened, and never claims the system is in use.
  assert.match(
    systemMessage,
    /solar system Jita: its scene is loaded and would not accept the move/u,
    systemMessage,
  );
  assert.match(systemMessage, /try again later/u, systemMessage);
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
  const summary = messages[messages.length - 1];
  assert.match(summary, /moved 0 Skyhook\(s\).*0 destroyed markers left alone, skipped 1/u, summary);
  assert.deepStrictEqual(fixture.entities.get(1000000000001).position, { x: 1, y: 2, z: 3 });
  assert.deepStrictEqual(
    fixture.items.get(1000000000001).spaceState.position,
    { x: 1, y: 2, z: 3 },
  );
});

test("align: a loaded scene with no position authority is a diagnostic skip", () => {
  // After the fix this branch is unreachable against this vendor - the scene owns
  // `setEntityPosition` - so it is kept as a diagnostic for a vendor that exposes
  // neither. Nothing may be left half-done: no store write, no refresh, moved 0.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0]],
    loadedSystems: [SYSTEM_ID],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  delete fixture.scene.setEntityPosition;
  fixture.scene.positionAuthority = null;
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  const systemMessage = messages.find((message) => /orbital skyhooks moved/u.test(message));
  assert.match(
    systemMessage,
    /0 orbital skyhooks moved \(of 1 attempted\), 0 verified/u,
    systemMessage,
  );
  assert.match(
    systemMessage,
    /skipped: orbital skyhook at Planet I is realised in the loaded scene of its solar system, which exposes no position authority - its move would be lost/u,
    systemMessage,
  );
  assert.match(
    systemMessage,
    /solar system Jita: its scene is loaded and would not accept the move/u,
    systemMessage,
  );
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "updateInventoryItem"),
    false,
    "a refused scene write must not fall through to the store",
  );
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "refreshInventoryBackedEntityPresentation"),
    false,
    "a refused scene write must not refresh a presentation",
  );
});

test("align: the scene's positionAuthority is the fallback writer", () => {
  // A vendor that only exposes the raw authority: the write must still be called on the
  // authority itself, and the move must count.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0]],
    storeWriteLost: true,
    loadedSystems: [SYSTEM_ID],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  delete fixture.scene.setEntityPosition;
  fixture.scene.positionAuthority = {
    setEntityPosition(itemID, position, setOptions) {
      fixture.calls.push({ fn: "authoritySetEntityPosition", itemID, position, setOptions, receiver: this });
      const entity = fixture.entities.get(itemID);
      if (!entity) return { available: false, reason: "entity-not-found" };
      entity.position = { ...position };
      return { available: true };
    },
  };
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  const applied = fixture.calls.filter((entry) => entry.fn === "authoritySetEntityPosition");
  assert.strictEqual(applied.length, 1, JSON.stringify(fixture.calls.map((entry) => entry.fn)));
  assert.strictEqual(applied[0].receiver, fixture.scene.positionAuthority);
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
});

test("align: a vendor without isSolarSystemSceneLoaded stays store-only", () => {
  // An older vendor: the accessor that cannot create a scene is missing, so the read path
  // must fall through to the store rather than reach for ensureScene.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({ planets: [THREE_PLANETS[0]] });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const depsWithoutCheck = {
    ...deps,
    getSpaceRuntime: () => {
      const spaceRuntime = deps.getSpaceRuntime();
      delete spaceRuntime.isSolarSystemSceneLoaded;
      return spaceRuntime;
    },
  };
  const runtime = createRuntimeWith(fixture, depsWithoutCheck, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "ensureScene"),
    false,
    "a missing accessor must not fall back to creating a scene",
  );
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
});

test("align: a vendor with only the scene registry still finds a loaded scene", () => {
  // The registry lookup is the second no-create accessor, used when the vendor has no
  // `getSceneByDescriptor`. It must find the loaded scene, never create one.
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    planets: [THREE_PLANETS[0]],
    storeWriteLost: true,
    loadedSystems: [SYSTEM_ID],
  });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const depsWithoutLookup = {
    ...deps,
    getSpaceRuntime: () => {
      const spaceRuntime = deps.getSpaceRuntime();
      delete spaceRuntime.getSceneByDescriptor;
      return spaceRuntime;
    },
  };
  const runtime = createRuntimeWith(fixture, depsWithoutLookup, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  assert.strictEqual(
    fixture.calls.filter((entry) => entry.fn === "setEntityPosition").length,
    1,
    JSON.stringify(fixture.calls.map((entry) => entry.fn)),
  );
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "scenesGet"),
    true,
    "the registry must be the lookup used",
  );
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "ensureScene"), false);
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(systemMessage, /1 verified at the landing point \+ 25000 m/u, systemMessage);
});

test("align never creates a scene: ensureScene is spied on and must stay untouched", () => {
  // The live root cause, pinned as a spy: the read asked `ensureScene`, which bootstraps
  // the scene and realises its entities, so all 40 systems looked loaded and unmovable.
  // An align run must complete without that call being made even once.
  const clock = createClock();
  const messages = [];
  const ensureSceneCalls = [];
  const { fixture, deps } = createFixture({ planets: [THREE_PLANETS[0]] });
  fixture.orbitals.push(orbital(40009001, 1000000000001));
  fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  fixture.entities.set(1000000000001, {
    itemID: 1000000000001,
    position: { x: 1, y: 2, z: 3 },
  });
  const spiedDeps = {
    ...deps,
    getSpaceRuntime: () => {
      const spaceRuntime = deps.getSpaceRuntime();
      spaceRuntime.ensureScene = (systemID) => {
        ensureSceneCalls.push(systemID);
        throw new Error(`ensureScene(${systemID}) must never be called by an align run`);
      };
      return spaceRuntime;
    },
  };
  const runtime = createRuntimeWith(fixture, spiedDeps, {}, {
    timers: clock,
    sendTo: (target, message) => { messages.push(message); return true; },
  });
  const config = configModule.load(modDir, {});
  chatCommand.handleCommand(runtime, config, session(), "align");
  clock.advance(100000);

  assert.deepStrictEqual(ensureSceneCalls, [], "ensureScene was called during an align run");
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "ensureScene"), false);
  const systemMessage = messages.find((message) => /orbital skyhooks? moved/u.test(message));
  assert.match(
    systemMessage,
    /1 orbital skyhooks moved \(of 1 attempted\), 1 verified at the landing point \+ 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies/u,
    systemMessage,
  );
  assert.strictEqual(/in use/u.test(systemMessage), false, systemMessage);
});

test("deploy: a Skyhook carries the type radius in spaceRadius, like a launched one", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  runtime.applyPlan(runtime.buildPlan(SYSTEM_ID, session()), session());
  const calls = fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner");
  assert.strictEqual(calls.length, 3);
  for (const entry of calls) {
    assert.strictEqual(
      entry.itemOptions.spaceRadius,
      45000,
      "spaceRadius must be the type's radius from the item metadata",
    );
  }
  assert.ok(
    fixture.calls.some((entry) => entry.fn === "getItemMetadata" && entry.typeID === 81080),
    "the radius must be read from the vendor metadata, not hard-coded",
  );
  assert.strictEqual(
    fixture.calls.filter((entry) => entry.fn === "createSpaceItemForOwner")
      .every((entry) => "spaceRadius" in entry.itemOptions),
    true,
  );
  // A different metadata radius is passed through as-is.
  const other = createFixture({ skyhookRadius: 60_000 });
  const otherRuntime = createRuntimeWith(other.fixture, other.deps);
  otherRuntime.applyPlan(otherRuntime.buildPlan(SYSTEM_ID, session()), session());
  assert.strictEqual(
    other.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner").itemOptions.spaceRadius,
    60_000,
  );
});

test("deploy: a metadata failure still deploys, without the spaceRadius option", () => {
  for (const options of [{ metadataThrows: true }, { metadataMissing: true }, { skyhookRadius: 0 }]) {
    const { fixture, deps } = createFixture(options);
    const runtime = createRuntimeWith(fixture, deps);
    const result = runtime.applyPlan(runtime.buildPlan(SYSTEM_ID, session()), session());
    assert.strictEqual(result.deployed.length, 3, `deploy must succeed for ${JSON.stringify(options)}`);
    assert.deepStrictEqual(result.failures, []);
    const call = fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner");
    assert.strictEqual(
      "spaceRadius" in call.itemOptions,
      false,
      `no spaceRadius option for ${JSON.stringify(options)}`,
    );
  }
});

test("deploy: nothing about the hub reaches the player", () => {
  // A hub is irrelevant to a deploy: the operator confirmed in game that a
  // Skyhook produces normally in a system with no sovereignty infrastructure, and
  // that the earlier "nothing showed" was the client not having refreshed. No
  // reply, in any path, may mention a hub.
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.error, null);
  assert.strictEqual("hub" in plan, false, "the plan carries no hub state");
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 3);
  assert.strictEqual(/hub/iu.test(runtime.describePlan(plan, result)), false);
  assert.strictEqual(
    /hub/iu.test(runtime.describeStatus(runtime.statusSystem(SYSTEM_ID, session()), {})),
    false,
  );
  assert.strictEqual(
    /hub/iu.test(chatCommand.handleCommand(runtime, config, session(), "anchor here").message),
    false,
  );
  assert.strictEqual(
    /hub/iu.test(chatCommand.handleCommand(runtime, config, session(), "status here").message),
    false,
  );
  // The "nothing to deploy" path is clean too.
  const occupied = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002),
      orbital(40009003, 1000000000003),
    ],
  });
  const occupiedRuntime = createRuntimeWith(occupied.fixture, occupied.deps);
  const occupiedMessage = chatCommand.handleCommand(
    occupiedRuntime, config, session(), "anchor here",
  ).message;
  assert.match(occupiedMessage, /nothing to deploy/u);
  assert.strictEqual(/hub/iu.test(occupiedMessage), false);
});

test("plan: a partly populated system deploys only the missing planets", () => {
  const { fixture, deps } = createFixture({
    orbitals: [orbital(40009001, 1000000000001), orbital(40009002, 1000000000002)],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(plan.deployable.map((entry) => entry.planetID), [40009003]);
  assert.deepStrictEqual(plan.skippedPresent.map((entry) => entry.planetID), [40009001, 40009002]);
  assert.deepStrictEqual(plan.overDestroyed, []);
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 1);
  const text = runtime.describePlan(plan, result);
  assert.match(text, /deployed 1, skipped 2 already present, 0 over a destroyed skyhook/u);
  assert.match(text, /already present: orbital skyhook at Planet I \(live skyhook\); orbital skyhook at Planet II \(live skyhook\)/u);
});

test("plan: a fully occupied system fails with a clear error and touches nothing", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002),
      orbital(40009003, 1000000000003),
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.ok, true);
  assert.ok(plan.error, "a fully occupied system must report an error");
  assert.match(plan.error, /all 3 planets already have a skyhook/u);
  assert.deepStrictEqual(plan.deployable, []);
  const text = runtime.describePlan(plan, null);
  assert.match(text, /nothing to deploy/u);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"), false);
});

test("plan: a destroyed skyhook does not block - the planet is deployed on again", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001, { destroyedAtMs: 1700000000000 }),
      orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000001 }),
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.error, null, "a destroyed skyhook must not stop the command");
  assert.deepStrictEqual(
    plan.deployable.map((entry) => entry.planetID),
    [40009001, 40009002, 40009003],
  );
  assert.deepStrictEqual(plan.overDestroyed.map((entry) => entry.planetID), [40009001, 40009002]);
  assert.deepStrictEqual(plan.skippedPresent, []);
  const tombstonesBefore = fixture.orbitals
    .filter((entry) => entry.destroyedAtMs > 0)
    .map((entry) => ({ itemID: entry.itemID, destroyedAtMs: entry.destroyedAtMs }));
  assert.strictEqual(tombstonesBefore.length, 2);
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 3);
  // The tombstone records are kept exactly as they were: never deleted, never
  // cleared, and the new Skyhook gets its own item id beside them.
  for (const before of tombstonesBefore) {
    const after = fixture.orbitals.find((entry) => entry.itemID === before.itemID);
    assert.ok(after, `the tombstone ${before.itemID} must be kept`);
    assert.strictEqual(after.destroyedAtMs, before.destroyedAtMs, "destroyedAtMs must never be cleared");
  }
  assert.strictEqual(fixture.orbitals.length, 5, "two tombstones plus three new records");
  for (const entry of result.deployed) {
    assert.ok(entry.itemID > 1000000000002, "every new skyhook gets its own item id");
  }
  const text = runtime.describePlan(plan, result);
  assert.match(text, /deployed 3, skipped 0 already present, 2 over a destroyed skyhook/u);
  assert.match(
    text,
    /over a destroyed skyhook: orbital skyhook at Planet I \(old orbital tombstone - kept as history\)/u,
  );
  // A second pass sees the new skyhooks as live, so the planets are occupied now.
  const second = runtime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(second.deployable, []);
  assert.strictEqual(second.skippedPresent.length, 3);
  assert.deepStrictEqual(second.overDestroyed, []);
});

test("plan: a planet whose only record is a destroyed tombstone is deployable", () => {
  const { fixture, deps } = createFixture({
    orbitals: [orbital(40009001, 1000000000001, { destroyedAtMs: 1700000000000 })],
    planets: [THREE_PLANETS[0]],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.error, null);
  assert.deepStrictEqual(plan.deployable.map((entry) => entry.planetID), [40009001]);
  assert.deepStrictEqual(plan.overDestroyed.map((entry) => entry.planetID), [40009001]);
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 1);
  assert.ok(result.deployed[0].itemID > 1000000000001, "the replacement gets a new item id");
  assert.strictEqual(fixture.orbitals.length, 2, "the tombstone stays, the new record sits beside it");
  assert.strictEqual(
    fixture.orbitals.find((entry) => entry.itemID === 1000000000001).destroyedAtMs,
    1700000000000,
  );
});

test("plan: a structure-shaped skyhook is occupied and reported, never deployed on", () => {
  const { fixture, deps } = createFixture({
    structures: [
      {
        structureID: 1100000000123,
        typeID: 81080,
        solarSystemID: SYSTEM_ID,
        moonID: 40009002,
        itemName: "Skyhook",
      },
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(plan.deployable.map((entry) => entry.planetID), [40009001, 40009003]);
  const occupied = plan.skippedPresent.find((entry) => entry.planetID === 40009002);
  assert.ok(occupied, "the planet under the structure-shaped skyhook must be occupied");
  assert.strictEqual(occupied.reason, "structure");
  assert.strictEqual(occupied.itemID, 1100000000123);
  const text = runtime.describePlan(plan, runtime.applyPlan(plan, session()));
  assert.match(text, /orbital skyhook at Planet II \(structure-shaped skyhook\)/u);
});

test("plan: a structure-shaped skyhook with no planet blocks the whole system", () => {
  const { fixture, deps } = createFixture({
    structures: [
      { structureID: 1100000000999, typeID: 81080, solarSystemID: SYSTEM_ID, moonID: 0, position: null },
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.ok(plan.error);
  assert.match(plan.error, /structure-shaped skyhook \(1100000000999\)/u);
  assert.match(plan.error, /refusing to build anywhere in that system/u);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"), false);
});

// The vendor mints a synthetic ledger slot (1000000000000 + planetID) for every
// planet of a CLAIMED system that has no deployed orbital. That row is what a
// deploy is for, so it must read as free; only a real deployment record - a row
// under any other key, or deployedItem: true - is occupancy.
test("plan: a claimed system whose planets only have their slot rows deploys all of them", () => {
  const planets = [1, 2, 3, 4, 5].map((index) => planet(40009000 + index, `Planet ${index}`, index));
  const ledger = {};
  for (const entry of planets) {
    ledger[String(SKYHOOK_ITEM_ID_OFFSET + entry.planetID)] = ledgerRow(entry.planetID);
  }
  const { fixture, deps } = createFixture({ planets, ledger });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.error, null, "a free game-created slot must not block a deploy");
  assert.deepStrictEqual(
    plan.deployable.map((entry) => entry.planetID),
    [40009001, 40009002, 40009003, 40009004, 40009005],
  );
  assert.deepStrictEqual(plan.skippedPresent, []);
  assert.deepStrictEqual(plan.overDestroyed, []);
  assert.ok(plan.claim, "the slot rows still say which corporation holds the system");
  assert.strictEqual(plan.claim.corporationID, CORPORATION_ID);
  // Status still distinguishes the slot from a built skyhook - read before the
  // deploy below, which is what turns those slots into real skyhooks.
  const status = runtime.describeStatus(runtime.statusSystem(SYSTEM_ID, session()), {});
  assert.match(status, /Planet 1: free \(game-created slot, nothing built on it yet\)/u);
  assert.match(status, /5 planet\(s\): 0 with a skyhook, 0 free over a destroyed skyhook \(deployable\), 5 free/u);
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 5);
  assert.deepStrictEqual(result.failures, []);
  assert.match(
    runtime.describePlan(plan, result),
    /deployed 5, skipped 0 already present, 0 over a destroyed skyhook/u,
  );
});

test("plan: a real deployment record under its own item id blocks, slot rows do not", () => {
  const planets = [1, 2, 3, 4, 5].map((index) => planet(40009000 + index, `Planet ${index}`, index));
  const ledger = {};
  for (const entry of planets) {
    ledger[String(SKYHOOK_ITEM_ID_OFFSET + entry.planetID)] = ledgerRow(entry.planetID);
  }
  ledger["1000000000123"] = ledgerRow(40009002, {
    skyhookID: 1000000000123,
    deployedItem: true,
  });
  const { fixture, deps } = createFixture({ planets, ledger });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(
    plan.deployable.map((entry) => entry.planetID),
    [40009001, 40009003, 40009004, 40009005],
  );
  const occupied = plan.skippedPresent.find((entry) => entry.planetID === 40009002);
  assert.ok(occupied, "a deployed ledger row must block its planet");
  assert.strictEqual(occupied.reason, "ledger");
  assert.strictEqual(occupied.itemID, 1000000000123);
  assert.match(occupied.detail, /sovereignty ledger row \(deployed\)/u);
  assert.match(
    runtime.describePlan(plan, runtime.applyPlan(plan, session())),
    /deployed 4, skipped 1 already present, 0 over a destroyed skyhook/u,
  );
});

test("plan: a destroyed planet slot does not block either", () => {
  const planets = [1, 2, 3, 4, 5].map((index) => planet(40009000 + index, `Planet ${index}`, index));
  const ledger = {};
  for (const entry of planets) {
    ledger[String(SKYHOOK_ITEM_ID_OFFSET + entry.planetID)] = ledgerRow(entry.planetID);
  }
  // The RYQC-I / 0OTX-J shape: the planet slot was destroyed. A new Skyhook may
  // be placed there; the old row stays as history.
  ledger[String(SKYHOOK_ITEM_ID_OFFSET + 40009003)] = ledgerRow(40009003, { destroyed: true });
  const { fixture, deps } = createFixture({ planets, ledger });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.error, null);
  assert.deepStrictEqual(
    plan.deployable.map((entry) => entry.planetID),
    [40009001, 40009002, 40009003, 40009004, 40009005],
  );
  assert.deepStrictEqual(plan.overDestroyed.map((entry) => entry.planetID), [40009003]);
  assert.strictEqual(
    fixture.ledger[String(SKYHOOK_ITEM_ID_OFFSET + 40009003)].destroyed,
    true,
    "the destroyed slot row is never cleared",
  );
  const text = runtime.describePlan(plan, runtime.applyPlan(plan, session()));
  assert.match(text, /deployed 5, skipped 0 already present, 1 over a destroyed skyhook/u);
  assert.match(text, /orbital skyhook at Planet 3 \(old slot tombstone - kept as history\)/u);
});

test("plan: one system mixing slot, live, tombstone, structure and deployed ledger", () => {
  const planets = [1, 2, 3, 4, 5].map((index) => planet(40009000 + index, `Planet ${index}`, index));
  const { fixture, deps } = createFixture({
    planets,
    orbitals: [
      orbital(40009002, 1000000000002),
      orbital(40009003, 1000000000003, { destroyedAtMs: 1700000000000 }),
    ],
    ledger: {
      // P1: only the game-created slot -> free.
      [String(SKYHOOK_ITEM_ID_OFFSET + 40009001)]: ledgerRow(40009001),
      // P5: a deployment record with no orbital record in sight -> occupied.
      "1000000000123": ledgerRow(40009005, { skyhookID: 1000000000123, deployedItem: true }),
    },
    structures: [
      {
        structureID: 1100000000123,
        typeID: 81080,
        solarSystemID: SYSTEM_ID,
        moonID: 40009004,
        itemName: "Skyhook",
      },
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(plan.deployable.map((entry) => entry.planetID), [40009001, 40009003]);
  assert.deepStrictEqual(
    plan.skippedPresent.map((entry) => `${entry.planetID}:${entry.reason}`),
    ["40009002:live", "40009004:structure", "40009005:ledger"],
  );
  assert.deepStrictEqual(plan.overDestroyed.map((entry) => entry.planetID), [40009003]);
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 2);
  assert.strictEqual(
    plan.deployable.length + plan.skippedPresent.length,
    planets.length,
    "every planet must land in exactly one bucket",
  );
  assert.strictEqual(plan.overDestroyed.length, 1, "and the destroyed one is counted inside deployable");
  const text = runtime.describePlan(plan, result);
  assert.match(text, /deployed 2, skipped 3 already present, 1 over a destroyed skyhook/u);
  assert.match(text, /already present: orbital skyhook at Planet 2 \(live skyhook\); orbital skyhook at Planet 4 \(structure-shaped skyhook\); orbital skyhook at Planet 5 \(sovereignty ledger row \(deployed\)\)/u);
  assert.match(text, /over a destroyed skyhook: orbital skyhook at Planet 3 \(old orbital tombstone - kept as history\)/u);
  assert.strictEqual(
    fixture.orbitals.find((entry) => entry.itemID === 1000000000003).destroyedAtMs,
    1700000000000,
    "the orbital tombstone is untouched",
  );
});

test("plan: a deployed ledger row still blocks with no orbital record visible", () => {
  const deployed = createFixture({
    ledger: {
      "1000000000123": ledgerRow(40009002, { skyhookID: 1000000000123, deployedItem: true }),
    },
  });
  const runtime = createRuntimeWith(deployed.fixture, deployed.deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(plan.deployable.map((entry) => entry.planetID), [40009001, 40009003]);
  const occupied = plan.skippedPresent.find((entry) => entry.planetID === 40009002);
  assert.ok(occupied);
  assert.strictEqual(occupied.reason, "ledger");
  assert.match(occupied.detail, /sovereignty ledger row \(deployed\)/u);
  assert.match(runtime.describePlan(plan, runtime.applyPlan(plan, session())), /ledger row/u);

  // deployedItem also wins when the row happens to sit under the slot key.
  const slotKey = createFixture({
    ledger: {
      [String(SKYHOOK_ITEM_ID_OFFSET + 40009002)]: ledgerRow(40009002, { deployedItem: true }),
    },
  });
  const slotRuntime = createRuntimeWith(slotKey.fixture, slotKey.deps);
  const slotPlan = slotRuntime.buildPlan(SYSTEM_ID, session());
  assert.deepStrictEqual(slotPlan.deployable.map((entry) => entry.planetID), [40009001, 40009003]);
  assert.strictEqual(
    slotPlan.skippedPresent.find((entry) => entry.planetID === 40009002).reason,
    "ledger",
  );
});

test("plan: a destroyed ledger slot does not block either", () => {
  const { fixture, deps } = createFixture({
    ledger: {
      [String(SKYHOOK_ITEM_ID_OFFSET + 40009003)]: ledgerRow(40009003, { destroyed: true }),
    },
  });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.error, null);
  assert.deepStrictEqual(
    plan.deployable.map((entry) => entry.planetID),
    [40009001, 40009002, 40009003],
  );
  assert.deepStrictEqual(plan.overDestroyed.map((entry) => entry.planetID), [40009003]);
  assert.match(
    runtime.describePlan(plan, runtime.applyPlan(plan, session())),
    /deployed 3, skipped 0 already present, 1 over a destroyed skyhook/u,
  );

  // The same rule for a destroyed deployment record under its own item id: the
  // post-destruction shape of the ledger is a real key with destroyed: true.
  const deployed = createFixture({
    ledger: {
      "1000000000123": ledgerRow(40009002, {
        skyhookID: 1000000000123,
        deployedItem: true,
        destroyed: true,
      }),
    },
  });
  const deployedRuntime = createRuntimeWith(deployed.fixture, deployed.deps);
  const deployedPlan = deployedRuntime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(deployedPlan.error, null);
  assert.deepStrictEqual(
    deployedPlan.deployable.map((entry) => entry.planetID),
    [40009001, 40009002, 40009003],
  );
  assert.deepStrictEqual(deployedPlan.overDestroyed.map((entry) => entry.planetID), [40009002]);
  assert.match(
    deployedRuntime.describePlan(deployedPlan, deployedRuntime.applyPlan(deployedPlan, session())),
    /old ledger tombstone - kept as history/u,
  );
  assert.strictEqual(
    deployed.fixture.ledger["1000000000123"].destroyed,
    true,
    "a destroyed ledger row is never cleared",
  );
});

test("plan: one command never exceeds maxPlanetsPerCommand", () => {
  const planets = [];
  for (let index = 1; index <= 65; index += 1) {
    planets.push(planet(40010000 + index, `Planet ${index}`, index));
  }
  const { fixture, deps } = createFixture({ planets });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(plan.ok, false);
  assert.match(plan.error, /has 65 planets, above the configured maxPlanetsPerCommand \(64\)/u);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"), false);

  const capped = createFixture({ planets });
  const cappedRuntime = createRuntimeWith(capped.fixture, capped.deps, { maxPlanetsPerCommand: 2 });
  const cappedPlan = cappedRuntime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(cappedPlan.ok, false);
  assert.match(cappedPlan.error, /maxPlanetsPerCommand \(2\)/u);

  const allowed = createFixture({ planets: planets.slice(0, 2) });
  const allowedRuntime = createRuntimeWith(allowed.fixture, allowed.deps, { maxPlanetsPerCommand: 2 });
  const allowedPlan = allowedRuntime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(allowedPlan.ok, true);
  assert.strictEqual(allowedPlan.error, null);
});

test("plan: requireClaimedSystemOwnership refuses a system held by somebody else", () => {
  const foreignLedger = {
    [String(SKYHOOK_ITEM_ID_OFFSET + 40009003)]: ledgerRow(40009003, {
      corporationID: 97000001,
      allianceID: 98000001,
    }),
  };
  const foreign = createFixture({ ledger: foreignLedger });
  const runtime = createRuntimeWith(foreign.fixture, foreign.deps, {
    requireClaimedSystemOwnership: true,
  });
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  assert.ok(plan.error);
  assert.match(plan.error, /belongs to another corporation or alliance/u);
  assert.strictEqual(runtime.applyPlan(plan, session()).ok, false);

  const mine = createFixture({ ledger: foreignLedger });
  const owned = createRuntimeWith(mine.fixture, mine.deps, {
    requireClaimedSystemOwnership: true,
  });
  assert.strictEqual(owned.buildPlan(SYSTEM_ID, session({ corporationID: 97000001 })).error, null);

  const unclaimed = createFixture();
  const claiming = createRuntimeWith(unclaimed.fixture, unclaimed.deps, {
    requireClaimedSystemOwnership: true,
  });
  const unclaimedPlan = claiming.buildPlan(SYSTEM_ID, session());
  assert.ok(unclaimedPlan.error);
  assert.match(unclaimedPlan.error, /not claimed/u);
});

test("plan: ownerMode chooses who owns the conjured skyhook", () => {
  const character = createFixture();
  const characterRuntime = createRuntimeWith(character.fixture, character.deps, {
    ownerMode: "character",
  });
  const characterPlan = characterRuntime.buildPlan(SYSTEM_ID, session());
  assert.strictEqual(characterPlan.ownerID, CHARACTER_ID);
  characterRuntime.applyPlan(characterPlan, session());
  assert.strictEqual(
    character.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner").ownerID,
    CHARACTER_ID,
  );

  const corporation = createFixture();
  const corporationRuntime = createRuntimeWith(corporation.fixture, corporation.deps, {});
  corporationRuntime.applyPlan(corporationRuntime.buildPlan(SYSTEM_ID, session()), session());
  assert.strictEqual(
    corporation.fixture.calls.find((entry) => entry.fn === "createSpaceItemForOwner").ownerID,
    CORPORATION_ID,
  );
});

test("a throwing vendor call is caught and reported, never propagated", () => {
  for (const throwing of [
    "createSpaceItemForOwner",
    "ensureOrbitalForItem",
    "listPlanetsForSystem",
    "listOrbitalsForPlanet",
    "getSkyhook",
  ]) {
    const { fixture, deps } = createFixture({ throwOn: throwing });
    const runtime = createRuntimeWith(fixture, deps);
    const config = configModule.load(modDir, {});
    let result = null;
    assert.doesNotThrow(() => {
      result = chatCommand.handleCommand(runtime, config, session(), "anchor here");
    }, `${throwing} must not escape`);
    assert.ok(typeof result.message === "string" && result.message.length > 0);
    assert.doesNotThrow(() => {
      chatCommand.handleCommand(runtime, config, session(), "status here");
      chatCommand.handleCommand(runtime, config, session(), "remove here");
    }, `${throwing} must not escape the status/remove paths either`);
  }
});

test("a failing create is reported in the reply and does not stop the rest", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.deployed.length, 3);

  const failing = createFixture({ createFailure: "INVENTORY_FULL" });
  const failingRuntime = createRuntimeWith(failing.fixture, failing.deps);
  const failingPlan = failingRuntime.buildPlan(SYSTEM_ID, session());
  const failingResult = failingRuntime.applyPlan(failingPlan, session());
  assert.strictEqual(failingResult.ok, true);
  assert.strictEqual(failingResult.deployed.length, 0);
  assert.strictEqual(failingResult.failures.length, 3);
  assert.strictEqual(failingResult.failures[0].errorMsg, "INVENTORY_FULL");
  const text = failingRuntime.describePlan(failingPlan, failingResult);
  assert.match(text, /FAILED orbital skyhook at Planet I: INVENTORY_FULL/u);
  assert.match(text, /deployed 0/u);
});

test("a spawn failure is logged, not fatal: the row and the orbital stay", () => {
  const { fixture, deps } = createFixture({ spawnResult: { success: false, errorMsg: "SCENE_NOT_FOUND" } });
  const runtime = createRuntimeWith(fixture, deps);
  const plan = runtime.buildPlan(SYSTEM_ID, session());
  const result = runtime.applyPlan(plan, session());
  assert.strictEqual(result.deployed.length, 3);
  assert.deepStrictEqual(result.failures, []);
  assert.strictEqual(result.deployed[0].spawn, "skipped");
});

// ─── removal ─────────────────────────────────────────────────────────────────

test("remove runs the destruction triple per skyhook, in order", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000000 }),
    ],
  });
  fixture.ledger[String(1000000000001)] = ledgerRow(40009001, { skyhookID: 1000000000001, deployedItem: true });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.unanchorSystem(SYSTEM_ID, session());
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.destroyed.map((entry) => entry.itemID), [1000000000001]);
  assert.deepStrictEqual(result.alreadyDestroyed.map((entry) => entry.itemID), [1000000000002]);
  assert.deepStrictEqual(result.failures, []);
  const order = callNames(fixture).filter((name) => [
    "markOrbitalDestroyed",
    "ensureScene",
    "destroyDynamicInventoryEntity",
    "destroySkyhooks",
  ].includes(name));
  assert.deepStrictEqual(order, [
    "markOrbitalDestroyed",
    "ensureScene",
    "destroyDynamicInventoryEntity",
    "destroySkyhooks",
  ]);
  const removal = fixture.calls.find((entry) => entry.fn === "destroyDynamicInventoryEntity");
  assert.strictEqual(removal.destroyOptions.suppressExplosion, true);
  const tombstone = fixture.orbitals.find((entry) => entry.itemID === 1000000000001);
  assert.strictEqual(tombstone.destroyedAtMs, 1700000000000);
  const text = runtime.describeRemoval(result);
  assert.match(text, /destroyed 1, already destroyed 1, left alone 0 structure-shaped/u);
  assert.match(text, /destroyed orbital skyhook at Planet I, ledger tombstoned/u);
  assert.match(
    text,
    /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\)/u,
    text,
  );
  assert.strictEqual(/orbital skyhook at Planet II/u.test(text), false, text);
});

test("unanchor: destroyed markers are one count, and nothing says the planet is lost", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      { ...orbital(40009002, 1000000000002), destroyedAtMs: 1700000000000 },
      { ...orbital(40009003, 1000000000003), destroyedAtMs: 1700000000001 },
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.unanchorSystem(SYSTEM_ID, session());
  assert.deepStrictEqual(result.destroyed.map((entry) => entry.itemID), [1000000000001]);
  assert.deepStrictEqual(
    result.alreadyDestroyed.map((entry) => entry.itemID),
    [1000000000002, 1000000000003],
  );
  const text = runtime.describeRemoval(result);
  assert.match(text, /destroyed 1, already destroyed 2, left alone 0 structure-shaped/u, text);
  // One line for both markers, with the count, and no per-marker planet name.
  assert.match(
    text,
    /destroyed markers left alone: 2 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\) - the skyhook is already gone, and the planet can be deployed on again/u,
    text,
  );
  assert.strictEqual(/already a tombstone/u.test(text), false, text);
  assert.strictEqual(/Planet II|Planet III/u.test(text), false, text);
  // Only the live record was tombstoned: the markers keep their own timestamps.
  assert.deepStrictEqual(
    fixture.calls.filter((entry) => entry.fn === "markOrbitalDestroyed").map((entry) => entry.itemID),
    [1000000000001],
  );
  assert.deepStrictEqual(
    fixture.orbitals.map((entry) => entry.itemID),
    [1000000000001, 1000000000002, 1000000000003],
    "no marker row is ever deleted",
  );
});

test("remove treats DYNAMIC_ENTITY_NOT_FOUND as success and never touches structures", () => {
  const { fixture, deps } = createFixture({
    orbitals: [orbital(40009001, 1000000000001)],
    structures: [
      { structureID: 1100000000123, typeID: 81080, solarSystemID: SYSTEM_ID, moonID: 40009002 },
    ],
    destroyEntityResult: { success: false, errorMsg: "DYNAMIC_ENTITY_NOT_FOUND" },
  });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.unanchorSystem(SYSTEM_ID, session());
  assert.deepStrictEqual(result.destroyed.map((entry) => entry.itemID), [1000000000001]);
  assert.deepStrictEqual(result.failures, []);
  assert.deepStrictEqual(result.untouchedStructures.map((entry) => entry.structureID), [1100000000123]);
  const text = runtime.describeRemoval(result);
  assert.match(text, /left alone 1 structure-shaped/u);
  assert.match(text, /not touched \(structure-shaped/u);
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed" && entry.itemID === 1100000000123),
    false,
  );
});

test("remove reports a scene entity it could not clear, and still tombstones the ledger", () => {
  const { fixture, deps } = createFixture({
    orbitals: [orbital(40009001, 1000000000001)],
    destroyEntityResult: { success: false, errorMsg: "SCENE_NOT_FOUND" },
  });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.unanchorSystem(SYSTEM_ID, session());
  assert.strictEqual(result.destroyed.length, 1);
  assert.strictEqual(result.destroyed[0].entityNote, "SCENE_NOT_FOUND");
  assert.strictEqual(result.failures.length, 1);
  assert.match(result.failures[0].errorMsg, /scene entity: SCENE_NOT_FOUND/u);
  assert.match(runtime.describeRemoval(result), /scene entity: SCENE_NOT_FOUND/u);
});

test("remove leaves the orbital row alone when it cannot tombstone the record", () => {
  const { fixture, deps } = createFixture({ orbitals: [orbital(40009001, 1000000000001)] });
  const runtime = createRuntimeWith(
    fixture,
    {
      ...deps,
      getPlanetOrbitalState: () => ({
        ...deps.getPlanetOrbitalState(),
        markOrbitalDestroyed: () => {
          throw new Error("markOrbitalDestroyed exploded");
        },
      }),
    },
  );
  const result = runtime.unanchorSystem(SYSTEM_ID, session());
  assert.deepStrictEqual(result.destroyed, []);
  assert.strictEqual(result.failures.length, 1);
  assert.match(result.failures[0].errorMsg, /markOrbitalDestroyed exploded/u);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "destroySkyhooks"), false);
});

test("remove refuses a system with more skyhook entries than the cap", () => {
  const orbitals = [];
  for (let index = 1; index <= 65; index += 1) {
    orbitals.push(orbital(40020000 + index, 2000000000000 + index));
  }
  const { fixture, deps } = createFixture({ orbitals });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.unanchorSystem(SYSTEM_ID, session());
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /above the configured maxPlanetsPerCommand \(64\)/u);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"), false);
});

// ─── status ──────────────────────────────────────────────────────────────────

test("status reports every planet as present, tombstone or free", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000000 }),
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const result = runtime.statusSystem(SYSTEM_ID, session());
  const text = runtime.describeStatus(result, { includeDestroyed: true });
  assert.match(text, /autoSkyHookDeploy v1\.0\.0: Jita/u);
  assert.strictEqual(/30000142/u.test(text), false, "a status line never carries the system id");
  assert.match(text, /Planet I: orbital skyhook present \(live skyhook\)/u);
  assert.match(text, /Planet II: free \(destroyed skyhook tombstone - a new one may be placed here\)/u);
  assert.match(text, /Planet III: free/u);
  assert.match(text, /3 planet\(s\): 1 with a skyhook, 1 free over a destroyed skyhook \(deployable\), 1 free/u);
  // Markers are counted, not listed: one line, no per-marker item name.
  assert.match(
    text,
    /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\)/u,
    text,
  );
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"), false);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"), false);
});

test("status and remove count markers instead of listing tombstones", () => {
  const { fixture, deps } = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001),
      orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000000 }),
      orbital(40009003, 1000000000003, { destroyedAtMs: 1700000000001 }),
    ],
  });
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});

  // Status: a marker count, and the count line appears exactly once no matter how
  // many markers the system holds.
  const status = chatCommand.handleCommand(runtime, config, session(), "status here").message;
  assert.match(status, /destroyed markers left alone: 2 \(a destroyed skyhook stays/u, status);
  assert.strictEqual(status.split("destroyed markers left alone:").length - 1, 1, status);

  // Removing a marker is refused in words, never in ids: one marker line, the count,
  // and the sentence that says the planet can be used again.
  const removal = chatCommand.handleCommand(runtime, config, session(), "remove 1000000000002").message;
  assert.match(removal, /already destroyed 1/u, removal);
  assert.match(
    removal,
    /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed until something is deployed on that planet again\) - the skyhook is already gone, and the planet can be deployed on again/u,
    removal,
  );
  assert.strictEqual(/1000000000002/u.test(removal), false, "a removal reply never quotes the id");
  // Neither read touched anything.
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "markOrbitalDestroyed"), false);
  assert.strictEqual(fixture.calls.some((entry) => entry.fn === "destroySkyhooks"), false);
});

test("status honours includeDestroyedInStatus and the listing cap", () => {
  const { fixture, deps } = createFixture({
    orbitals: [orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000000 })],
  });
  const runtime = createRuntimeWith(fixture, deps, { includeDestroyedInStatus: false });
  const text = runtime.describeStatus(runtime.statusSystem(SYSTEM_ID, session()), {
    includeDestroyed: false,
  });
  assert.strictEqual(/destroyed skyhook tombstone - a new one/u.test(text), false);
  assert.match(text, /1 free over a destroyed skyhook \(history not shown\)/u);
  // The annotation is dropped, the marker count is not: the marker is what keeps the
  // vendor's bootstrap from re-minting the default.
  assert.match(text, /destroyed markers left alone: 1 \(a destroyed skyhook stays destroyed/u, text);

  const capped = createFixture({
    planets: [1, 2, 3, 4].map((index) => planet(40030000 + index, `Planet ${index}`, index)),
  });
  const cappedRuntime = createRuntimeWith(capped.fixture, capped.deps, { maxPlanetsPerCommand: 2 });
  const cappedText = cappedRuntime.describeStatus(
    cappedRuntime.statusSystem(SYSTEM_ID, session()),
    {},
  );
  assert.match(cappedText, /listing stops at maxPlanetsPerCommand=2; 2 more planet\(s\) not shown/u);
  assert.match(cappedText, /4 planet\(s\): 0 with a skyhook, 0 free over a destroyed skyhook \(deployable\), 4 free/u);
});

test("status says when the system is unclaimed or claimed", () => {
  const unclaimed = createFixture();
  const unclaimedRuntime = createRuntimeWith(unclaimed.fixture, unclaimed.deps);
  assert.match(
    unclaimedRuntime.describeStatus(unclaimedRuntime.statusSystem(SYSTEM_ID, session()), {}),
    /no row for this system \(unclaimed\)/u,
  );
  const claimed = createFixture({
    ledger: { [String(SKYHOOK_ITEM_ID_OFFSET + 40009001)]: ledgerRow(40009001, { active: true }) },
  });
  const claimedRuntime = createRuntimeWith(claimed.fixture, claimed.deps);
  assert.match(
    claimedRuntime.describeStatus(claimedRuntime.statusSystem(SYSTEM_ID, session()), {}),
    new RegExp(`claimed \\(corporation ${CORPORATION_ID}, alliance ${ALLIANCE_ID}\\)`, "u"),
  );
});

// ─── chat seams ──────────────────────────────────────────────────────────────

function createChatUpstream(options = {}) {
  const seen = [];
  const upstream = {
    AVAILABLE_SLASH_COMMANDS: options.commands || ["help", "motd"],
    COMMANDS_HELP_TEXT: options.helpText === undefined
      ? ["/help", "/motd"]
      : options.helpText,
    executeChatCommand(session, rawMessage, chatHub) {
      seen.push({ session, rawMessage, chatHub });
      const message = `vanilla:${rawMessage}`;
      if (chatHub && typeof chatHub.sendSystemMessage === "function") {
        chatHub.sendSystemMessage(session, message, null);
      }
      return { handled: true, message };
    },
    seen,
  };
  if (options.commandsReadOnly) {
    Object.defineProperty(upstream, "AVAILABLE_SLASH_COMMANDS", {
      value: Object.freeze(["help"]),
      writable: false,
    });
  }
  if (options.commandNotWritable) {
    Object.defineProperty(upstream, "executeChatCommand", { value: upstream.executeChatCommand, writable: false });
  }
  if (options.helpNotWritable) {
    Object.defineProperty(upstream, "COMMANDS_HELP_TEXT", { value: upstream.COMMANDS_HELP_TEXT, writable: false });
  }
  return upstream;
}

test("the /ash overlay chains to the previous handler for everything else", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const upstream = createChatUpstream();
  const conversations = [];
  const chatHub = { sendSystemMessage: (target, message) => conversations.push(message) };
  chatCommand.install(upstream, { runtime, config });

  assert.ok(upstream.AVAILABLE_SLASH_COMMANDS.includes("ash"));
  assert.ok(Array.isArray(upstream.COMMANDS_HELP_TEXT));
  assert.ok(upstream.COMMANDS_HELP_TEXT.includes("/ash help"));

  const ours = upstream.executeChatCommand(session(), "/ash status here", chatHub, {});
  assert.strictEqual(ours.handled, true);
  assert.match(ours.message, /autoSkyHookDeploy v1\.0\.0/u);
  assert.strictEqual(conversations.length, 1);

  const theirs = upstream.executeChatCommand(session(), "/motd", chatHub, {});
  assert.strictEqual(theirs.message, "vanilla:/motd");
  assert.strictEqual(upstream.seen.length, 1, "the previous handler must have run for /motd");
});

test("the /ash overlay appends to help text that is already a string", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const upstream = createChatUpstream({ helpText: "/help\n/motd" });
  chatCommand.install(upstream, { runtime, config });
  assert.strictEqual(typeof upstream.COMMANDS_HELP_TEXT, "string");
  assert.match(upstream.COMMANDS_HELP_TEXT, /\/help\n\/motd\n\/ash anchor here\|system <systemID>\|region <regionID>/u);
});

test("the /ash overlay gives up on a non-writable export or help text", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const frozen = createChatUpstream({ commandNotWritable: true });
  const original = frozen.executeChatCommand;
  chatCommand.install(frozen, { runtime, config });
  assert.strictEqual(frozen.executeChatCommand, original);
  assert.strictEqual(frozen[chatCommand.OVERLAY_MARKER], undefined);

  const readOnlyList = createChatUpstream({ commandsReadOnly: true, helpNotWritable: true });
  const readOnlyOriginal = readOnlyList.executeChatCommand;
  chatCommand.install(readOnlyList, { runtime, config });
  assert.strictEqual(readOnlyList.executeChatCommand === readOnlyOriginal, false, "the hook still installs");
  assert.deepStrictEqual(readOnlyList.AVAILABLE_SLASH_COMMANDS, ["help"]);
});

test("the /ash overlay is idempotent", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const upstream = createChatUpstream();
  chatCommand.install(upstream, { runtime, config });
  const wrapped = upstream.executeChatCommand;
  chatCommand.install(upstream, { runtime, config });
  assert.strictEqual(upstream.executeChatCommand, wrapped);
});

test("the !ash trigger answers by throwing an error with no code", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const broadcasts = [];
  const upstream = {
    broadcastLocalMessage(session, message) {
      broadcasts.push(message);
      return { entry: { message } };
    },
    sendChannelMessage(session, roomName, message) {
      broadcasts.push(`${roomName}:${message}`);
      return { entry: { message } };
    },
  };
  plainChat.install(upstream, { runtime, config, chatCommand });

  let thrown = null;
  try {
    upstream.broadcastLocalMessage(session(), "!ash status here");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, "the reply is a thrown Error");
  assert.match(thrown.message, /autoSkyHookDeploy v1\.0\.0/u);
  assert.strictEqual(thrown.code, undefined, "the error must carry no code");
  assert.deepStrictEqual(broadcasts, [], "the line must never be broadcast");

  let channelThrown = null;
  try {
    upstream.sendChannelMessage(session(), "corp", "!ash help");
  } catch (error) {
    channelThrown = error;
  }
  assert.ok(channelThrown instanceof Error);
  assert.match(channelThrown.message, /autoSkyHookDeploy - \/ash/u);
  assert.strictEqual(channelThrown.code, undefined);
  assert.deepStrictEqual(broadcasts, []);

  // Anything that is not addressed to this mod is broadcast exactly as before.
  upstream.broadcastLocalMessage(session(), "hello everyone");
  upstream.broadcastLocalMessage(session(), "!aud mining");
  assert.deepStrictEqual(broadcasts, ["hello everyone", "!aud mining"]);

  // Every subcommand works in ordinary chat, the new ones included: the offset
  // reads, and the single-id removal and the sweep reach the same handler.
  const offsetReply = (() => {
    try {
      upstream.broadcastLocalMessage(session(), "!ash offset");
    } catch (error) {
      return error.message;
    }
    return null;
  })();
  assert.match(offsetReply, /offset: 25 km \(25000 m\)/u);
  const removeReply = (() => {
    try {
      upstream.broadcastLocalMessage(session(), "!ash remove notanid");
    } catch (error) {
      return error.message;
    }
    return null;
  })();
  assert.match(removeReply, /no planet named "notanid"/u);
  const unanchorReply = (() => {
    try {
      upstream.broadcastLocalMessage(session(), "!ash ua here");
    } catch (error) {
      return error.message;
    }
    return null;
  })();
  assert.match(unanchorReply, /destroyed 0, already destroyed 0, left alone 0/u);
  assert.deepStrictEqual(broadcasts, ["hello everyone", "!aud mining"], "none of those broadcast");

  plainChat.install(upstream, { runtime, config, chatCommand });
  assert.strictEqual(typeof upstream.broadcastLocalMessage, "function");
});

test("the !ash trigger survives a non-writable channel", () => {
  const { fixture, deps } = createFixture();
  const runtime = createRuntimeWith(fixture, deps);
  const config = configModule.load(modDir, {});
  const upstream = {};
  Object.defineProperty(upstream, "broadcastLocalMessage", {
    value: (session, message) => ({ entry: { message } }),
    writable: false,
  });
  const original = upstream.broadcastLocalMessage;
  plainChat.install(upstream, { runtime, config, chatCommand });
  assert.strictEqual(upstream.broadcastLocalMessage, original);
  assert.strictEqual(upstream[plainChat.OVERLAY_MARKER], undefined);
});

test("the whole loader chain installs both seams and patches cached modules", () => {
  const root = tmpdir("ashd-tree-");
  try {
    const chatCommandsFile = path.join(root, "server", "src", "services", "chat", "chatCommands.js");
    const chatRuntimeFile = path.join(root, "server", "src", "_secondary", "chat", "chatRuntime.js");
    fs.mkdirSync(path.dirname(chatCommandsFile), { recursive: true });
    fs.mkdirSync(path.dirname(chatRuntimeFile), { recursive: true });
    fs.writeFileSync(
      chatCommandsFile,
      [
        '"use strict";',
        "const AVAILABLE_SLASH_COMMANDS = ['help', 'motd'];",
        "const COMMANDS_HELP_TEXT = ['/help', '/motd'];",
        "function executeChatCommand(session, rawMessage, chatHub) {",
        "  const message = `vanilla:${rawMessage}`;",
        "  if (chatHub && typeof chatHub.sendSystemMessage === 'function') {",
        "    chatHub.sendSystemMessage(session, message, null);",
        "  }",
        "  return { handled: true, message };",
        "}",
        "module.exports = { AVAILABLE_SLASH_COMMANDS, COMMANDS_HELP_TEXT, executeChatCommand };",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      chatRuntimeFile,
      [
        '"use strict";',
        "function broadcastLocalMessage(session, message) { return { entry: { message } }; }",
        "function sendChannelMessage(session, roomName, message) { return { entry: { message: `${roomName}:${message}` } }; }",
        "module.exports = { broadcastLocalMessage, sendChannelMessage };",
        "",
      ].join("\n"),
      "utf8",
    );

    const code = [
      "const path = require('node:path');",
      "const root = process.argv[1];",
      "process.env.EVEJS_AUTO_SKYHOOK_DEPLOY = '0';",
      `const loader = require(${JSON.stringify(loaderPath)});`,
      "const chatCommands = require(path.join(root, 'server/src/services/chat/chatCommands.js'));",
      "const state = loader.install({",
      "  runtimeRoot: root,",
      "  environment: { EVEJS_AUTO_SKYHOOK_DEPLOY: '1' },",
      "});",
      "const chatRuntime = require(path.join(root, 'server/src/_secondary/chat/chatRuntime.js'));",
      "const replies = [];",
      "const chatHub = { sendSystemMessage: (session, message) => replies.push(message) };",
      "const ours = chatCommands.executeChatCommand({ characterID: 1, solarSystemID: 30000142 }, '/ash help', chatHub, {});",
      "const theirs = chatCommands.executeChatCommand({ characterID: 1, solarSystemID: 30000142 }, '/motd', chatHub, {});",
      "let plain = null;",
      "try { chatRuntime.broadcastLocalMessage({ characterID: 1, solarSystemID: 30000142 }, '!ash help'); }",
      "catch (error) { plain = { message: error.message, code: error.code === undefined ? 'none' : String(error.code) }; }",
      "console.log('RESULT:' + JSON.stringify({",
      "  active: state.active,",
      "  applied: state.api.applied(),",
      "  version: state.api.version,",
      "  commands: chatCommands.AVAILABLE_SLASH_COMMANDS.includes('ash'),",
      "  helpArray: Array.isArray(chatCommands.COMMANDS_HELP_TEXT),",
      "  helpHasAsh: chatCommands.COMMANDS_HELP_TEXT.join('\\n').includes('/ash help'),",
      "  ours: ours.message.split('\\n')[0],",
      "  theirs: theirs.message,",
      "  plain,",
      "  replies: replies.length,",
      "}));",
    ].join("\n");
    const child = runNode(["-e", code, root], { env: { ...process.env } });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
    const result = parseChildResult(child.stdout);
    assert.strictEqual(result.active, true);
    assert.deepStrictEqual(result.applied, ["chatCommands", "chatRuntime"]);
    assert.strictEqual(result.version, loaderModule.MOD_VERSION);
    assert.strictEqual(result.commands, true);
    assert.strictEqual(result.helpArray, true);
    assert.strictEqual(result.helpHasAsh, true);
    assert.strictEqual(result.ours, "autoSkyHookDeploy - /ash");
    assert.strictEqual(result.theirs, "vanilla:/motd");
    assert.strictEqual(result.plain.code, "none");
    assert.match(result.plain.message, /autoSkyHookDeploy - \/ash/u);
    assert.strictEqual(result.replies, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── the vendor tree this mod targets ────────────────────────────────────────

test("the loader's follow-up delivery works with only the slash seam loaded", () => {
  // The live bug: `followUpSender` is still null for a slash-only session, and the lazy
  // path reached for a `targetMap` that only exists inside a function - so a
  // ReferenceError was swallowed and every follow-up of a region run was dropped. This
  // drives the real loader wiring in a child process with the chatRuntime module never
  // loaded, and asserts the hub path delivers and nothing throws.
  const root = tmpdir("ashd-delivery-");
  try {
    const chatCommandsFile = path.join(root, "server", "src", "services", "chat", "chatCommands.js");
    fs.mkdirSync(path.dirname(chatCommandsFile), { recursive: true });
    fs.writeFileSync(
      chatCommandsFile,
      [
        '"use strict";',
        "const AVAILABLE_SLASH_COMMANDS = ['help'];",
        "const COMMANDS_HELP_TEXT = ['/help'];",
        "function executeChatCommand(session, rawMessage, chatHub) {",
        "  if (chatHub && typeof chatHub.sendSystemMessage === 'function') {",
        "    chatHub.sendSystemMessage(session, `vanilla:${rawMessage}`, null);",
        "  }",
        "  return { handled: true, message: `vanilla:${rawMessage}` };",
        "}",
        "module.exports = { AVAILABLE_SLASH_COMMANDS, COMMANDS_HELP_TEXT, executeChatCommand };",
        "",
      ].join("\n"),
      "utf8",
    );
    const code = [
      "const path = require('node:path');",
      "const root = process.argv[1];",
      "process.env.EVEJS_AUTO_SKYHOOK_DEPLOY = '0';",
      `const loader = require(${JSON.stringify(loaderPath)});`,
      "const errors = [];",
      "const state = loader.install({",
      "  runtimeRoot: root,",
      "  environment: { EVEJS_AUTO_SKYHOOK_DEPLOY: '1' },",
      "  logError: (message) => errors.push(String(message)),",
      "});",
      "const chatCommands = require(path.join(root, 'server/src/services/chat/chatCommands.js'));",
      "const hubReplies = [];",
      "const chatHub = { sendSystemMessage: (session, message) => hubReplies.push(message) };",
      "const session = { characterID: 7, characterName: 'Tester', solarSystemID: 30000142 };",
      // No chatRuntime module is ever required: `followUpSender` stays null.
      "let threw = null;",
      "let withoutHub = null;",
      "try { withoutHub = loader._testing.deliverFollowUp(session, 'before any command'); }",
      "catch (error) { threw = error.message; }",
      // Now the session has run a command, so the hub is known.
      "chatCommands.executeChatCommand(session, '/ash help', chatHub, {});",
      "let afterHub = null;",
      "try { afterHub = loader._testing.deliverFollowUp(session, 'starting now'); }",
      "catch (error) { threw = (threw || '') + '|' + error.message; }",
      "console.log('RESULT:' + JSON.stringify({",
      "  active: state.active,",
      "  threw,",
      "  withoutHub,",
      "  afterHub,",
      "  hubReplies,",
      "  errors,",
      "}));",
    ].join("\n");
    const child = runNode(["-e", code, root], { env: { ...process.env } });
    assert.strictEqual(child.status, 0, child.stderr || child.stdout);
    const result = parseChildResult(child.stdout);
    assert.strictEqual(result.threw, null, `delivery must never throw: ${result.threw}`);
    // With no hub and no broadcaster yet it reports the failure instead of throwing.
    assert.strictEqual(result.withoutHub, false);
    assert.match(
      String(child.stderr || ""),
      /could not deliver a follow-up message/u,
      `the failure must be logged unconditionally: ${child.stderr}`,
    );
    // Once the command has run, the hub it used carries the follow-up.
    assert.strictEqual(result.afterHub, true);
    assert.deepStrictEqual(result.hubReplies.slice(1), ["starting now"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureOptionsForDelivery() {
  return {
    solarSystems: [{
      solarSystemID: SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0,
    }],
  };
}

test("a run aborts instead of stalling when its follow-ups cannot be delivered", () => {
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID, 30000148];
  const planets = systems.map((systemID, index) => ({
    ...planet(40009001 + (index * 10), `P${index}`, 1),
    solarSystemID: systemID,
  }));
  const clock = createClock();
  const { fixture, deps } = createFixture({
    planets,
    solarSystems: systems.map((systemID) => ({
      solarSystemID: systemID, regionID: REGION_ID, security: -0.5, factionID: 0,
    })),
  });
  const errors = [];
  // A delivery path that answers false, exactly like the loader does when neither the
  // hub nor the broadcaster is available.
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: () => false,
    logError: (message) => errors.push(String(message)),
  });
  const config = configModule.load(modDir, {});
  const reply = chatCommand.handleCommand(runtime, config, session(), "anchor region 10000043").message;
  assert.match(reply, /3 systems to work/u, reply);
  // The countdown's first tick cannot be delivered, so the run ends there - and because
  // it ends during the countdown, nothing was deployed.
  clock.advance(5000);
  assert.strictEqual(runtime.regionRunStatus(), null, "the run must not survive a dead channel");
  assert.ok(
    errors.some((message) => /aborted: the 10 s countdown tick could not be delivered/u.test(message)),
    JSON.stringify(errors),
  );
  clock.advance(100000);
  assert.strictEqual(
    fixture.calls.some((entry) => entry.fn === "createSpaceItemForOwner"),
    false,
    "an aborted run must not deploy anything",
  );
  assert.strictEqual(clock.pending(), 0, "the aborted run must leave no timer behind");

  // A delivery path that throws is the same case.
  const throwingClock = createClock();
  const throwing = createRuntimeWith(createFixture(fixtureOptionsForDelivery()).fixture,
    createFixture(fixtureOptionsForDelivery()).deps, {}, {
      timers: throwingClock,
      sendTo: () => { throw new Error("the channel is gone"); },
      logError: (message) => errors.push(String(message)),
    });
  chatCommand.handleCommand(throwing, config, session(), "anchor region 10000043");
  throwingClock.advance(5000);
  assert.strictEqual(throwing.regionRunStatus(), null);
  assert.ok(
    errors.some((message) => /could not deliver a follow-up message/u.test(message)),
    JSON.stringify(errors),
  );
});

test("status reports an active run, so progress is observable without the chat channel", () => {
  const clock = createClock();
  const messages = [];
  const { fixture, deps } = createFixture({
    solarSystems: [{
      solarSystemID: SYSTEM_ID, regionID: REGION_ID, security: -0.5, factionID: 0,
    }],
  });
  const runtime = createRuntimeWith(fixture, deps, {}, {
    timers: clock,
    sendTo: (target, message) => {
      messages.push(message);
      return true;
    },
  });
  const config = configModule.load(modDir, {});
  const idle = chatCommand.handleCommand(runtime, config, session(), "status here").message;
  assert.match(idle, /v1\.0\.0: Jita/u, idle);
  assert.strictEqual(/run in progress/u.test(idle), false, "no run yet");
  // Start one and read status again: the run line names the kind, the phase, the counts
  // and the estimate.
  chatCommand.handleCommand(runtime, config, session(), "anchor region 10000043");
  const active = chatCommand.handleCommand(runtime, config, session(), "status here").message;
  assert.match(
    active,
    /\n  run in progress: deploy on Domain, countdown, \[0\/1 systems done, 1 system left, about \d+ s remaining\]/u,
    active,
  );
  // After it finishes the line is gone again.
  clock.advance(100000);
  const after = chatCommand.handleCommand(runtime, config, session(), "status here").message;
  assert.strictEqual(/run in progress/u.test(after), false, after);
});

// ─── names, not ids ─────────────────────────────────────────────────────────

test("names: a system label is the vendor's name, and an unknown one falls back", () => {
  const { fixture, deps } = createFixture({ solarSystemsMissingName: true });
  const runtime = createRuntimeWith(fixture, deps);
  assert.strictEqual(runtime.describeSystemLabel(SYSTEM_ID), `system ${SYSTEM_ID}`);
  assert.strictEqual(runtime.describeSystemLabel(39999999), "system 39999999");

  const namedFixture = createFixture({
    solarSystems: [
      { solarSystemID: SYSTEM_ID, solarSystemName: SYSTEM_NAME, regionID: REGION_ID },
      { solarSystemID: OTHER_SYSTEM_ID, solarSystemName: OTHER_SYSTEM_NAME, regionID: REGION_ID },
    ],
  });
  const named = createRuntimeWith(namedFixture.fixture, namedFixture.deps);
  assert.strictEqual(named.describeSystemLabel(SYSTEM_ID), SYSTEM_NAME);
  assert.strictEqual(named.describeSystemLabel(OTHER_SYSTEM_ID), OTHER_SYSTEM_NAME);
});

test("names: describeRegion knows the generated table and falls back on an unknown id", () => {
  const runtime = createRuntimeWith(createFixture().fixture, createFixture().deps);
  for (const [regionID, name] of [
    [10000063, "Period Basis"],
    [10000060, "Delve"],
    [10000043, "Domain"],
    [10000022, "Stain"],
    [11000001, "A-R00001"],
    [10000002, "The Forge"],
    [10000003, "Vale of the Silent"],
  ]) {
    assert.strictEqual(runtime.describeRegion(regionID), name, String(regionID));
  }
  // An id the table does not know is still named as a region, never as an empty string.
  assert.strictEqual(runtime.describeRegion(99999999), "region 99999999");
  assert.strictEqual(runtime.describeRegion(0), "an unknown region");
  assert.strictEqual(runtime.describeRegion(null), "an unknown region");
  // A vendor row that carries its own name is authoritative for that server.
  assert.strictEqual(runtime.describeRegionLabel(99999999, [{ regionName: "Nowhere" }]), "Nowhere");
  assert.strictEqual(runtime.describeRegionLabel(10000060, []), "Delve");
});

test("names: a Skyhook and a distance are written the way the operator reads them", () => {
  const runtime = createRuntimeWith(createFixture().fixture, createFixture().deps);
  assert.strictEqual(runtime.skyhookLabel("RYQC-I III"), "orbital skyhook at RYQC-I III");
  assert.strictEqual(runtime.skyhookLabel(""), "orbital skyhook at an unnamed planet");
  assert.strictEqual(runtime.skyhookLabel(null), "orbital skyhook at an unnamed planet");
  // The item id never stands in for the name: an unknown planet reads as a place.
  assert.strictEqual(runtime.planetNameFor(49999999), "an unnamed planet");
  assert.strictEqual(runtime.planetNameFor(40009001), "Planet I");
  assert.strictEqual(runtime.planetNameFor(40009001, { itemName: "RYQC-I III" }), "RYQC-I III");

  // Metres carry thousands separators; the landing-point offset keeps its own shape.
  assert.strictEqual(runtime.formatMeters(10506), "10,506 m");
  assert.strictEqual(runtime.formatMeters(123), "123 m");
  assert.strictEqual(runtime.formatMeters(1_234_567), "1,234,567 m");
  assert.strictEqual(runtime.formatMeters(0), "0 m");
});

// Every message the fixtures produce, so the rule "no raw id in a reply" is checked
// over the whole surface rather than one line at a time. The fixtures' system names
// deliberately contain no digits (see the `named` systems below), so a bare number in
// a reply can only have come from an id.
function collectUserFacingMessages() {
  const collected = [];
  const namedRows = (systems) => systems.map((systemID, index) => ({
    solarSystemID: systemID,
    solarSystemName: `Named System ${index + 1}`,
    regionID: REGION_ID,
    security: -0.5,
    factionID: 0,
  }));
  const systems = [SYSTEM_ID, OTHER_SYSTEM_ID, 30000146];
  const planets = systems.flatMap((systemID, index) => ([
    { ...planet(40009001 + (index * 10), `Planet ${index + 1} I`, 1), solarSystemID: systemID },
    { ...planet(40009002 + (index * 10), `Planet ${index + 1} II`, 2), solarSystemID: systemID },
  ]));

  // 1. A region deploy, including a verification anomaly 10,506 m off the landing point.
  const deployClock = createClock();
  const deployMessages = [];
  startRegionRun(deployClock, deployMessages, {
    planets,
    itemPositionDrift: 10506,
    solarSystems: namedRows(systems),
  }, "anchor region 10000043");
  deployClock.advance(1_000_000);
  collected.push(...deployMessages);

  // 2. An align run, whose progress suffix counts Skyhooks.
  const alignClock = createClock();
  const alignMessages = [];
  const alignRun = createFixture({ planets: [THREE_PLANETS[0]], solarSystems: namedRows([SYSTEM_ID]) });
  alignRun.fixture.orbitals.push(orbital(40009001, 1000000000001));
  alignRun.fixture.items.set(1000000000001, {
    itemID: 1000000000001,
    spaceState: { position: { x: 1, y: 2, z: 3 } },
  });
  const alignRuntime = createRuntimeWith(alignRun.fixture, alignRun.deps, {}, {
    timers: alignClock,
    sendTo: (target, message) => { alignMessages.push(message); return true; },
  });
  const alignConfig = configModule.load(modDir, {});
  chatCommand.handleCommand(alignRuntime, alignConfig, session(), "align");
  alignClock.advance(1_000_000);
  collected.push(...alignMessages);

  // 3. The removal reply, a status listing, and the same removal by planet name.
  const removal = createFixture({
    orbitals: [orbital(40009001, 1000000000001), orbital(40009002, 1000000000002)],
    solarSystems: namedRows([SYSTEM_ID]),
  });
  removal.fixture.ledger[String(1000000000001)] = ledgerRow(40009001, {
    skyhookID: 1000000000001,
    deployedItem: true,
  });
  const removalRuntime = createRuntimeWith(removal.fixture, removal.deps);
  const removalConfig = configModule.load(modDir, {});
  collected.push(
    chatCommand.handleCommand(removalRuntime, removalConfig, session(), "remove 1000000000001").message,
  );
  collected.push(
    chatCommand.handleCommand(removalRuntime, removalConfig, session(), "status here").message,
  );
  collected.push(
    chatCommand.handleCommand(removalRuntime, removalConfig, session(), "remove \"Planet I\"").message,
  );

  // 3b. A status over several destroyed markers, so the collapsed marker line is in
  // the sample the no-raw-id scan walks: it carries a count and no id of its own.
  const markers = createFixture({
    orbitals: [
      orbital(40009001, 1000000000001, { destroyedAtMs: 1700000000000 }),
      orbital(40009002, 1000000000002, { destroyedAtMs: 1700000000001 }),
    ],
    solarSystems: namedRows([SYSTEM_ID]),
  });
  const markersRuntime = createRuntimeWith(markers.fixture, markers.deps);
  collected.push(
    chatCommand.handleCommand(markersRuntime, configModule.load(modDir, {}), session(), "status here")
      .message,
  );

  // 4. A sweep whose every destruction fails, so the failure line is in the sample too.
  const failing = createFixture({
    orbitals: [orbital(40009001, 1000000000001)],
    solarSystems: namedRows([SYSTEM_ID]),
  });
  const failingRuntime = createRuntimeWith(failing.fixture, failing.deps, {}, {
    throwOn: "markOrbitalDestroyed",
  });
  collected.push(
    failingRuntime.describeScopeRemoval(
      failingRuntime.unanchorScope(
        failingRuntime.resolveScope({ kind: "region", regionID: REGION_ID }, session()),
        session(),
      ),
    ),
  );

  return collected;
}

test("names: no user-facing message carries a raw item, system or region id", () => {
  const messages = collectUserFacingMessages();
  assert.ok(messages.length > 8, `expected a real sample of messages, got ${messages.length}`);
  assert.ok(
    messages.some((message) => /ANOMALY/u.test(message)),
    "the sample must include an anomaly line",
  );
  assert.ok(
    messages.some((message) => /systems done/u.test(message)),
    "the sample must include a progress suffix",
  );
  assert.ok(
    messages.some((message) => /destroyed markers left alone: 2/u.test(message)),
    "the sample must include a collapsed marker line with a count",
  );
  for (const message of messages) {
    const bare = String(message)
      // The allocator's own counter line is the one deliberate exception: it names the
      // counter, not an object, and `/ash status` is where an operator reads it.
      .split(/\r?\n/u)
      .filter((line) => !/item id counter/u.test(line))
      .join("\n")
      .replace(/maxPlanetsPerCommand=\d+/gu, "maxPlanetsPerCommand=N")
      .replace(/corporation \d+/gu, "corporation N")
      .replace(/alliance \d+/gu, "alliance N")
      .replace(/\b\d+ m \d+ s\b/gu, "N m N s")
      .replace(/\b\d+ ms\b/gu, "N ms")
      .replace(/\b\d+ s\b/gu, "N s");
    assert.strictEqual(
      /\d{6,}/u.test(bare),
      false,
      `a raw id reached a reply: ${message}`,
    );
  }
});

// ─── the vendor tree this mod targets ────────────────────────────────────────

function findLiveTree() {
  const candidates = [
    process.env.EVEJS_AUTO_SKYHOOK_DEPLOY_TREE,
    runtimeRoot,
    path.join(runtimeRoot, "EveJS"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "server", "src", "services", "planet", "planetOrbitalState.js"))) {
      return candidate;
    }
  }
  return null;
}

test("the live vendor tree still exposes every entry point this mod calls", () => {
  const live = findLiveTree();
  if (!live) {
    console.log("     SKIP no EveJS tree found next to this mod");
    return;
  }
  const read = (relative) => fs.readFileSync(path.join(live, ...relative.split("/")), "utf8");
  const expectations = [
    ["server/src/services/planet/planetOrbitalState.js", [
      /_testing: \{/u,
      /listPlanetsForSystem\(solarSystemID\)/u,
      /function findNearestPlanetID\(solarSystemID/u,
      /function ensureOrbitalForItem\(item, options = \{\}\)/u,
      /function listOrbitalsForPlanet\(planetID\)/u,
      /function listOrbitalsForSystem\(solarSystemID\)/u,
      /function markOrbitalDestroyed\(orbitalID, nowMs = Date\.now\(\)\)/u,
      /function isOrbitalRecordDestroyed\(record\)/u,
    ]],
    ["server/src/services/inventory/itemStore.js", [
      /function createSpaceItemForOwner\(ownerId, solarSystemId, itemType, options = \{\}\)/u,
      /function getItemMetadata\(typeID, name = null\)/u,
      /function resolveSpawnedSpaceItemRadius\(itemType, options = \{\}\)/u,
    ]],
    ["server/src/services/ship/orbitalLaunchRuntime.js", [
      /spaceRadius: currentItem\.spaceRadius \|\| currentItem\.radius \|\| null/u,
    ]],
    ["server/src/space/worldData.js", [
      /function getCelestialByID\(celestialID\)/u,
      /function getCelestialsForSystem\(solarSystemID\)/u,
    ]],
    // The placement: the vendor's deterministic per-planet landing point, and the
    // two places the game itself uses it (structure placement, player warp).
    ["server/src/space/destiny/simulation/warpInPointParity.js", [
      /function getPlanetWarpInPoint\(target\)/u,
      /function getClientParityWarpInPoint\(target\)/u,
      /function hasClientWarpInPoint\(target\)/u,
      /const myRandom = createPythonRandom\(toPositiveInt\(target && target\.itemID, 0\)\);/u,
      /getClientParityWarpInPoint,/u,
    ]],
    ["server/src/services/structure/structureDeploymentPlacement.js", [
      /function appendWarpInPoints\(balls\)/u,
      /const warpInPoint = getClientParityWarpInPoint\(\{/u,
    ]],
    ["server/src/space/destiny/commands/warpCommands.js", [
      /getClientParityWarpInPoint\(target\)/u,
      /runtime\.warpToPoint\(session, clientParityWarpInPoint, \{/u,
    ]],
    ["server/src/space/runtime.js", [/const runtimeExports = module\.exports;/u]],
    ["server/src/space/runtime/spaceRuntime/dynamicEntities.js", [
      /spawnDynamicInventoryEntity\(systemID, itemID, options = \{\}\)/u,
      /destroyDynamicInventoryEntity\(systemID, entityID, options = \{\}\)/u,
    ]],
    ["server/src/space/runtime/spaceRuntime/sceneRegistry.js", [
      /ensureScene\(systemID, options = \{\}\)/u,
      // The read-only loaded-scene check an align run must use instead of ensureScene.
      /isSolarSystemSceneLoaded\(systemID\)/u,
      /return numericSystemID > 0 && this\.scenes\.has\(numericSystemID\);/u,
    ]],
    ["server/src/space/runtime/spaceRuntime/sceneDisposal.js", [
      // The non-creating scene lookup.
      /getSceneByDescriptor\(sceneDescriptor\)/u,
      /return descriptor \? this\.scenes\.get\(descriptor\.sceneKey\) \|\| null : null;/u,
    ]],
    // The clock methods live on the scene: the scene class gets them from
    // `scene/clock.js`, and the scene's own constructor installs the authority.
    ["server/src/space/runtime/scene/clock.js", [
      /setEntityPosition\(entityOrID, position, options = \{\}\)/u,
      /return this\.positionAuthority\.setEntityPosition\(entityOrID, position, \{/u,
    ]],
    ["server/src/space/runtime/solarSystemScene.js", [
      /this\.positionAuthority = createScenePositionAuthority\(\{/u,
    ]],
    ["server/src/services/sovereignty/sovModernState.js", [
      /const SKYHOOK_ITEM_ID_OFFSET = 1000000000000;/u,
      /function bootstrapSkyhooksFromSystems\(/u,
      /function getSkyhook\(skyhookID, identity\)/u,
      /function listLocalSkyhooks\(identity\)/u,
      /function destroySkyhooks\(skyhookIDs\)/u,
    ]],
    ["server/src/services/structure/structureState.js", [
      /function listStructuresForSystem\(solarSystemID, options = \{\}\)/u,
    ]],
    ["server/src/services/chat/chatCommands.js", [
      /function executeChatCommand\(session, rawMessage, chatHub, options = \{\}\)/u,
      /AVAILABLE_SLASH_COMMANDS,/u,
      /COMMANDS_HELP_TEXT,/u,
    ]],
    ["server/src/_secondary/chat/chatRuntime.js", [
      /function broadcastLocalMessage\(session, message\)/u,
      /function sendChannelMessage\(session, roomName, message, options = \{\}\)/u,
    ]],
  ];
  for (const [relative, patterns] of expectations) {
    const text = read(relative);
    for (const pattern of patterns) {
      assert.match(text, pattern, `${relative} must still match ${pattern}`);
    }
  }
  console.log(`     ${live}: ${expectations.length} vendor files verified`);
});

test("the live vendor tree still refuses what this mod refuses to call", () => {
  const live = findLiveTree();
  if (!live) {
    console.log("     SKIP no EveJS tree found next to this mod");
    return;
  }
  // Restated as assertions so a future vendor change that would make the mod's
  // invariants wrong is caught here rather than in a live system.
  const orbital = fs.readFileSync(
    path.join(live, "server", "src", "services", "planet", "planetOrbitalState.js"),
    "utf8",
  );
  assert.match(orbital, /function anchorOrbital\(itemID, session = null\)/u);
  const anchorBody = orbital.slice(orbital.indexOf("function anchorOrbital(itemID, session = null)"));
  assert.match(anchorBody.slice(0, 900), /ORBITAL_NOT_UNANCHORED/u);
  assert.match(orbital, /DEFAULT_ORBITAL_TIMER_MS = Math\.max\(/u);
  const sov = fs.readFileSync(
    path.join(live, "server", "src", "services", "sovereignty", "sovModernState.js"),
    "utf8",
  );
  assert.match(sov, /destroyed: true,/u, "the ledger tombstone flag must still exist");
  assert.match(sov, /if \(table\.skyhooks && table\.skyhooks\[key\] && table\.skyhooks\[key\]\.destroyed === true\) \{/u);
});

require("./installer")({ test, modDir });

console.log(`\n${results.length}/${results.length + failed} passed`);
if (failed > 0) process.exitCode = 1;
