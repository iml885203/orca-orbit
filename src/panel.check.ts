import { defineCheck } from 'orca/testing'

// `showcase` is the screenshot in the README and in Orbit's integrations page. It uses Orbit's
// public demo environment in a named instance, so no real environment or company name can leak
// into a published image. Shoot it with `orca plugin shot . --scenario showcase`.
const showcase = {
  persisted: { plugin: { selected: 'demo' } },
  requests: {
    'orbit.instances': () => ({
      instances: [
        { name: 'demo', environment: 'quickstart', daemon: true, up: 6, total: 6, lastActiveAt: Date.now() - 4 * 60_000, configPath: '/demo/envs/quickstart.yaml', dashboard: 'http://localhost:19801', socketPath: '/demo.sock' },
        { name: 'review', environment: 'quickstart', daemon: true, up: 3, total: 6, lastActiveAt: Date.now() - 2 * 3_600_000, configPath: '/demo/envs/quickstart.yaml', dashboard: 'http://localhost:19802', socketPath: '/review.sock' },
        { name: '', environment: 'quickstart', daemon: false, up: null, total: null, lastActiveAt: null, configPath: null, dashboard: null, socketPath: '/default.sock' }
      ]
    }),
    'orbit.resources': () => ({
      resources: [
        { name: 'redis', kind: 'container', role: 'infra', state: 'healthy', restarts: 0, ports: '26379', waitingOn: [] },
        { name: 'sql-server', kind: 'container', role: 'infra', state: 'healthy', restarts: 0, ports: '11433', waitingOn: [] },
        { name: 'shop-catalog-api', kind: 'service', role: 'backend', state: 'healthy', restarts: 0, ports: '28101', waitingOn: [] },
        { name: 'shop-inventory-api', kind: 'service', role: 'backend', state: 'healthy', restarts: 0, ports: '28102', waitingOn: [] },
        { name: 'shop-order-api', kind: 'service', role: 'backend', state: 'healthy', restarts: 1, ports: '28103', waitingOn: [] },
        { name: 'demo-shop', kind: 'service', role: 'frontend', state: 'healthy', restarts: 0, ports: '28100', waitingOn: [] }
      ]
    }),
    'orbit.sql': () => ({
      databases: [
        { db: 'OrdersDB', project: 'OrdersDB', status: 'in-sync', detail: 'In sync' },
        { db: 'CatalogDB', project: 'CatalogDB', status: 'changed', detail: '2 files changed since publish' },
        { db: 'CatalogDB_test', project: 'CatalogDB', status: 'not-published', detail: 'Not published' }
      ]
    }),
    'orbit.logs': () => ({ terminalId: 't1' })
  }
}

export default defineCheck({ fresh: {}, showcase })
