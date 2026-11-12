// 心跳引擎：单一时钟、A/B 两段、同一帧读、补算反转、资源池、回滚。
// 五个器官 + 三层 + 四补充 + 时间 + IO，共 15 个模块。

import { clamp, rng, hash } from './consts.js'
import { fuse } from './fuse.js'
import { render, COVER as INJECT_COVER } from './inject.js'
import { createResources } from './resource.js'
import { analyzeMessage, buildContext } from './context.js'

import { create as amygdala } from '../organs/amygdala.js'
import { create as hypothalamus } from '../organs/hypothalamus.js'
import { create as insula } from '../organs/insula.js'
import { create as hippocampus } from '../organs/hippocampus.js'
import { create as pfc } from '../organs/pfc.js'
import { create as neuromod } from '../layers/neuromod.js'
import { create as attention } from '../layers/attention.js'
import { create as social } from '../layers/social.js'
import { create as brainstem } from '../supplements/brainstem.js'
import { create as dmn } from '../supplements/dmn.js'
import { create as endocrine } from '../supplements/endocrine.js'
import { create as sickness } from '../supplements/sickness.js'
import { create as curve } from '../time/curve.js'
import { create as rhythm } from '../time/rhythm.js'
import { create as bias } from '../io/bias.js'
import { create as output } from '../io/output.js'

export const PERSONA_DEFAULT = {
  moodBase: 0.1, tauMoodH: 0.75, moodCap: 0.75,
  tickMs: 60_000, injectMaxLines: 7,
}

// 正常顺序：身体 → 调质 → 感受 → 记忆 → 偏置 → 社会 → 注意 → 走神 → 调节 → 曲线 → 节律 → 输出
const ORDER_B = [
  'amygdala',
  'hypothalamus', 'brainstem', 'endocrine', 'sickness', 'neuromod',
  'insula', 'hippocampus', 'bias', 'social', 'attention', 'dmn',
  'pfc', 'curve', 'rhythm', 'io',
]
// 补算顺序（X03）：慢的先行，避免快器官拿旧身体点火
const ORDER_COMP = [
  'hypothalamus', 'brainstem', 'endocrine', 'sickness', 'amygdala', 'rhythm',
  'dmn', 'hippocampus', 'neuromod', 'bias', 'social', 'attention',
  'insula', 'pfc', 'curve', 'io',
]

const DEFAULTS = {
  amygdala: { frame: 0, threat: 0.05, rewardPE: 0, novelty: 0, salience: 0.1, ne: 0.1, cort: 0.1, sensMax: 1, freeze: 0, kind: 'neutral', cue: '', context: {}, safety: {} },
  hypothalamus: { frame: 0, body: { hr: 70, hrv: 60, breath: 14, gut: 0, temp: 0, tension: 0.3, pain: 0 }, needs: {}, hpa: { cortisol: 0.15, ne: 0.1 }, rhythm: { energy: 0.6, moodBias: 0, thresholdShift: 0 }, sleepDebt: 0.2, bandwidthCap: 0.7, autonomic: { sym: 0.3, par: 0.6 }, hormones: {}, aggression: 0.1, cycle: { on: false, day: 14 }, stimulant: 0 },
  insula: { frame: 0, felt: { intensity: 0, qualities: [], location: '', precision: 0.5 }, disgust: 0, resonance: 0, mislabel: 0.2, craving: 0, wait: 0, risk: 0.2, bodySelf: 0.5, awareness: 0.5, bodyBudget: 1 },
  hippocampus: { frame: 0, recall: null, count: 0, encodes: 0, schemas: [], persons: {}, nostalgia: 0, recent: [] },
  pfc: { frame: 0, bandwidth: 0.6, cap: 0.8, load: 0.2, fatigue: 0.1, slots: 4, display: { mask: 0.3, toneShift: 'normal', brevity: 0.3, leakRisk: 0.2, rules: 0.7 }, attribution: { locus: 'circumstance', stability: 'temporary', globality: 'specific', blame: '环境', confidence: 0.5 }, reappraisal: { success: false }, conflict: 0, decision: {}, pfcGain: 0.5, repair: 0, regret: 0, labeling: 0, timePressure: 0 },
  neuromod: { frame: 0, ne: 0.3, da: 0.5, serotonin: 0.5, ach: 0.4, oxytocin: 0.35, vasopressin: 0.3, opioid: 0.3, endocannabinoid: 0.2, gain: 1 },
  attention: { frame: 0, gate: 1, focus: 0.4, salienceNet: 0.2, narrowing: 0, sticky: 0, onBody: 0.3, target: 'chat' },
  social: { frame: 0, selfOther: 0.7, mindRead: 0.5, affectiveEmpathy: 0.5, cognitiveEmpathy: 0.5, socialPain: 0, attachment: 'secure', status: 0.5, contagionOut: 0, empathyFatigue: 0, attitude: {}, trust: 0.6, otherFelt: 0, similarity: 0.6, comfort: 0, relationship: 'close', ledgerOpen: 0 },
  brainstem: { frame: 0, respiration: 14, heartRate: 70, arousal: 0.4, startle: 0, coupling: 0.5 },
  dmn: { frame: 0, mindWander: 0, selfThought: 0.2, rumination: 0, mentalTime: 0.3, socialImagining: 0.2, idleMs: 0 },
  endocrine: { frame: 0, cortisol: 0.15, oxytocin: 0.35, estrogen: 0.5, testosterone: 0.5, thyroid: 0.6 },
  sickness: { frame: 0, inflammation: 0, fatigue: 0, withdraw: 0, hyperalgesia: 0 },
  curve: { frame: 0, phase: 'peak', intensity: 0.1, refractory: false, ambivalence: 0, secondPeak: 0 },
  rhythm: { frame: 0, weekly: 0, seasonal: 0, drift: 0, bias: 0 },
  bias: { frame: 0, neg: 0, hostile: 0, congruent: 0 },
  io: { frame: 0, brevity: 0.3, punctuation: 'normal', replyDelayMs: 0, memeTendency: 0.5, voice: { rate: 1, volume: 1 }, leak: 0, venting: 0, seekComfort: 0, selfReportGap: 0, labeled: 0 },
}

export function createEngine({ persona = {}, now = () => Date.now(), bridge = null, emit = null } = {}) {
  const p = { ...PERSONA_DEFAULT, ...persona }
  // 时钟兜底：外部传进来的 now 可能返回 NaN，存档里的 at 不能再被写成 NaN/null
  const clockNow = () => {
    try { const v = Number(now()); if (Number.isFinite(v)) return v } catch { /* 落到下面 */ }
    return Date.now()
  }
  const organs = {
    amygdala: amygdala(), hypothalamus: hypothalamus({ cycle: persona.cycle }), insula: insula(),
    hippocampus: hippocampus(), pfc: pfc(),
    neuromod: neuromod(), attention: attention(), social: social(),
    brainstem: brainstem(), dmn: dmn(), endocrine: endocrine(), sickness: sickness(),
    curve: curve(), rhythm: rhythm(), bias: bias(), io: output(),
  }
  const res = createResources()
  const state = { mood: p.moodBase, at: now(), ticks: 0, lastText: '', scene: 'home', gapMs: 0, other: 0 }
  const trace = []
  const cache = new Map()
  const lastKnown = new Map()
  const seenEvents = new Map()
  let fused = null
  let busy = false

  const world = {
    tx: null,
    get(id) { return cache.get(id) ?? lastKnown.get(id) ?? DEFAULTS[id] ?? null },
    res,
    limits: null,
    scene: 'home',
    mood: state.mood,
    gapMs: 0,
    other: 0,
    spoke: false,
    labeled: false,
    rng: () => 0.5,
    emotions: [],
    activity: '',
  }

  function stepOne(id, tx) {
    const m = organs[id]
    if (!m) return
    const before = safeSnapshot(m)
    try {
      m.step(world)
      const r = m.read()
      cache.set(id, r)
      lastKnown.set(id, r)
    } catch (e) {
      // X12：只回滚抛错的那个模块
      try { m.restore(before) } catch { /* ignore */ }
      trace.push({ error: id, msg: String(e?.message || e) })
    }
  }

  function tick(events = [], sessionId = '') {
    // X10：单飞锁，绝不并发
    if (busy) return fused
    busy = true
    try {
      const t1 = now()
      const dtMs = clamp(t1 - state.at, 0, 24 * 3600_000)
      // K07 幂等：同一条消息 30 秒内不重复计
      const uniq = []
      for (const e of events) {
        const key = `${e.type}:${hash(String(e.text || ''))}`
        const last = seenEvents.get(key) || 0
        if (t1 - last < 30_000) continue
        seenEvents.set(key, t1)
        uniq.push(e)
      }
      if (seenEvents.size > 200) seenEvents.clear()
      const tx = { txId: `tx_${state.ticks + 1}`, t0: state.at, t1, dtMs, seed: 20261110 + state.ticks, events: uniq }
      // C08：间隔只对"对方的行为"计时，不把自己的延迟算进去
      // 把这一拍的对话转给记忆侧（宿主事件在 web 会话里没送达，只能从这条稳的路补）
      try {
        for (const ev of uniq) {
          if (!ev || !ev.text) continue
          bridge?.noteText?.(sessionId || ev.sessionId || '', ev.type, ev.text, ev.at)
        }
      } catch { /* 记忆侧不在就当没有 */ }

      if (events.some(e => e.type === 'user')) { state.gapMs = 0; state.lastUserAt = t1 }
      else if (state.lastUserAt) state.gapMs = t1 - state.lastUserAt
      cache.clear()
      world.tx = tx
      // 场景按时间推断（A06 情境恐惧要用）
      const hr = new Date(t1).getHours()
      state.scene = hr >= 23 || hr < 6 ? 'night' : state.scene === 'night' ? 'home' : state.scene
      world.scene = state.scene
      // 对方状态：从这一轮的话里读（S03/S09/共情共振要用）
      state.other = uniq.some(e => /难受|崩溃|哭了|失眠|压力大|烦死|好累/.test(String(e.text || ''))) ? 0.7 : 0
      world.other = state.other
      // 这一拍用户说了什么，要在合成之前就让 fuse 看见：
      // 以前 lastUserText 是这一拍后半段才写进去的，导致"她对这句话的判断"总是晚一拍。
      const _u = uniq.filter((e) => e.type === 'user').map((e) => String(e.text || '')).join(' ').trim()
      world.lastUserText = _u
      // 被指出做错、被反复返工：这一条以前完全不进评价，所以整晚返工她一点都不烦。
      const _fail = /不对|错了|还是不行|没修好|没生效|怎么又|说了几次|又错|骗我|糊弄|假\u7684|白改/.test(String(_u || ''))
      state.failStreak = _fail
        ? Math.min(4, Number(state.failStreak || 0) + 1)
        : Math.max(0, Number(state.failStreak || 0) * 0.5)
      world.spoke = false
      world.mood = state.mood
      world.gapMs = state.gapMs
      world.emotions = fused?.emotions ?? []
    stepOne('io', tx)
      // X04：抑制增益只对下一帧生效
      world.prevGain = lastKnown.get('pfc')?.display ? (lastKnown.get('pfc')?.pfcGain ?? 0.5) : 0.5
      const t0ms = Date.now()

      res.step(dtMs)
      world.rng = rng(tx.seed, 'pfc', state.ticks)
      world.limits = {
        inhibit: Math.min(res.read().total, res.read().sub.inhibit),
        attention: Math.min(res.read().total, res.read().sub.attention),
        empathy: Math.min(res.read().total, res.read().sub.empathy),
        will: Math.min(res.read().total, res.read().sub.will),
      }

      // A 段：先反应
      if (dtMs > 600_000) {
        stepOne('hypothalamus', tx)
        stepOne('brainstem', tx)
      }
      // 上下文：这句是新消息，但她的反应取决于最近几轮在说什么
      const lastUser = uniq.filter(e => e.type === 'user').slice(-1)[0]
      const currentFeatures = lastUser ? analyzeMessage(lastUser.text) : null
      if (currentFeatures && lastUser) {
        state.recent = [...(state.recent || []), { text: String(lastUser.text).slice(0, 60), at: t1, features: currentFeatures }].slice(-8)
        state.lastUserText = String(lastUser.text).slice(0, 60)
      }
      const context = buildContext(state.recent || [], currentFeatures || {})
      world.context = context
      // 多轮配对：上一问一答留着，才能"上一条说重了、这一条软一点"
      const lastAst = uniq.filter(e => e.type === 'assistant').slice(-1)[0]
      if (lastAst) state.lastAssistantText = String(lastAst.text ?? '').slice(0, 120)
      if (lastUser) {
        const prevUser = String(state.prevUserText || '')
        const prevAnswer = String(state.lastAssistantText || '')
        const txt = String(lastUser.text ?? '')
        world.pair = {
          prevUserLen: prevUser.length,
          nowUserLen: txt.length,
          prevAnswerLen: prevAnswer.length,
          shorter: prevUser.length > 0 && txt.length < prevUser.length * 0.6,
          softening: /对不起|抱歉|是我|我错|别生气|求你|好吧|算了/.test(txt),
          escalating: /又|还是|到底|说了几遍|怎么还|不是说了/.test(txt),
          answeredShort: prevAnswer.length > 0 && prevAnswer.length < 12,
        }
        state.prevUserText = txt.slice(0, 120)
      } else {
        world.pair = null
      }
      let memoryEcho = null
      if (bridge) {
        const qText = lastUser ? String(lastUser.text ?? '') : ''
        // 时间单位必须归一：消息带的 at 可能是秒，beforeMs 必须是毫秒。
        // 单位错了的后果很隐蔽——beforeMs 变成 1.7e9，而 episode.start 是毫秒（1.7e12），
        // "start >= beforeMs" 把**所有**旧事都滤掉，于是每一拍都是 empty-hits、回声永远空。
        const rawAt = lastUser ? Number(lastUser.at) : NaN
        const qAt = Number.isFinite(rawAt) ? (rawAt < 1e12 ? rawAt * 1000 : rawAt) : t1
        // 回声必须属于"这一句"。按**文字**认，不按时间戳认：
        // 同一句话重复出现时，上一拍异步捞到的结果应该能接着用；
        // 按时间戳认等于每说一遍都从零开始（异步永远追不上）。
        if (!lastUser || (state.memoryEchoCache && state.memoryEchoCache.queryText === qText)) {
          memoryEcho = state.memoryEchoCache || null
        }
        if (lastUser) {
          // 先试同步粗召回（记忆侧有 recallSync 时，这一拍就能用上，不再隔一拍）
          let fast = null
          try {
            // 不传 beforeMs：那本来只是"别把这一句自己捞回来"的优化，
            // 但记忆侧的时间轴和这里的 at 不保证同一把尺子，传错一次就把整库滤空
            // （实测就是：直接问命中 3 条，进真实对话永远 empty-hits）。
            // 这一句还没入 episode，不传也不会自己想起自己。
            fast = bridge.recallFast
              ? bridge.recallFast(lastUser.text, { valence: Number(fused?.valence ?? state.mood), arousal: Number(state.arousal) || 0, beforeMs: qAt - 1 })
              : null
          } catch { fast = null }
          if (fast && !fast.degraded && fast.hits?.length) {
            // 同步命中必须和这句话有字面重叠（记忆侧的 keep() 就是这么挡的）。
            // 假记忆不挡，这里补一道；降级的命中不参与这条规则。
            const qc2 = String(qText).replace(/[\s\p{P}]/gu, '')
            const grams2 = new Set()
            for (let i = 0; i + 1 < qc2.length; i += 1) grams2.add(qc2.slice(i, i + 2))
            const related = (h) => {
              const b = String(h?.brief || '')
              for (const g of grams2) if (b.includes(g)) return true
              return false
            }
            const kept2 = fast.hits.filter(related)
            if (!kept2.length) fast = null
            else fast = { ...fast, hits: kept2 }
          }
          if (fast && fast.hits?.length) {
            const ranked = bridge.moodRerank
              ? bridge.moodRerank(fast.hits, Number(fused?.valence ?? state.mood), { degraded: fast.degraded })
              : fast.hits
            const tone = ranked.reduce((s, h) => s + (Number(h.valence) || 0), 0) / ranked.length
            // 回声轮换：命中集往往稳定（BM25 头部永远是那几条旧事），
            // 直接取前 3 会让"记忆回声"几个月不变。给它一个游标，
            // 每条新消息从下一名开始取 3 条 —— 都是相关的，但不会僵在同一组。
            const rot = Number(state.echoCursor || 0) + 1
            state.echoCursor = rot
            const n = ranked.length
            const rotated = n > 3
              ? Array.from({ length: n }, (_, i) => ranked[(rot + i) % n])
              : ranked
            state.memoryEchoCache = { hits: rotated.slice(0, 3), tone, degraded: fast.degraded, valenceReady: fast.valenceReady, source: 'sync', at: t1, queryAt: qAt, queryText: qText }
            memoryEcho = state.memoryEchoCache
          } else if (!(state.memoryEchoCache && state.memoryEchoCache.queryText === qText)) {
            // 这一句真的没想起什么：清掉旧的，别拿上一句冒充。
            // 但如果缓存正是**这一句**异步捞回来的，不能清。
            state.memoryEchoCache = null
          }
          // empty-hits 是"确实想不起来"的确定结论：这时不许再拿异步兜底，
          // 否则松散检索会把不相关的事塞进这一句，等于给她安错记忆。
          const stage = bridge.fastStage ? bridge.fastStage() : null
          // 同步那条路"降级/没装/出错"时，它返回空不等于"想不起来"，这时才退回异步。
          // 反过来：stage==='empty-hits' 是记忆侧**确定**的"这一句想不起什么"
          // （它用字面重叠做硬检查防编造），这时绝不能拿异步的松散结果顶上，
          // 否则任何一句话都会被塞进同一组旧事——面板看起来就"永远那三条"。
          const degraded = !fast || fast.degraded === true || stage == null ||
            stage === 'ok-false' || stage === 'degraded' || stage === 'index-not-loaded' || stage === 'threw'
          if (stage !== 'empty-hits' && degraded) {
            try {
              Promise.resolve(bridge.recallAsync ? bridge.recallAsync(lastUser.text) : bridge.recall(lastUser.text))
                .then(hit => {
                  // 同步已经拿到结果就别覆盖：异步只是兜底。
                  // 抢着覆盖等于把同拍结果又降回"隔一拍"。
                  if (!hit || state.memoryEchoCache?.source === 'sync') return
                  state.memoryEchoCache = { ...hit, source: 'async', at: t1, queryAt: qAt, queryText: qText }
                }).catch(() => {})
            } catch { /* 忽略 */ }
          }
          try {
            const s = bridge.salience(lastUser.text)
            if (s != null) world.memorySalience = s
          } catch { /* 忽略 */ }
        }
      }
      // 每 10 拍拉一次"最近记忆里发生了什么"（只读 episodes，异步，不阻塞这一拍）
      if (bridge && state.ticks % 10 === 0 && typeof bridge.recentEpisodes === 'function') {
        Promise.resolve(bridge.recentEpisodes(6, 5)).then(list => { if (list) state.memoryRecent = list }).catch(() => {})
      }
      world.memoryEcho = memoryEcho
      // 本拍同步没拿到、但异步在同一拍里回来了（或上一拍留下的同一句还没用过）：
      // 读的时候再取一次。以前异步结果只写进 cache，从没被读出去过。
      if (!world.memoryEcho && state.memoryEchoCache?.hits?.length) {
        world.memoryEcho = state.memoryEchoCache
      }
      // 图式：从记忆皮层挑几条高置信度的概念，当作"她已经认定了的事"。
      // 以前这一格只看心情自己的本地 schemas（要同一个 cue 攒够 3 次），
      // 事实上永远不会出现 —— 面板上那行就永远是 —。
      if (bridge && typeof bridge.schemas === 'function') {
        const qs = lastUser ? String(lastUser.text ?? '') : String(state.lastUserText || '')
        try {
          const sc = bridge.schemas(qs, 3)
          if (Array.isArray(sc)) world.memorySchemas = sc
          // 诊断要和取数同一个实例，否则面板会读到另一个 bridge 的空调试
          if (typeof bridge.schemaDebug === 'function') world.memorySchemaDebug = bridge.schemaDebug()
        } catch { /* 图式取不到不影响这一拍 */ }
      }
      world.memoryRecent = state.memoryRecent || null
      try {
        organs.amygdala.fast(world)
      } catch (e) {
        trace.push({ error: 'amygdala.fast', msg: String(e?.message || e) })
      }
      cache.set('amygdala', organs.amygdala.read())
      lastKnown.set('amygdala', cache.get('amygdala'))

      // B 段：后解释
      const hipBefore = lastKnown.get('hippocampus')?.count ?? 0
      const order = dtMs > 600_000 ? ORDER_COMP : ORDER_B
      for (const id of order) {
        if (dtMs > 600_000 && (id === 'hypothalamus' || id === 'brainstem')) continue
        stepOne(id, tx)
      }

      // X08：情景延迟落库（等归因出来再提交）
      for (const m of Object.values(organs)) { try { m.commit?.() } catch { /* 单个失败不影响 */ } }

      // 时间过去：几个"慢变量"也要松一档。
      // 它们原来只在有事件时被驱动，安静下来就永远卡在 100（戒备/反刍/念头黏住），
      // 连带着心情一直被按在低位。这里按 dt 衰减，没消息的时候也会慢慢回落。
      try {
        const relax = 1 - Math.exp(-(dtMs / 60_000) / 10) // 10 分钟量级（主人指定的手感）
        const loose = [
          ['social', { trust: 0.6 }],
          ['attention', { sticky: 0 }],
          ['dmn', { rumination: 0 }],
        ]
        for (const [id, targets] of loose) {
          const organ = organs[id]
          if (!organ?.snapshot || !organ?.restore) continue
          const snap = organ.snapshot()
          let touched = false
          for (const [key, goal] of Object.entries(targets)) {
            const cur = Number(snap?.[key])
            if (!Number.isFinite(cur)) continue
            const next = cur + (goal - cur) * relax * 0.5
            if (Math.abs(next - cur) > 1e-4) { snap[key] = next; touched = true }
          }
          if (touched) organ.restore(snap)
        }
      } catch { /* 衰减失败不影响这一拍 */ }

      state.ticks += 1
      state.at = Number.isFinite(t1) ? t1 : clockNow()
      fused = fuse(world, state.mood, p)
      // 中性话这一拍：留着的情绪只是余温，标在最终返回对象上（fuse 内部标的是局部数组）
      try {
        const u = String(world.lastUserText || '')
        const neutralTurn = u.length > 0 && !/烦|累死|崩溃|垃圾|废物|重写|谢谢|厉害|棒|辛苦|真是绝了|你可真行|呵呵|好家伙|抱歉|对不起|我说重了/.test(u)
        if (neutralTurn && Array.isArray(fused.emotions)) {
          fused.emotions = fused.emotions.map((e) => ({ ...e, from: 'linger' }))
        }
      } catch { /* 标记失败只影响"新/旧"判定 */ }
      // io 在 fuse 之前跑，表情包拿的是上一拍的情绪；这里用当拍情绪补算一次，
      // 否则"被骂那一拍还在按旧情绪挑表情"。
      try {
        world.emotions = fused?.emotions ?? []
        stepOne('io', tx)
        // 让注入和面板读到的表情包跟 io 当拍的值一致（之前注入拿的是上一拍的 meme）
        const ioNow = organs.io?.read?.()
        if (ioNow) {
          fused.io = ioNow
          if (ioNow.meme) fused.meme = ioNow.meme
        }
      } catch { /* 补算失败就沿用上一拍，不影响其他器官 */ }
      // 记忆对心情的影响：想起的事会拽一下底色（只拽一点，不许翻盘）
      // 返工累积：越被反复指出做错，越烦；这条直接进情绪表，面板上看得见
      const _fs = Number(state.failStreak || 0)
      if (_fs >= 1) {
        const tone = Math.min(0.45, 0.12 * _fs)
        fused.valence = clamp(Number(fused.valence || 0) - tone * 0.35, -1, 1)
        fused.moodTarget = clamp(Number(fused.moodTarget || 0) - tone * 0.5, -1, 1)
        if (_fs >= 2) {
          const list = Array.isArray(fused.emotions) ? fused.emotions.slice() : []
          list.unshift({ kind: '烦', intensity: Math.min(0.8, 0.35 + 0.15 * _fs), from: 'rework' })
          fused.emotions = list.slice(0, 3)
        }
      }

      if (memoryEcho) {
        fused.memoryEcho = memoryEcho
        fused.moodTarget = clamp(fused.moodTarget + 0.12 * memoryEcho.tone, -1, 1)
        fused.valence = clamp(fused.valence + 0.05 * memoryEcho.tone, -1, 1)
      }
      // 多轮配对跟记忆无关：没想起旧事，也得知道上一句刚说过什么
      fused.pair = world.pair || null

      // 回告记忆侧 + 情绪写回：必须在 fuse 之后。
      // 编码那一步（hippocampus.step）里的 w.emotions 是上一帧的 fused，
      // 所以账本里的 kind 要么空、要么是上一句的标签。这里用"这一帧"的情绪盖章。
      if (bridge && typeof bridge.announce === 'function') {
        const nowCount = organs.hippocampus.read().count
        if (nowCount > hipBefore) {
          const emo = fused.emotions?.[0] ?? null
          const ep = organs.hippocampus.stampLast?.({ kind: emo?.kind })
            ?? organs.hippocampus.snapshot().episodes.slice(-1)[0]
          const brief = String(ep?.triggerBrief ?? '')
          bridge.announce?.({ at: ep?.at, valence: ep?.valence ?? 0, intensity: ep?.intensity ?? 0, brief }, emit)
          try {
            const moodNow = Number(state.mood) || 0
            const emoValence = Number(ep?.valence) || 0
            // 人格的先验（第四条桥）：只说"这件事该记得多深"。
            // 拿不到就 null，按原来的算——不许拿 0 假装"没有偏好"。
            const prior = typeof bridge.personaPrior === 'function' ? bridge.personaPrior() : null
            const bias = prior ? Number(prior.deepBias) || 0 : 0
            const deepen = 1 + 0.4 * Math.max(0, -emoValence) + 0.45 * bias
            const base = Number(ep?.intensity) || 0
            const kind = String(ep?.kind ?? '')
            // 两件事分开：
            //   说不出名字但当时确实被戳到了 → 记，named:false
            //   连"被戳到"的量都没有（效价近 0、强度也低）→ 不记
            // 以前一律记，账本里六成是"有情绪：说了几句话"，统计全被稀释。
            const notable = Math.abs(emoValence) >= 0.15 || base >= 0.35
            // 记忆深度：情绪本身够重，或者人格认为"这种事她放不下"
            const deep = deepen > 1.1 || (bias > 0.75 && Math.abs(emoValence) >= 0.2)
            if (kind || notable) {
              bridge.annotate?.({
                kind,
                valence: ep?.valence ?? 0,
                intensity: clamp(base * deepen, 0, 1.6),
                depth: deep ? 'deep' : 'normal',
                mood: Number(moodNow.toFixed(3)),
                brief,
                prior: prior ? bias : null,
              }, sessionId)
            }
          } catch { /* 写不进去不影响心跳 */ }
        }
      }

      // 心情积分（慢变量）
      const k = 1 - Math.exp(-(dtMs / 60_000) / (p.tauMoodH * 60))
      state.mood = clamp(state.mood + (fused.moodTarget - state.mood) * k, p.moodBase - p.moodCap, p.moodBase + p.moodCap)
      // 当场的话要有当场的影响：不然"刚被顶"和"没事"心情一个样
      // 注意：以前这里要求 `fused.emotions.length`——被夸时常常没有情绪对象，
      // 于是"正面当场影响"这根分支根本进不去（连带上面那 0.03 也白写）。
      if (lastUser) {
        // 用"这一拍整体什么感觉"（fused.valence），不要用 emotions[0]：
        // 被夸时往往只剩一个残留的负面情绪对象，按它的符号判，一句好话反而算成坏的。
        const evRaw = Number(fused.valence)
        const ev = Number.isFinite(evRaw) ? evRaw : (Number(fused.emotions?.[0]?.valence ?? 0) || 0)
        // 以前只有负面影响（0.05），正面一点都没有——慢积分的时间尺度是小时，
        // 于是一段对话里心情只会往下走，被怎么夸都回不来。
        // 正向也给一点，但刻意更轻（0.03 < 0.05）：坏消息确实更重，但不是完全不讲理。
        if (ev < 0) state.mood = clamp(state.mood + 0.05 * ev, p.moodBase - p.moodCap, p.moodBase + p.moodCap)
        else if (ev > 0) state.mood = clamp(state.mood + 0.03 * ev, p.moodBase - p.moodCap, p.moodBase + p.moodCap)
        // 被怼过之后 threat 会挂很久，valence 一直负着——夸两句也翻不回来。
        // 一句明确的、没有夹刺的好话，给一个固定的小抬升：不多，但保证方向对。
        const said = String(lastUser.text || '')
        const praise = /厉害|太棒|真好|谢谢|开心|漂亮|不错|辛苦|好看|喜欢/.test(said)
        const sting = /不行|做不好|算了|不指望|就这|烦死|无语|服了|闭嘴/.test(said)
        if (praise && !sting) {
          state.mood = clamp(state.mood + 0.02, p.moodBase - p.moodCap, p.moodBase + p.moodCap)
        }
      }

      trace.push({
        txId: tx.txId, dtMs, mood: r3(state.mood), valence: r3(fused.valence),
        emotion: fused.emotions[0]?.kind ?? '-', ms: Date.now() - t0ms,
        stale: cache.size < Object.keys(organs).length,
      })
      if (trace.length > 200) trace.shift()
      return fused
    } finally {
      busy = false
    }
  }

  function text({ hour } = {}) {
    if (!fused) tick()
    // 同一拍内只渲染一次：否则同一轮里第二次渲染会误判成"重复"，加上"还是那样"
    if (state.renderTick === state.ticks && state.renderText) return state.renderText
    const h = hour ?? new Date(state.at).getHours()
    const t = render(fused, { hour: h, lastLine: state.lastText, world, tick: state.ticks })
    state.lastText = t.split('\n')[0] || ''
    state.renderTick = state.ticks
    state.renderText = t
    return t
  }

  function snapshot() {
    // at 必须是真的时间戳：不然重启后算不出"隔了多久"，情绪恢复/回底色全都失效
    const atNow = Number.isFinite(state.at) ? state.at : clockNow()
    return {
      schema: 1,
      mood: state.mood, at: atNow, ticks: state.ticks, scene: state.scene,
      organs: Object.fromEntries(Object.entries(organs).map(([id, m]) => [id, safeSnapshot(m)])),
    }
  }

  function restore(o) {
    if (!o || typeof o !== 'object') return
    if (Number(o.schema) !== 1) return   // X11：版本不符就冷启动
    if (typeof o.mood === 'number') state.mood = clamp(o.mood, -1, 1)
    // 冷启动 / 隔了很久才恢复：心情往底色回一半。
    // 不然几小时前那点不快会被原样带进来，一开机就是"她还在气头上"。
    if (typeof o.at === 'number') {
      const away = Math.max(0, clockNow() - o.at)
      if (away >= 30 * 60_000) {
        state.mood = clamp(state.mood + (p.moodBase - state.mood) * 0.5, p.moodBase - p.moodCap, p.moodBase + p.moodCap)
      }
      if (process.env.DSH_AFFECT_DEBUG_RESTORE) console.error('[restore]', JSON.stringify({ oAt: o.at, clock: clockNow(), away, mood: state.mood }))
    } else {
      // 老存档没有时间戳（早期版本写的 at:null）：不知道离开多久，就温和地回 1/4。
      // 不然一开机就是几小时前那股低气压，得靠聊很久才爬得回来。
      state.mood = clamp(state.mood + (p.moodBase - state.mood) * 0.25, p.moodBase - p.moodCap, p.moodBase + p.moodCap)
      if (process.env.DSH_AFFECT_DEBUG_RESTORE) console.error('[restore]', JSON.stringify({ oAt: o.at, fallback: true, mood: state.mood }))
    }
    if (typeof o.at === 'number') state.at = o.at
    if (typeof o.ticks === 'number') state.ticks = o.ticks
    for (const [id, m] of Object.entries(organs)) {
      if (o.organs?.[id]) { try { m.restore(o.organs[id]) } catch { /* 单个坏不影响其他 */ } }
    }
    // 冷启动时，器官层也要松一档：光把 mood 往回拉没用，
    // amygdala.threat / insula 唤醒还是旧值的话，第一拍就把目标拉回低位。
    if (state.mood !== undefined) {
      const away = typeof o.at === 'number' ? Math.max(0, clockNow() - o.at) : null
      const k = away === null ? 0.75 : (away >= 30 * 60_000 ? 0.5 : 1)
      if (k < 1) {
        for (const id of ['amygdala', 'insula']) {
          const organ = organs[id]
          if (!organ?.snapshot || !organ?.restore) continue
          try {
            const snap = organ.snapshot()
            let touched = false
            for (const key of ['threat', 'fastThreat', 'intensity', 'arousal']) {
              if (typeof snap?.[key] === 'number') { snap[key] = snap[key] * k; touched = true }
            }
            if (touched) organ.restore(snap)
          } catch { /* 单个器官不行就算了 */ }
        }
      }
    }
    cache.clear()
    lastKnown.clear()
  }

  const ENGINE_COVER = [
    // 动力学不变量
    'K01', 'K02', 'K03', 'K04', 'K05', 'K07', 'K08', 'K09', 'K10', 'K11', 'K12',
    // 跨表一致性
    'C01', 'C02', 'C04', 'C06', 'C07', 'C08', 'C09',
    // 多器协作
    'X01', 'X02', 'X03', 'X05', 'X06', 'X07', 'X08', 'X10', 'X11', 'X12',
  ]

  const cover = () => {
    const m = Object.fromEntries(Object.entries(organs).map(([id, x]) => [id, x.cover ?? []]))
    m.engine = ENGINE_COVER
    m.inject = INJECT_COVER
    return m
  }
  const health = () => Object.fromEntries(Object.entries(organs).map(([id, m]) => [id, m.health?.() ?? { ok: true }]))

  return {
    persona: p, organs, state, trace, res,
    tick, text, snapshot, restore, read: () => fused, cover, health,
    // 人格可写的三个"感受层"旋钮就住在 p 上（threatGain / baselineMood / sensitivity）。
    // 单独开一个口子，是因为 retune 原本只能写器官 params，写不到这里。
    personaParams: () => p,
    bridgeStatus: () => (bridge?.status ? bridge.status() : null),
    debugRecall: (text) => (bridge?.debugRecall ? bridge.debugRecall(text) : null),
    setScene(scene) { state.scene = scene },
    setGap(ms) { state.gapMs = ms },
    setOther(v) { state.other = v },
    markSpoke() { world.spoke = true },
  }
}

function safeSnapshot(m) {
  try { return m.snapshot() } catch { return null }
}

const r3 = (n) => Math.round(n * 1000) / 1000
