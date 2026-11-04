// Pure Orbit helpers: parse `orbit ... --json` envelopes and build the read-only commands the
// worker runs. No Node imports, so the worker tests and the panel share it.
import type { Instance, Resource, SqlDb } from './protocol'

/** Runs `orbit <args>` and answers its stdout. */
export type Orbit = (args: readonly string[]) => Promise<string>

const READ_COMMANDS = [['instance', 'list'], ['status'], ['inspect'], ['sqlserver', 'list'], ['sqlserver', 'diff'], ['logs']]
const VALUE_FLAGS = new Set(['--instance', '-c', '--config', '--lines', '--tail'])

/** Whether the command words (global flags removed) start with one Orbit command that only reads. */
export function isReadOnly(args: readonly string[]): boolean {
  const words = args.filter((arg, i) => !arg.startsWith('-') && !VALUE_FLAGS.has(args[i - 1] ?? ''))
  return READ_COMMANDS.some((command) => command.every((word, i) => words[i] === word))
}

/**
 * `--instance` for a named instance, and `-c` for both: a command run inside a project (a log
 * tab opens in the focused workspace) would otherwise pick up that project's orbit.yaml.
 */
export function targetArgs(instance: Pick<Instance, 'name' | 'configPath'>): string[] {
  return [...(instance.name ? ['--instance', instance.name] : []), ...(instance.configPath ? ['-c', instance.configPath] : [])]
}

type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message: string } }

export class OrbitError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Reads the `orbit.cli.v1` envelope; a failed command becomes an OrbitError with Orbit's code. */
export function envelope<T>(stdout: string): T {
  const parsed = JSON.parse(stdout) as Envelope<T>
  if (!parsed.ok || parsed.data === undefined) {
    throw new OrbitError(parsed.error?.code ?? 'unknown', parsed.error?.message ?? 'orbit failed')
  }
  return parsed.data
}

type InstanceJson = {
  name: string
  environment: string
  /** The daemon's state, not its resources'. */
  state: string
  dashboard?: string
  socket_path: string
  config_path?: string
  /** Resources per state; absent when Orbit could not ask the daemon (unknown, not "none running"). */
  resource_states?: Record<string, number>
  last_active_at?: string
}

function countsOf(states: Record<string, number> | undefined): { up: number | null; total: number | null } {
  if (!states) return { up: null, total: null }
  const entries = Object.entries(states)
  return {
    up: entries.filter(([state]) => state !== 'stopped').reduce((sum, [, n]) => sum + n, 0),
    total: entries.reduce((sum, [, n]) => sum + n, 0)
  }
}

export function parseInstances(stdout: string): Instance[] {
  const data = envelope<{ instances: InstanceJson[] }>(stdout)
  return data.instances.map((i) => ({
    name: i.name,
    environment: i.environment,
    daemon: i.state === 'running',
    ...countsOf(i.resource_states),
    lastActiveAt: Date.parse(i.last_active_at ?? '') || null,
    configPath: i.config_path ?? null,
    dashboard: i.dashboard ?? null,
    socketPath: i.socket_path
  }))
}

type InspectJson = {
  daemon: { running: boolean; dashboard?: string }
  environment?: { selected_name?: string; selected_path?: string }
}

export function isActive(resource: Pick<Resource, 'state'>): boolean {
  return resource.state !== 'stopped'
}

/**
 * Running means some resource is up, for the default runtime and named instances alike: a daemon
 * alone runs nothing (the default one stays up between sessions).
 */
export function isRunning(instance: Pick<Instance, 'up'>): boolean {
  return (instance.up ?? 0) > 0
}

export function withCounts(instance: Instance, resources: Resource[]): Instance {
  return { ...instance, up: resources.filter(isActive).length, total: resources.length }
}

/** The default runtime, from `orbit inspect --json` run outside any project. */
export function parseDefault(inspect: string, socketPath: string): Instance {
  const data = envelope<InspectJson>(inspect)
  return {
    name: '',
    environment: data.environment?.selected_name ?? '',
    daemon: data.daemon.running,
    up: null,
    total: null,
    lastActiveAt: null,
    configPath: data.environment?.selected_path ?? null,
    dashboard: data.daemon.dashboard ?? null,
    socketPath
  }
}

type ResourceJson = {
  name: string
  kind: string
  role?: string
  state: string
  restart_count?: number
  ports?: Record<string, number>
  pending_dependencies?: string[]
}

export function parseResources(stdout: string): Resource[] {
  const data = envelope<{ setup_required?: boolean; resources?: ResourceJson[] }>(stdout)
  return (data.resources ?? []).map((r) => ({
    name: r.name,
    kind: r.kind,
    role: r.role ?? '',
    state: r.state,
    restarts: r.restart_count ?? 0,
    ports: Object.values(r.ports ?? {}).join(', '),
    waitingOn: r.pending_dependencies ?? []
  }))
}

type PublishRecordJson = { database: string; last_publish: unknown }

export type SqlProjects = {
  databases: { project: string; db: string }[]
  /** Databases Orbit has published, from `publish_records`; null when the Orbit CLI is too old to report them. */
  published: Set<string> | null
}

export function parseSqlProjects(stdout: string): SqlProjects {
  const data = envelope<{ projects: { name: string; databases: string[] }[]; publish_records?: PublishRecordJson[] }>(stdout)
  return {
    databases: data.projects.flatMap((p) => p.databases.map((db) => ({ project: p.name, db }))),
    published: data.publish_records ? new Set(data.publish_records.filter((r) => r.last_publish != null).map((r) => r.database)) : null
  }
}

type DiffJson = {
  in_sync: boolean
  created: number
  altered: number
  dropped: number
  file_changes?: unknown[]
}

export function sqlFromDiff(target: { project: string; db: string }, stdout: string): SqlDb {
  const diff = envelope<DiffJson>(stdout)
  if (diff.in_sync) return { ...target, status: 'in-sync', detail: 'In sync' }
  const files = diff.file_changes?.length ?? 0
  const detail = files
    ? `${files} file${files === 1 ? '' : 's'} changed since publish`
    : `+${diff.created} ~${diff.altered} -${diff.dropped}`
  return { ...target, status: 'changed', detail }
}

/** POSIX single-quoting, so names never reach the shell as syntax. */
export function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

export const LOG_LINES = 200

/** Orbit 0.16.9+ prints the last `--lines` before following; older versions only follow. */
export function logsCommand(instance: Pick<Instance, 'name' | 'configPath'>, resource: string): string {
  const args = [...targetArgs(instance), 'logs', resource, '-f', '--lines', String(LOG_LINES)]
  if (!isReadOnly(args)) throw new Error(`refused: orbit ${args.join(' ')}`)
  return ['orbit', ...args].map(quote).join(' ')
}
