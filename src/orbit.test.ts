import { assert, test } from 'orca/testing'
import { envelope, isReadOnly, logsCommand, parseResources, parseSqlProjects, sqlFromDiff } from './orbit'

const ok = (data: unknown) => JSON.stringify({ schema_version: 'orbit.cli.v1', ok: true, data })

test('allows only Orbit commands that read', () => {
  assert.equal(isReadOnly(['--instance', 'up', '-c', '/x.yaml', 'status', '--json']), true)
  assert.equal(isReadOnly(['sqlserver', 'diff', 'OrdersDB', '--json']), true)
  assert.equal(isReadOnly(['logs', 'api', '-f', '--lines', '200']), true)
  assert.equal(isReadOnly(['up']), false)
  assert.equal(isReadOnly(['--instance', 'x', 'down']), false)
  assert.equal(isReadOnly(['sqlserver', 'publish', '--all']), false)
  assert.equal(isReadOnly(['sqlserver', 'reset', 'OrdersDB']), false)
  assert.equal(isReadOnly(['open']), false)
})

test('a failed command keeps Orbit error code', () => {
  const failed = JSON.stringify({ ok: false, error: { code: 'not_configured', message: 'SQL Server workflow is not enabled' } })
  assert.throws(() => envelope(failed), (error: Error & { code?: string }) => error.code === 'not_configured')
})

test('resources keep state, restarts and what they wait on', () => {
  const [r] = parseResources(ok({ resources: [{ name: 'web', kind: 'service', role: 'backend', state: 'stopped', ports: { http: 3000, https: 3443 }, restart_count: 2, pending_dependencies: ['mongodb'] }] }))
  assert.deepEqual(r, { name: 'web', kind: 'service', role: 'backend', state: 'stopped', restarts: 2, ports: '3000, 3443', waitingOn: ['mongodb'] })
})

test('only databases with a recorded publish count as published', () => {
  const stdout = ok({
    projects: [{ name: 'OrdersDB', databases: ['OrdersDB', 'Other'] }],
    publish_records: [
      { database: 'OrdersDB', project: 'OrdersDB', last_publish: { at: '2026-11-04T10:08:19Z', source: 'cli' }, last_reset: null, baseline_at: null },
      { database: 'Other', project: 'OrdersDB', last_publish: null, last_reset: null, baseline_at: { at: '2026-11-04T10:08:19Z', source: 'cli' } }
    ]
  })
  assert.deepEqual([...(parseSqlProjects(stdout).published ?? [])], ['OrdersDB'])
})

test('a diff names file changes when the quick check has only those', () => {
  const target = { project: 'OrdersDB', db: 'OrdersDB' }
  assert.equal(sqlFromDiff(target, ok({ in_sync: true, created: 0, altered: 0, dropped: 0 })).status, 'in-sync')
  const changed = sqlFromDiff(target, ok({ in_sync: false, created: 0, altered: 0, dropped: 0, quick: true, file_changes: [{}, {}] }))
  assert.deepEqual(changed, { ...target, status: 'changed', detail: '2 files changed since publish' })
})

test('logs of a named instance carry its config', () => {
  assert.equal(
    logsCommand({ name: 'dev1', configPath: '/a b/shop.yaml' }, 'api'),
    "orbit --instance dev1 -c '/a b/shop.yaml' logs api -f --lines 200"
  )
  assert.equal(logsCommand({ name: '', configPath: '/envs/ft.yaml' }, 'redis'), 'orbit -c /envs/ft.yaml logs redis -f --lines 200')
})
