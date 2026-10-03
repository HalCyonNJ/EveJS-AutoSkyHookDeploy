# Auto Skyhook Deploy

A server-side loader mod for **EveJS 0.12.9** that conjures **Orbital Skyhooks**
(typeID 81080) onto every planet of a solar system that does not already have
one, and removes them again.

- No item is consumed. Nothing has to be carried.
- No ship is needed, and the caller does not have to be in the target system.
- Nothing is written to the EveJS source tree: the mod overlays two chat entry
  points in memory when the server loads.
- Server-side only. The client is not modified and no overlay is shipped.

Everyone can use it: it is a single-player private game, and the two command
spellings are just two ways to type the same thing.

| Command | Alias | What it does |
|---|---|---|
| `/ash anchor here`<br>`/ash anchor system <systemID>`<br>`/ash anchor region <regionID>` | `/ash a` | Deploy one Skyhook next to **every planet that does not already have one**, in one system or in every sovereignty-claimable system of a region. NPC/faction space is refused for a single system and skipped inside a region. |
| `/ash align [here\|system <systemID>\|region <regionID>]` | `/ash al` | Move the Skyhooks that are **already deployed** onto the configured `offsetMeters` - the placement a fresh deploy would produce. With no argument it covers every system that holds a Skyhook, including ones deployed by hand. Paced exactly like a region run, and its per-system line counts Skyhooks left. |
| `/ash remove <skyhookID>`<br>`/ash remove "<planet name>"` | `/ash r` | Destroy **one** Skyhook, named either by the id the scanner shows and `/ash status` uses, or by the name of the planet it orbits - `/ash remove "RYQC-I III"`, resolved in the caller's own system. |
| `/ash unanchor here`<br>`/ash unanchor system <systemID>`<br>`/ash unanchor region <regionID>` | `/ash ua` | Destroy **every Skyhook in that scope**, whoever deployed it. A region runs paced, one system at a time. |
| `/ash stop` | `/ash st` | Cancel a region run: during its countdown nothing has been done, otherwise the system being worked is finished and verified first. |
| `/ash offset [<value>]` | `/ash of` | Read or set how far past the planet's landing point a Skyhook is placed (default 25,000 m). Kilometres (`5`, `5km`) or metres (`5000m`); saved for the next restart. |
| `/ash status [here\|<systemID>]` | `/ash s` | Read-only: per planet, whether a Skyhook exists (live), is free, or is free over a destroyed tombstone. While a run is in progress it also prints that run's progress and time left. |
| `/ash help` | `/ash h` | The short help. |

**The same subcommands work in ordinary chat as `!ash ...`** - so
`!ash anchor here`, `!ash al region 10000043`, `!ash remove 9988400003181`, `!ash remove "RYQC-I III"`, `!ash ua region 10000043`, `!ash stop`, `!ash of 10km`,
`!ash s`, `!ash h` all work for a character
who has no staff rights. A `!ash` line is consumed before it is broadcast, so it
is never shown to anybody else.

## The one-Skyhook-per-planet rule

A planet that already has any of the following is **occupied and is never built
on twice**:

1. a live Skyhook (an orbital record for typeID 81080 with no tombstone);
2. a **structure-shaped** Skyhook (typeID 81080 is also registered as a
   sovereignty structure, so a second, competing deploy route exists);
3. a **sovereignty ledger row for a real deployment** - a record under a real
   item id, or one carrying `deployedItem`, that is not itself a tombstone.

Two things are deliberately **not** occupancy, and each is a correction from a
live test:

- the free *slot* row the game mints for every planet of a claimed system that
  has nothing built on it. It is the room a Skyhook is meant to go in, and
  `/ash anchor` fills it, which is what makes the command useful in a claimed
  system.
- a **destroyed Skyhook**. Destroying one does **not** prevent deploying a new
  one on that planet. The old record (an orbital tombstone, or a destroyed planet
  slot) is left exactly where it is as history - never deleted, never cleared -
  and the replacement gets its own item id beside it. The reply counts those
  deployments separately.

Partially populated systems are the normal case. Every deploy reply states three
counts, whether it deployed anything or not:

```
autoSkyHookDeploy v1.0.0: Jita: deployed 3, skipped 2 already present, 1 over a destroyed skyhook
  deployed: orbital skyhook at Planet I; orbital skyhook at Planet II; orbital skyhook at Planet III
  over a destroyed skyhook: orbital skyhook at Planet IV (old orbital tombstone - kept as history)
```

If **all** planets are occupied the command fails with a clear error instead of
reporting a silent success:

```
autoSkyHookDeploy v1.0.0: nothing to deploy: Jita: all 5 planets already have a skyhook (5 present); nothing to deploy
```

Each Skyhook is placed **just past the planet's warp-in point** - the one spot a
warp to that planet always lands on, whatever angle you approach from. The mod reads
that point from the game's own code (`getClientParityWarpInPoint`), the same point
the game uses for structure placement and warps you to, and then moves the Skyhook
`offsetMeters` further out along the same bearing (25,000 m = 25 km by default) so a
ship warping in does not materialise inside its model. The landing point's vertical
component is kept: it is deliberately a little above or below the planet's plane.

Only when the game has no warp-in point for a body (no radius, a radius under
90 km, an asteroid belt, a wreck) does the mod fall back to a plain placement:
`planetRadius + beyondSurface` from the centre, horizontally on the star-facing
side, where `beyondSurface` is the larger of `standoffMeters` (5,000,000 m = 5,000 km
by default) and `planetRadius * orbitMargin` (one planet radius by default). Both
keys exist for that fallback only, and the offset does not apply there.

A Skyhook produces on its own; a system's sovereignty hub is where its power and
workforce are totalled, not a requirement for producing them. Nothing here needs a
hub, a claim or a hub id - the mod never looks for one.

`/ash remove <skyhookID>` (or `/ash remove "RYQC-I III"`) destroys one Skyhook and
`/ash unanchor here` sweeps a whole system. Both run the vendor's destruction
sequence per Skyhook and name every one they processed by the planet it orbits, plus
anything they could not handle - a structure-shaped Skyhook is reported and
deliberately left alone, and a Skyhook that is already a tombstone is kept as it is
and counted in one line instead of being listed one by one (`destroyed markers left
alone: N`): a destroyed marker is a "do not re-create this" decision, not a
failure. The planet is deployable again straight afterwards. Both also re-sync the
game's item-id counter when it is behind the highest id in use, and say so in one line:
that clause and the id an operator types are the only ids left in a reply.

Installed with the third-party **EveJS Launcher**? See [LAUNCHER.md](LAUNCHER.md) for
`Mods > Add ZIP`, the Configure panel and the update channel - and for the honest note
that this path was written from a working third-party package, because no launcher is
available here to test it against.

The full command reference, with an example of every reply, is in
[MANUAL.md](MANUAL.md). The implementation is described in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Why a distant Skyhook shows `Location <itemID>` in the scanner

This is expected behaviour and **nothing needs fixing**.

The client resolves an object's name through the scene, and the server
deliberately gives an object that is off-grid or out of range a numeric
placeholder (`Location <itemID>`) instead of its name. A Skyhook you conjured
somewhere else, or one that is simply too far away to be resolved, therefore
shows the placeholder. Fly to it - warping to 0 m is enough to enter interaction
range - and the real name, **Skyhook**, appears, and the structure works
normally. The id in the placeholder is the Skyhook's own item id, the same id
`/ash status` prints.

## Installing

From a checkout, the mod folder must be named `mods\autoSkyHookDeploy` inside the
EveJS installation. The bundled installer copies the payload there and registers
the preload:

```bat
installer\install.bat --server "C:\path\to\EveJS"
```

| Script | Use it to |
|---|---|
| `installer\install.bat` | install, or re-register the preload |
| `installer\update.bat` | replace an older copy of the mod (it reports the version it moved from and to) |
| `installer\uninstall.bat` | remove the preload and the mod folder (Skyhooks already in the game are left alone) |
| `installer\status.bat` | show what is registered, without writing anything |

`--server` may be omitted when the installer can find the installation by itself.
`installer\README.md` documents every argument, the backups it writes
(`<EveJS root>\_autoskyhookdeploy-backup\`), and the configuration it seeds.

After installing:

| Deployment | Next step |
|---|---|
| Docker | `docker compose build` then `docker compose up -d --no-deps server` - `mods/` is inside the image, so a rebuild is required |
| Windows native | restart the server with `StartServer.bat` |

Confirm the boot line:

```
[autoSkyHookDeploy] v1.0.0 loader ready — /ash anchor|align|remove|unanchor|stop|offset|status|help and !ash work for every character
```

Then, in the game: `/ash help`, or `!ash help` from ordinary chat.

## Configuration

Priority: **process environment** > **`<mod root>\settings.json`** (written by the
EveJS Launcher's Configure panel) > **`<EveJS root>\config\autoSkyHookDeploy.json`**
> **`mods\autoSkyHookDeploy\.env`** > **built-in defaults**.

The JSON file is created for you by the installer and is never overwritten
afterwards; `config/` is bind-mounted, so changing it needs a container restart
and never an image rebuild. Keys may be written either the short way (as in
`config.example.json`) or the long way (the environment variable name).

`settings.json` is the launcher's file, and `config\autoSkyHookDeploy.json` is the
installer's. **`/ash offset` rewrites whichever of the two is in force** - the
launcher's file when it exists, the config JSON otherwise - so a value set in game is
never shadowed by the other one, needs no restart and survives one. The file is
re-read on every command, so a hand edit is picked up too. A file that cannot be
parsed is reported in text and left exactly as it is: the mod never rewrites
configuration it could not read, and the last good value stays in force.

| Key | Environment variable | Default | Meaning |
|---|---|---|---|
| `enabled` | `EVEJS_AUTO_SKYHOOK_DEPLOY` | `true` | Master switch. `false` leaves the server exactly as vanilla. |
| `verbose` | `..._VERBOSE` | `false` | Log the loader's detail for every step. |
| `allowDeploy` | `..._ALLOW_DEPLOY` | `true` | Allow `/ash anchor` and `!ash anchor`. |
| `allowRemove` | `..._ALLOW_REMOVE` | `true` | Allow `/ash remove` and `!ash remove`. |
| `maxPlanetsPerCommand` | `..._MAX_PLANETS_PER_COMMAND` | `64` | Hard safety cap on one command (range 1..4096). A system with more planets than this is refused outright; the same cap bounds one sweep and truncates one status listing. |
| `regionCountdownSeconds` | `..._REGION_COUNTDOWN_SECONDS` | `15` | Seconds a region run announces before its first system (range 0..120; `0` starts at once). `/ash stop` cancels during the countdown with nothing done. |
| `regionStepDelayMs` | `..._REGION_STEP_DELAY_MS` | `2000` | Milliseconds between the systems of a region run, after each one has been verified and reported (range 0..60000; `0` means no delay). |
| `offsetMeters` | `..._OFFSET_METERS` | `25000` | How far **past the planet's landing point** the Skyhook goes, in metres (25,000 m = 25 km), so a ship warping in arrives clear of the Skyhook's model - at 5 km a warp to the planet still landed against it. Range 0..100000 (0..100 km); `0` puts it exactly on the landing point. Adjustable in game with `/ash offset`, which writes it into whichever configuration file is in force (see above) and needs no restart. |
| `standoffMeters` | `..._STANDOFF_METERS` | `5000000` | **Fallback placement only.** The floor of the fallback distance, in **metres**: 5,000,000 m is 5,000 km, which is where manual deployments from a ship land. Range 100,000..100,000,000 (100 km..100,000 km). A Skyhook goes on the planet's warp-in point whenever the game has one, and this key is never consulted then. |
| `orbitMargin` | `..._ORBIT_MARGIN` | `1.0` | **Fallback placement only.** How many planet radii above the surface the fallback puts the Skyhook; the larger of this and `standoffMeters` wins there. A float, range 0..10; `0` leaves only the `standoffMeters` floor. Ignored whenever the game has a warp-in point for the body. |
| `ownerMode` | `..._OWNER_MODE` | `"corporation"` | Who owns a conjured Skyhook: `corporation` (the caller's corporation) or `character` (the caller). |
| `requireClaimedSystemOwnership` | `..._REQUIRE_CLAIMED_SYSTEM_OWNERSHIP` | `false` | When `true`, only deploy into an already claimed system whose sovereignty owner corporation or alliance is the caller's. |
| `includeDestroyedInStatus` | `..._INCLUDE_DESTROYED_IN_STATUS` | `true` | When `false`, `/ash status` still counts the planets whose only record is a destroyed Skyhook (they are deployable either way) but drops the "a new one may be placed here" annotation from the listing. |

A value with the wrong type, or out of range, is a **configuration error**: the
loader logs every offending key, installs **no hooks at all**, and the server
behaves exactly like vanilla EveJS. That is deliberate - a configuration mistake
should not half-install a mod.

`.env.example` documents every key with its accepted spellings and the effect of
each value.

## Tests

```bat
node test\run.js
```

or `RunTests.bat`. The suite needs no server, no game data and no scene: the
vendor services are replaced by fixtures, and the two chat seams are driven
directly. It ends with `N/N passed` and exits 0.

## Requirements

- EveJS 0.12.9.
- Node.js 18 or newer for the installer and the test suite.
- Nothing else: no client change, no item, no module, no skill.

## License

AGPL-3.0. See [LICENSE](LICENSE).
