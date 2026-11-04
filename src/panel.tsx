import {
  atom,
  Badge,
  Button,
  Card,
  EmptyState,
  Heading,
  IconButton,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Table,
  Text,
  type Atom,
  type PanelContext
} from 'orca'
import { isActive, isRunning } from './orbit'
import type { Instance, Resource, SqlDb } from './protocol'

type Load<T> = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; message: string }

const REFRESH_MS = 30_000
const SQL_TIMEOUT_MS = 120_000
const DEFAULT_KEY = '(default)'
/** Orbit has no instance called "default": the unnamed runtime is labelled so it never reads as one. */
const DEFAULT_LABEL = 'default runtime'

const instances = atom<Load<Instance[]>>({ state: 'loading' })
const selected = atom<string | null>('selected', null, { persist: 'plugin' })
const resources = atom<Load<Resource[]>>({ state: 'idle' })
const sql = atom<Load<SqlDb[] | null>>({ state: 'idle' })
const notice = atom<string | null>(null)

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Sets `box` to loading only when it has nothing to show, so a background refresh never blanks a table. */
async function load<T>(box: Atom<Load<T>>, run: () => Promise<T>): Promise<void> {
  if (read(box).state !== 'ready') set(box, { state: 'loading' })
  try {
    set(box, { state: 'ready', value: await run() })
  } catch (error) {
    set(box, { state: 'failed', message: message(error) })
  }
}

function keyOf(instance: Instance): string {
  return instance.name || DEFAULT_KEY
}

function nameOf(key: string): string {
  return key === DEFAULT_KEY ? '' : key
}

function labelOf(instance: Instance): string {
  return instance.name || DEFAULT_LABEL
}

function stateOf(instance: Instance): string {
  if (!instance.daemon) return 'daemon off'
  return instance.total === null ? 'daemon up' : `${instance.up}/${instance.total} up`
}

function selectedInstance(): Instance | undefined {
  const list = read(instances)
  return list.state === 'ready' ? list.value.find((i) => keyOf(i) === read(selected)) : undefined
}

async function refresh(): Promise<void> {
  await load(instances, async () => (await plugin.request('orbit.instances')).instances)
  const key = read(selected)
  // A restored selection has no SQL yet; later refreshes leave SQL alone because a check can take seconds.
  if (key) await loadDetail(key, read(sql).state === 'idle')
}

async function choose(key: string | null): Promise<void> {
  set(selected, key)
  set(resources, { state: 'idle' })
  set(sql, { state: 'idle' })
  if (key) await loadDetail(key, true)
}

async function loadDetail(key: string, withSql: boolean): Promise<void> {
  const name = nameOf(key)
  const work = [load(resources, async () => (await plugin.request('orbit.resources', { name })).resources)]
  if (withSql) work.push(checkSql(name))
  await Promise.all(work)
}

async function checkSql(name: string): Promise<void> {
  await load(sql, async () => (await plugin.request('orbit.sql', { name }, { timeoutMs: SQL_TIMEOUT_MS })).databases)
}

async function openLogs(name: string, resource: string): Promise<void> {
  try {
    await plugin.request('orbit.logs', { name, resource })
    set(notice, null)
  } catch (error) {
    set(notice, message(error))
  }
}

export function setup(ctx: PanelContext): () => void {
  void refresh()
  const timer = setInterval(() => {
    if (read(ctx.visible)) void refresh()
  }, REFRESH_MS)
  return () => clearInterval(timer)
}

function InstanceTable({ list }: { list: Instance[] }) {
  const ordered = [...list].sort(
    (a, b) => Number(isRunning(b)) - Number(isRunning(a)) || Number(b.daemon) - Number(a.daemon) || keyOf(a).localeCompare(keyOf(b))
  )
  const key = read(selected)
  return (
    <Table
      label="Instances"
      selectionMode="single"
      selected={key ? [key] : []}
      maxHeight="md"
      columns={[
        { key: 'name', label: 'Instance' },
        { key: 'env', label: 'Environment', width: 'md', hideBelow: 'sm' },
        { key: 'state', label: 'State', width: 'sm' },
        { key: 'last', label: 'Last used', width: 'xs', align: 'end', hideBelow: 'md' }
      ]}
      rows={ordered.map((i) => ({
        key: keyOf(i),
        cells: {
          name: labelOf(i),
          env: i.environment,
          state: stateOf(i),
          last: i.lastActiveAt ? { type: 'relative' as const, at: i.lastActiveAt } : null
        }
      }))}
      onSelectionChange={({ keys }) => void choose(keys[0] ?? null)}
    />
  )
}

function ResourceTable({ instance }: { instance: Instance }) {
  const list = read(resources)
  if (list.state === 'failed') return <Text tone="danger" size="xs">{list.message}</Text>
  if (list.state === 'ready' && list.value.length === 0) {
    return <Text muted size="xs">{instance.daemon ? 'No resources' : 'Daemon stopped: Orbit reports resources only while the daemon runs.'}</Text>
  }
  const rows = list.state === 'ready' ? list.value : []
  const active = rows.filter(isActive).length
  return (
    <Stack gap="xs">
      <Row gap="xs">
        <Text weight="medium" size="sm">Resources</Text>
        <Badge tone={active ? 'success' : 'neutral'}>{`${active}/${rows.length} up`}</Badge>
      </Row>
      <Table
        label="Resources"
        loading={list.state === 'loading'}
        maxHeight="md"
        columns={[
          { key: 'name', label: 'Name', sortable: true },
          { key: 'kind', label: 'Kind', width: 'sm', hideBelow: 'sm' },
          { key: 'state', label: 'State', width: 'sm', sortable: true },
          { key: 'restarts', label: 'Restarts', width: 'xs', align: 'end', hideBelow: 'md' }
        ]}
        rows={[...rows]
          .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || a.name.localeCompare(b.name))
          .map((r) => ({
            key: r.name,
            cells: {
              name: r.name,
              kind: r.kind,
              state: r.waitingOn.length && !isActive(r) ? `${r.state} (needs ${r.waitingOn.join(', ')})` : r.state,
              restarts: r.restarts
            }
          }))}
        onRowAction={({ key }) => void openLogs(instance.name, key)}
      />
      <Text muted size="xs">Enter or double-click a resource to follow its logs.</Text>
    </Stack>
  )
}

const SQL_LABEL: Record<SqlDb['status'], string> = {
  'in-sync': 'in sync',
  changed: 'changed',
  'not-published': 'not published',
  unknown: 'unknown'
}

function SqlTable({ instance }: { instance: Instance }) {
  const list = read(sql)
  if (list.state === 'idle') return null
  if (list.state === 'loading') return <Spinner label="Checking SQL projects" />
  if (list.state === 'failed') return <Text tone="danger" size="xs">{list.message}</Text>
  if (list.value === null) return <Text muted size="xs">SQL Server workflow is not enabled for this environment.</Text>
  const dbs = list.value
  const count = (status: SqlDb['status']) => dbs.filter((d) => d.status === status).length
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        <Text weight="medium" size="sm">SQL</Text>
        <Badge tone="success">{`${count('in-sync')} in sync`}</Badge>
        {count('changed') ? <Badge tone="warning">{`${count('changed')} changed`}</Badge> : null}
        {count('not-published') ? <Badge>{`${count('not-published')} not published`}</Badge> : null}
        {count('unknown') ? <Badge tone="danger">{`${count('unknown')} unknown`}</Badge> : null}
        <IconButton icon="refresh" label="Check SQL again" size="xs" variant="ghost" onPress={() => checkSql(instance.name)} />
      </Row>
      <Table
        label="SQL databases"
        maxHeight="md"
        columns={[
          { key: 'db', label: 'Database', sortable: true },
          { key: 'status', label: 'Status', width: 'sm', sortable: true },
          { key: 'detail', label: 'Detail', hideBelow: 'md' }
        ]}
        rows={dbs.map((d) => ({ key: d.db, cells: { db: d.db, status: SQL_LABEL[d.status], detail: d.detail } }))}
      />
    </Stack>
  )
}

function Detail({ instance }: { instance: Instance }) {
  const url = instance.dashboard
  return (
    <Card title={labelOf(instance)} description={`${instance.environment} · ${stateOf(instance)}`}>
      <Stack gap="md">
        {instance.lastActiveAt ? (
          <Text muted size="xs">
            Last used <RelativeTime at={instance.lastActiveAt} />
          </Text>
        ) : null}
        <Row gap="xs">
          <Button size="sm" icon="open-external" disabled={!url || !instance.daemon} onPress={() => (url ? shell.openExternal(url) : undefined)}>
            Dashboard
          </Button>
        </Row>
        <ResourceTable instance={instance} />
        <SqlTable instance={instance} />
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const list = read(instances)
  const problem = read(notice)
  const chosen = selectedInstance()
  const running = list.state === 'ready' ? list.value.filter(isRunning).length : 0
  return (
    <Stack gap="sm">
      <Row justify="between">
        <Row gap="xs">
          <Heading level={3}>Orbit</Heading>
          {list.state === 'ready' ? <Badge tone={running ? 'success' : 'neutral'}>{`${running} running`}</Badge> : null}
        </Row>
        <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={refresh} />
      </Row>
      {problem ? <Text tone="danger" size="xs">{problem}</Text> : null}
      {list.state === 'loading' ? <Spinner label="Reading Orbit" /> : null}
      {list.state === 'failed' ? <EmptyState icon="error" title="orbit failed" description={list.message} /> : null}
      {list.state === 'ready' ? <InstanceTable list={list.value} /> : null}
      {chosen ? <Detail instance={chosen} /> : null}
    </Stack>
  )
}
