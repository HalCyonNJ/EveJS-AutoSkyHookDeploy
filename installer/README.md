# Auto Skyhook Deploy - installer

Registers the mod's loader with an EveJS 261018.1 installation and keeps the mod
folder in step with this package. It edits three things:

| Deployment | File | What is written |
|---|---|---|
| Docker | `docker/entrypoint.sh` | `--require /app/mods/autoSkyHookDeploy/loader.js` on both server launches |
| Docker build context | `.dockerignore` | `!mods/` and `!mods/**`, because 261018.1's allowlist does not mention `mods/` |
| Windows native | `StartServer.bat` | an append-only block that adds `--require "<root>/mods/autoSkyHookDeploy/loader.js"` to `NODE_OPTIONS` |

Nothing else in the installation is touched. The `.dockerignore` lines stay in
place on uninstall - another loader mod may still need them. `server/package.json`
is deliberately left alone: it is an input to the image's dependency layer, so
editing it would force a dependency reinstall on the next image build.

## Usage

```bat
install.bat --server "C:\path\to\EveJS"
install.bat --server "C:\path\to\EveJS" --dry-run
install.bat --server "C:\path\to\EveJS" --docker-only
install.bat --server "C:\path\to\EveJS" --native-only
update.bat  --server "C:\path\to\EveJS"
uninstall.bat --server "C:\path\to\EveJS" --dry-run
status.bat  --server "C:\path\to\EveJS"
```

`--server` may be omitted when the installer can find the installation itself:
it looks at its own folder, its siblings, and then walks upwards. `update.bat`
and `uninstall.bat` accept the same arguments; `status.bat` runs
`install.js --status` and writes nothing.

The same entry points run directly with Node, which is what they wrap:

```bat
node install.js --server "C:\path\to\EveJS"
node update.js --server "C:\path\to\EveJS"
node uninstall.js --server "C:\path\to\EveJS" --keep-files
node install.js --status --server "C:\path\to\EveJS"
```

## What each run does

**install / update**

1. Copies this package's mod payload into `<EveJS root>\mods\autoSkyHookDeploy`,
   pruning development-only folders (`installer/`, `tools/`, `dist/`,
   `node_modules/`, `.git/`) and `ANNOUNCEMENT.md` out of the target. A local
   `.env` that is already there is never overwritten.
2. Adds the preload to `docker/entrypoint.sh` and/or `StartServer.bat`, adding a
   preload only where one is missing.
3. Creates `<EveJS root>\config\autoSkyHookDeploy.json` from the payload's
   `config.example.json` if it is absent, and otherwise adds only the keys this
   release introduced. A value that is already in the file is never changed. The
   launcher's `settings.json` (in the mod folder) is a separate file and is never
   read, created, changed or deleted by the installer or by an uninstall.
4. Archives everything it was about to modify under
   `<EveJS root>\_autoskyhookdeploy-backup\<timestamp>\`.

`update.bat` is `install.js` with `--update`: it prints the version it is
replacing and the version it is moving to, and does the same three steps.

**uninstall**

Removes the preload lines this mod registered, archives and deletes
`mods\autoSkyHookDeploy`, and leaves everything else - including
`config\autoSkyHookDeploy.json` and the launcher's `settings.json` - in place. The removals
are surgical, so a
loader mod that registered itself after this one keeps its registration.
`--keep-files` removes the registrations but leaves the mod folder.

Skyhooks that are already deployed in the game are not touched by uninstall.
They are game state, not mod state.

## After installing

| Deployment | Next step |
|---|---|
| Docker | `docker compose build` then `docker compose up -d --no-deps server` (`mods/` is inside the image, so a rebuild is required) |
| Windows native | restart the server with `StartServer.bat` |

Confirm the boot line:

```
[autoSkyHookDeploy] v1.0.0 loader ready - /ash anchor|align|remove|unanchor|stop|offset|status|help and !ash work for every character
```

Then, in the game, `/ash help` (or `!ash help` from ordinary chat).

## Configuration

Priority: process environment > `<mod root>\settings.json` (written by the EveJS
Launcher's Configure panel, when a launcher is used) >
`<EveJS root>\config\autoSkyHookDeploy.json` >
`mods\autoSkyHookDeploy\.env` > built-in defaults.

`config\autoSkyHookDeploy.json` is the deployment-friendly spelling: `config/`
is bind-mounted, so changing it needs a container restart and never an image
rebuild, and it survives `update.bat`. The mod's own `.env` is convenient in a
native checkout. Both spellings of every key are accepted (the short name used
by `config.example.json`, and the environment-variable name).

`settings.json` belongs to the launcher (its `updates.preserveFiles` keeps it across
an update) and is not part of this payload. It outranks the config JSON, and
`/ash offset` writes whichever of the two is in force, so a value set in game is never
shadowed by the other one. The installer never creates, changes or deletes it, and a
**missing** `settings.json` is not an error at all.

The full table is in the mod's `README.md`. A value that is present but has the
wrong type, or is out of range, is treated as a configuration error: the loader
then installs no hooks at all, logs the offending key, and the server behaves
exactly like vanilla EveJS. The same rule applies to `settings.json` when a launcher
has written one - it is a configuration source, not a runtime store.

## Rollback

Each run leaves a timestamped copy of everything it changed:

```
<EveJS root>\_autoskyhookdeploy-backup\<YYYYMMDD-HHMMSS>\
```

Restore a file by copying it back over the current one. `uninstall.bat` also
archives the mod folder before deleting it, so a rollback can always be done by
hand even if a later run replaced the same lines again.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done (a `[SKIP]` line means the step was already in place) |
| 1 | failed; the message above the exit line says which step and why |

Set `EVEJS_AUTO_SKYHOOK_DEPLOY_DEBUG=1` to print a stack trace instead of the
one-line message.
