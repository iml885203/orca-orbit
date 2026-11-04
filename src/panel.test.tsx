import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { Instance } from './protocol'

const dev1: Instance = { name: 'dev1', environment: 'shop', daemon: true, up: 1, total: 2, lastActiveAt: Date.parse('2026-11-01T00:00:00Z'), configPath: '/b.yaml', dashboard: 'http://localhost:19801', socketPath: '/s' }
const def: Instance = { name: '', environment: 'app', daemon: true, up: 0, total: 5, lastActiveAt: null, configPath: null, dashboard: null, socketPath: '/d' }

function host(opened: unknown[]) {
  return mockHost({
    requests: {
      'orbit.instances': () => ({ instances: [def, dev1] }),
      'orbit.resources': () => ({
        resources: [
          { name: 'sql-server', kind: 'container', role: 'infra', state: 'running', restarts: 0, ports: '11433', waitingOn: [] },
          { name: 'api', kind: 'service', role: 'backend', state: 'stopped', restarts: 0, ports: '8080', waitingOn: ['kafka'] }
        ]
      }),
      'orbit.sql': () => ({
        databases: [
          { db: 'OrdersDB', project: 'OrdersDB', status: 'in-sync', detail: 'In sync' },
          { db: 'BillingDB', project: 'BillingDB', status: 'not-published', detail: 'Not published' }
        ]
      }),
      'orbit.logs': (input) => (opened.push(input), { terminalId: 't1' })
    }
  })
}

const instancesTable = { role: 'grid', label: 'Instances' } as const
const resourcesTable = { role: 'grid', label: 'Resources' } as const

test('running instances come first; selecting one shows resources, SQL and opens logs', async () => {
  const opened: unknown[] = []
  const view = await mount(panel, { host: host(opened) })
  try {
    assert.notEqual(view.find({ text: '1 running' }), null)
    assert.deepEqual(view.rowsOf(instancesTable), ['dev1', '(default)'])
    const drawn = JSON.stringify(view.tree())
    assert.ok(drawn.includes('default runtime'), 'the unnamed runtime never reads as an instance called default')
    assert.ok(drawn.includes('0/5 up'), 'a daemon with nothing up is not running')

    await view.selectRows(instancesTable, ['dev1'])
    assert.ok(JSON.stringify(view.tree()).includes('Last used'), 'the card shows when the instance was last used')
    assert.deepEqual(view.rowsOf(resourcesTable), ['sql-server', 'api'])
    assert.notEqual(view.find({ text: '1/2 up' }), null)
    assert.ok(JSON.stringify(view.tree()).includes('stopped (needs kafka)'), 'a stopped resource names what it waits on')
    assert.notEqual(view.find({ text: '1 in sync' }), null)
    assert.notEqual(view.find({ text: '1 not published' }), null)

    await view.activateRow(resourcesTable, 'api')
    assert.deepEqual(opened, [{ name: 'dev1', resource: 'api' }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
    assert.deepEqual(view.warnings, [])
  } finally {
    // The panel's refresh timer would keep Node alive after a failed assertion.
    await view.unmount()
  }
})

test('a selection restored from the last run loads its SQL too', async () => {
  const view = await mount(panel, { host: host([]), persisted: { plugin: { selected: 'dev1' } } })
  try {
    assert.notEqual(view.find({ text: '1 in sync' }), null)
  } finally {
    await view.unmount()
  }
})
