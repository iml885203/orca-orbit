# Orbit for Orca

A read-only Orbit status panel in Orca's right sidebar.

- **Instances**: the default runtime and every named `--instance`. Each has its own daemon;
  State shows `daemon off` or how many resources are up (`2/12 up`). A runtime counts as
  running when at least one resource is up — a daemon alone runs nothing, and the default
  runtime's daemon stays up between sessions. Refreshes every 30 seconds while visible.
- **Resources**: select an instance to see each container and service with its state and
  restarts; a stopped resource names the dependencies it waits on. Enter or double-click a
  resource to open its logs in a terminal tab (Orca switches to it).
- **SQL**: each database of the environment's SQL projects is `in sync`, `changed` (files
  changed since the last publish), `not published` or `unknown`.
- **Dashboard** opens the instance's Orbit dashboard in the browser.

## Read-only

The worker runs only `orbit instance list`, `status`, `inspect`, `sqlserver list`,
`sqlserver diff` and `logs` (`isReadOnly` in `src/orbit.ts`); never `up`, `down`, `restart`,
`publish` or `reset`.

## How SQL status is read

`orbit sqlserver diff` on a database Orbit never published runs the full SqlPackage comparison
(seconds per database). The worker first reads the daemon's publish record
(`GET /api/db-state` on the instance socket) and runs the quick diff only for published
databases, so a 22-database environment answers in about 0.2 seconds.

`/api/db-state` is the dashboard's daemon endpoint, not part of Orbit's CLI contract; if it
stops answering, every database shows `unknown` with the reason.

## Orbit version

Orbit 0.16.9 or newer: named instances' resource counts and last-used time come from
`orbit instance list --json`, and the log tab's `orbit logs <r> -f --lines 200` shows recent
lines before following. With older Orbit, named instances show `daemon up` without counts and
log tabs start empty.

## Develop

```sh
orca plugin test .
orca plugin dev load . --approve <fingerprint>   # edits then hot-reload
orca plugin dev unload .
```

Needs Orca 1.4.247 or newer and `orbit` on PATH. Logs open through Orca's bundled CLI, found
beside the running app (`bin/orca` on macOS, `bin/orca-ide` on Linux), because the plugin
API's `terminal.create` opens a background terminal that never appears on screen.

Platforms: macOS verified; Linux coded for but untested; Windows not supported yet (commands
are POSIX-quoted and joined with `;`).
