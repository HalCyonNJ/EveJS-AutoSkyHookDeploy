# Changelog

All notable changes to this mod are recorded here. One section per release; the
version matches `MOD_VERSION` in `loader.js` and the version in
`evejs-launcher.mod.json`.

## 1.0.0 - 2026-10-02

First release.

- **`/ash anchor here|<systemID>`** (alias `/ash a`) deploys one Orbital Skyhook
  (typeID 81080) next to every planet in a solar system that does not already
  have one. No item is consumed, no ship is needed, and the caller does not have
  to be in the target system.
- **`/ash remove <skyhookID>`** (alias `/ash r`) destroys **one** Skyhook, named either
  by the id the scanner shows and `/ash status` uses, or by the name of the planet it
  orbits in quotes (`/ash remove "RYQC-I III"`). A planet name is resolved inside the
  caller's own system and only against the Skyhooks deployed there, so an operator can
  use the name they read off the screen instead of a number. An id must name a Skyhook
  this server knows (an orbital record, or a derived ledger row), and must not be a
  structure-shaped one - that case is reported instead of touched. The vendor's
  destruction sequence then runs for that one Skyhook - orbital tombstone, scene entity
  (which removes the `items` row), then the sovereignty ledger tombstone - and every
  refusal is text, never an exception: a name matching no planet, a planet with no
  Skyhook, an ambiguous name and an unknown id each get a sentence. Asking twice about
  the same Skyhook is answered gracefully.
- **`/ash unanchor here|<systemID>`** (alias `/ash ua`) destroys every Skyhook in a
  system, whoever deployed it, exactly as `/ash remove here` used to, with the same
  per-id sequence and the same reporting. `remove` no longer accepts a system, and
  `unanchor` no longer accepts an id; `/ash remove here` answers with a pointer to
  `/ash unanchor here`, and so does a bare system id.
- **The item-id counter is calibrated after a removal.** A removal deletes an `items`
  row, so the game's own "next item id" counter is re-synced once per command through
  the vendor's allocator: `getItemReferenceHighWaterMark()` is compared with the stored
  counter, and only when the counter is not above that mark is
  `reserveItemIDs(1)` called to force it forward (that call consumes an id, so it is
  never made when the counter is already correct). The mod never writes the identity
  table itself, and the reply carries one short clause -
  `item id counter: 9988400003304 (already ahead of the highest id)` or
  `raised to ... (was ..., highest id ...)`. If the allocator is unavailable the
  removal still happens, the clause is omitted, and a verbose run says why.
- **`/ash offset [<value>]`** (alias `/ash of`) reads or sets how far past a planet's
  landing point a Skyhook is placed. A bare number is kilometres (`5`), and either unit
  can be spelled out (`5km`, `5000m`); the reply always echoes metres and kilometres,
  and out-of-range or unparsable input is refused with text without changing anything.
  The value is written into **whichever configuration file is in force** - the launcher's
  `settings.json` when there is one, the installer's `config/autoSkyHookDeploy.json`
  otherwise - and that file is re-read on every command, so a change takes effect
  immediately and survives a restart with no restart flag and no image rebuild. A file
  that cannot be parsed is reported in text and never rewritten: the last good value
  stays in force.
- **`/ash anchor|unanchor region <regionID>` and `system <systemID>`** scope a command
  to a whole region or to one named system (`here` and a bare numeric id keep working).
  Which systems are workable is decided by the game's own
  `isSovereigntyClaimableSolarSystem` and never reimplemented: a single system in
  NPC/faction space (or high-sec/low-sec) is refused, those systems are skipped and named
  inside a region, and a region where every system is NPC space is refused.
- **A region command is paced and abortable.** Mass-creating structures can stall the
  server, so `region` announces a countdown (`regionCountdownSeconds`, default 15 s,
  ticking at 10 s and 5 s), then works **one system at a time**, verifies what that system
  wrote (item row present, position equal to the landing point plus the configured offset,
  live orbital record attached to the right planet), reports it
  (`MVUO-F: deployed 9, verified 9 at the landing point + 25000 m, 0 anomalies
  [1/40 systems done, 39 systems left, about 2 m 02 s remaining]`) and waits
  `regionStepDelayMs` (default 2000 ms) before the next one. A failing system
  is reported and the run continues. New `/ash stop` (`/ash st`) cancels during the
  countdown with nothing done, or ends the run after the system being worked has been
  finished and verified; one run exists per process, a second is refused with a pointer at
  it, and a server restart simply ends a run - nothing resumes half-way.
- **Reports are written in names, with progress and time left.** `describeSystemLabel`
  returns the vendor's own `solarSystemName` alone (no `(id)` suffix, falling back to
  `system <id>`), a region is named from the generated table in `lib/regionNames.js`
  (built from CCP's public ESI `universe/regions` endpoints on 2026-10-03, with
  `region <id>` as the unknown-id fallback), and every object is
  `orbital skyhook at <planet name>` rather than an item id. Every per-system line and
  the closing line carry `[X/N systems done, Y left, about <duration> remaining]`, with
  `Y` counting Skyhooks for an align run; `/ash status` prints the same bracket while a run
  is active. Distances read with thousands separated (`10,506 m`), and a raw item, system
  or region id no longer appears in any user-facing line - the one deliberate exception is
  the item-id counter clause after a removal, which is an instruction-shaped value rather
  than a label. A test walks every message the fixtures produce and fails on a bare id.
- **EveJS Launcher support**: the manifest now carries the `settings`, `updates` and
  `launcherApi` blocks, `settings.json` in the mod folder is a real configuration
  source (precedence **process environment > `settings.json` > config JSON > `.env` >
  default`), `launcher/helper.js` implements the helper protocol for all six
  capabilities, and `tools/build-package.js` + `tools/BuildPackage.bat` build
  `dist/EveJS-AutoSkyHookDeploy-<version>.zip`. The launcher path was derived from a working
  third-party package because no launcher and no schema document are available here, so it
  is **implemented but untested by us**; the assumptions are listed in
  `HOW-IT-WORKS.md` and `LAUNCHER.md`.
- **`/ash align [here|system <systemID>|region <regionID>]`** (alias `/ash al`) moves the
  Skyhooks already in the world onto the configured `offsetMeters` - the placement a fresh
  deploy would produce - because changing the offset only affects new deploys. The command is
  named `align`, spelled out or as `/ash al`; the earlier working name `reanchor` and its `ra`
  short form are not accepted and answer with a pointer at `align`. With no
  argument it covers every system that holds a Skyhook, including ones deployed by hand. Each
  move is written through the vendor's own `itemStore.updateInventoryItem` (never a direct
  store write), followed by `spaceRuntime.refreshInventoryBackedEntityPresentation` when the
  vendor exposes it, and verified by re-reading the row. It is paced exactly like a region run
  and `/ash stop` applies; a planet with no usable landing point and a missing item row are
  reported as skips, and a destroyed tombstone is counted as a marker rather than a skip (see
  the marker bullet below). Nothing is created or removed, so the item-id
  counter is untouched.
- **Region and align runs estimate their own time.** The countdown reply now carries a line
  such as `estimated 4 m 12 s: 85 systems, 612 planets, 84 x 2000 ms step delay, 15 s
  countdown (measured 48 ms per planet so far)`, and the final line reports the actual
  elapsed time against that estimate (`finished - 40 of 40 systems done, 0 left, in
  2 m 41 s (including the countdown; estimated 3 m 05 s; 49 ms per planet measured)`). The
  figures come from a process-level moving average of the real per-planet and per-system cost,
  so the first estimate is approximate and later ones are closer; the per-system lines use the
  same machinery over what is still outstanding, which is where their "about ... remaining"
  comes from. The countdown reply also carries a reminder to stay in game and not jump or log
  off until the run finishes.
- **Fixed: `/ash align` counted attempts as successes, and its moves were thrown away in a
  system whose scene was loaded.** Writing `spaceState.position` through
  `itemStore.updateInventoryItem` is right for an item nobody has realised, and a live test
  proved it: twelve systems nobody was in ended up at exactly `landingPoint + offsetMeters`. But
  in the system the operator was standing in, all ten Skyhooks were reported `moved` while every
  one of them was byte-identical in the store afterwards - `moved 10, verified 0`, with the ten
  `ANOMALY ... sits <n> m from the landing point` lines that made the failure visible. A
  realised entity is authoritative for its position, so a move now goes through the vendor's own
  authority first when the item is realised in a scene that is already loaded
  (`scene.setEntityPosition` - the scene is the clock in this vendor - falling back to
  `scene.positionAuthority.setEntityPosition`, `scenePositionAuthority.js:234`), reads it back to
  confirm, and then writes the store row. The counts are what the verification confirms rather
  than what was attempted - the system line reports `M orbital skyhooks moved (of A attempted), V
  verified at the landing point + <offset>, S skipped, K anomalies` - so a run can never claim
  `moved 10, verified 0` again. Verification reads the realised entity when there is one and the
  store row otherwise. The default `offsetMeters` also rose to **25,000 m (25 km)**, from 10,000.
- **Fixed: an align run no longer creates a scene, and no longer calls a clock that does not
  exist.** A live `/ash align region 10000063` reported all **40 of 40** systems as "in use
  (its scene is loaded)" with `0 ... moved ... 9 skipped` and moved nothing - while the operator
  was in exactly one system, and the region deploy they had run just before had deployed nothing
  at all ("all 9 planets already have a skyhook"). Two root causes, both verified against the
  vendor source: (1) the read path called `spaceRuntime.ensureScene(systemID)` for each system,
  and that call *creates and bootstraps* a scene (`sceneRegistry.js:149`) - so the mod itself
  loaded all 40 systems, realised their entities and then reported every one of them as realised
  and unmovable; (2) the move called `scene.clock.setEntityPosition(...)`, but there is no
  `scene.clock` in this vendor - `setEntityPosition` is a method of the scene itself
  (`solarSystemScene.js:140` installs `this.positionAuthority`, and the methods of
  `scene/clock.js` are mixed into `SolarSystemScene.prototype`), so the call was made on
  `undefined`, which is why every system "exposed no position authority". The align read/move
  path now asks the non-creating `spaceRuntime.isSolarSystemSceneLoaded(systemID)`
  (`sceneRegistry.js:56`, a registry read only), fetches the scene with the non-creating
  `getSceneByDescriptor` (`sceneDisposal.js:522`), and calls
  `scene.setEntityPosition(itemID, position, { reason, velocity: 0 })` - falling back to
  `scene.positionAuthority.setEntityPosition` - only when the item is realised in a scene that is
  already loaded. When no scene is loaded the move is the store write alone, the path that always
  worked, and no "in use" note is printed. That note is now accurate and reserved for a real
  loaded-scene refusal: `solar system <name>: its scene is loaded and would not accept the move;
  the vendor unloads an empty scene on its own, so try again later`. The deploy and removal paths
  keep their `ensureScene` calls (a fresh deploy must load the scene to spawn the entity, a
  removal must load it to destroy the entity), so a deploy or removal legitimately leaves a scene
  loaded for a while - which is exactly why an align run's move has to be correct on the scene
  itself. A test spies on the vendor runtime and fails if an align run calls `ensureScene` at all.
- **Fixed: a region run's follow-up messages could be dropped silently.** `deliverFollowUp`
  reached for a `targetMap` binding that exists only inside `install()`, so for a slash-only
  session - where the chatRuntime seam is never patched and no broadcaster has been captured -
  the lazy path threw a ReferenceError that its own try/catch swallowed, and every follow-up
  was lost. The run itself kept working systems for minutes while the operator saw no tick, no
  per-system report and no summary; only the release command (`/ash stop`) answered, which is
  exactly what the live test showed. Follow-ups now go through the **chat hub the command
  arrived on** (`chatHub.sendSystemMessage`, the same channel the command's reply uses) and
  fall back to the captured `broadcastLocalMessage`, with the chatRuntime filename held at
  module scope for the on-demand load. When neither can deliver, the failure is logged at error
  level and the run **aborts immediately** instead of stalling, and `/ash status` reports an
  active run (`run in progress: <kind> on <label>, <phase>, [X/N systems done, Y systems left,
  about <duration> remaining]`).
- **`/ash status [here|<systemID>]`** (alias `/ash s`) reads the system back per
  planet: live, free, or free over a destroyed skyhook (which is deployable).
- **Destroyed markers are counted, not listed, and are no longer called skips.** A record
  carrying `destroyed: true` is the marker that stops the vendor's bootstrap from re-creating
  a destroyed Skyhook (`sovModernState.js:713-718`), so no report prints an
  `is a destroyed tombstone` line per marker any more: an align system line carries its own
  `D destroyed markers` column above one `destroyed markers left alone: D (a destroyed
  skyhook stays destroyed until something is deployed on that planet again)` line, the
  closing summary reads `D destroyed markers left alone, skipped S`, and `/ash status`,
  `/ash remove` and `/ash unanchor` count them the same way - no id, no per-marker line, and
  no behaviour change: the markers are still never deleted, never cleared and never counted
  as failures.
- **`/ash help`** (alias `/ash h`).
- Every subcommand also works in ordinary chat as **`!ash ...`**, so a character
  without staff rights can drive the mod; the line is consumed before it is
  broadcast to the channel.
- **One live Skyhook per planet.** A planet that already has a live Skyhook, a
  structure-shaped Skyhook or a sovereignty ledger row for a real deployment is
  occupied and is skipped. Neither of the two things that look like occupancy is
  one: the free ledger slot a claimed system mints for an empty planet is the room
  a Skyhook goes in, so `/ash anchor` works in exactly the systems it exists for;
  and a **destroyed** Skyhook does not block a replacement (see the next bullet).
  Every deploy reply reports how many were deployed, how many were skipped as
  already present and how many went over a destroyed skyhook; a fully occupied
  system fails with a clear error instead of a silent success.
- **A destroyed Skyhook is replaceable.** Destroying an orbital Skyhook does not
  prevent a new one on that planet: the vendor's launch path has no uniqueness
  check, and `sovModernState.js:713-717` only stops the *bootstrap* from
  re-minting the default slot for a claimed planet. A destroyed orbital tombstone
  and a destroyed planet slot are therefore history, not a "no". The old record is
  never deleted and `destroyedAtMs` is never cleared (a standing invariant); the
  replacement gets its own item id beside it, the deploy reply counts it in its
  own column (`N over a destroyed skyhook`) and names the kind of record it found
  (`old orbital tombstone - kept as history`) without quoting its id, and
  `/ash status` reports the planet as
  `free (destroyed skyhook tombstone - a new one may be placed here)`. A planet is
  deployable again straight after `/ash remove`.
- Partly populated systems deploy only the missing planets; each Skyhook starts
  `ONLINING` with the vendor's own 60 s activation timer and settles to `IDLE` by
  itself.
- **Each Skyhook is placed on the planet's warp-in point** - the one deterministic
  spot a warp to that planet always lands on. The mod reads it from the game's own
  code: `getPlanetWarpInPoint` (`warpInPointParity.js:208`, seeded from the planet's
  itemID) via `getClientParityWarpInPoint` (`:256`), the same point the game appends
  to its structure deployment positions
  (`structureDeploymentPlacement.js:276-294`) and warps a player to
  (`warpCommands.js:523-528`). `position` is that point plus
  `unitVector(planet -> point) * offsetMeters`, `direction` is the
  unit vector from the planet's centre to the landing point - the landing point's
  deliberate small vertical component is kept, the offset does not move it, and
  `direction.y === 0` is now a property of the
  fallback only, not of the rule - and `targetPoint` is the position. A Skyhook at
  the planet's centre is inside the planet, which is why the centre was never an
  option.
- **`offsetMeters` (default 25,000 m = 25 km, range 0..100000) moves the Skyhook past
  the landing point, because warping in collided with its model.** A ship warping to
  a planet materialises exactly on that point, so a Skyhook placed there is a model in
  the ship's face; the offset puts it just beside the arrival spot, along the same
  bearing. `0` puts it exactly on the landing point. It applies to the warp-in branch
  only - the fallback placement has no landing point to keep clear of. Env
  `EVEJS_AUTO_SKYHOOK_DEPLOY_OFFSET_METERS`; the operator's in-game report
  ("everything is findable now, and it works") is where the jitter started; the default is
  now 25 km, because the structure is large and even 10 km left a warp landing against it.
- **`standoffMeters` and `orbitMargin` are the fallback placement's inputs.**
  They are used only when the game has no usable warp-in point for a body (the
  accessor is missing or threw, it answered `null`, the point is not a finite vector,
  or it coincides with the planet's centre - the vendor itself declines bodies under
  `MIN_WARP_IN_POINT_RADIUS` (90,000 m), asteroid belts and wrecks): the Skyhook then
  goes `planetRadius + beyondSurface` from the centre with
  `beyondSurface = Math.max(standoffMeters, planetRadius * orbitMargin)`,
  horizontally on the star-facing side. `standoffMeters` (env
  `EVEJS_AUTO_SKYHOOK_DEPLOY_STANDOFF_METERS`) is the floor, default **5,000,000 m
  (5,000 km)** beyond the surface, range 100,000..100,000,000 m
  (100 km..100,000 km) - the game's own static-scene orbitals use 100,000 m
  (100 km), which a live test showed is too close to interact with comfortably,
  while the operator's manual deployments from a ship sit 4,600,000-7,000,000 m
  beyond the surface (median 5,202,512 m). `orbitMargin` (env
  `EVEJS_AUTO_SKYHOOK_DEPLOY_ORBIT_MARGIN`) is how many planet radii above the
  surface the fallback goes - a float, default **1.0**, range 0..10 - and the larger
  of the two wins there. The planet radius is clamped to the vendor's 1,000 m floor
  in the fallback. The fallback direction is horizontal and star-facing, read from
  `worldData.getCelestialsForSystem` (rows with `kind === "sun"` or `groupID === 6`),
  never by parsing the celestials file; with no star row, an unreadable catalogue or
  a planet sitting on its star it is `+X`.
- **The earlier distance experiments were a red herring.** Two live tests went into
  a fixed standoff and then a planet-scaled one (`standoffMeters * orbitMargin`
  scaling, and a correlation with the client's
  `PUBLIC_GRID_NEARBY_VISIBILITY_RADIUS_METERS = 12_500_000` at
  `server/src/space/destiny/visibility/constants.js:32`). Neither was the cause: a
  Skyhook 5,000 km off in an arbitrary direction is simply not where the player
  lands. The operator's in-game evidence settled it, and the placement now uses the
  landing point. The distance, both fallback keys, the floor-beats-margin and
  margin-beats-floor cases and the clamp are all asserted by the suite.
- **`spaceRadius` parity with a launched Skyhook.** A launched one carries the
  type's radius in `spaceRadius` (`orbitalLaunchRuntime.js:427-437`), and a
  mod-created row was missing exactly that field. The radius is now read from
  `itemStore.getItemMetadata(81080)` and passed explicitly - never hard-coded - and
  omitted again when the metadata is unavailable, which leaves the vendor's own
  `|| null` behaviour in place. With that, a conjured row matches a launched one in
  every field the game reads.
- Configuration with fail-closed validation: `enabled`, `verbose`,
  `allowDeploy`, `allowRemove`, `maxPlanetsPerCommand`, `offsetMeters`,
  `standoffMeters`,
  `orbitMargin` (the last two are the fallback placement's inputs), `ownerMode`,
  `requireClaimedSystemOwnership`,
  `includeDestroyedInStatus`, `regionCountdownSeconds`,
  `regionStepDelayMs`. A
  wrong-typed or out-of-range value installs no hooks at all and logs the
  offending keys. That rule covers the launcher's `settings.json` too (it is a
  configuration source), except that a **missing** `settings.json` is not a problem:
  without a launcher there is simply nothing there.
- Installer for the Docker and the Windows native deployments, with idempotent
  preload registration, backups under `<EveJS root>\_autoskyhookdeploy-backup\`,
  and server configuration seeded into `config/autoSkyHookDeploy.json` once and
  never overwritten.
- **The preload is registered last, so this mod owns the outermost hook.** It
  wraps the chat seams it is handed, so it must load after loaders that replace
  exports wholesale; both the Docker `--require` list and the native
  `NODE_OPTIONS` block are placed after every preload already registered, and a
  stray copy of this mod's own block is removed first. Both positions are
  asserted by the suite.
- Test suite (`node test\run.js`): command parser, plan builder, occupancy rules,
  placement (the Skyhook landing exactly `offsetMeters` past the vendor's warp-in
  point with the unit direction to the landing point, and the fallback with both keys,
  the floor-beats-margin and
  margin-beats-floor cases, the radius clamp and the horizontal star-facing
  direction including its own fallbacks), the offset's chat read/set/persist path
  (including `5`, `5km`, `5000m`, refusals, and a fresh runtime seeing the saved
  value), the single-id removal and its refusals, the sweep, the item-id calibration
  in both directions, `spaceRadius` parity, the destruction
  sequence, chat seams, fail-closed configuration and the installer, all without a
  server, a scene or game data.
