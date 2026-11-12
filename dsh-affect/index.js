// 插件入口：挂心跳（A/B 两段）、读盘、注入、面板、工具。
// 单包，15 个模块。

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createEngine } from './core/engine.js'
import { createBridge } from './core/bridge.js'
import { pickLegacy } from './core/inherit.js'
import { summarize, dashboardHtml } from './core/dashboard.js'
import { createStore } from './core/store.js'
import { VERSION } from './core/consts.js'

// 把宿主各种形状的消息体挑成字符串。
// 以前这里写的是 String(data?.text ?? ...)，data.text 是对象时就被转成 "[object Object]"，
// 于是心情看不见原话、记忆也存进垃圾摘要。
function textOfData(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(textOfData).filter(Boolean).join('')
  if (typeof v === 'object') return textOfData(v.text ?? v.content ?? v.parts ?? v.message?.content ?? v.message)
  return ''
}

export const name = 'dsh-affect'
// 少了 webServer 的话，ctx.webServer 是 undefined，路由会被静默跳过 → 页面 404
export const inject = ['systemPrompt', 'webServer']

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 只读四个记忆器官：拿不到就是 null，情绪照跑
  const bridge = createBridge((id) => {
    try { return ctx.get?.(id) ?? null } catch { return null }
  })
  const engine = createEngine({
    persona: config.persona || {},
    bridge,
    emit: (name, payload) => { try { ctx.emit?.(name, payload) } catch { /* 没人听 */ } },
  })

  // 首次启动：继承旧心情插件的最后一帧（只这一次，之后按新内核自己演化）
  const inheritOnce = () => {
    if (engine.state.inherited) return
    const legacy = pickLegacy(home)
    engine.state.inherited = legacy
      ? { ...legacy.meta, ok: true }
      : { ok: false, at: new Date().toISOString(), reason: 'no mood-v2 state' }
    if (legacy) {
      engine.restore({ schema: 1, mood: legacy.mood, organs: legacy.organs })
      try { ctx.logger?.info?.(`[affect] 继承旧心情：valence=${legacy.mood.toFixed(2)}`) } catch { /* 没有 logger */ }
    }
  }
  const store = createStore(home)

  let loaded = false
  const ready = store.load(() => engine.snapshot()).then((saved) => {
    if (saved && saved.schema === 1) engine.restore(saved)
    // 继承旧心情只在第一次做：把旧插件的最后一帧当初始状态，之后按新内核演化
    if (!engine.state.inherited) {
      inheritOnce()
      try { store.set(engine.snapshot()); void store.save() } catch { /* 存不下不影响跑 */ }
    }
    loaded = true
  })

  function tick(events = [], sessionId = '') {
    const out = engine.tick(events, sessionId)
    void ready.then(() => { store.set(engine.snapshot()); return store.save() })
    // 同一拍广播：人格要"这一拍算完的心情"，不能靠它自己那个 60 秒定时器碰运气。
    // 只在真正跑完一拍之后发，payload 带上一拍的序号，接收方好判断有没有漏拍。
    try {
      ctx.emit?.('affect/tick', { at: Date.now(), tick: engine.state.ticks, session: sessionId })
    } catch { /* 没人听就算了 */ }
    return out
  }

  function text() {
    if (!loaded) return ''
    try { return engine.text() } catch { return '' }
  }

  // 唯一时钟
  const timer = setInterval(() => { try { tick() } catch { /* 单拍失败不阻塞 */ } }, engine.persona.tickMs)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect?.(() => () => clearInterval(timer))

  // 消息进来立刻跑一拍
  ctx.on?.('session/event', (session, event) => {
    const type = event?.type
    if (type !== 'user/message' && type !== 'assistant/message') return
    const data = event?.data
    const body = textOfData(data).trim()
    if (!body) return
    // 会话 id 要一路带到记忆桥：情绪写回时挂在这条消息所在的会话上，否则注入和检索看不见
    const sid = String(session?.id ?? session?.sessionId ?? session ?? '')
    void ready.then(() => {
      const ev = { type: type === 'user/message' ? 'user' : 'assistant', text: body, at: Date.now() }
      if (ev.type === 'assistant') engine.markSpoke()
      tick([ev], sid)
    })
  })

  ctx.systemPrompt?.context?.({ name: 'affect', order: 46, text })

  // 给别的插件读的接口：表情包怎么发，由她的心情决定
  try {
    ctx.provide?.('affect.io', {
      memeHint: () => engine.organs.io.read().meme ?? null,
      read: () => summarize(engine),
      mood: () => engine.state.mood,
    })
  } catch { /* 老版本没有 provide */ }

  try {
    ctx.webServer?.register?.({
      path: '/affect/live',
      handler: async (req, res) => {
        await ready
        // 面板被打开 = 时间在走：先补一拍空心跳，让慢变量按真实间隔衰减
        try { engine.tick([]) } catch { /* 心跳失败不影响读数 */ }
        const payload = summarize(engine)
        // summarize 里的 text 是缓存/另一条渲染，之前一直是空的：
        // 这里直接用引擎当场渲染的那段，才是真正注入给她的文字
        try {
          payload.text = engine.text()
        } catch (e) {
          // 渲染失败就把错误吐出来，别静悄悄留个空字符串装作没事
          payload.text = ''
          payload.textError = String(e?.message || e)
        }
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      },
    })
    ctx.webServer?.register?.({
      path: '/affect/dashboard',
      handler: async (req, res) => {
        await ready
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(dashboardHtml())
      },
    })
    ctx.webServer?.register?.({
      path: '/affect/stats',
      handler: async (req, res) => {
        await ready
        const u = new URL(req.url, 'http://x')
        const days = Math.max(1, Math.min(365, Number(u.searchParams.get('days')) || 7))
        const archive = u.searchParams.get('archive')
        const archiveResult = archive === 'invalid' && bridge?.archiveInvalid ? bridge.archiveInvalid() : null
        const f = engine.read() || {}
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          ok: true,
          windowDays: days,
          writebacks: bridge?.stats ? { ...bridge.stats(days), source: 'affect-notes' } : null,
          // 别名：人格层看到的应该是"我自己本子里的情绪样本数"，别和她的 episode 数混
          writebackSamples: bridge?.stats ? bridge.stats(days).n : 0,
          archive: archiveResult,
          // 记忆侧的长期情绪统计：人格层只读这一个口就够了，不用记两个数据源
          memory: bridge?.memoryTrend ? bridge.memoryTrend(days) : null,
          now: {
            mood: Number((engine.state.mood ?? 0).toFixed(3)),
            emotions: (f.emotions ?? []).slice(0, 3).map(e => ({ kind: e.kind, intensity: Number((e.intensity ?? 0).toFixed(2)) })),
            trust: Number((f.trust ?? 0).toFixed(3)),
            arousal: Number((f.arousal ?? 0).toFixed(3)),
            echo: (f.memoryEcho?.hits ?? []).map(h => h.brief).slice(0, 3),
            echoSource: f.memoryEcho?.source ?? null,
          },
        }, null, 1))
      },
    })
    ctx.webServer?.register?.({
      path: '/affect/recall',
      handler: async (req, res) => {
        await ready
        const u = new URL(req.url, 'http://x')
        const q = String(u.searchParams.get('q') || '').slice(0, 200)
        const f = engine.read()
        const valence = Number(u.searchParams.get('valence') ?? engine.state.mood) || 0
        const t0 = Date.now()
        const pr = q && bridge?.probe ? bridge.probe(q, { valence, arousal: Number(engine.state.arousal) || 0 }) : { stage: 'no-query', hits: [] }
        const ms = Date.now() - t0
        const ranked = pr.hits?.length && bridge?.moodRerank ? bridge.moodRerank(pr.hits, valence, { degraded: pr.degraded }) : (pr.hits ?? [])
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          ok: pr.stage === 'ok',
          q,
          valence,
          stage: pr.stage,
          degraded: pr.degraded ?? null,
          valenceReady: pr.valenceReady ?? null,
          ms,
          hits: ranked.map(h => ({ id: h.id, brief: h.brief, valence: h.valence, score: Number(h.score || 0).toFixed(4) })),
          moodNow: Number((f?.mood ?? 0).toFixed(3)),
        }, null, 1))
      },
    })
    ctx.webServer?.register?.({
      path: '/affect/state',
      handler: async (req, res) => {
        await ready
        if (!engine.read()) tick()
        const f = engine.read()
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({
          ok: true, version: VERSION,
          at: new Date().toISOString(),
          mood: Number(engine.state.mood.toFixed(3)),
          fused: f,
          memoryCaps: bridge?.capabilities?.() ?? null,
          organs: engine.health(),
          trace: engine.trace.slice(-12),
        }, null, 1))
      },
    })
    ctx.webServer?.register?.({
      path: '/affect/trace',
      handler: async (req, res) => {
        await ready
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ trace: engine.trace.slice(-100) }))
      },
    })
  } catch { /* 没有 webServer 就只注入 */ }

  try {
    ctx.provide?.('affect.core', Object.freeze({
      read: () => engine.read(),
      text: () => text(),
      mood: () => engine.state.mood,
      poke: (t) => tick([{ type: 'user', text: String(t || ''), at: Date.now() }]),
      scene: (s) => engine.setScene(String(s || 'home')),
      cover: () => engine.cover(),
      // 写回真相：attempted / landed / failed。
      // 谁要判断"情绪真的进记忆了没有"看这里——不要看 wrote:true，
      // 那只是"账本追加成功"，不等于记忆收下了。
      writeback: () => bridge.writebackTruth(),
      // 人格层回写参数：只动 params 对象，不碰状态，不重建器官
      retune: (cfg) => {
        let n = 0
        for (const [id, patch] of Object.entries(cfg || {})) {
          if (!patch) continue
          // persona 是"感受层"的三个旋钮（threatGain/baselineMood/sensitivity），
          // 住在引擎的 p 上，不在任何器官的 params 里。数值在这里夹一次，
          // 人格那边算错也不会把心情推到离谱的地方。
          if (id === 'persona') {
            const p = engine.personaParams?.()
            if (!p) continue
            const clamp = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : null)
            const g = clamp(patch.threatGain, 0.5, 2)
            const s = clamp(patch.sensitivity, 0.5, 2)
            const b = clamp(patch.baselineMood, -0.2, 0.2)
            if (g !== null) p.threatGain = g
            if (s !== null) p.sensitivity = s
            if (b !== null) p.baselineMood = b
            n += 1
            continue
          }
          const organ = engine.organs?.[id]
          if (!organ?.params) continue
          try { Object.assign(organ.params, patch); n += 1 } catch { /* 单个失败不影响别的 */ }
        }
        return { ok: true, organs: n }
      },
    }))
  } catch { /* 老宿主不支持就算了 */ }
}
