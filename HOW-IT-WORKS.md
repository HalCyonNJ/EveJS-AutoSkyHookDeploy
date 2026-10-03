# How Auto Skyhook Deploy works

This document describes what the mod does to an EveJS 0.12.9 server, which
vendor entry points it uses, and which rules it will not break. Line references
are to the 0.12.9 tree this mod was developed against
(`server/src/...`, verified against the checkout this mod ships beside).

The mod is a **loader**: it never edits a file on disk. It installs itself by
chaining `Module._load`, overlays two chat entry points at load time, and then
does all of its real work lazily, inside a command handler, through the vendor's
own services. Nothing runs on a scene tick.

---

## 1. What a skyhook is, in this server

An Orbital Skyhook is item type **81080**. It exists in three stores at once, and
the mod has to respect all three:

| Store | Written by | Holds |
|---|---|---|
| `items` | `itemStore` | the row a scene can materialise; `spaceState`, position, owner |
| `planetOrbitalState` | `planetOrbitalState` (`server/src/services/planet/planetOrbitalState.js`) | the orbital record: `itemID`, `planetID`, `solarSystemID`, `state`, `destroyedAtMs` |
| the sovereignty ledger | `sovModernState` (`server/src/services/sovereignty/sovModernState.js`) | the gameplay row the sovereignty UI reads (`deployedItem`, reagents, workforce, `destroyed`) |

The first two are authoritative and durable. The third is **derived**: every read
rebuilds it from `planetOrbitalState` and deletes keys it does not recognise.

### The derived-ledger rule

`bootstrapSkyhooksFromSystems` (`sovModernState.js:629`) walks every orbital
record with `typeID === 81080` (`readDeployedSkyhookOrbitals`,
`sovModernState.js:757`) and rebuilds `table.skyhooks[key]` from it, stamping
`deployedItem = true` (`:654`) and carrying `destroyed = destroyed ||
Boolean(orbital.destroyedAtMs)` (`:663`). It then walks the claimed systems and
mints a **synthetic slot** for every planet that has no deployed orbital:
`skyhookID = SKYHOOK_ITEM_ID_OFFSET + planetID`, i.e.
`1000000000000 + planetID` (`:40`, `:685-689`). Finally it deletes every ledger
key it did not recognise (`:747-753`).

Two consequences drive this mod's design:

1. **Writing the ledger by hand is pointless.** It is pruned on the next read.
   When the mod wants a row to exist immediately, it asks the vendor to read it
   (`getSkyhook`, `:1936`; `listLocalSkyhooks`, `:1950`) after the orbital record
   exists, and the bootstrap produces the row.
2. **A tombstone is a decision, not an absence.** The synthetic-slot loop skips a
   slot whose ledger row already has `destroyed === true` (`:713-718`) so a
   destroyed skyhook is not silently recreated while the system stays claimed.

### The one-row-per-planet geometry

`ensureOrbitalForItem` (`planetOrbitalState.js:758`) builds its record from
`buildDefaultsFromItem` (`:458`), which resolves `planetID` as
`options.planetID ?? findNearestPlanetID(solarSystemID, position)` (`:479-482`).
Passing `planetID` explicitly is therefore load-bearing: the position alone can
resolve to a different planet, and a skyhook on the wrong planet is a bug that
looks like a success.

---

## 2. Deploying one skyhook

`/ash anchor` builds a plan, then executes it planet by planet. Per planet:

1. **Create the space row.** `itemStore.createSpaceItemForOwner(OWNER, S, 81080,
   { position, direction, targetPoint, mode: "STOP", createdAtMs: Date.now(),
   spaceRadius })` (`server/src/services/inventory/itemStore.js:3538`). This is the
   only vendor function that produces a skyhook-shaped space row **without a
   session, a ship or a scene** - which is exactly what "the caller does not need
   to be in the system" requires. The row lands with `locationID = S`, `flagID =
   0`, `singleton = 1` (`:3555`) and a built `spaceState` (`:3561`). The mod reads
   `created.data.itemID`.

   `spaceRadius` is passed explicitly, because it is the one field where a
   mod-created row used to differ from a launched one. The vendor's launch path
   sets `spaceRadius: currentItem.spaceRadius || currentItem.radius || null`
   (`server/src/services/ship/orbitalLaunchRuntime.js:427-437`), while
   `createSpaceItemForOwner` fills the field only from `options.spaceRadius > 0`
   (`itemStore.js:3558-3560`, resolver at `:3467-3485`). The radius therefore comes
   from `itemStore.getItemMetadata(81080)` (`:1841`, exported at `:7636`) and is
   **never hard-coded**; if the metadata is unavailable or gives no radius, the
   option is simply omitted (which is what the vendor's own `|| null` does) and
   the deployment still happens.

   **The position is the whole game here, and the answer is the planet's warp-in
   point.** In this game a warp to a planet always lands on **one deterministic
   point**, whatever angle the ship approaches from, and the vendor owns it:

   - `getPlanetWarpInPoint` (`server/src/space/destiny/simulation/warpInPointParity.js:208`)
     derives the angle from `createPythonRandom(planet.itemID)` (`:223`) and lands
     at `radius + 1_000_000 + radius * dd` with `dd` clamped to 0.5..10.5, with a
     deliberate vertical component (`y = planet.y + radius * Math.sin(rr) * 0.5`,
     `:239`) - so the point is neither exactly horizontal nor a simple multiple of
     the radius.
   - `getClientParityWarpInPoint` (`:256`) dispatches to it for planets and returns
     `null` when the target has no warp-in point at all (`hasClientWarpInPoint`,
     `:170`: no radius, a radius below `MIN_WARP_IN_POINT_RADIUS` (90,000), an
     asteroid belt, a wreck, or a category that is not a celestial).
   - The game's own **structure placement** appends these points as deployment
     positions (`server/src/services/structure/structureDeploymentPlacement.js:276-294`,
     `appendWarpInPoints`), and a player **warp is executed to exactly this point**
     (`server/src/space/destiny/commands/warpCommands.js:523-528`,
     `runtime.warpToPoint(session, clientParityWarpInPoint, ...)`).

   The mod therefore places the Skyhook **just past that point**: `position` is the
   warp-in point plus `unitVector(planet -> point) * offsetMeters` (default 25,000 m),
   `direction` is the unit vector from the planet's centre to the landing point
   (vertical component included, and unmoved by the offset -
   `direction.y === 0` is a property of the fallback, not of this rule), and
   `targetPoint` is the position. The reason for the offset is the second half of the
   operator's finding: a ship warping in materialises exactly on the landing point, so
   a Skyhook placed there is a model in the ship's face. Moving it 25 km further out
   along the same bearing leaves it in view, still right beside the arrival spot.
   `offsetMeters` is adjustable in game (`/ash offset`), see §2.1. It applies to this
   branch only - the fallback has no landing point to keep clear of.

   The celestial row the function needs is read from the vendor
   (`worldData.getCelestialByID`); the
   mod guarantees `itemID` is present before calling, because the function seeds its
   RNG from it and a missing id would silently produce a *different* point rather
   than no point.

   That is the whole saga explained: a Skyhook placed 5,000 km off in an arbitrary
   direction is **not** where the player lands, so it cannot be seen from the
   landing spot; placed on the landing point it is right next to the ship. An
   earlier build also chased a correlation with the client's
   `PUBLIC_GRID_NEARBY_VISIBILITY_RADIUS_METERS = 12_500_000`
   (`server/src/space/destiny/visibility/constants.js:20`, `:32`) and scaled the
   standoff with the planet. That was a **red herring**: the operator's in-game
   evidence is the ground truth here, and the useful question was never "how far
   out" but "where does the ship arrive".

   *Fallback.* Only when the vendor has no usable warp-in point - the accessor is
   missing or threw, the function answered `null`, or the point is not a finite
   vector or coincides with the planet's centre - does the mod fall back to the
   earlier heuristic, and it logs why in verbose mode:

   ```
   beyondSurface = Math.max(standoffMeters, planetRadius * orbitMargin)
   position      = planetPosition + direction * (planetRadius + beyondSurface)
   direction     = horizontal, star-facing (unit vector in the ecliptic plane)
   ```

   `standoffMeters` (default 5,000,000 m = 5,000 km, where the operator's manual
   deployments sit) and `orbitMargin` (default `1.0`, range 0..10, a ratio in planet
   radii) are therefore documented as the **fallback's** inputs, not as the rule.
   The direction heuristic in that fallback is: the vendor's own
   `buildPlanetOrbitalPosition` (`staticSceneEntity.js:618-635`) derives its vector
   from the planet id and is vertical by 10%, 57% or even 88% depending on the id,
   which leaves Skyhooks directly above or below their planet where the operator
   could not find them; manual deployments are not uniform either (across the 340
   live Skyhooks the vertical share of the offset is 0-2% for 71, 2-5% for 83,
   5-10% for 109, 10-50% for 35 and 50-100% for 42). The fallback therefore keeps
   the offset **exactly in the ecliptic plane** (`direction.y === 0`, so the Skyhook
   keeps its planet's height) and points it at the **system's star**: the sunlit
   side, which is both horizontal and predictable. The star is read through the
   vendor's celestial catalogue, `worldData.getCelestialsForSystem(S)`
   (`worldData.js:217`, exported at `:292`; rows with `kind === "sun"` or
   `groupID === 6` carry `position`) - the 258 MB celestials file is never parsed
   here. If the catalogue cannot be read, the system has no star row, or the planet
   sits on top of its star, the fallback direction is `{ x: 1, y: 0, z: 0 }`, which
   is horizontal as well, and the reason is logged in verbose mode.

   Placing the Skyhook at the planet's centre instead (an even earlier build did)
   buries it **inside** the planet: the directional scanner still lists it by
   distance, so it looks deployed, but the client draws nothing there and the
   object cannot be selected, warped to or interacted with. Every deployment is
   asserted to land exactly `offsetMeters` past the vendor's warp-in point when there
   is one, and on
   `planetRadius + max(standoffMeters, planetRadius * orbitMargin)` along the
   horizontal star-facing direction when there is not, with `targetPoint` equal to
   the position in both cases.

### 2.1 The offset, and the configuration file behind it

A ship warping to a planet arrives **on** the landing point, so a Skyhook sitting
exactly there is a model in the ship's face. The offset moves it along the same
bearing, which keeps it in view without moving it away from the arrival spot.
`offsetMeters` (default 25,000 m = 25 km, range 0..100000) is the one setting the
operator is expected to change from in game, so it is the one setting with a
runtime path:

- `/ash offset` reads it, `/ash offset <value>` sets it. A bare number is
  kilometres (`5`), and either unit can be written (`5km`, `5000m`); the reply always
  echoes metres and kilometres, so an ambiguous entry is visible immediately.
  `0` puts the Skyhook exactly on the landing point.
- The value is written into **whichever configuration file is in force**:
  the launcher's `<mod root>/settings.json` when a launcher has written one (it
  outranks the config JSON), the installer's
  `<EveJS root>/config/autoSkyHookDeploy.json` otherwise (`config.js:offsetFilename`,
  `createLiveConfig`). It is read on **every** command - not cached at boot - so a
  change needs no restart and no image rebuild, and a hand edit is picked up too.
- Precedence, at boot and at command time: **process environment > `settings.json` >
  config JSON > `.env` > built-in default** (`config.js:load`, `pick`;
  `SETTINGS_FILENAME`). That is the order the launcher's own README documents, and it
  is why `/ash offset` does not write the installer's file while a `settings.json`
  exists: writing the lower file would be silently shadowed.
- A **malformed** configuration file of either kind is a configuration problem, so the
  fail-closed rule applies to it exactly as it does to the config JSON. A **missing**
  `settings.json` is not a problem at all. But a file that breaks *after* boot must not
  take the mod offline or lose the setting: `/ash offset` reports
  `cannot read the configuration file: ...` in text, keeps using the last good value,
  and refuses to write - the mod never rewrites configuration it could not parse
  (`createLiveConfig.readValue`/`writeValue`).
2. **Attach the orbital record.** `planetOrbitalState.ensureOrbitalForItem(
   created.data, { solarSystemID: S, planetID: P, ownerID: OWNER, corporationID:
   OWNER, allianceID: <caller's alliance or null> })`. `ensureOrbitalForItem`
   requires `categoryID === CATEGORY_ORBITAL (46)` (`:759`), runs
   `beginSkyhookActivation` (`:550`) and stores the record. Because
   `beginSkyhookActivation` forces `UNANCHORED -> ONLINING` with
   `DEFAULT_ORBITAL_TIMER_MS` (`:56`, 60 s by default, overridable with
   `EVEJS_PI_ORBITAL_TIMER_MS`), the record is durable immediately and the
   vendor's own reconciliation timer
   (`scheduleOrbitalTransitionReconciliation`, `:602`, scheduled at `:791-793`)
   completes it to `IDLE`. The mod never calls `anchorOrbital` (`:912`) or
   `onlineOrbital` (`:927`): both refuse a skyhook, and `anchorOrbital` answers
   `ORBITAL_NOT_UNANCHORED` (`:920`) once the record is `IDLE`.
3. **Put it in its scene.** `spaceRuntime.ensureScene(S)`
   (`server/src/space/runtime/spaceRuntime/sceneRegistry.js:149`) and then
   `spaceRuntime.spawnDynamicInventoryEntity(S, itemID)`
   (`.../dynamicEntities.js:86`). The spawn ensures the scene itself, but the
   explicit call makes "the scene could not be built" distinguishable from "the
   entity could not be spawned". This step is **not fatal**: the item row and the
   orbital record are already durable, so a failure is logged for the operator
   and never turns into a half-undone deployment.
4. **Read the ledger row.** `sovModernState.getSkyhook(itemID, identity)` inside
   a `try`/`catch`, purely so the derived row exists immediately. Nothing is
   written.

`server/src/space/runtime.js` is the aggregator that re-exports the runtime
singleton (`:1366`, `const runtimeExports = module.exports;`), so the two
methods above are reached through it.

The position comes from `listPlanetsForSystem` (see below), with
`worldData.getCelestialByID(planetID)`
(`server/src/space/worldData.js:223`) as the fallback, and the direction from the
system's star through `worldData.getCelestialsForSystem(S)` (section 2).

### Where the power and workforce go

A Skyhook's power and workforce are totalled by the sovereignty **infrastructure
hub** of its system: `sovModernState.getSkyhookHarvestContribution` feeds
`getHubLocalHarvest`, which feeds `getHubResources`. The hub is the harvest's
*destination*, not a precondition: a deployed Skyhook produces on its own, and an
in-game test confirmed that production works in a system with no hub, no
`sovereignty/systems/<id>` row and no claim at all. A report of "the skyhooks do
not produce" in exactly such a system turned out to be the client not having
refreshed. Nothing in this mod reads, requires, warns about or refuses on the
presence of a hub.

### Never used

- `structureState.createStructure`, `structureDeployment.Anchor`,
  `deployGenericStructureFromItem`: typeID 81080 is also registered as a
  sovereignty-family **structure** (`server/src/services/structure/structureConstants.js:292`),
  which is the vendor's second, competing deploy route. This mod never takes it;
  the mod's only job there is to notice that a structure-shaped skyhook exists
  and treat the planet as occupied.
- `sovParityReset` (it wipes every skyhook, hub, claim and alliance).
- Any direct write to `planetOrbitalState` state, to the sovereignty ledger, or
  to the raw gameplay tables.

---

## 3. Enumerating a system

The mod never reads `gameStore/data/celestials/data.json` (258 MB, already parsed
and memoised by the vendor). It asks:

```
planetOrbitalState._testing.listPlanetsForSystem(solarSystemID)
  -> [{ planetID, solarSystemID, typeID, radius, position, celestialIndex, itemName }]
```

(`planetOrbitalState.js:298`, exported under `_testing` at `:1333`, cache built in
`getPlanetsBySystem`, `:260`). `findNearestPlanetID` (`:371`) is used for one
thing only: attributing a structure-shaped skyhook to the planet it orbits when
the structure record does not say.

---

## 4. Occupancy: four reasons a planet is skipped

A plan is built per planet, in this order. Any hit means "occupied, skip", and
the reason is reported.

1. **A live skyhook.** `listOrbitalsForPlanet(P)`
   (`planetOrbitalState.js:828`) contains a record with `typeID === 81080` and no
   tombstone.
2. **A sovereignty ledger row that is a real deployment.** Read through the
   vendor (`getSkyhook`, `sovModernState.js:1936`; `listLocalSkyhooks`, `:1950`,
   which is aimed by `identity.solarSystemID`), never from the raw table. A row
   counts as occupancy in exactly two cases, and only while it is **not** a
   tombstone:
   - its key is **not** that planet's synthetic slot key
     (`String` of `SKYHOOK_ITEM_ID_OFFSET + planetID`, i.e. `1000000000000 + P`),
     so it is a record of something actually deployed; or
   - it carries `deployedItem === true`.

   A row whose key **is** the planet's slot key and which is not
   `deployedItem: true` is **not** occupancy. That row is the free slot
   `bootstrapSkyhooksFromSystems` mints for every planet of a claimed system that
   has no deployed orbital (`sovModernState.js:685-689`, offset declared at
   `:40`), and it is precisely what a deploy is for: treating it as occupancy
   would make `/ash anchor` refuse every planet of every claimed system. The
   distinction is the difference between "the game reserved this planet a slot"
   and "somebody built here". `/ash status` prints such a planet as
   `free (game-created slot, nothing built on it yet)` so the two are never
   confused in a reply.
3. **A structure-shaped skyhook.**
   `structureState.listStructuresForSystem(S, { includeDestroyed: true })`
   (`server/src/services/structure/structureState.js:1965`) contains a
   `typeID === 81080` entry. Structure records carry no `planetID`, so the entry
   is attributed through `moonID` and then through `findNearestPlanetID` on its
   position. An entry that cannot be attributed at all blocks the whole system:
   nothing may be built where an unattributable one might be.
4. **Anything unreadable.** Every vendor call is wrapped. A store that fails to
   load or throws degrades to "no data" plus a log line, never to a stack trace
   in someone's chat.

### A destroyed skyhook is not a "no"

A destroyed orbital record (`destroyedAtMs` set, or `isOrbitalRecordDestroyed`,
`planetOrbitalState.js:162`) and a destroyed planet slot
(`1000000000000 + P` with `destroyed === true`) are **history, not occupancy**.
The live game lets a new Skyhook be placed on a planet whose previous one was
destroyed, and the vendor's launch path has no uniqueness check at all. What
`sovModernState.js:713-717` actually says is narrower than it looks: the
*bootstrap* must not treat the absence of a live row as a request to re-create
the **default slot** while the system stays claimed. It says nothing about a
player-driven deploy.

So the mod deploys over a tombstone normally, and keeps the tombstone exactly
where it is. The old record is never deleted and `destroyedAtMs` is never
cleared - that is a standing invariant (section 9). The new Skyhook gets its own
`itemID` and its own orbital record beside the old one, and `/ash status` reports
the planet as `free (destroyed skyhook tombstone - a new one may be placed
here)` rather than as occupied.

Three policy checks sit on top of occupancy, two of them optional:

- `requireClaimedSystemOwnership` compares the caller's corporation/alliance with
  the system's sovereignty owner, which is itself derived from the ledger rows
  found for that system. A system with no ledger row at all is unclaimed and is
  refused in that mode.
- `maxPlanetsPerCommand` (default 64, range 1..4096) refuses a system with more
  planets than the cap, before anything is created. The same cap bounds one
  `unanchor` and truncates one `status` listing.
- `offsetMeters` (default 25,000 m = 25 km, range 0..100000) is how far past the
  planet's landing point the Skyhook goes, so a ship warping in does not materialise
  inside it. It is validated like every other key, **and** it is the one key with a
  runtime path: `/ash offset` writes it into the configuration file in force, which is
  read on every command (§2.1).
- `regionCountdownSeconds`
  (default 15, range 0..120) and `regionStepDelayMs` (default 2000, range 0..60000)
  govern a paced region run: a region holding more systems than the cap is refused
  before the countdown, and the other two are the countdown and the gap between
  systems (§5.1).
- `standoffMeters` (default 5,000,000 m = 5,000 km, range 100,000..100,000,000 m)
  and `orbitMargin` (default 1.0, range 0..10, a ratio in planet radii) are the
  **fallback placement's** inputs: a Skyhook goes on the planet's warp-in point
  whenever the vendor has one, and only a celestial with none uses
  `max(standoffMeters, planetRadius * orbitMargin)` instead. Both are validated
  like every other key. Choosing the warp-in point needs no configuration at all,
  which is the point: it is where the player lands.

### The reply

`/ash anchor` always states three numbers, whether it did anything or not:
deployed, skipped as already present, and how many of the deployments went over
a destroyed skyhook ("N over a destroyed skyhook"), each one also named in its
own line with the old tombstone's id. A system where every planet is occupied is
an **error message**, not a silent success. A partly populated system deploys
only the missing planets and names both groups. The three counts are also why a
"0 deployed" answer is still informative.

---

## 5. Removing skyhooks: `remove <id>` and `unanchor`

There are two removal commands, because a command that takes an id and a command
that takes a system are two commands:

- **`/ash remove <skyhookID>`** destroys **one** Skyhook, by the id the scanner
  shows or by the name of the planet it orbits (`/ash remove "RYQC-I III"`). An id is
  validated as a positive integer, then
  resolved: `planetOrbitalState.getOrbitalByID(id)` (`planetOrbitalState.js`, exported)
  must return a typeID 81080 record, or the derived ledger row
  (`sovModernState.getSkyhook(id, identity)`) must name it. A **name** is resolved
  inside the caller's own system - `getCelestialsForSystem` for the planets, then
  `listOrbitalsForPlanet` for the live Skyhooks on the named one - so a name can only
  ever reach a Skyhook the caller could see; it is refused in words when it matches no
  planet, several planets, or a planet with no Skyhook. A
  **structure-shaped** Skyhook has no orbital record at all, so it is recognised
  first through its own store, `structureState.getStructureByID(id)` - which is
  exported and is what makes the refusal work even when no orbital record names a
  system. That order matters: a wrong id is refused *before* anything is written.
- **`/ash unanchor here|<systemID>`** is the system-wide sweep:
  `planetOrbitalState.listOrbitalsForSystem(S)` filtered to typeID 81080, plus the
  structure-shaped ones reported as untouched. This is exactly what
  `/ash remove here` used to do, and `/ash remove here` now answers with a pointer
  to it. A numeric argument that is *not* a known Skyhook but *is* a solar system
  (its `_testing.listPlanetsForSystem` returns planets) is answered the same way,
  which is the mistake worth naming.

Both run the vendor's destruction sequence per id:

1. `planetOrbitalState.markOrbitalDestroyed(itemID)`
   (`planetOrbitalState.js:1119`) writes a tombstone: `state = UNANCHORED`,
   `destroyedAtMs` set, `conditionState` fully damaged (`:1131-1138`). The row is
   **kept on purpose** - the vendor's own comment at `:1128-1130` explains that a
   planet with no record makes `listDefaultCustomsOfficesForSystem` treat it as
   needing a fresh default.
2. `spaceRuntime.ensureScene(S)` then
   `spaceRuntime.destroyDynamicInventoryEntity(S, itemID, { suppressExplosion: true })`
   (`.../dynamicEntities.js:239`), which removes the scene entity and the `items`
   row behind it. `DYNAMIC_ENTITY_NOT_FOUND` is treated as success, so a retry
   after a partial failure is safe.
3. `sovModernState.destroySkyhooks([itemID])` (`sovModernState.js:2193`) writes
   the ledger tombstone (`active: false, destroyed: true`) immediately instead of
   waiting for the next bootstrap.

The three steps are ordered and each is reported. If step 1 fails, steps 2 and 3
are **not** run for that id: deleting the item row of a skyhook whose orbital
record is not tombstoned is how a resurrection starts. If step 2 fails for a
reason other than `DYNAMIC_ENTITY_NOT_FOUND`, the reply says so while steps 1 and
3 - the durable part - still stand.

A skyhook whose orbital record is already a tombstone is left alone and counted in
its own column (`already destroyed N` in the header, one `destroyed markers left
alone: N` line underneath - section 5.1.2). Structure-shaped skyhooks are listed and
deliberately never touched. Because a destroyed record is not occupancy (section 4),
the planet is deployable again straight after a removal - `/ash anchor` will build a
replacement over the tombstone the removal just wrote, and the tombstone stays
where it is as history.

### The item-id counter, calibrated once per removal

A removal deletes an `items` row, and the operator asked for the game's own
"next item id" counter to be re-synced afterwards so a freed id can never be handed
out again. It is done **once per command**, through the vendor's allocator, and only
when it is actually needed:

```
highWater = identityAllocator.getItemReferenceHighWaterMark()   // :518
counter   = gameStore.read(IDENTITY_TABLE, "/").nextItemID      // read-only
if (counter <= highWater) identityAllocator.reserveItemIDs(1)   // :601
```

`reserveItemIDs(count, options)` is what the vendor itself uses for exactly this: it
takes `max(state.nextItemID, getItemReferenceHighWaterMark() + 1, minimumCandidate)`,
stores `firstItemID + amount` and flushes the identity table synchronously
(`:601-625`). Two things follow, and both are on purpose:

- **It is not called when the counter is already ahead of the high-water mark**,
  because the call *consumes* the id it returns: doing it unconditionally would leak
  one id per removal. The reply says which case applied
  (`item id counter: 9988400003304 (already ahead of the highest id)` or
  `raised to ... (was ..., highest id ...)`).
- **The mod never writes the identity table itself.** The counter is read through the
  vendor's own `gameStore.read` (the allocator exports the high-water mark but no
  counter accessor, so this read is the only way to make the comparison the operator
  asked for) and every write goes through `reserveItemIDs`.

If the allocator or the game store cannot be reached, the removal still happens, the
clause is left out of the reply, and a verbose run says why - this can never break a
removal.

### 5.1 A region run is a paced, abortable job

`anchor region <regionID>` and `unanchor region <regionID>` are the only commands that
can touch hundreds of planets, and mass-creating structures is what stalls a server, so
a region is never worked in one burst. The scope is resolved first (5.2), then the work
is handed to a job in `lib/runtime.js`:

- **Nothing is done during the countdown.** The command's own reply is the plan summary
  and the countdown (`region X: N systems to work, M NPC/faction space skipped -
  starting in 15 s, type /ash stop to cancel`), and the job ticks at 10 s and 5 s before
  it starts. `/ash stop` in that window clears the timer, drops the job and answers that
  nothing was touched - which is true, because the first system has not begun.
- **One system per step, never a burst.** Each step calls the *same* functions a
  targeted command uses (`buildPlan` + `applyPlan`, or `unanchorSystem` with
  `{calibrate: false}`), so there is one implementation of the per-system work. Between
  steps the job waits `regionStepDelayMs` (default 2000) on a `setTimeout`; nothing
  blocks the event loop, and a 0 delay still yields a 0 ms timer rather than a
  synchronous loop, so the loop always gets a turn.
- **Every system is verified against what was written**, not assumed: the item row is
  re-read with `itemStore.findItemById`, its `spaceState.position` is compared with the
  landing point plus the configured offset (recomputed through `buildOrbitalSlot`, 1 m
  of tolerance), and the orbital record is re-read with `getOrbitalByID` to check it is
  live, is typeID 81080 and belongs to the right planet. A removal verifies the
  opposite: no live orbital record is left and the item rows are gone. Anything that does
  not match is reported as an `ANOMALY` line, in the shape
  `<system>: deployed N, verified V at the landing point + offset, A anomalies
  [X/N systems done, Y systems left, about <duration> remaining]`. Every line names the
  object it is about (5.1.1), never its id.
- **A failure never aborts the run.** A system that cannot be read or deployed is
  reported (`FAILED ...`) and the loop moves on; a throw from a vendor call is caught
  the same way.
- **`/ash stop` is honoured between systems.** During the loop it sets a flag; the system
  being worked is finished *and verified* first, its report is sent, and only then does
  the run end with a summary of what was done and how many systems remain. No system is
  ever left half-done.
- **The counter is calibrated once per run**, in the summary, not once per system.
- **Timing is measured, not guessed.** Every planet's work (item row -> orbital record ->
  spawn) and every system's step is timestamped and folded into a **process-level**
  exponentially weighted average (weight 0.3, kept outside the runtime instance), seeded at
  48 ms per planet and 200 ms per system - the operator's observed order of magnitude. The
  countdown reply carries `estimated <X>: N systems, P planets, N-1 x <delay> ms step
  delay, <countdown> s countdown (measured <m> ms per planet so far)`, and the first run says
  it is using the default instead. The final line reports the actual elapsed time against the
  stored estimate, countdown included (and says so). `align` knows its Skyhook count up
  front; a region deploy estimates the planet count from the measured planets-per-system
  average.
- **The progress suffix is the same estimate, over what is left.** Every per-system line and
  the closing line end with `[X/N systems done, Y left, about <duration> remaining]`, and
  `/ash status` prints the same bracket from `regionRunStatus()`. One helper
  (`remainingPlanFor`) turns a run's outstanding work into the plan shape `estimateRunMs`
  already takes - the systems not started, their planets (or the not-yet-reached Skyhooks of
  an align run), the step delays between them, and the countdown only while it is still
  running - so no second estimate maths exists. `left` counts the unit the run moves:
  systems for a deploy or a sweep, Skyhooks for an align run.
- **The countdown reply also warns the operator** to stay in game and avoid jumping or
  logging off until the run finishes, with the `/ash stop` escape next to it.
- **`/ash align`** reuses this whole job: its scope is every system that holds a Skyhook
  (found through the vendor's own `planetOrbitalState.readState().orbitalsByID`, so a
  hand-deployed one is included) or the named system/region. Each Skyhook is moved by
  recomputing `buildOrbitalSlot` - the same placement maths a deploy uses.
- **A loaded scene needs the runtime route, and that is a live lesson.** Writing
  `spaceState.position` through `itemStore.updateInventoryItem` is correct for an item nobody
  has realised: twelve systems moved to the exact target that way. But for an item **realised
  in a loaded scene** - a system somebody is in - the entity is authoritative and the store
  write is lost, which is exactly what a live test showed (the operator's own system: ten
  Skyhooks reported moved, every one of them byte-identical in the store afterwards, while the
  twelve systems nobody was in were perfect). So the move is now: if the item is realised in a
  scene that is **already loaded**, reposition the entity first through the authority that scene
  owns, `scene.setEntityPosition(itemID, position, { reason, velocity: 0 })` (falling back to
  `scene.positionAuthority.setEntityPosition`, `scenePositionAuthority.js:234`, which sets
  `entity.position` and observes the entity so clients see it); read the entity back and treat a
  refusal or a non-moving scene as a skip for that system. Then the store row is written either
  way (it is the authority for an unloaded scene and the persisted record), and
  `spaceRuntime.refreshInventoryBackedEntityPresentation(systemID, itemID)` is called when the
  vendor exposes it.
- **The loaded-scene check must not create the scene, and the clock lives on the scene.** The
  first version of this path asked `spaceRuntime.ensureScene(systemID)` for each system and then
  called `scene.clock.setEntityPosition(...)`. Both were wrong, and a live `/ash align region
  10000063` over 40 systems showed it: every one of the 40 reported `0 ... moved ... 9 skipped`
  with `solar system <name> is in use (its scene is loaded) ... try again when nobody is in that
  system`, while the operator was in exactly one system and the run before it had deployed
  nothing at all. `ensureScene` (`sceneRegistry.js:149`) *creates and bootstraps* a scene - it
  constructs the `SolarSystemScene`, realises its inventory-backed entities and runs the startup
  materialisation - so asking it about each system loaded all 40, and every one of them then
  looked realised and, with no `scene.clock` in this vendor, unmovable. There is no
  `scene.clock`: `solarSystemScene.js:140` installs
  `this.positionAuthority = createScenePositionAuthority({ ... })` on the scene, and the methods
  of `scene/clock.js` (`setEntityPosition`, `getPositionSnapshot`) are mixed into
  `SolarSystemScene.prototype` (`runtime.js:1222-1256`), so the write belongs on the scene. The
  align read/move path now uses the **non-creating** accessors:
  `spaceRuntime.isSolarSystemSceneLoaded(systemID)` (`sceneRegistry.js:56`, which only reads
  `this.scenes.has(...)`) to decide whether a scene exists at all, and
  `spaceRuntime.getSceneByDescriptor(systemID)` (`sceneDisposal.js:522`, a registry lookup) - or
  the scene registry itself - to fetch it. A runtime missing those accessors falls through to
  the store-only path; `ensureScene` is never called from the align path, and a test spies on
  the runtime and fails if it ever is. The deploy and removal paths keep their `ensureScene`
  calls (`runtime.js:1126`, `runtime.js:1181`): a fresh deploy must load the scene to spawn the
  entity and a removal must load it to destroy the entity. A deploy or a removal therefore
  legitimately leaves a scene loaded for a while - the vendor unloads an empty scene on its own -
  so an align run in the same session can legitimately take the runtime path, which is exactly why
  the move has to be correct on the scene itself.
- **The store is authoritative when no scene is loaded, and nothing is called "in use".** If
  `isSolarSystemSceneLoaded(systemID)` is false the move is the store write alone - the path the
  twelve clean systems proved - and no scene note is printed for that system. The note itself no
  longer claims the system is in use: a genuine loaded-scene refusal reads `solar system <name>:
  its scene is loaded and would not accept the move; the vendor unloads an empty scene on its
  own, so try again later`, and it is a diagnostic rather than a routine outcome (with the
  scene's own authority always present in this vendor, the no-authority branch is effectively
  unreachable).
- **The counts are what verification confirms, never what was attempted.** An align system
  reports `M orbital skyhooks moved (of A attempted), V verified at the landing point +
  <offset>, S skipped, D destroyed markers, K anomalies`, where `moved` counts writes the
  immediate read-back
  confirmed and `verified`
  counts those the verification pass still confirms; verification reads the realised entity when
  there is one (that is what the client sees) and the store row otherwise. A planet with no
  usable landing point, a missing item row and a scene that keeps its own position are reported
  as skips with their reason. A destroyed tombstone is not: it is a marker this mod leaves alone
  on purpose, so it has its own count and one explanatory line (5.1.1), and the closing summary
  keeps the three numbers apart (`moved N Skyhook(s) onto the landing point + <offset>, D
  destroyed markers left alone, skipped S`). Nothing is created or removed, so the
  item-id counter is deliberately not touched.
- **One run per process**, held in the runtime closure: a second region command is
  refused with a pointer at `/ash stop`. The job is in memory only, so a restart ends a
  run and nothing resumes - which is safe precisely because each system is committed and
  verified as a whole.
- **Which channel a follow-up uses.** The vendor calls
  `executeChatCommand(session, rawMessage, chatHub)`, and the command's own reply travels
  through that hub, so it is the one channel proven to reach the session: the loader records
  every hub `chatCommand.install` sees (its `onHub`) and prefers it. The fallback is the
  vendor's own `broadcastLocalMessage`, captured when the chatRuntime seam is patched - the
  ordinary-chat `!ash` path has no hub - and when that has never been captured the chatRuntime
  module is required on demand **through a filename kept at module scope**. Reaching for the
  `targetMap` of `install()` from a module-level function was a live bug: the resulting
  ReferenceError was swallowed, every follow-up of a region run was dropped, and the operator
  watched a run that reported nothing while it worked systems for minutes.
- **A run never stalls silently.** `deliverFollowUp` answers true only when something actually
  took the message. When neither the hub nor the broadcaster can deliver it, the failure is
  logged at **error level** (never behind `verbose`) and the run **aborts immediately**:
  during the countdown nothing has been touched, and mid-run the system already finished stays
  committed and verified, because each system is a whole. `/ash status` also reports an active
  run (`run in progress: <kind> on <label>, <phase>, [X/N systems done, Y systems left, about
  <duration> remaining]`), so progress is observable even when the channel that carries the
  follow-ups is not working.

### 5.1.1 Reports are names, never ids

Every message this mod sends is meant to be read by the operator who asked for it, and a
line of numbers is not readable. The rules are therefore part of the runtime, not of the
call sites:

- **A solar system is named by the vendor's own `solarSystemName`** -
  `worldData.getSolarSystemByID(id).solarSystemName` (`server/src/space/worldData.js:170`).
  `describeSystemLabel` returns that name alone; there is no `(id)` suffix. When the row or
  the name is missing the label falls back to `system <id>`, which is the only place a
  system id reaches a reply.
- **A region is named from a generated table.** `lib/regionNames.js` is a frozen
  `regionID: "Name"` map (114 entries, ASCII) generated from CCP's public ESI
  `universe/regions` and `universe/regions/{id}` endpoints on **2026-10-03**, which is
  where `Period Basis`, `Delve`, `Domain`, `Stain`, `Vale of the Silent` and the
  wormhole/jove ids come from. `describeRegion(regionID)` reads it; an id it does not know
  falls back to `region <id>` rather than printing nothing, and a vendor row that carries
  its own `regionName` wins over the table because it is authoritative for that server.
  The table is data, never a live call: the mod does not talk to ESI at runtime.
- **An object is `orbital skyhook at <planet name>`.** This mod only ever moves, verifies
  or destroys Skyhooks, so the planet it orbits identifies it completely. The planet name
  comes from the row already in hand or from `worldData.getCelestialByID(planetID)`
  (`.itemName`, `worldData.js:223`); `planetNameFor` answers `an unnamed planet` when
  neither has a name, and `skyhookLabel(planetName)` is the one place the phrase is built.
  Every per-system line, `skipped:` line, `ANOMALY` line, deploy/remove detail line and
  status line goes through it - a raw itemID never reaches a reply (`/ash remove` still
  accepts one as *input*, and the post-removal `item id counter:` clause still reports the
  allocator's own number, because that is a value the operator may need to compare, not a
  label).
- **`/ash remove` accepts a planet name as well as an id.** A name is resolved inside the
  caller's own system through `getCelestialsForSystem` plus
  `orbitalState.listOrbitalsForPlanet`, and only against live Skyhooks; a name that matches
  nothing, matches several planets, or names a planet with no Skyhook is refused in words.
- **Metres are separated.** `formatMeters` renders `10,506 m`, and is used for every
  distance in a reply; the landing-point offset keeps its own `+ 25000 m` shape.
- **A destroyed marker is a count, never a list.** A record carrying `destroyed: true` is a
  marker the mod leaves alone (5.1.2), so it is reported as
  `destroyed markers left alone: N (a destroyed skyhook stays destroyed until something is
  deployed on that planet again)` - one line, one number, and no `orbital skyhook at <planet
  name>` per marker. The align system line carries the count as its own column
  (`... S skipped, D destroyed markers, K anomalies`) and so does the closing summary
  (`... D destroyed markers left alone, skipped S`); `/ash remove` and `/ash unanchor` print
  the same single line. A marker therefore never reaches a `skipped:` or `ANOMALY` line, and
  a report of nine markers is nine quiet lines shorter than it used to be.
- The non-negotiable part is tested: one suite case walks every message the fixtures
  produce (a deploy with an anomaly, an align run, a removal, a status listing over several
  destroyed markers, a failing sweep) and fails if a bare item, system or region id appears
  in any of them.

### 5.1.2 A destroyed marker is not a failure: it is the vendor's "do not re-create this"

A Skyhook this mod removes is not erased. `planetOrbitalState.markOrbitalDestroyed(itemID)`
writes a tombstone (`state = UNANCHORED`, `destroyedAtMs` set) and
`sovModernState.destroySkyhooks([id])` writes the ledger row with `active: false,
destroyed: true`; both rows are **kept**. On a claimed system the vendor's own bootstrap
appends a fresh default for every planet that has no deployed Skyhook, so a planet whose
only record is a tombstone is exactly the case that decision protects:

```
// sovModernState.js:713-718, inside bootstrapSkyhooksFromSystems
// Destroyed Skyhooks are a persistent player decision. Keep their tombstone
// while this system remains claimed instead of treating the absence of a
// live row as a bootstrap request to recreate it.
if (table.skyhooks && table.skyhooks[key] && table.skyhooks[key].destroyed === true) {
  continue;
}
```

That is why this mod never deletes or clears a destroyed record: without the marker the
next server start re-creates the Skyhook the operator deliberately removed, and it is why
an "already destroyed" answer from `/ash remove` is a success, not a refusal - the Skyhook
is gone and the marker is doing its job.

Deploying on that planet does not consume the marker either. `/ash anchor` sees the planet
as free, creates the new Skyhook under its own item id, and the destroyed record stays where
it is beside it (section 4). The planet is deployable again from the moment it is destroyed;
the marker only keeps the bootstrap from making a new one on its own.

Presentation follows from that: a marker is not work that failed, so it is never counted as
a skip and never listed one by one (5.1.1). The reports count what they moved, what they
genuinely could not move, and how many markers they left alone, in that order. The one
place a marker's own id still appears is the verbose log
(`align: leaving destroyed marker <itemID> on planet <planetID> alone`, and the same in
`unanchor`), where a developer can follow one marker; no reply ever carries it.

### 5.2 Scope and NPC space

A command's scope is one system (`here`, a bare system id, or `system <id>`) or a whole
region (`region <regionID>`). Which systems may be worked on is decided by the vendor's
own rule, never reimplemented: `isSovereigntyClaimableSolarSystem(solarSystemOrID)`
(`server/src/services/sovereignty/sovSystemRules.js:46`, exported at `:82`; it accepts a
row object or an id, `resolveSolarSystemRecord` at `:31`). It returns false for Zarzakh
(`:55`), for the regions the game never lets anyone claim
(`NON_CLAIMABLE_REGION_IDS`, `:63`), for faction space (a non-zero `factionID`, `:67`)
and for high-sec and low-sec (`security > 0`, `:71-72`).

- A **single system** that is not claimable is refused with text naming the security and
  faction values, and nothing is touched. `here` is checked the same way.
- Inside a **region** those systems are skipped, counted and named in the reply; a region
  where every system is NPC space is refused.
- If the rule cannot be loaded - or throws for a system - the command **refuses** rather
  than guessing, because building in space that is not ours is the failure worth avoiding.
- Region → systems comes from the vendor's static table, `worldData.getSolarSystems()`
  (`worldData.js:174`, exported at `:277`, ~8,490 rows, each with `solarSystemID`,
  `regionID`, `security` and `factionID`). The map is derived once and cached for the
  life of the process; the table does not change at runtime. A region id that holds no
  systems is text, not a crash.

### 5.3 The launcher contract

The third-party **EveJS Launcher** installs a mod from a ZIP, enables the manifest entry,
optionally writes a `settings.json` from its Configure panel, and can call a helper for
install/verify/profile/disable/remove/recover. `autoSkyHookDeploy` supports that path:

- **`settings` block** (`evejs-launcher.mod.json`): one file,
  `{id: "settings", base: "mod", path: "settings.json", format: "json"}`, and one field
  per configuration key - `id` is the key, `key: [id]`, `file: "settings"`,
  `restart: "game_server"`, the mod's own default and its own range. `verbose` is
  `advanced`. A test asserts both directions (every field is a key the mod reads, and
  every key except `enabled` - the launcher's own enable toggle - has a field), so the
  panel cannot drift from the code.
- **`settings.json` is a configuration source**: `<mod root>/settings.json`, read at boot
  with the precedence **process environment > `settings.json` > config JSON > `.env` >
  built-in default** (`config.js:load`, `pick`). A malformed one fails closed like any
  other source; a missing one is not a problem. `/ash offset` writes *whichever file is in
  force* (`config.offsetFilename`), so an in-game value is never shadowed by the panel's
  copy.
- **`launcherApi` block** + `launcher/helper.js`: the same request/result protocol and the
  same six capabilities. The helper answers every request with the request id, never
  throws, and is honest about there being no client half: `prepare_profile` reports
  `clientScriptDelivery: "none"`, and `prepare_disable`/`prepare_remove` report that
  nothing outside the mod folder needs undoing.
- **`updates` block**: GitHub provider, `HalCyonNJ/EveJS-AutoSkyHookDeploy`,
  `EveJS-AutoSkyHookDeploy-{version}.zip`, `stable`, tag prefix `v`, and
  `preserveFiles: ["settings.json"]`. It does nothing until that repository and a Release
  exist.
- **`tools/build-package.js` + `tools/BuildPackage.bat`** build
  `dist/EveJS-AutoSkyHookDeploy-<version>.zip` from the working tree (no git needed), with one
  `autoSkyHookDeploy/` folder inside, excluding build output, VCS metadata, dependency
  folders and stray archives. `--dry-run` prints exactly what would be packaged.

**Unverified assumptions.** There is no launcher on the machine this was developed on and
no schema document: the contract above was read off a working third-party package
(`soloProgressionBalance` 0.4.1), field by field. Specifically unverified: that the
`settings` block's `files`/`fields` shapes and the `minimum`/`maximum`/`advanced` members
are exactly what the launcher parses; that a `string` field (used here for `ownerMode`,
because the example had no choice field) is accepted; that the helper is invoked with
`--request`/`--result` and that its result members (`state`, `message`,
`restartRequired`, `contributions`, `environment`, `arguments`,
`clientScriptDelivery`) are read as assumed; that the launcher consumes `settings.json`
with the precedence its README states; that `preserveFiles` and the GitHub `updates`
provider behave as declared; and whether the launcher would rather have a
`loader.js.disabled` payload than an active `loader.js` (this mod ships an active
`loader.js`, because its Docker and native installers and the container's `--require` all
depend on that name, and a launcher install simply enables the manifest entry - the same
as the two sibling mods). None of this changes the server-side behaviour: with no
launcher, nothing about the mod changes at all.

---

## 6. The two chat seams

### `/ash` - the slash path

The client sends a line that starts with `/` as a `slash.SlashCmd`, which reaches
`chatCommands.executeChatCommand`
(`server/src/services/chat/chatCommands.js:1071`). The loader overlays that
export:

- the command name is pushed into `AVAILABLE_SLASH_COMMANDS` (`:291`) when that
  array is still an array and still extensible;
- the six `/ash` lines are appended to `COMMANDS_HELP_TEXT` (`:455`) **in
  whatever shape the export is in** - an array gets four more entries, and an
  already-joined string gets a newline and the lines, because a sibling loader
  mod may have coerced it first;
- the wrapper matches its own command and answers it, and calls the previous
  function for everything else, so `/sov`, `/aud`, `/help` and every other
  command behave exactly as before;
- the export itself is checked for a writable property descriptor first. A
  read-only export is left alone and reported, never half-patched.

### `!ash` - the ordinary-chat path

A line without a leading `/` never reaches `executeChatCommand`. The client sends
it as a plain chat message, `xmppStubServer` hands it to `chatRuntime`, and
`chatRuntime.broadcastLocalMessage`
(`server/src/_secondary/chat/chatRuntime.js:1701`) broadcasts it unconditionally.

The seam is therefore the broadcaster, and the reply **is a thrown `Error`**:

```
try { sendResult = chatRuntime.broadcastLocalMessage(session, body); }
catch (error) { sendSystemMessageToClient(client, roomJid,
                  formatChannelAccessError(error, "speak")); return; }
```

`formatChannelAccessError` returns `error.message` for any error whose code it
does not recognise. Throwing therefore does four things at once: the reply goes
to the sender alone as a system line, the broadcast is suppressed, the channel
backlog stays clean, and no other chat is affected. The error carries **no
`.code`**: a recognised code would be translated into a different message.
`sendChannelMessage` (`:1004`, message at argument index 2) is wrapped the same
way, so the trigger behaves identically in any chat window.

The loader marks both upstream objects and both wrapper functions with
`Symbol.for("evejs.autoSkyHookDeploy.<thing>")`, so a double wrap is impossible
even if two preload entries are ever registered.

### Session identity

The caller's character, corporation and alliance come from the session
(`session.characterID`/`charid`, `corporationID`/`corpid`,
`allianceID`/`allianceid`), with the character record as a fallback, and the
current solar system from `session.solarsystemid2 || session.solarsystemid` -
the same recipe the vendor uses in `skyhookRuntime.identityFor`
(`server/src/services/sovereignty/skyhookRuntime.js:27`). `here` resolves
through that value only, so a caller with no current system gets a clear message
instead of a guess.

---

## 7. Loading, and failing closed

`loader.js`:

1. Chains `Module._load`. The previous loader always runs first; this mod only
   post-processes what comes back. Canonical filenames are resolved with
   `fs.realpathSync.native`, lowercased on win32, and target requests are
   resolved with `Module._resolveFilename` inside a `try`/`catch`, so a failed
   resolution can never break an unrelated `require`.
2. Patches modules that are **already** in `Module._cache` (a sibling mod's
   preload may have loaded chat earlier) and modules loaded afterwards, through
   the same `applyTarget`.
3. Skips worker threads unless explicitly allowed, so a worker never installs a
   second copy of the hooks.
4. Wraps the whole install and each individual target patch in `try`/`catch`: a
   loader that throws during `--require` would take the server down with it.
5. Logs one stable line when it is ready:
   `[autoSkyHookDeploy] v1.0.0 loader ready - /ash anchor|remove|status|help and
   !ash work for every character ...`

**Fail closed.** The configuration is read before anything is patched. If any
value has the wrong type or is out of range, every offending key is logged, the
message `invalid mod-owned configuration - no hooks installed` is written, and
the loader installs **no** hooks at all: no `Module._load` chain, no overlay, no
`AVAILABLE_SLASH_COMMANDS` entry. The server then behaves exactly like vanilla
EveJS, which is the only safe direction for a configuration error.

Priority: environment variable > `<EveJS root>/config/autoSkyHookDeploy.json` >
the mod's own `.env` > built-in defaults. The JSON file is the deployment-friendly
spelling because `**/.env` is dropped from the image, while `config/` is
bind-mounted. Keys may be written either the long way (the environment variable
name) or the short way used by `config.example.json`.

Every entry point into vendor code is wrapped:

- the slash wrapper and the plain-chat wrapper each have their own `try`/`catch`
  around the command handler, so a throw becomes a reply;
- `buildPlan` / `applyPlan` / `removeSkyhook` / `unanchorSystem` / `statusSystem` /
  `handleOffsetCommand` guard each vendor
  call individually, so one broken store degrades one feature and not the reply.
  The offset's state store is guarded the same way: an unreadable file or a failing
  write becomes a reply, never a throw;
- the scene work in a deploy is guarded separately, because it must not undo a
  durable row.

---

## 8. Tests

`node test\run.js` (or `RunTests.bat`) runs the whole suite without a server, a
scene or a game database. The vendor surface is replaced by fixtures through
`createServerDeps`-shaped dependency injection, and the two chat seams are driven
directly, including a child process that installs the real `Module._load` chain
against a throwaway tree and then calls `/ash help`, `/motd` and `!ash help`
through the patched exports.

The suite covers: the command parser and every accepted spelling (including bad
input), the plan builder for a system that is all free / partly occupied / fully
occupied / all destroyed tombstones (which are deployable again) / has a
structure-shaped skyhook / has a deployed ledger row with no orbital record / has
nothing but the game-created slot rows of a claimed system (which deploys every
planet) / has a destroyed planet slot (deployable too) / mixes a slot, a live
skyhook, an orbital tombstone, a structure-shaped skyhook and a deployed ledger
row in one system, that the tombstones survive a deploy over them with
`destroyedAtMs` intact, that a deploy lands exactly `offsetMeters` past the vendor's
warp-in point (the default, a configured value and `0`) with `direction` the unit
vector to the landing point, `targetPoint` equal to the position and the
fallback formula demonstrably unused, that the offset never applies to the fallback,
that the fallback still applies (and keeps its
scaled distance, the clamped planet radius, the horizontal star-facing direction and
the `+X` degenerate case) when the warp-in point is absent, the accessor is missing,
it throws, or it returns a point at the planet's centre, that `/ash offset` reads and
sets the value in both units, refuses out-of-range and unparsable input without
changing anything, that `5`, `5km` and `5000m` all resolve to 5,000 m and that the
value survives a fresh runtime built on the same configuration file, that a file which
is missing, broken or out of range is reported without becoming a problem for a
missing one (and fails closed for a broken one), that `remove <id>` destroys exactly one skyhook and refuses a bad, unknown,
structure-shaped or already-destroyed id with text, that `/ash remove here` points at
`/ash unanchor` and a solar system id does too, that the sweep is unchanged, that the
item-id counter is calibrated exactly once per command and only when it is behind
(both directions, including a throwing allocator and an unreadable game store), that
`spaceRadius` is passed with the metadata radius and omitted when the metadata is
unavailable, that no reply mentions a hub on any path, the
`maxPlanetsPerCommand` cap, the destruction triple in order, `DYNAMIC_ENTITY_NOT_FOUND` as success, a
throwing vendor call being reported rather than propagated, that an align run never creates a
scene (`ensureScene` is spied on and must stay untouched, and a runtime without the read-only
accessors falls through to the store-only path), that an item realised in an already-loaded
scene is moved through the scene's own `setEntityPosition` - with the receiver asserted to be
the scene, the store row written and the entity read back - while an item whose scene is not
loaded is moved through the store alone, verified, and never reported as "in use", that a
loaded scene which refuses the move skips with the honest note and leaves nothing half-written,
that destroyed markers are counted in a single line on the align, removal and status paths
instead of being listed as skips (`0 skipped, N destroyed markers` with no per-marker line and
no per-marker id),
fail-closed
configuration installing no hooks, the manifest version matching `MOD_VERSION`,
the installer payload pruning and preload registration, and a live probe that
asserts the vendor entry points named in this document still exist in the tree
beside the mod. Two of those cases pin the registration position itself: the
Docker `--require` flag must land immediately before the module path (last in the
continuation group) and the native `NODE_OPTIONS` block must land after every
preload block already registered, because this mod wraps the exports it is handed
and therefore has to own the outermost `Module._load` hook. A loader that
replaces exports wholesale sits innermost, and registering this mod ahead of it
would put its chat seams inside a hook that can be replaced.

---

## 9. Invariants

These were learned from a real incident on a live server. None of them is
negotiable, and each is enforced by construction rather than by convention.

1. **Never clear a tombstone.** Do not create an `items` row *instead of* the
   one a destroyed skyhook used to have, do not delete a destroyed orbital record
   and do not clear `destroyedAtMs` or `destroyed: true`. A missing item row can
   mean "destroyed", not "never deployed". Deploying over a tombstone is allowed
   (section 4) and writes a **new** item id and a **new** orbital record beside
   the old one; the old record is left exactly as it was. `remove` leaves an
   existing tombstone alone and counts it as a destroyed marker (5.1.2), and no
   code path in this mod writes an
   `items` row except `createSpaceItemForOwner` during a deploy of a planet that
   passed every occupancy check.
2. **Never delete a destroyed skyhook's orbital row.** The tombstone is what
   stops the vendor from minting a fresh default for that planet. `remove` calls
   `markOrbitalDestroyed` (which keeps the row) and never deletes records.
3. **One live skyhook per planet.** A live orbital, a structure-shaped skyhook,
   or a sovereignty ledger row for a real deployment is occupancy; a destroyed
   record is history and is deployed over. A plan is built from the vendor's own
   lists before a single row is created.
4. **Never call `sovParityReset`.** It wipes every skyhook, hub, claim and
   alliance on the server.
5. **Never route a skyhook through the sovereignty-structure path, and never
   call `anchorOrbital` / `onlineOrbital` on one.**
6. **Never let a throw escape into a chat broadcast or a scene pass.** Every hook
   body is wrapped, and every failure is reported to the caller as text.
7. **Never write the installer's config file, and never fail closed on the state
   file.** `config/autoSkyHookDeploy.json` belongs to the installer and is never
   overwritten by any code path; runtime-adjustable values go to the mod's own
   never rewrite a configuration file it could not parse, and never let a file that
   breaks after boot take the mod offline: /ash offset reports it, keeps the last
   good value, and leaves the file alone.
8. **Never write game state to fix a counter.** The item-id counter is moved only
   through the vendor's `reserveItemIDs`, only when it is behind the high-water mark,
   and at most once per removal command - the allocator consumes the id it returns,
   so an unconditional call would leak one id per removal.
