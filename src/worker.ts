import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  OrbitError,
  isReadOnly,
  logsCommand,
  parseDefault,
  withCounts,
  parseInstances,
  parseResources,
  parseSqlProjects,
  sqlFromDiff,
  targetArgs,
  type Orbit,
  type SqlProjects
} from './orbit'
import type { Instance, SqlDb } from './protocol'

export type Deps = {
  orbit: Orbit
  /** Opens a visible terminal tab in the workspace at `path` and switches to it. */
  showTerminal: (tab: { path: string; title: string; command: string }) => Promise<{ terminalId: string }>
}

const COMMAND_TIMEOUT_MS = 60_000
const SQL_DIFF_CONCURRENCY = 4

// Orca hands the worker only PATH and HOME, and an app started from the desktop gets the login
// PATH without the shell profile, so the usual install locations of `orbit` are added.
const EXTRA_PATH: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin'],
  linux: ['/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]
}

// The CLI Orca bundles, by platform (names from Orca's own installer).
const ORCA_CLI: Partial<Record<NodeJS.Platform, string>> = { darwin: 'orca', linux: 'orca-ide', win32: 'orca.exe' }

/** Orca's bundled CLI beside the running app, so no install path is assumed; `orca` on PATH otherwise. */
export function orcaCliPath(platform: NodeJS.Platform, resourcesPath: string | undefined): string {
  const name = ORCA_CLI[platform]
  return resourcesPath && name ? join(resourcesPath, 'bin', name) : 'orca'
}

function run(file: string, args: readonly string[]): Promise<string> {
  const path = [process.env.PATH, ...(EXTRA_PATH[process.platform] ?? [])].filter(Boolean).join(delimiter)
  const env = { ...process.env, PATH: path }
  return new Promise((resolve, reject) => {
    // cwd is HOME so Orbit's project discovery never picks up an orbit.yaml: the default
    // runtime is then the environment selected with `orbit switch`, as in the dashboard.
    execFile(file, [...args], { env, cwd: homedir(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      // Orbit exits non-zero with a JSON error envelope on stdout; let the parser report it.
      if (error && !stdout.trim()) reject(new Error(stderr.trim() || error.message))
      else resolve(stdout)
    })
  })
}

const nodeDeps: Deps = {
  orbit: (args) =>
    isReadOnly(args) ? run('orbit', args) : Promise.reject(new Error(`refused: orbit ${args.join(' ')}`)),
  showTerminal: async ({ path, title, command }) => {
    const out = JSON.parse(
      await run(orcaCliPath(process.platform, (process as { resourcesPath?: string }).resourcesPath), ['terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command, '--focus', '--json'])
    ) as { result?: { terminal?: { handle?: string } } }
    const terminalId = out.result?.terminal?.handle
    if (!terminalId) throw new Error('Orca did not open the terminal')
    return { terminalId }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export function registerHandlers(orca: OrcaWorkerApi, deps: Deps): void {
  const defaultSocket = join(homedir(), '.orbit', 'orbit.sock')

  async function resourcesOf(instance: Instance) {
    if (!instance.daemon) return []
    return parseResources(await deps.orbit([...targetArgs(instance), 'status', '--json']))
  }

  // `instance list` reports each named instance's resource counts; the default runtime is not in
  // it, so only that one needs a `status` call.
  async function instances(): Promise<Instance[]> {
    const [named, inspect] = await Promise.all([deps.orbit(['instance', 'list', '--json']), deps.orbit(['inspect', '--json'])])
    const base = parseDefault(inspect, defaultSocket)
    const def = base.daemon ? withCounts(base, await resourcesOf(base)) : base
    return [def, ...parseInstances(named)]
  }

  async function find(name: string): Promise<Instance> {
    const match = (await instances()).find((i) => i.name === name)
    if (!match) throw new Error(`No Orbit instance named ${name}`)
    return match
  }

  async function focusedWorkspacePath(): Promise<string> {
    const [{ workspaces }, focused] = await Promise.all([
      orca.host.call('workspace.list', {}),
      orca.host.call('workspace.readContext', {})
    ])
    const match =
      workspaces.find((w) => w.name === focused?.displayName && w.branch === focused?.branch) ??
      workspaces.find((w) => w.name === focused?.displayName) ??
      workspaces[0]
    if (!match) throw new Error('Open a workspace in Orca first: logs open as a tab inside one.')
    return match.path
  }

  orca.panels.handle('orbit.instances', async () => ({ instances: await instances() }))

  orca.panels.handle('orbit.resources', async ({ name }) => {
    return { resources: await resourcesOf(await find(name)) }
  })

  orca.panels.handle('orbit.sql', async ({ name }) => {
    const instance = await find(name)
    const target = targetArgs(instance)
    let sql: SqlProjects
    try {
      sql = parseSqlProjects(await deps.orbit([...target, 'sqlserver', 'list', '--json']))
    } catch (error) {
      if (error instanceof OrbitError && error.code === 'not_configured') return { databases: null }
      throw error
    }
    const { published } = sql
    // A database Orbit never published would make `diff` build and run the full engine (seconds
    // each); the publish record answers it without touching SQL Server.
    const databases = await mapLimit(sql.databases, SQL_DIFF_CONCURRENCY, async (p): Promise<SqlDb> => {
      if (!published) return { ...p, status: 'unknown', detail: 'Needs Orbit 0.16.10 or later' }
      if (!published.has(p.db)) return { ...p, status: 'not-published', detail: 'Not published' }
      try {
        return sqlFromDiff(p, await deps.orbit([...target, 'sqlserver', 'diff', p.db, '--json']))
      } catch (error) {
        return { ...p, status: 'unknown', detail: error instanceof Error ? error.message : String(error) }
      }
    })
    return { databases }
  })

  orca.panels.handle('orbit.logs', async ({ name, resource }) => {
    const instance = await find(name)
    return deps.showTerminal({
      path: await focusedWorkspacePath(),
      title: `${instance.name || 'orbit'} · ${resource}`,
      command: logsCommand(instance, resource)
    })
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  registerHandlers(orca, nodeDeps)
}
