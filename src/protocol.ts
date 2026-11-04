// The panel <-> worker contract: src/panel.tsx and src/worker.ts both read it.

/**
 * One Orbit runtime: the default runtime (`name` is empty) or a named `--instance`. Each has its
 * own daemon; Orbit's `instance list` covers only the named ones.
 */
export type Instance = {
  name: string
  environment: string
  daemon: boolean
  /** Resources not stopped, and all resources; null while the daemon is down (Orbit cannot say). */
  up: number | null
  total: number | null
  /** Last recorded Orbit command for a named instance (ms); null for the default runtime or when unknown. */
  lastActiveAt: number | null
  /** Passed back as `-c`: Orbit refuses a named instance without its config, and pinning the default runtime's keeps project discovery out. */
  configPath: string | null
  dashboard: string | null
  socketPath: string
}

export type Resource = {
  name: string
  kind: string
  role: string
  state: string
  restarts: number
  ports: string
  waitingOn: string[]
}

export type SqlStatus = 'in-sync' | 'changed' | 'not-published' | 'unknown'
export type SqlDb = { db: string; project: string; status: SqlStatus; detail: string }

type Target = { name: string }

declare module 'orca' {
  interface PluginRequests {
    'orbit.instances': { output: { instances: Instance[] } }
    /** Empty for a runtime whose daemon is not running: Orbit only reports a live daemon's resources. */
    'orbit.resources': { input: Target; output: { resources: Resource[] } }
    /** `null` when the environment does not enable the SQL Server workflow. */
    'orbit.sql': { input: Target; output: { databases: SqlDb[] | null } }
    /** Opens `orbit logs -f` in a terminal tab of the focused workspace and switches to it. */
    'orbit.logs': { input: Target & { resource: string }; output: { terminalId: string } }
  }
}
