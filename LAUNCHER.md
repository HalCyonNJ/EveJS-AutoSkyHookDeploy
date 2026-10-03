# Installing with the third-party EveJS Launcher

`autoSkyHookDeploy` ships the manifest blocks that launcher expects (`settings`,
`updates`, `launcherApi`) and a helper at `launcher/helper.js`, so it can be added the
same way as any other package. This page is the short version; the contract itself, and
what is **not** verified, is in [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

## Install

1. `Mods > Add ZIP`, and pick `EveJS-AutoSkyHookDeploy-<version>.zip`
   (built with `tools\BuildPackage.bat` - see "Building the ZIP" below).
2. Enable `Auto Skyhook Deploy` in the mod list.
3. Configure it if you want to (the next section), then restart the server when the
   launcher asks.
4. In game, `/ash help` (or `!ash help` in ordinary chat) lists the commands:
   `anchor`, `align`, `unanchor`, `remove`, `offset`, `stop`, `status`, `help`.

Nothing else is needed: this mod is server-side only. It has no client component, no
login handshake and no vendor file to patch, so the launcher's profile preparation
answers `clientScriptDelivery: "none"` and its disable/remove steps have nothing outside
the mod folder to undo.

## Configure

The panel writes `settings.json` **inside the mod folder**, and the mod reads it on
every start. Every field is one of the mod's own configuration keys, with the mod's own
default and range, so the panel and the code cannot disagree:

| Field | Meaning |
|---|---|
| Landing-point offset (m) | `offsetMeters` - how far past the planet's landing point a Skyhook is placed (default 25000). `/ash offset` changes it in game and writes it back to this file. |
| Fallback standoff beyond the surface (m) | `standoffMeters` - used only for a body the game has no warp-in point for. |
| Fallback orbit margin (planet radii) | `orbitMargin` - the other half of that fallback. |
| Region run countdown (seconds) | `regionCountdownSeconds` - the warning before a region run starts (default 15). |
| Delay between region systems (ms) | `regionStepDelayMs` - the gap between systems in a region run (default 2000). |
| Maximum planets per system command | `maxPlanetsPerCommand` - refuses a system bigger than this. |
| Allow /ash anchor | `allowDeploy`. |
| Allow /ash remove and /ash unanchor | `allowRemove`. |
| Owner of a conjured Skyhook | `ownerMode` - `corporation` or `character`. |
| Only work systems the caller's corporation or alliance holds | `requireClaimedSystemOwnership`. |
| List destroyed tombstones in /ash status | `includeDestroyedInStatus`. |
| Verbose server log (advanced) | `verbose`. |

Precedence, highest first: **process environment > `settings.json` >
`config\autoSkyHookDeploy.json` > the mod's `.env` > built-in default**. So an
environment variable set by the launcher or by Docker still wins, a value set in the panel
beats the installer's config file, and a malformed `settings.json` is a configuration
error exactly like a malformed config JSON: the loader installs no hooks and names the
offending key in the log. A **missing** `settings.json` is not an error at all.

`updates.preserveFiles` lists `settings.json`, so a mod update keeps your values.

## Update, disable, remove

* **Update**: the manifest declares a GitHub provider
  (`HalCyonNJ/EveJS-AutoSkyHookDeploy`, asset `EveJS-AutoSkyHookDeploy-{version}.zip`,
  tag prefix `v`, channel `stable`). It only works once that repository and a Release
  exist - this mod has not been published yet, so until then install a new ZIP by hand.
* **Disable**: the launcher stops loading the mod. Skyhooks already deployed stay in the
  game world: they are game state, not mod state.
* **Remove**: delete the entry or the folder. `settings.json` is the only file the mod
  writes outside the game's own data, and it can be deleted with the folder.

## Building the ZIP

```
tools\BuildPackage.bat              -> dist\EveJS-AutoSkyHookDeploy-<version>.zip
tools\BuildPackage.bat --dry-run    -> print the file list, write nothing
```

The archive holds one `autoSkyHookDeploy/` folder with `evejs-launcher.mod.json` at its
root, which is the shape `Mods > Add ZIP` unpacks. Build output, VCS metadata, dependency
folders and stray archives are excluded; `tools\` and `test\` ship inside the ZIP (the
installer prunes `tools\` from an installed payload) so the package can rebuild and
re-check itself.

## What is not verified

There is no launcher on the machine this mod was developed on and no schema document for
it, so the launcher path was written by mirroring a working third-party package field by
field. It is **implemented but untested by us**. The exact assumptions, and what to look
at if the launcher disagrees, are listed in [HOW-IT-WORKS.md](HOW-IT-WORKS.md) under
"The launcher contract".
