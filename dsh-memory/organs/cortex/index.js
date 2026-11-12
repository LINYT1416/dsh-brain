// 大脑皮层插件入口（单器官版）。
// 只做挂载 + 调度 + 对外接口；逻辑都在 lib/。
// 对应：F01 管道、F14 巩固窗口、F19 审计、F35–F44 接口、F40 注入。
import { every, dailyAt } from '../../lib/clock.js'
import { CortexStore, readMeta, writeMeta, appendJsonl, FILES } from './lib/store.js'
import { makeAdapters, capabilityReport, CONTRACT_VERSION } from './lib/adapters.js'
import { makeCortex } from './lib/pipeline.js'
import { expandQuery } from './lib/match.js'
import { extractEpisode, EXTRACT_VERSION } from './lib/extract.js'
import { cleanupCells } from './lib/cleanup.js'
import { toCell } from './lib/extract.js'
import { makeTool } from './lib/tool.js'
import { rollback, versions } from './lib/version.js'
import { cellKey } from './lib/schema.js'
import { attach } from './lib/schema-graph.js'
import { addSupport } from './lib/evidence.js'
import { recompute } from './lib/confidence.js'
import { shouldUpgrade, upgrade, classify } from './lib/anti-pollution.js'
import { record as recordConflict } from './lib/conflicts.js'

const NAME = 'cortex'
const VERSION = '0.1.0'

// 不声明 inject，ctx.tools / ctx.webServer / ctx.agents 拿不到，
// 工具和面板会静默不注册（实测报告里“后三个器官工具全哑”就是这条）。
export const inject = ['tools', 'webServer', 'agents']

export function apply(ctx) {
  const store = new CortexStore()
  // 装载完成之前进来的入站候选先攒着：store 会在 bootstrap 里被磁盘内容覆盖，
  // 早写的会当场消失（海马体一启动就调 upsert，这条路上真的丢过数据）。
  const pendingInbound = []
  let booted = false
  const adapters = makeAdapters(ctx)
  let meta = null
  let cortex = null
  let lastProbeAt = 0
  const runtime = { mounted: new Set(), contextCache: new Map(), lastError: null, health: null }
  let lastKick = 0

  /** 现探：启动顺序决定谁先瞎，所以不能只在 apply 时探一次（500ms 节流）。 */
  function refreshAdapters(force = false) {
    const now = Date.now()
    if (!force && now - lastProbeAt < 500) return adapters
    lastProbeAt = now
    Object.assign(adapters, makeAdapters(ctx))
    return adapters
  }

  let resolveReady
  const readyPromise = new Promise((resolve) => { resolveReady = resolve })
  const ready = () => readyPromise

  /** 跨器官事件：能发就发，发不出去落 outbox（R20/R21）。 */
  function emit(name, payload) {
    const env = { v: CONTRACT_VERSION, kind: name, at: Date.now(), payload }
    try { ctx.emit?.(name, env) } catch { /* 没人听 */ }
    try { void appendJsonl(FILES.outbox, env) } catch { /* 落盘失败不影响主流程 */ }
    return env
  }

  function refreshContext() {
    if (!cortex) return { text: '', ids: [] }
    try {
      const seg = cortex.inject()
      for (const sid of runtime.mounted) runtime.contextCache.set(sid, seg.text)
      return seg
    } catch (e) {
      runtime.lastError = String(e?.message || e)
      return { text: '', ids: [] }
    }
  }

  async function bootstrap() {
    try {
      await store.init()
      meta = await readMeta()
      // 抽取规则升级：旧 episode 重抽一遍，并把旧的碎地点归档
      if (meta.extractVersion !== EXTRACT_VERSION) {
        meta.distilled = {}
        meta.extractVersion = EXTRACT_VERSION
        meta.needsRebuild = true
        cleanupCells(store)
        await writeMeta(meta)
      }
      refreshAdapters(true)
      cortex = makeCortex({ store, adapters, meta })
      booted = true
      // 把装载之前攒下的入站候选补写进去（顺序保持，冲突判定照常走）
      if (pendingInbound.length) {
        const queued = pendingInbound.splice(0, pendingInbound.length)
        for (const batch of queued) {
          try { api.upsert(batch) } catch { /* 单批失败不影响后面的 */ }
        }
      }
      runtime.health = cortex.health()
      refreshContext()
      for (const agent of ctx.agents?.list?.() || []) mount(agent)

      // 多器官协作：海马体发 episode 事件就催一次蒸馏，30 秒去抖
      try {
        const off = ctx.on?.('memory/episode/created', () => {
          const now = Date.now()
          if (now - lastKick < 30000) return
          lastKick = now
          void tick({ deep: false })
        })
        if (off) ctx.effect?.(off)
      } catch { /* 没有事件系统就靠轮询 */ }
    } catch (e) {
      runtime.lastError = String(e?.message || e)
    } finally {
      resolveReady()
    }
  }

  // ── 工具 ──────────────────────────────────────────────
  const tools = [
    makeTool('cortex_ask', '问皮层：她记住了什么（事实/偏好/关系）。返回提炼过的结论，不是原话；问具体细节说想不起来。', {
      query: { type: 'string' },
      k: { type: 'integer', minimum: 1, maximum: 10 },
    }, ['query'], async (args) => {
      await ready()
      return cortex.ask(args.query, { k: args.k || 5 })
    }),

    makeTool('cortex_stats', '看皮层现状：多少事实、多少假设、多少冲突、器官接了几个。', {}, [], async () => {
      await ready()
      return cortex.stats()
    }),

    makeTool('cortex_correct', '纠错：用户说记错了，把这条标成作废（保留历史，不物理删）。', {
      id: { type: 'string' },
      reason: { type: 'string' },
    }, ['id'], async (args) => {
      await ready()
      return cortex.correction(args.id, args.reason || 'user-said-wrong')
    }),

    makeTool('cortex_consolidate', '手动跑一次巩固（从海马体拉新 episode 蒸馏）。dryRun 先看会动哪些。', {
      dryRun: { type: 'boolean' },
      mode: { type: 'string', enum: ['shallow', 'deep'] },
    }, [], async (args) => {
      await ready()
      return cortex.distill({ dryRun: Boolean(args.dryRun), mode: args.mode || 'shallow' })
    }),

    makeTool('cortex_rebuild', '按当前抽取规则重算全部存量：旧 cell 归档，从 episode 重抽一遍（fact 状态保留）。', {}, [], async () => {
      await ready()
      return cortex.rebuild({ mode: 'deep' })
    }),

    makeTool('cortex_conflict_probe', '造一对矛盾数据（手机号两条不同值），验证冲突识别和记录能跑通；结束后自动归档。', {}, [], async () => {
      await ready()
      return cortex.conflictProbe()
    }),

    makeTool('cortex_conflicts', '看还没裁决的冲突（新信息和旧事实打架的）。', {}, [], async () => {
      await ready()
      return cortex.conflicts()
    }),

    makeTool('cortex_health', '皮层自检：层级、能力、能不能写、上次拉取。', {}, [], async () => {
      await ready()
      return cortex.health()
    }),

    makeTool('cortex_resolve', '裁决一条冲突（index 从 cortex_conflicts 来）：winner 选 a/b/neither。', {
      index: { type: 'integer', minimum: 0 },
      winner: { type: 'string', enum: ['a', 'b', 'neither'] },
    }, ['index'], async (args) => {
      await ready()
      return cortex.resolveConflict(args.index, args.winner || 'neither')
    }),

    makeTool('cortex_restore', '把归档的条目恢复成热存（C5 遗忘可恢复）。', {
      id: { type: 'string' },
    }, ['id'], async (args) => {
      await ready()
      return cortex.restore(args.id)
    }),

    makeTool('cortex_rollback', '回滚到某个快照；不传 name 就列可用快照。', {
      name: { type: 'string' },
    }, [], async (args) => {
      await ready()
      if (!args.name) return { snapshots: await versions() }
      const out = await rollback(store, args.name, meta)
      refreshContext()
      return out || { error: 'snapshot-not-found' }
    }),
  ]

  // ── 挂载 Agent：注入 + 反馈回读 ──────────────────────
  function mount(agent) {
    if (!agent?.ctx || !agent.id || runtime.mounted.has(agent.id)) return
    const sid = String(agent.id)
    runtime.mounted.add(sid)
    runtime.contextCache.set(sid, refreshContext().text)

    // 注入开关：config.json 的 inject.cortex === false 时，不往 system prompt 写（工具照常可用）
    if (globalThis.__DSH_ALL_INJECT__?.cortex !== false) {
      try {
        const dispose = agent.ctx.systemPrompt.context({
          name: 'cortex-knowledge',
          order: 910,
          required: false,
          interpolate: false,
          text: () => runtime.contextCache.get(sid) || '',
        })
        agent.ctx.effect?.(dispose)
      } catch (e) {
        runtime.lastError = String(e?.message || e)
      }
    }

    const off = agent.ctx.on?.('agent/inbox/inserted', ({ message } = {}) => {
      try {
        if (!cortex) return
        const text = message?.content?.text || message?.text || ''
        if (text) cortex.observe(String(text))
      } catch { /* 反馈失败不影响对话 */ }
    })
    if (off) agent.ctx.effect?.(off)
  }

  try {
    ctx.effect?.(ctx.on('agent/created', ({ agent }) => { try { mount(agent) } catch { /* 单个失败不拖累 */ } }))
  } catch { /* 没有事件系统就靠轮询 */ }

  const poll = setInterval(() => {
    try {
      for (const agent of ctx.agents?.list?.() || []) if (!runtime.mounted.has(String(agent?.id))) mount(agent)
    } catch { /* 下一轮 */ }
  }, 5000)
  poll.unref?.()
  ctx.effect?.(() => clearInterval(poll))

  // ── 定时：拉取 + 蒸馏 ────────────────────────────────
  async function tick({ deep = false } = {}) {
    try {
      await ready()
      if (!cortex) return { skipped: 'booting' }
      refreshAdapters()
      // 规则升级后的存量重算：旧 cell 归档，按新规则从 episode 重抽一遍
      if (meta.needsRebuild) {
        meta.needsRebuild = false
        await writeMeta(meta)
        const r = await cortex.rebuild({ mode: 'deep' })
        return { ...r, rebuilt: true }
      }
      const out = await cortex.distill({ mode: deep ? 'deep' : 'shallow' })
      if (out?.processed) refreshContext()
      for (const id of out?.promotedIds || []) emit('memory/cortex/fact/promoted', { cellId: id })
      if (out?.conflictIds?.length) emit('memory/cortex/conflict/found', { count: out.conflictIds.length, ids: out.conflictIds })
      runtime.health = cortex.health()
      return out
    } catch (e) {
      runtime.lastError = String(e?.message || e)
      return { error: runtime.lastError }
    }
  }

  // 统一拍子：浅巩固每 5 分钟；深巩固每天 3 点一次。
  // 以前是每 30 分钟轮询"现在是 3 点吗"——3:00 和 3:30 会各跑一遍深巩固。
  const stopShallow = every('cortex.shallow', 5 * 60 * 1000, () => { void tick({ deep: false }) })
  const stopDeep = dailyAt('cortex.deep', 3, () => { void tick({ deep: true }) })
  ctx.effect?.(() => { stopShallow(); stopDeep() })

  // ── 服务 & 面板 ─────────────────────────────────────
  const api = {
    v: CONTRACT_VERSION,
    version: VERSION,
    features: ['extract', 'upsert', 'handoff', 'concepts', 'search', 'contradicts', 'summarize', 'anchorsOf', 'expand', 'relations', 'judge', 'ask', 'distill', 'rebuild', 'inject'],
    // 入站（海马体调）；不需要等 bootstrap
    extract: (episode) => extractEpisode(episode),
    upsert: (candidates) => {
      // 还没装载完：先攒着，别写进还没被磁盘内容覆盖的 store（写了会丢）
      if (!booted) {
        pendingInbound.push(candidates)
        return { accepted: 0, queued: true }
      }
      // 海马体传两种形状都接：扁平的候选，或 {episodeId, facts:[...]} 的包。
      const list = []
      for (const item of (Array.isArray(candidates) ? candidates : [candidates])) {
        if (!item) continue
        if (Array.isArray(item.facts)) {
          for (const f of item.facts) {
            list.push({ ...f, supportIds: [item.episodeId].filter(Boolean), anchors: [item.episodeId].filter(Boolean) })
          }
        } else {
          list.push(item)
        }
      }
      let accepted = 0
      for (const cand of list) {
        if (!cand?.subject || !cand?.object) continue
        const cell = toCell({ ...cand, source: cand.source || 'inferred', state: cand.state || 'fact', layer: cand.layer || 'semantic' })
        const existing = store.find(cellKey(cell))
        if (existing) {
          // 同一件事再推一次：不是跳过，是累计证据；够两条就升级
          let changed = false
          for (const sid of cell.supportIds) {
            if (addSupport(existing, sid)) changed = true
          }
          existing.lastSeen = Math.max(existing.lastSeen || 0, cell.lastSeen)
          existing.confidence = recompute(existing)
          shouldUpgrade(existing) && upgrade(existing)
          store.put(existing)
          attach(store, existing) // 进图：subject/object 边，关系检索靠它
          if (changed) accepted += 1
        } else {
          // 真正的写入路径就是这里（海马体巩固 → handoff → ingest），
          // 而它以前**只做同 key 合并，从不判冲突**：于是"我住在威海"和"我住在青岛"
          // 并排躺成两条事实，conflicts() 永远是空的。判定函数（classify/contradictsSync）
          // 早就写好了，只是这条路上没人调用它。
          // 现在：新事实入库前跟同主语同谓词的老事实比一次，冲突就记下来、压置信度。
          const peer = store.findByPredicate(cell.subject, cell.predicate)
          const verdict = classify(cell, peer)
          if (peer && verdict === 'conflict') {
            const notConflict = cell.kind === 'event' || peer.kind === 'event'
              || cell.subject !== peer.subject
            if (!notConflict) {
              // ingest 是同步函数；record() 在第一个 await 之前就把冲突塞进 store.conflicts 了，
              // 落盘是后面异步做的，所以这里不能 await（会语法错），直接调用即可。
              void recordConflict(store, peer, cell, 'value-mismatch')
              cell.evidenceFlag = true
              cell.confidence = Math.min(Number(cell.confidence ?? 0.9), 0.4)
            }
          }
          store.put(cell)
          // 主链路以前不挂图：facts 有、edges 永远 0，relations() 一直是空的。
          attach(store, cell)
          accepted += 1
        }
      }
      return { accepted }
    },
    // 海马体那边按真假判断，所以这里必须返回 boolean（不能返回对象，
    // 否则 {ok:false} 也是 truthy，会把它误标成 retired）。
    handoff: (episodeId) => Boolean(meta?.distilled?.[episodeId]),
    // 前额叶用 callSync 调这四个，所以必须同步返回，不能是 Promise
    concepts: (query, k) => (cortex ? cortex.conceptsSync(query, k) : { items: [], query }),
    search: (q, opts) => (cortex ? cortex.searchSync(q, opts) : { hits: [], mode: 'auto' }),
    contradicts: (a, b) => (cortex ? cortex.contradictsSync(a, b) : { verdict: 'unknown', confidence: 0, why: 'booting' }),
    summarize: (items) => (cortex ? cortex.summarizeSync(items) : { text: '', ids: [], why: 'booting' }),
    // E5/E8：cellId → episode ids，海马体接图时用它把 c: 和 e: 对上
    anchorsOf: (cellId) => (cortex ? cortex.anchorsOf(cellId) : { id: String(cellId || ''), supportIds: [], anchors: [], episodes: [] }),
    // 查询扩写：前额叶要拼 keys 时可以直接拿，别自己再写一份同义表
    expand: (query) => expandQuery(query),
    /** 装载完成时 resolve；外部写入要"写后立刻读"时先 await 它 */
    whenReady: () => ready(),
    // 需要 bootstrap 完成
    relations: async (id) => { await ready(); return cortex.edgesOf(id) },
    judge: async (a, b) => { await ready(); return cortex.judgePair(a, b) },
    ingest: async () => ({ ok: true, note: '皮层只读海马体，不直接收消息' }),
    ask: async (q, o) => { await ready(); refreshAdapters(); return cortex.ask(q, o) },
    distill: async (o) => { await ready(); refreshAdapters(); return cortex.distill(o) },
    inject: async (o) => { await ready(); return cortex.inject(o) },
    observe: async (t) => { await ready(); return cortex.observe(t) },
    correct: async (id, r) => {
      await ready()
      const row = await cortex.correction(id, r)
      if (row) emit('memory/cortex/corrected', { cellId: id })
      return row
    },
    resolve: async (index, winner) => { await ready(); return cortex.resolveConflict(index, winner) },
    restore: async (id) => { await ready(); return cortex.restore(id) },
    rollback: async (name) => {
      await ready()
      const out = await rollback(store, name, meta)
      refreshContext()
      return out
    },
    stats: async () => { await ready(); refreshAdapters(); return cortex.stats() },
    health: async () => { await ready(); refreshAdapters(); return cortex.health() },
    rebuild: async () => { await ready(); refreshAdapters(); return cortex.rebuild({ mode: 'deep' }) },
    conflictProbe: async () => { await ready(); return cortex.conflictProbe() },
    conflicts: async () => { await ready(); return cortex.conflicts() },
    capabilities: () => { refreshAdapters(); return capabilityReport(adapters) },
    context: () => refreshContext().text,
  }
  try { ctx.provide?.('memory.cortex', api) } catch { /* 老版本没有 provide */ }
  try { ctx.set?.('memory.cortex', api) } catch { /* 同上 */ }

  for (const tool of tools) {
    try {
      if (ctx.tools?.get?.(tool.name)) continue
      ctx.tools?.register?.(tool)
    } catch (e) {
      console.error(`[${NAME}] tool register failed:`, tool.name, e)
    }
  }

  try {
    const ws = ctx.webServer?.register ? ctx.webServer : (ctx.get?.('webServer') ?? null)
    if (ws?.register) {
      ws.register({ kind: 'exact', path: '/cortex/state', handler: async (_req, res) => sendJson(res, await api.stats()) })
      ws.register({
        kind: 'exact',
        path: '/cortex/ask',
        handler: async (req, res) => {
          const q = new URL(req.url, 'http://x').searchParams.get('q') || ''
          sendJson(res, await api.ask(q, { k: 8 }))
        },
      })
      ws.register({ kind: 'exact', path: '/cortex/consolidate', handler: async (_req, res) => sendJson(res, await api.distill({ mode: 'shallow' })) })
    }
  } catch { /* 没有 webServer 就当纯记忆插件 */ }

  void bootstrap()

  return () => { /* 定时器由 effect 清掉 */ }
}

function sendJson(res, value) {
  try {
    res.statusCode = 200
    res.setHeader?.('content-type', 'application/json; charset=utf-8')
    res.end?.(JSON.stringify(value))
  } catch { /* 面板出错不炸插件 */ }
}
