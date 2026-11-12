// 存储层：只追加 jsonl + 原子写 + 单写队列 + 快照。
// 对应：C2 内容与索引分离、C4 来源置信度、F13 版本与回滚、F19 审计。
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = process.env.CORTEX_DIR || join(homedir(), '.dsh', 'cortex')
export const SNAP_DIR = join(DATA_DIR, 'snapshots')

export const FILES = {
  cells: join(DATA_DIR, 'cells.jsonl'),
  graph: join(DATA_DIR, 'graph.jsonl'),
  conflicts: join(DATA_DIR, 'conflicts.jsonl'),
  traces: join(DATA_DIR, 'traces.jsonl'),
  audit: join(DATA_DIR, 'audit.jsonl'),
  outbox: join(DATA_DIR, 'outbox.jsonl'),
  meta: join(DATA_DIR, 'meta.json'),
}

export async function ensureDirs() {
  await mkdir(DATA_DIR, { recursive: true })
  await mkdir(SNAP_DIR, { recursive: true })
}

let queue = Promise.resolve()
export function enqueue(task) {
  const next = queue.then(task, task)
  queue = next.catch(() => {})
  return next
}

export async function appendJsonl(file, obj) {
  await ensureDirs()
  // 目录可能已经被删掉（测试收尾 / 用户清数据）：落盘失败不该把进程带崩。
  // 以前这里裸 appendFile，rebuild/attach 的异步写在 tmp 目录消失后抛 ENOENT 未捕获。
  await enqueue(() => appendFile(file, JSON.stringify(obj) + '\n', 'utf8').catch(() => {}))
}

export async function appendLines(file, objs) {
  if (!objs?.length) return
  await ensureDirs()
  const chunk = objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
  await enqueue(() => appendFile(file, chunk, 'utf8').catch(() => {}))
}

export async function readJsonl(file, { limit = 0 } = {}) {
  try {
    const text = await readFile(file, 'utf8')
    const rows = []
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try { rows.push(JSON.parse(s)) } catch { /* 半截行跳过 */ }
    }
    return limit > 0 ? rows.slice(-limit) : rows
  } catch {
    return []
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDirs()
  const tmp = `${file}.tmp-${process.pid}`
  await enqueue(async () => {
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, file)
  })
}

export async function readMeta() {
  return (await readJson(FILES.meta, null)) || {
    version: 1,
    schemaVersion: 1,
    createdAt: Date.now(),
    cursor: 0,
    snapshotSeq: 0,
    lastDistillAt: 0,
    stats: {},
  }
}

export async function writeMeta(meta) {
  await writeJsonAtomic(FILES.meta, meta)
}

export function exists(file) {
  return existsSync(file)
}

/** 快照：蒸馏前落一份，供 F13 回滚。 */
export async function writeSnapshot(seq, payload) {
  await ensureDirs()
  const name = `snap-${String(seq).padStart(6, '0')}.json`
  await writeJsonAtomic(join(SNAP_DIR, name), payload)
  return join(SNAP_DIR, name)
}

export async function listSnapshots() {
  try {
    const names = (await readdir(SNAP_DIR)).filter((n) => n.startsWith('snap-') && n.endsWith('.json')).sort()
    return names
  } catch {
    return []
  }
}

export async function readSnapshot(name) {
  return readJson(join(SNAP_DIR, name), null)
}

export async function pruneSnapshots(keep = 10) {
  const names = await listSnapshots()
  const drop = names.slice(0, Math.max(0, names.length - keep))
  for (const n of drop) {
    try { await unlink(join(SNAP_DIR, n)) } catch { /* 删不掉就算了 */ }
  }
}

export async function fileSize(file) {
  try {
    return Buffer.byteLength(await readFile(file, 'utf8'), 'utf8')
  } catch {
    return 0
  }
}

// ── 内存态（cells / 图 / 冲突）────────────────────────────────
import { cellKey, normalizeCell, touch } from './schema.js'
import { FeatureSpace } from './features.js'

export class CortexStore {
  constructor() {
    this.cells = new Map()      // id -> cell
    this.byKey = new Map()      // cellKey -> id
    this.graph = []             // {from,to,kind,w,at}
    this.conflicts = []         // {at,a,b,reason,state}
    this.features = new FeatureSpace()
    this.loaded = false
  }

  async init() {
    if (this.loaded) return this
    const rows = await readJsonl(FILES.cells)
    for (const row of rows) this.put(normalizeCell(row), { persist: false })
    this.graph = await readJsonl(FILES.graph)
    this.conflicts = await readJsonl(FILES.conflicts)
    // 同一对只留最后一条状态（open → stale/resolved 覆盖），避免统计重复
    const seen = new Map()
    for (const c of this.conflicts) {
      const k = `${c.aId}|${c.bId}`
      seen.set(k, c)
    }
    this.conflicts = [...seen.values()]
    this.loaded = true
    return this
  }

  allCells() {
    return [...this.cells.values()]
  }

  get(id) {
    return this.cells.get(id) || null
  }

  find(key) {
    const id = this.byKey.get(key)
    const c = id ? this.cells.get(id) || null : null
    return c && !c.archived ? c : null
  }

  /** 同主体+同谓词的第一条（用于冲突检测；不要求客体相同）。 */
  findByPredicate(subject, predicate) {
    for (const c of this.cells.values()) {
      if (c.retracted || c.archived) continue
      if (c.subject === subject && c.predicate === predicate) return c
    }
    return null
  }

  /** 写入一条 cell；默认落盘（只追加，读时后者覆盖前者）。 */
  put(cell, { persist = true } = {}) {
    const prev = this.cells.get(cell.id)
    if (prev) touch(cell, { version: Math.max(prev.version || 1, cell.version || 1) })
    this.cells.set(cell.id, cell)
    this.byKey.set(cellKey(cell), cell.id)
    if (persist) void appendJsonl(FILES.cells, cell)
    return cell
  }

  remove(id) {
    const cell = this.cells.get(id)
    if (!cell) return null
    this.cells.delete(id)
    this.byKey.delete(cellKey(cell))
    void appendJsonl(FILES.cells, { ...cell, retracted: true, state: 'retracted', deletedAt: Date.now() })
    return cell
  }

  addEdge(from, to, kind, w = 1) {
    if (!from || !to || from === to) return null
    const hit = this.graph.find((e) => e.from === from && e.to === to && e.kind === kind)
    if (hit) {
      hit.w += w
      hit.at = Date.now()
      void appendJsonl(FILES.graph, hit)
      return hit
    }
    const edge = { from, to, kind, w, at: Date.now() }
    this.graph.push(edge)
    void appendJsonl(FILES.graph, edge)
    return edge
  }

  neighbors(id, hops = 1) {
    let frontier = new Set([id])
    const seen = new Set([id])
    for (let h = 0; h < hops; h++) {
      const next = new Set()
      for (const e of this.graph) {
        if (frontier.has(e.from) && !seen.has(e.to)) { seen.add(e.to); next.add(e.to) }
        if (frontier.has(e.to) && !seen.has(e.from)) { seen.add(e.from); next.add(e.from) }
      }
      frontier = next
      if (!frontier.size) break
    }
    return [...seen].filter((x) => x !== id)
  }

  edgesOf(id) {
    return this.graph.filter((e) => e.from === id || e.to === id)
  }

  loadFrom(cells = [], graph = []) {
    this.cells.clear()
    this.byKey.clear()
    for (const c of cells) {
      const cell = normalizeCell(c)
      this.cells.set(cell.id, cell)
      this.byKey.set(cellKey(cell), cell.id)
    }
    this.graph = graph.map((e) => ({ ...e }))
  }

  stats() {
    const list = this.allCells()
    return {
      total: list.length,
      facts: list.filter((c) => c.state === 'fact').length,
      hypotheses: list.filter((c) => c.state === 'hypothesis').length,
      retracted: list.filter((c) => c.retracted).length,
      episodic: list.filter((c) => c.layer === 'episodic').length,
      semantic: list.filter((c) => c.layer === 'semantic').length,
      inference: list.filter((c) => c.layer === 'inference').length,
      edges: this.graph.length,
      conflicts: this.conflicts.length,
    }
  }
}
