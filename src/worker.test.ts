import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { orcaCliPath, registerHandlers, type Deps } from './worker'

const ok = (data: unknown) => JSON.stringify({ schema_version: 'orbit.cli.v1', ok: true, data })

const instanceList = ok({
  instances: [
    { name: 'dev1', environment: 'shop', state: 'running', dashboard: 'http://localhost:19801', socket_path: '/s/dev1.sock', config_path: '/envs/shop.yaml', resource_states: { healthy: 1, running: 1, stopped: 3 }, last_active_at: '2026-11-01T08:00:00Z' },
    { name: 'demo', environment: 'orbit', state: 'stopped', socket_path: '/s/demo.sock', config_path: '/demo/orbit.yaml' }
  ]
})

function fakeOrbit(calls: string[][], overrides: Record<string, string> = {}): Deps['orbit'] {
  return async (args) => {
    calls.push([...args])
    const line = args.join(' ')
    for (const [match, out] of Object.entries(overrides)) if (line.includes(match)) return out
    if (line === 'instance list --json') return instanceList
    if (line === 'inspect --json') return ok({ daemon: { running: true, dashboard: 'http://localhost:19800' }, environment: { selected_name: 'app', selected_path: '/envs/app.yaml' } })
    if (line.endsWith('status --json')) return ok({ resources: [{ name: 'redis', kind: 'container', state: 'running' }] })
    throw new Error(`unexpected orbit ${line}`)
  }
}

function mountWith(deps: Partial<Deps> & Pick<Deps, 'orbit'>, host = mockHost()) {
  const full: Deps = {
    showTerminal: async () => ({ terminalId: 't1' }),
    ...deps
  }
  return mountWorker({ default: (orca: Parameters<typeof registerHandlers>[0]) => registerHandlers(orca, full) }, { host })
}

test('counts named instances from instance list and asks status only for the default runtime', async () => {
  const calls: string[][] = []
  const worker = await mountWith({ orbit: fakeOrbit(calls) })
  const { instances } = await worker.request('orbit.instances')
  assert.deepEqual(
    instances.map((i) => [i.name, i.daemon, i.up, i.total, i.lastActiveAt]),
    [['', true, 1, 1, null], ['dev1', true, 2, 5, Date.parse('2026-11-01T08:00:00Z')], ['demo', false, null, null, null]]
  )
  assert.deepEqual(calls.filter((c) => c.includes('status')), [['-c', '/envs/app.yaml', 'status', '--json']])
  await worker.deactivate()
})

test('a stopped instance reports no resources without asking its daemon', async () => {
  const calls: string[][] = []
  const worker = await mountWith({ orbit: fakeOrbit(calls) })
  assert.deepEqual(await worker.request('orbit.resources', { name: 'demo' }), { resources: [] })
  assert.equal(calls.some((c) => c.includes('demo')), false)
  await worker.deactivate()
})

test('SQL diffs only published databases and reads the rest from the publish record', async () => {
  const calls: string[][] = []
  const orbit = fakeOrbit(calls, {
    'sqlserver list': ok({
      projects: [{ name: 'OrdersDB', databases: ['OrdersDB', 'OrdersDB_test'] }],
      publish_records: [
        { database: 'OrdersDB', project: 'OrdersDB', last_publish: { at: 'x', source: 'cli' }, last_reset: null, baseline_at: null },
        { database: 'OrdersDB_test', project: 'OrdersDB', last_publish: null, last_reset: null, baseline_at: { at: 'x', source: 'cli' } }
      ]
    }),
    'sqlserver diff OrdersDB --json': ok({ in_sync: true, created: 0, altered: 0, dropped: 0, quick: true })
  })
  const worker = await mountWith({ orbit })
  const { databases } = await worker.request('orbit.sql', { name: 'dev1' })
  assert.deepEqual(databases?.map((d) => [d.db, d.status]), [['OrdersDB', 'in-sync'], ['OrdersDB_test', 'not-published']])
  assert.deepEqual(calls.filter((c) => c.includes('diff')), [['--instance', 'dev1', '-c', '/envs/shop.yaml', 'sqlserver', 'diff', 'OrdersDB', '--json']])
  await worker.deactivate()
})

test('an Orbit CLI without publish records reports SQL status as unknown without diffing', async () => {
  const calls: string[][] = []
  const orbit = fakeOrbit(calls, { 'sqlserver list': ok({ projects: [{ name: 'OrdersDB', databases: ['OrdersDB'] }] }) })
  const worker = await mountWith({ orbit })
  const { databases } = await worker.request('orbit.sql', { name: 'dev1' })
  assert.deepEqual(databases?.map((d) => [d.db, d.status, d.detail]), [['OrdersDB', 'unknown', 'Needs Orbit 0.16.10 or later']])
  assert.equal(calls.some((c) => c.includes('diff')), false)
  await worker.deactivate()
})

test('an environment without the SQL workflow answers null', async () => {
  const notConfigured = JSON.stringify({ ok: false, error: { code: 'not_configured', message: 'not enabled' } })
  const worker = await mountWith({ orbit: fakeOrbit([], { 'sqlserver list': notConfigured }) })
  assert.deepEqual(await worker.request('orbit.sql', { name: '' }), { databases: null })
  await worker.deactivate()
})

test('logs open a focused tab in the focused workspace', async () => {
  const host = mockHost()
  host.respond('workspace.list', {
    workspaces: [
      { id: 'w1', kind: 'folder', name: 'orbit', path: '/github/orbit', branch: 'main', hostId: null },
      { id: 'w2', kind: 'folder', name: 'sample', path: '/work/sample', branch: null, hostId: null }
    ],
    truncated: false
  })
  host.respond('workspace.readContext', { branch: '', displayName: 'sample', terminals: [] })
  const tabs: unknown[] = []
  const worker = await mountWith({ orbit: fakeOrbit([]), showTerminal: async (tab) => (tabs.push(tab), { terminalId: 't7' }) }, host)
  assert.deepEqual(await worker.request('orbit.logs', { name: 'dev1', resource: 'api' }), { terminalId: 't7' })
  assert.deepEqual(tabs, [{ path: '/work/sample', title: 'dev1 · api', command: 'orbit --instance dev1 -c /envs/shop.yaml logs api -f --lines 200' }])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('finds the Orca CLI Orca bundles on each platform', () => {
  assert.equal(orcaCliPath('darwin', '/Applications/Orca.app/Contents/Resources'), '/Applications/Orca.app/Contents/Resources/bin/orca')
  assert.equal(orcaCliPath('linux', '/opt/Orca/resources'), '/opt/Orca/resources/bin/orca-ide')
  assert.equal(orcaCliPath('linux', undefined), 'orca')
})
