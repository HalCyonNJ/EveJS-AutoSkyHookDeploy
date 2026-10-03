# Auto Skyhook Deploy - command reference

Every command below works in two spellings:

| Spelling | Where it is typed | Who can use it |
|---|---|---|
| `/ash ...` | the chat box, like any slash command | everybody (it is a Game Master spelling only in the sense that it looks like one; no staff rights are needed) |
| `!ash ...` | ordinary chat | everybody, including characters without staff rights |

A reply always goes to the caller alone. A `!ash` line is never broadcast to the
channel it was typed in.

Aliases: `a` = `anchor`, `al` = `align`, `r` = `remove`, `s` = `status`, `h` = `help`.

---

## `/ash help`, `/ash h`

Without an argument, `/ash` prints the same list.

```
autoSkyHookDeploy - /ash
  /ash anchor here|system <systemID>|region <regionID>
  /ash align [here|system <systemID>|region <regionID>]
  /ash remove <skyhookID>|"<planet name>"
  /ash unanchor here|system <systemID>|region <regionID>
  /ash stop
  /ash offset [<value>]
  /ash status [here|<systemID>]
  /ash help
  /ash a  = /ash anchor
  /ash al = /ash align
  /ash r  = /ash remove
  /ash ua = /ash unanchor
  /ash st = /ash stop
  /ash of = /ash offset
  /ash s  = /ash status
  /ash h  = /ash help
  align moves the Skyhooks already deployed onto the configured offset, paced like a region
  a region is worked one system at a time, after a countdown: NPC/faction space is skipped
  and named, each system is verified and reported, and /ash stop cancels
  offset takes kilometres (5 or 5km) or metres (5000m) and is saved for the next restart.
Every subcommand also works in ordinary chat as !ash (for example !ash status here).
```

An unknown word is answered with the list rather than silence:

```
/ash frobnicate here
autoSkyHookDeploy: unknown subcommand "frobnicate" (anchor, align, remove, unanchor, offset, status or help).
autoSkyHookDeploy - /ash
  /ash anchor here|<systemID>
  ...
```

The command that moves already-deployed Skyhooks was called `reanchor` (short form
`ra`) before 1.0.0. Neither spelling is accepted any more - they are not aliases - but
they are answered with a pointer instead of the generic refusal above:

```
/ash reanchor
autoSkyHookDeploy: unknown command "reanchor" - it is now /ash align (or /ash al).
autoSkyHookDeploy - /ash
  /ash anchor here|<systemID>
  ...
```

---

## `/ash anchor here|<systemID>`, `/ash a`

Deploys one Orbital Skyhook (typeid 81080) next to every planet in the system
that does not already have one. `here` is the caller's current solar system; a
number is any solar system id. The caller does not have to be in the target
system, in a ship, or anywhere in particular.

Nothing is consumed and nothing has to be carried. The planet id is passed to
the vendor explicitly, so a skyhook never lands on the wrong planet. Each one is
placed **just past the planet's warp-in point** - the single spot a warp to that
planet always lands on - offset 25,000 m (25 km) further out by default so a ship
warping in does not materialise inside it (`/ash offset` changes that). Only a body
the game has no warp-in point for (a body under 90 km radius, an asteroid belt) gets
a plain fallback placement instead.

**A system with three free planets**

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 3, skipped 0 already present, 0 over a destroyed skyhook
  deployed: orbital skyhook at Planet I; orbital skyhook at Planet II; orbital skyhook at Planet III
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
```

**A partly populated system - the normal case**

```
/ash anchor 30000142
autoSkyHookDeploy v1.0.0: Jita: deployed 1, skipped 2 already present, 0 over a destroyed skyhook
  deployed: orbital skyhook at Planet III
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
  already present: orbital skyhook at Planet I (live skyhook); orbital skyhook at Planet II (sovereignty ledger row (deployed))
```

**A system where everything is taken**

Nothing is created and the reply says so rather than reporting a silent success:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: nothing to deploy: Jita: all 3 planets already have a skyhook (3 present); nothing to deploy
```

**A planet whose skyhook was destroyed**

A destroyed skyhook leaves an orbital tombstone behind, and that tombstone does
**not** prevent a new one: the planet is deployed on like any other free planet.
The old record is kept exactly as it is as history, the replacement gets its own
item id beside it, and the reply counts the deployment in its own column:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 3, skipped 0 already present, 1 over a destroyed skyhook
  deployed: orbital skyhook at Planet I; orbital skyhook at Planet II; orbital skyhook at Planet III
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
  over a destroyed skyhook: orbital skyhook at Planet III (old orbital tombstone - kept as history)
```

A system where **every** planet carries a destroyed tombstone is therefore
deployed on in full, not refused:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 3, skipped 0 already present, 3 over a destroyed skyhook
  ...
  over a destroyed skyhook: orbital skyhook at Planet I (old orbital tombstone - kept as history); orbital skyhook at Planet II (old orbital tombstone - kept as history); orbital skyhook at Planet III (old orbital tombstone - kept as history)
```

**A claimed system, with free game-created slots**

The game mints a free slot for every planet of a claimed system that has nothing
built on it. A slot is not occupancy - it is the room a Skyhook is meant to go
in, and it is why `/ash anchor` is useful in the systems that matter. All five
planets are filled:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 5, skipped 0 already present, 0 over a destroyed skyhook
  deployed: orbital skyhook at Planet 1; orbital skyhook at Planet 2; orbital skyhook at Planet 3; orbital skyhook at Planet 4; orbital skyhook at Planet 5
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
```

**A planet already occupied by something that is not a free slot**

A structure-shaped skyhook (the vendor's second, competing route for typeid
81080) and a ledger row for a real deployment are occupancy. The reply names which
one was found:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 1, skipped 2 already present, 0 over a destroyed skyhook
  deployed: orbital skyhook at Planet III
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
  already present: orbital skyhook at Planet I (sovereignty ledger row (deployed)); orbital skyhook at Planet II (structure-shaped skyhook)
```

A planet whose slot was destroyed is deployed on as well - the destroyed slot is
history, not a refusal - so all five planets in that system are filled:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 5, skipped 0 already present, 1 over a destroyed skyhook
  deployed: orbital skyhook at Planet 1; orbital skyhook at Planet 2; orbital skyhook at Planet 3; orbital skyhook at Planet 4; orbital skyhook at Planet 5
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
  over a destroyed skyhook: orbital skyhook at Planet 3 (old slot tombstone - kept as history)
```

A structure-shaped skyhook that is not tied to any planet blocks the whole
system, because nothing may be built where an unattributable one might be:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: nothing to deploy: Jita already holds a structure-shaped skyhook (1100000000999) that is not tied to a planet; refusing to build anywhere in that system
```

**A system with no sovereignty infrastructure**

Nothing special happens: the Skyhooks are built and they produce on their own. A
system's hub is where a Skyhook's power and workforce are totalled, not a
requirement for producing them, and the mod never looks for one.

**Where each Skyhook is placed**

On the planet's **warp-in point**: a warp to a planet in this game always lands on
one deterministic spot, and that is where the Skyhook goes, so it is beside the ship
the moment you arrive. The point carries a small vertical component of its own, and
the mod keeps it rather than flattening it.

If the game has no warp-in point for a body, the fallback is a horizontal placement
on the side of the planet that faces the **system's star**, at the larger of
`standoffMeters` beyond the surface (default 5,000,000 m = 5,000 km) and
`planetradius * orbitMargin` (default one planet radius). Those two keys are the
fallback's inputs and are not consulted otherwise.

**A failure in one of the vendor stores**

The orbital record and the item row are written first, the scene last. A create
or attach that fails is reported per planet and the rest of the system still
runs:

```
/ash anchor here
autoSkyHookDeploy v1.0.0: Jita: deployed 2, skipped 0 already present, 0 over a destroyed skyhook
  deployed: orbital skyhook at Planet I; orbital skyhook at Planet II
  each one starts ONLINING with the vendor's own 60 s activation timer and settles to IDLE by itself
  FAILED orbital skyhook at Planet III: INVENTORY_FULL
```

A scene failure is not a failure of the command: the skyhook and its orbital
record are already durable, so the spawn is logged for the server operator and
the reply stays clean.

**Refusals**

```
/ash anchor
autoSkyHookDeploy: /ash anchor needs here or a system id.
autoSkyHookDeploy - /ash
  ...

/ash anchor mars
autoSkyHookDeploy: "mars" is not a solar system id (use here or a number).

/ash anchor 0
autoSkyHookDeploy: a solar system id must be a positive number.

/ash anchor here          (not in space, no current system)
autoSkyHookDeploy: no current solar system on this session; name a system id instead

/ash anchor here          (allowDeploy = 0 on this server)
autoSkyHookDeploy: deploy is switched off on this server (EVEJS_AUTO_SKYHOOK_DEPLOY_ALLOW_DEPLOY=0).

/ash anchor here          (requireClaimedSystemOwnership = 1, system held by somebody else)
autoSkyHookDeploy v1.0.0: nothing to deploy: that system belongs to another corporation or alliance, and this server only deploys into a system its owner already holds

/ash anchor here          (more planets than maxPlanetsPerCommand)
autoSkyHookDeploy v1.0.0: Jita has 65 planets, above the configured maxPlanetsPerCommand (64); raise the cap to work on this system
```

---

## `/ash remove <skyhookID>|<planet name>`, `/ash r`

Destroys **one** Skyhook. It is named either by the id the scanner shows and
`/ash status` uses, or by the name of the planet it orbits, typed in quotes because
a name contains spaces:

```
/ash remove 1000000000002
/ash remove "RYQC-I III"
```

A planet name is resolved **inside the caller's own solar system**, and only against
the Skyhooks actually deployed there: it can never name a Skyhook somewhere else.
The public name is the same one `/ash status` prints, so the two spellings are
interchangeable once a name resolves to exactly one Skyhook. Per skyhook the
vendor's destruction sequence runs in this order:

1. the orbital record becomes a tombstone (kept, never deleted);
2. the scene entity is destroyed, which also removes the `items` row - and
   `DYNAMIC_ENTITY_NOT_FOUND` counts as success, so a retry is safe;
3. the sovereignty ledger gets its tombstone immediately instead of waiting for
   the next bootstrap.

```
/ash remove 1000000000002
autoSkyHookDeploy v1.0.0: Jita: destroyed 1, already destroyed 0, left alone 0 structure-shaped
  destroyed orbital skyhook at Planet II, ledger tombstoned
  item id counter: 9988400003304 (already ahead of the highest id)
```

A skyhook whose orbital record already carries a tombstone is left exactly as it
is. Clearing a tombstone is how a destroyed skyhook gets silently resurrected, so
this command never does it - and the marker is not a failure, so it is not counted
as one. The reply is one line with the count; it does not list the markers one by
one. Asking twice is therefore safe, and answered gracefully:

```
/ash remove 1000000000002
autoSkyHookDeploy v1.0.0: Jita: destroyed 0, already destroyed 1, left alone 0 structure-shaped
  destroyed markers left alone: 1 (a destroyed skyhook stays destroyed until something is deployed on that planet again) - the skyhook is already gone, and the planet can be deployed on again
  item id counter: 9988400003304 (already ahead of the highest id)
```

Every refusal is text, and it names the right command where that is the mistake. A
planet name resolves only in the system the caller is in; an id is accepted from
anywhere:

```
/ash remove here
autoSkyHookDeploy: /ash remove takes one Skyhook, not a system. To clear every Skyhook in this system use /ash unanchor here.

/ash remove 30000142
autoSkyHookDeploy: 30000142 is a solar system, not a Skyhook id; to clear a whole system use /ash unanchor 30000142

/ash remove abc
autoSkyHookDeploy: no planet named "abc" is in Jita; check the spelling, or name the Skyhook by id

/ash remove "RYQC-I III"          (that planet has no Skyhook, or you are not in its system)
autoSkyHookDeploy: orbital skyhook at RYQC-I III is not deployed in RYQC-I (nothing there to remove)

/ash remove 9998400003181
autoSkyHookDeploy: no Skyhook with id 9998400003181 is known to this server

/ash remove 0
autoSkyHookDeploy: a Skyhook id or the name of the planet it orbits is needed (for example /ash remove 9988400003181 or /ash remove "RYQC-I III")
autoSkyHookDeploy - /ash
  ...
```

A **structure-shaped** Skyhook (typeid 81080 registered as a sovereignty structure
instead of an orbital record) is recognised by id and reported, never touched - it
is a structure, not an orbital, and this mod does not own that route:

```
/ash remove 1100000000123
autoSkyHookDeploy: that id is a structure-shaped Skyhook in Jita; this command never destroys those
```

After a successful removal the game's own **item-id counter** is calibrated once,
so an id freed by the deletion can never be handed out again. It is only moved when
it is actually behind the highest id any table still references - the reply says so
either way:

```
  item id counter: raised to 9988400003305 (was 9988400003300, highest id 9988400003304)
```

---

## `/ash unanchor here|<systemID>`, `/ash ua`

The system-wide sweep: destroys **every** skyhook in the system, whoever deployed
it, with the same per-id sequence and the same calibration of the item-id counter
(once, not once per id).

```
/ash unanchor here
autoSkyHookDeploy v1.0.0: Jita: destroyed 3, already destroyed 1, left alone 1 structure-shaped
  destroyed orbital skyhook at Planet I, ledger tombstoned
  destroyed orbital skyhook at Planet II, ledger tombstoned
  destroyed orbital skyhook at Planet III, ledger tombstoned
  destroyed markers left alone: 1 (a destroyed skyhook stays destroyed until something is deployed on that planet again) - the skyhook is already gone, and the planet can be deployed on again
  not touched (structure-shaped, this command never destroys those): structureID 1100000000123
  item id counter: 9988400003304 (already ahead of the highest id)
```

A scene entity that could not be cleared is reported while the two tombstones -
which are the durable part - still land:

```
/ash unanchor 30000142
autoSkyHookDeploy v1.0.0: Jita: destroyed 1, already destroyed 0, left alone 0 structure-shaped
  destroyed orbital skyhook at Planet I, ledger tombstoned, scene entity: SCENE_NOT_FOUND
  FAILED orbital skyhook at Planet I: scene entity: SCENE_NOT_FOUND
```

Refusals are the same shape as for `anchor`: a missing token, a bad token, a
trailing word that is not part of a system, no current system, `allowRemove = 0`,
or more entries than `maxPlanetsPerCommand`.

---

## `/ash offset [<value>]`, `/ash of`

Reads or sets how far **past the planet's landing point** a Skyhook is placed. The
reason for it: a warp to a planet always lands on one point, so a Skyhook sitting
exactly there is a model in the ship's face. The default 25,000 m (25 km) puts it
just beside that spot.

```
/ash offset
autoSkyHookDeploy offset: 25 km (25000 m) - a Skyhook sits this far past the planet's landing point so a ship warping in does not materialise inside it
```

A bare number is **kilometres** (the way it was asked for), and either unit can be
spelled out. Every accepted form echoes both units, so an ambiguous entry is
visible before it matters:

```
/ash offset 5
autoSkyHookDeploy: offset set to 25 km (25000 m) - saved, and in effect from the next Skyhook onwards

/ash offset 25km      -> 25 km (25000 m)
/ash offset 25000m    -> 25 km (25000 m)
/ash of 2.5km         -> 2.5 km (2500 m)
/ash offset 0         -> 0 km (0 m)     (exactly on the landing point)
/ash offset 100km     -> 100 km (100000 m)
```

Bad input is refused with text, and the value does not change:

```
/ash offset 200km
autoSkyHookDeploy: offset must be between 0 km and 100 km (0..100000 m), so "200km" is out of range. offset: 25 km (25000 m) - ...
/ash offset abc
autoSkyHookDeploy: "abc" is not an offset; give kilometres (5 or 5km) or metres (5000m). offset: 25 km (25000 m) - ...
/ash offset 5 miles
autoSkyHookDeploy: "5 miles" is not an offset; give kilometres (5 or 5km) or metres (5000m). offset: 25 km (25000 m) - ...
```

The value is written into **whichever configuration file is in force**: the launcher's
`settings.json` when there is one (it outranks everything but the process
environment), the installer's `config\autoSkyHookDeploy.json` otherwise. It takes
effect on the very next Skyhook with no restart, and it survives one. The file is
re-read on every command, so a hand edit is picked up too; a file that cannot be
parsed is reported in text and left exactly as it is - the mod never rewrites
configuration it could not read - and the last good value stays in force.

---

## `/ash stop`, `/ash st`

Cancels the region run that is in progress:

* during the **countdown** nothing has been touched yet, so the run is cancelled
  outright: `cancelled during the countdown - nothing was deployed and no system was
  touched`;
* during the **loop** the system being worked is finished and verified first, and the
  rest are left alone: `stopping after the system being worked (it is completed and
  verified first)`, followed by a summary of what was done and how many systems remain.

With no run in progress it answers `nothing to stop`. One region run exists per server,
so a second `anchor region` or `unanchor region` while one is running is refused with a
pointer at this command.

---

## Region runs are paced

`anchor region` and `unanchor region` deliberately do **not** work a whole region in one
burst - mass-creating structures can stall the game - so they run as a job:

1. the plan is built, NPC/faction space is filtered out, and the reply is that summary
   with the countdown:

   ```
   /ash anchor region 10000060
   autoSkyHookDeploy v1.0.0: Delve: 85 systems to work, 12 NPC/faction space skipped - starting in 15 s, type /ash stop to cancel
     skipped NPC/faction space: Jita, Perimeter
   please stay in game and avoid jumping or logging off until the run finishes; type /ash stop to cancel
     estimated 3 m 51 s: 85 systems, 640 planets, 84 x 2000 ms step delay, 15 s countdown (first run, so this uses the default 48 ms per planet)
   ```

   Nothing is touched during the countdown. It ticks at 10 s and 5 s, then says
   `starting now`; `/ash stop` in that window cancels everything. The reminder line is
   there because a run should not be interrupted by jumping around or logging off, and
   the estimate line is measured cost (per planet, self-correcting run by run) plus the
   step delays and the countdown - the delays dominate in a big region.
2. **one system at a time**, through exactly the same single-system path a targeted
   command uses;
3. that system is then **verified against what was written** - the item row exists, its
   position is the landing point plus the configured offset, and the orbital record is
   live and attached to the right planet - and the result is reported:

   ```
   autoSkyHookDeploy v1.0.0: Delve: 9 deployed, verified 9 at the landing point + 25000 m, 0 anomalies  [10/40 systems done, 30 systems left, about 1 m 40 s remaining]
   ```

   An anomaly is named rather than hidden (`ANOMALY orbital skyhook at RYQC-I I sits
   10,506 m from the landing point + 25000 m`), and a system that fails is reported while the run
   continues.
4. **2 s** (configurable) after that report, the next system starts.

The run ends with a summary:

```
autoSkyHookDeploy v1.0.0: Delve: finished - 85 of 85 systems done, 0 left, in 3 m 11 s (including the countdown; estimated 3 m 04 s; 49 ms per planet measured)
  deployed 640, skipped 12 already present, 3 over a destroyed skyhook
  0 anomalies, 0 failed system(s)
  every system was verified as it finished; the run is over, and a restart would simply end it - nothing resumes by itself
```

A run that `/ash stop` ended says `stopped` instead of `finished`, reports the systems
it did work and how many remain, and prints the same actual-versus-estimated line.

### Progress and time left

Every per-system line, and the closing line, carries how far the run has come and how
long the rest is expected to take, in the same bracket:

```
autoSkyHookDeploy v1.0.0: RYQC-I: 9 orbital skyhooks moved, verified 9 at the landing point + 25000 m, 0 anomalies  [10/40 systems done, 30 systems left, about 1 m 40 s remaining]
```

`X/N systems done` is the system count for every kind of run. `left` counts what the
run itself moves: systems for a deploy or a sweep, and **Skyhooks** for an align run
(`[10/40 systems done, 41 skyhooks left, about 1 m 40 s remaining]`). The remaining
figure is the same measured estimate the countdown reply carries, recomputed over what
is still outstanding - the systems not started, the planets (or Skyhooks) they hold and
the step delays between them - so it shrinks as the run goes and needs no separate
maths. `/ash status` while a run is active prints the same bracket.

`regionCountdownSeconds` (default 15) and `regionStepDelayMs` (default 2000) set the
pacing; `0` means no countdown and no delay. A region is never refused for its size: the pacing
and `/ash stop` are what bound a run. A server restart
ends a run - nothing resumes by itself - and that is safe, because each system is
committed and verified as a whole.

---

## NPC space

A system is workable exactly when the game's own `isSovereigntyClaimableSolarSystem`
says it is sovereignty-claimable, which excludes high-sec and low-sec as well as
faction space. The mod never reimplements that rule.

```
/ash anchor system 30000142
autoSkyHookDeploy: Jita is NPC/faction space (not sovereignty-claimable) (security 0.9): nothing was touched
```

`here` is checked the same way. Inside a region, those systems are skipped and named,
and a region where **every** system is NPC space is refused:

```
autoSkyHookDeploy: region 10000043 is NPC/faction space (none of its 2 systems is sovereignty-claimable): nothing was touched
```

If the game's rule cannot be loaded at all, the command refuses rather than building
Skyhooks in space that is not ours.


---

## `/ash align [here|system <systemID>|region <regionID>]`, `/ash al`

Changing `offsetMeters` only affects **new** deploys, so this command takes the Skyhooks
already in the world and moves each one onto `landingPoint + offsetMeters` - exactly what a
fresh deploy would produce. With no argument it covers **every system that holds a
Skyhook**, including ones a player deployed by hand; `here`, `system <id>` and
`region <regionID>` narrow it down the same way they do for `anchor`.

The reply says what is about to happen, warns you, and estimates the time:

```
/ash align
autoSkyHookDeploy v1.0.0: all systems with a Skyhook: 6 system(s) to work, 41 Skyhook(s) to move, starting in 15 s, type /ash stop to cancel
please stay in game and avoid jumping or logging off until the run finishes; type /ash stop to cancel
  estimated 28 s: 6 systems, 41 planets, 5 x 2000 ms step delay, 15 s countdown (measured 48 ms per planet so far)
```

It is paced exactly like a region run - a countdown, one system per step, every move
verified against what was written, a 2 s gap - and `/ash stop` cancels it the same way:

```
autoSkyHookDeploy v1.0.0: RYQC-I: 9 orbital skyhooks moved (of 9 attempted), 9 verified at the landing point + 25000 m, 0 skipped, 0 destroyed markers, 0 anomalies  [10/40 systems done, 41 skyhooks left, about 1 m 40 s remaining]
```

A Skyhook that cannot be moved is reported rather than failing: one whose planet has no
usable landing point, one with no item row, and one the loaded scene would not accept
each get a `skipped: ...` line with the reason. Nothing is created or removed, so the
item-id counter is not touched.

**A destroyed marker is not a skip.** A Skyhook the operator removed earlier stays in
the world as a `destroyed` record - the marker that stops the vendor's bootstrap from
re-creating it - so a run that meets one has nothing to move and nothing to report as
failed. Markers are counted, never listed: the system line carries the count and one
line explains it, and no marker is ever named one by one.

```
autoSkyHookDeploy v1.0.0: LWX-93: 9 orbital skyhooks moved (of 9 attempted), 9 verified at the landing point + 25000 m, 0 skipped, 9 destroyed markers, 0 anomalies  [2/42 systems done, 333 skyhooks left, about 1 m 38 s remaining]
    destroyed markers left alone: 9 (a destroyed skyhook stays destroyed until something is deployed on that planet again)
```

The counts are what the verification confirms, not what was attempted: `9 orbital skyhooks
moved (of 9 attempted), 9 verified` means nine were tried, nine writes landed, and nine were
read back at the target - a run can never report `moved 10, verified 0`. The first number is
always reported against the attempt count, so a skip is never mistaken for work that was
never there. A system whose move cannot stick is named with the reason, and a refusal on the
part of a scene that was **already loaded** says exactly that - it never claims somebody is
in the system:

```
autoSkyHookDeploy v1.0.0: RYQC-I: 0 orbital skyhooks moved (of 10 attempted), 0 verified at the landing point + 25000 m, 10 skipped, 0 destroyed markers, 0 anomalies  [10/40 systems done, 31 skyhooks left, about 1 m 22 s remaining]
  solar system RYQC-I: its scene is loaded and would not accept the move; the vendor unloads an empty scene on its own, so try again later
  skipped: orbital skyhook at RYQC-I I: the loaded scene of its solar system kept its own position
```

A system that holds both a genuine skip and destroyed markers reports the two apart, each
with its own evidence:

```
autoSkyHookDeploy v1.0.0: LWX-93: 0 orbital skyhooks moved (of 1 attempted), 0 verified at the landing point + 25000 m, 1 skipped, 2 destroyed markers, 0 anomalies  [2/42 systems done, 12 skyhooks left, about 6 s remaining]
    destroyed markers left alone: 2 (a destroyed skyhook stays destroyed until something is deployed on that planet again)
    skipped: orbital skyhook at LWX-93 II has no usable landing point
```

A finished align run closes with the same split, so `moved`, `destroyed markers left alone`
and `skipped` stay separate numbers:

```
  moved 345 Skyhook(s) onto the landing point + 25000 m, 11 destroyed markers left alone, 0 skipped
```

A scene that is **already loaded** is authoritative for the items realised in it, which is why
those moves go through the position authority the scene owns -
`scene.setEntityPosition(itemID, position, { reason, velocity: 0 })`, the same method the
vendor's own clock exposes on the scene. A system whose scene is **not** loaded is moved through
the item store alone; that is the path twelve systems proved correct in the live test. The
command never loads a scene just to find out: it asks the server whether the scene is already
there, so a run over a region cannot make every system it touches look occupied.

---

## `/ash status [here|<systemID>]`, `/ash s`

Read-only. Without an argument it reads the caller's own system. Per planet:
a live skyhook, free, or free over a destroyed tombstone (which is deployable).
Destroyed tombstones are also counted in one line of their own - a destroyed
marker is a "do not re-create this" decision, not a failure, so it is never
listed one by one:

```
/ash status here
autoSkyHookDeploy v1.0.0: Jita
  Planet I: orbital skyhook present (live skyhook)
  Planet II: free (game-created slot, nothing built on it yet)
  Planet III: free (destroyed skyhook tombstone - a new one may be placed here)
  Planet IV: orbital skyhook present (structure-shaped skyhook)
  Planet V: free
  destroyed markers left alone: 1 (a destroyed skyhook stays destroyed until something is deployed on that planet again)
  5 planet(s): 2 with a skyhook, 1 free over a destroyed skyhook (deployable), 2 free
  sovereignty ledger: claimed (corporation 98000001, alliance 99000001)
```

A planet whose ledger row is a real deployment - a record under its own item id,
or one carrying `deployeditem` - reads as a built skyhook rather than as a free
slot:

```
  Planet II: orbital skyhook present (sovereignty ledger row (deployed))
```

With `includeDestroyedInStatus = 0` the planets whose only record is a destroyed
Skyhook are still counted - they are deployable either way - but the annotation is
dropped from the listing:

```
/ash status here
autoSkyHookDeploy v1.0.0: Jita
  Planet I: orbital skyhook present (live skyhook)
  Planet V: free
  destroyed markers left alone: 1 (a destroyed skyhook stays destroyed until something is deployed on that planet again)
  5 planet(s): 2 with a skyhook, 1 free over a destroyed skyhook (history not shown), 2 free
  sovereignty ledger: claimed (corporation 98000001, alliance 99000001)
```

An unclaimed system has no ledger row, and the status says so:

```
  sovereignty ledger: no row for this system (unclaimed)
```

A system with more planets than `maxPlanetsPerCommand` is listed up to the cap
and says how many were left out; the counts still cover the whole system:

```
/ash status here
autoSkyHookDeploy v1.0.0: Jita
  Planet I: free
  Planet II: free
  4 planet(s): 0 with a skyhook, 0 free over a destroyed skyhook (deployable), 4 free
  (listing stops at maxPlanetsPerCommand=2; 2 more planet(s) not shown)
  sovereignty ledger: no row for this system (unclaimed)
```

A planet id that is not a system, or a system the server has no planets for:

```
/ash status 999999999
autoSkyHookDeploy v1.0.0: solar system 999999999 has no planets (is that a system id?)
```

While a region or align run is in progress the same reply ends with the run's own
state, so progress is readable even when the channel carrying its follow-ups is not:

```
  run in progress: deploy on Domain, countdown, [0/1 systems done, 1 system left, about 18 s remaining]
```

---

## Notes for the server operator

- `/ash status` and `/ash offset` (without a value) never write anything. `anchor`,
  `remove`, `unanchor`, `stop` and `offset <value>` write only through the vendor
  services named in `HOW-IT-WORKS.md`, plus the one configuration file `/ash offset`
  writes.
- Conjured skyhooks belong to the caller's corporation by default, or to the
  caller when `ownerMode = character`.
- The sovereignty ledger is derived from the orbital records on every read. This
  mod never writes it by hand; it only asks the vendor to read it, which is what
  makes a row appear immediately instead of at the next bootstrap.
- A claimed system gives every empty planet a free ledger *slot*
  (`1000000000000 + planetID`). A slot is not a skyhook: `/ash anchor` counts it
  as free and fills it, and `/ash status` prints it as
  `free (game-created slot, nothing built on it yet)`. Only a real deployment
  record - a row under another key, or one with `deployeditem` - counts as
  occupied.
- A destroyed skyhook's orbital tombstone, and a destroyed planet slot, are
  **history, not a refusal**: `/ash anchor` deploys on that planet like any other
  free one, and `/ash status` prints it as
  `free (destroyed skyhook tombstone - a new one may be placed here)`. The old
  record is never deleted and `destroyedAtMs` is never cleared - the replacement
  simply gets its own item id beside it, which is why the deploy reply counts it
  as "N over a destroyed skyhook".
- **A destroyed marker is not a failure.** Because the marker is what stops the
  vendor's bootstrap from re-creating a claimed planet's default Skyhook, every
  report counts the markers it left alone instead of listing them: one
  `destroyed markers left alone: N` line in `/ash status` and under an align or
  removal report, a `destroyed markers` count on an align system line, and
  `N destroyed markers left alone` in the closing align summary. A marker never
  lands in `skipped`, never reaches an `ANOMALY` line, and is never named one by one.
  Deploying on a planet that carries one does not clear it - the marker stays
  beside the new Skyhook.
- `/ash anchor` puts each Skyhook on the planet's **warp-in point** - the one spot
  a warp to that planet always lands on - **25,000 m further out** by default so a ship
  warping in does not materialise inside its model. That is the operator's in-game
  finding, and it supersedes the earlier distance experiments (the `standoffMeters` /
  `orbitMargin` scaling and the 12,500 km visibility theory, which turned out to be a
  red herring: the useful question was where the ship arrives, not how far out the
  object sits). Those two keys now only drive the fallback used when the game has no
  warp-in point for a body; the fallback is horizontal and star-facing, does not take
  the offset, and if the system's star cannot be read its direction is `+X`. The
  game's own static orbitals sit at 100,000 m (100 km) and are placed by a
  planet-id-derived vector that is vertical by up to 88%, which is why they are hard
  to find.
- The offset is the one setting that is meant to be changed from in game: `/ash offset`
  writes the configuration file that is actually in force - the launcher's
  `settings.json` when present, the installer's `config\autoSkyHookDeploy.json`
  otherwise - and that value is re-read on every command, so it needs no restart. A
  file that cannot be parsed is reported in text and **not** rewritten, and the last
  good value stays in force. Precedence for every key, highest first: process
  environment > `settings.json` > config JSON > `.env` > built-in default.
- A region command is a paced job, never a burst: one system per timer step, verified
  and reported before the next, with `/ash stop` able to end it between systems. The
  job lives only in memory, so a restart ends a run and nothing resumes half-way.
- A removal calibrates the game's **item-id counter** once per command through the
  vendor's own allocator: it reads `getItemReferenceHighWaterMark()` and compares it
  with the stored counter, and only when the counter is not above that mark does it
  ask `reserveItemIDs` to move it forward (that call consumes an id, so it is
  deliberately not made when the counter is already correct). The mod never writes
  the identity table itself. If the allocator cannot be reached, the removal still
  happens and the reply just leaves the clause out.
- A Skyhook **produces on its own**. A system's sovereignty infrastructure hub is
  where its power and workforce are totalled, not a precondition for producing
  them: an in-game test confirmed production works in a system with no hub and no
  claim. The mod never looks for a hub, never warns about one and never refuses
  because of one.
