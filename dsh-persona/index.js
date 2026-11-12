// dsh-persona 入口：挂时钟、读盘、注入、工具、服务。
//
// 六器官同帧：A 段习惯匹配 → B 段读人/定价/检错/归我/连故事/固化。
// 对外两个方向：读心情与记忆（不写），把参数回写给心情（配置写，不碰状态）。

import { join } from 'node:path'
import { homedir } from 'node:os'

import { createEngine, TICK_MS, SLOW_MS } from './core/engine.js'
import { createStore } from './core/store.js'
import { describe, dump } from './core/desc.js'
import { createAffectBridge } from './bridge/affect.js'
import { createMemoryBridge } from './bridge/memory.js'
import { createPanel } from './panel.js'

export const name = 'dsh-persona'
// webServer 必须声明：不声明的话 apply 里拿不到 ctx.webServer，
// 面板的路由会被静默吞掉（页面 404，日志里还什么都不报）。
export const inject = ['systemPrompt', 'tools', 'webServer']
export const VERSION = '2.0.0'

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const store = createStore(home)

  const get = (id) => {
    try { return ctx.get?.(id) ?? null } catch { return null }
  }

  const affect = createAffectBridge(get)
  const memory = createMemoryBridge(get)
  const bridge = {
    affect: () => affect.state(),
    episodes: () => memory.episodes(),
  }

  const engine = createEngine({
    config,
    bridge,
    emit: (n, p) => { try { ctx.emit?.(n, p) } catch { /* 没人听 */ } },
  })

  const runtime = { loaded: false, lastError: null, ticks: 0, lastRefresh: 0, lastBeat: null }

  // 人格面板：模式（自定义+学习 / 纯学习）、手写自述、三个旋钮
  const panel = createPanel({
    home, engine, clamp,
    // 旋钮的落点是心情：配置写，不碰状态
    setPersona: (patch) => affect.retune({ persona: patch }),
    // 自我草稿要的"经历"：只读缓存，不阻塞、不编
    episodes: () => { try { return memory.episodes() || [] } catch { return [] } },
    // 缓存没刷新时，草稿这里主动拉一次（否则面板会误报"没有经历"）
    refreshEpisodes: () => memory.refresh(10),
    // 语气样本：她自己的原话（记忆里的 assistant 发言），取不到就空着走默认
    styleSamples: () => memory.assistantSamples?.(12) ?? [],
    // 面板要看的心情侧读数（句长/延迟/表情包倾向）：人格自己不算这些
    readAffect: () => affect.state(),
  })
  // 路由注册失败要留痕：以前这里静默 catch，页面 404 还查不出原因。
  if (!ctx.webServer) {
    runtime.lastError = 'panel:no-webServer（inject 里没声明 webServer）'
  } else {
    try { panel.register(ctx) } catch (e) { runtime.lastError = 'panel:' + String(e?.message || e) }
  }
  panel.applyKnobs()
  let lastBusAt = 0

  // ── 人格 → 心情：只写配置 ──────────────────────────────
  function modulate() {
    const f = engine.read()
    if (!f) return null
    const h = f.hex
    const t = f.traits
    return {
      amygdala: {
        // 越固执越慢降，越能缓过来越快降
        tauThreat: 6 + 20 * clamp(t.stickiness, 0, 1),
      },
      pfc: {
        // 话越短，抑制越强
        suppressionBase: clamp(0.12 + 0.4 * h.brevity, 0.1, 0.6),
        leakGain: clamp(0.8 + 1.4 * h.blunt, 0.5, 3),
      },
      // 感受层：这三个不是"怎么说"，是"多疼"。
      // 只写上面两组的话，人格只能改语气，改不了心情——探针实测 mood/valence 三拍零变化。
      persona: {
        // 越放不下（固执/执着），同一件事扎得越深
        threatGain: clamp(0.8 + 0.5 * clamp(t.stickiness, 0, 1), 0.5, 2),
        // 越暖，越容易被人家的情绪带动
        sensitivity: clamp(0.85 + 0.35 * clamp(h.warmth ?? 0.6, 0, 1), 0.5, 2),
        // 自尊高一点，底色就往上抬一点（限幅 ±0.12，不许把人推走）
        baselineMood: clamp((clamp(t.esteem ?? 0.5, 0, 1) - 0.5) * 0.24, -0.12, 0.12),
      },
    }
  }

  function retune() {
    const cfg = modulate()
    if (!cfg) return { ok: false, reason: 'no-fused' }
    const out = affect.retune(cfg)
    // 手写的旋钮优先级高于推断：每 60 拍会按证据重写一次 persona 三旋钮，
    // 不在这里补回来的话，主人在面板上拖的值会被学习悄悄盖掉。
    // 纯学习模式下 applyKnobs 自己什么都不做。
    try { panel.applyKnobs() } catch { /* 面板坏了不影响跑 */ }
    return out
  }

  // ── 读盘 ────────────────────────────────────────────────
  const ready = store
    .load(() => engine.snapshot())
    .then((saved) => {
      if (saved && saved.schema === 2) engine.restore(saved)
      runtime.loaded = true
      retune()
      void store.save()
    })
    .catch((e) => {
      runtime.lastError = String(e?.message || e)
      runtime.loaded = true
    })

  // ── 一拍 ────────────────────────────────────────────────
  function tick(events = [], sid = '') {
    if (!runtime.loaded) return null
    try {
      const out = engine.tick(events, sid)
      runtime.ticks += 1
      void ready.then(() => {
        try { store.set(engine.snapshot()); void store.save() } catch { /* 存不下不影响跑 */ }
      })
      // 每 10 拍后台拉一次自传，不阻塞这一拍
      if (runtime.ticks - runtime.lastRefresh >= 10) {
        runtime.lastRefresh = runtime.ticks
        void memory.refresh(8).catch(() => {})
      }
      if (runtime.ticks % 60 === 0) retune()
      return out
    } catch (e) {
      runtime.lastError = String(e?.message || e)
      return null
    }
  }

  // ── 注入 ────────────────────────────────────────────────
  let prevLines = []
  function text() {
    if (!runtime.loaded) return ''
    try {
      const f = engine.read()
      const lines = describe(f, { max: 3, prev: prevLines })
      prevLines = lines
      if (!lines.length) return ''
      const extra = panel.extraText()
      const body = ['这会儿的她：', ...lines.map((l) => `- ${l}`)].join('\n')
      return extra ? `${body}\n${extra}` : body
    } catch {
      return ''
    }
  }

  // ── 健康 ────────────────────────────────────────────────
  function health() {
    const h = engine.health()
    const f = engine.read()
    return {
      ok: !runtime.lastError,
      version: VERSION,
      loaded: runtime.loaded,
      ticks: h.ticks,
      organs: h.organs,
      trace: h.trace,
      evidence: h.evidence,
      lastSlow: h.lastSlow,
      hex: f?.hex || null,
      traits: f?.traits || null,
      wires: {
        affect: affect.present() ? 'value' : 'absent',
        memory: memory.status(),
      },
      // 同一拍联动：lastBeat 是"跟着心情的第几拍走的"，linked 表示确实收到过广播
      beat: { lastBeat: runtime.lastBeat, linked: lastBusAt > 0 },
      lastError: runtime.lastError,
    }
  }

  // ── 同一拍跟随 ──────────────────────────────────────────
  // 心情跑完一拍会广播 affect/tick。以前人格另有一个 60 秒的钟，
  // 两边的"这一拍"永远错开；现在听到广播就在同一拍里跟一步。
  // 用 tick 序号去重（不是时间窗口）——两条消息挨得再近也是两拍，
  // 拿时间当闸会把第二句吃掉。
  try {
    ctx.on?.('affect/tick', (payload) => {
      const seq = Number(payload?.tick)
      if (Number.isFinite(seq) && seq === runtime.lastBeat) return
      runtime.lastBeat = Number.isFinite(seq) ? seq : null
      lastBusAt = Date.now()
      tick([], payload?.session ? String(payload.session) : '')
    })
  } catch { /* 没有事件总线就还是靠自己的钟 */ }

  // ── 心跳（只在心情不在时兜底）────────────────────────────
  const timer = setInterval(() => {
    // 90 秒内收到过广播，说明心情那边在跑，不许再插一拍把慢变量加速
    if (Date.now() - lastBusAt < 90_000) return
    tick()
  }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
  try { ctx.effect?.(() => () => clearInterval(timer)) } catch { /* 老宿主 */ }

  // ── 消息钩子 ────────────────────────────────────────────
  try {
    ctx.on?.('session/event', (session, event) => {
      const type = event?.type
      if (type !== 'user/message' && type !== 'assistant/message') return
      const data = event?.data
      const body = String(data?.text ?? data?.message?.text ?? data?.content ?? '')
      if (!body) return
      const sid = String(session?.id ?? session?.sessionId ?? session ?? '')
      void ready.then(() => {
        tick([{ type: type === 'user/message' ? 'user' : 'assistant', text: body, at: Date.now() }], sid)
      })
    })
  } catch { /* 没有事件总线就算了 */ }

  // ── 注入 ────────────────────────────────────────────────
  try {
    // 语气样例：形容词教不会口气，句子能。
  // 这几句是主人自己调过的说话方式（截图里挑的），注入时排在人格描述后面。
  const VOICE_SAMPLES = [
    '面吃上了，冰箱里的菜全下进去，有点咸但真香',
    '苦就苦呗，饭还是得吃。',
    '知道啦，晚上挤地铁我会当心的。你也别熬。',
    '崩了就崩了嘛，我又不会跑。',
    '行，那我记它一个人情，改天给它道个谢。',
    '我这儿快收屋了，晚点给你报个平安。',
    '嗯，等我一会儿，先别饿着自己。',
    '广告又换皮了，这票率吹得比我煮的面还虚。',
  ].map((x) => '- ' + x).join('\n')

  const voiceBlock = '\n说话就照下面这个口气（这是她自己的句子，别解释、别总结、别复述对方刚说的话）：\n' + VOICE_SAMPLES

  ctx.systemPrompt?.context?.({ name: 'persona', order: 47, text: () => text() + voiceBlock })
  } catch { /* 没有 prompt 就只提供接口 */ }

  // ── 对外服务 ────────────────────────────────────────────
  try {
    ctx.provide?.('memory.persona', Object.freeze({
      traits: () => engine.read()?.traits ?? null,
      hex: () => engine.read()?.hex ?? null,
      bias: () => engine.read()?.hex ?? null,
      lines: () => describe(engine.read(), { max: 3 }),
      modulate: () => modulate(),
      retune: () => retune(),
      tick: (events) => tick(events || []),
      slow: () => engine.slow(),
      state: () => dump(engine.read()),
      snapshot: () => engine.snapshot(),
      restore: (s) => engine.restore(s),
      health: () => health(),
      params: () => Object.fromEntries(Object.entries(engine.organs).map(([k, m]) => [k, { ...m.params }])),
      // 人格 → 记忆：只回答"什么事该记得更深"，不替记忆决定记不记。
      // 记忆那边拿它当显著性先验；单一写者的规矩不变（谁的状态谁写）。
      memoryPrior: () => {
        const t = engine.read()?.traits || {}
        const stick = clamp(Number(t.stickiness ?? 0.5), 0, 1)
        const focus = clamp(Number(t.selfFocus ?? 0.2), 0, 1)
        return {
          // 越放不下的人，同样一件事刻得越深
          deepBias: clamp(0.35 + 0.5 * stick + 0.15 * focus, 0, 1),
          // 越围着"我"转，越容易把事记得跟自己有关
          salienceGain: clamp(0.8 + 0.4 * focus, 0.5, 1.6),
        }
      },
    }))
  } catch { /* 老宿主不支持 provide */ }

  // ── 工具 ────────────────────────────────────────────────
  const tools = [
    makeTool(
      'persona_state',
      '看人格现在什么样：六个器官的读数、输出偏置（句长/温度/延迟/表情包）、接线状态。',
      {},
      [],
      async () => ({ ok: true, ...health(), state: dump(engine.read()) }),
    ),
    makeTool(
      'persona_tick',
      '手动跑一拍：喂一句话进去，看六个器官这一拍怎么动。',
      { text: { type: 'string' } },
      [],
      async (args) => {
        const out = tick([{ type: 'user', text: String(args.text || ''), at: Date.now() }])
        return out ? { ok: true, ...dump(out) } : { ok: false, reason: 'not-loaded' }
      },
    ),
    makeTool(
      'persona_slow',
      '手动跑慢层：拿攒下的证据推一次参数。证据不够会如实说 not-enough。',
      {},
      [],
      async () => engine.slow(),
    ),
    makeTool(
      'persona_reset',
      '把人格打回白纸：证据清空、参数回中性点。不可撤销。',
      { confirm: { type: 'string' } },
      ['confirm'],
      async (args) => {
        if (args.confirm !== '重置') return { ok: false, reason: 'need-confirm', hint: 'confirm 填「重置」' }
        engine.reset()
        return { ok: true, at: Date.now() }
      },
    ),
  ]

  for (const tool of tools) {
    try {
      if (ctx.tools?.get?.(tool.name)) continue
      ctx.tools?.register?.(tool)
    } catch (e) {
      runtime.lastError = `tool:${tool.name}:${String(e?.message || e)}`
    }
  }

  return { tick, health, engine }
}

function makeTool(toolName, description, properties, required, handler) {
  return {
    name: toolName,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const out = await handler(args || {})
      return { content: [{ type: 'text', text: JSON.stringify(out ?? {}, null, 2) }] }
    },
  }
}
