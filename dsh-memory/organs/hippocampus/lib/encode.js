// 编码：写入口。快、糙、不调模型。
// 对应功能总表：L0-1 单一入口、L0-2 去重、L1-1 绑定、L1-2 索引、L1-3 分离、L1-4 稀疏门、
// L1-5 膨胀展开、L1-6 来源链、L1-7 gate、L1-8 深度、L1-9 点火、L1-11 双通道、L1-12 旁路、
// L1-13 一次性编码、L1-14 可重放、L2-3 图、L2-4 序列、L2-6 地点、L2-7 相对时间、L2-15 置信度、
// R1 双门顺序、R13 旁路边界。

import { appendJsonl, appendRaw, FILES } from './store.js'
import { classify, makeFingerprint } from './fingerprint.js'
import { newEpisodeId, newRawId, messageKey, OWNER } from './memory.js'
import {
  clean, sha16, localDay, clockText,
} from './util.js'
import {
  extractEntities, detectType, detectPlace, salience, shouldRemember,
  depthOf, keywords, detectRelations, isTestText,
} from './taxonomy.js'
import { activeForgetFactor } from './decay.js'

const WINDOW_MS = 5 * 60 * 1000

/**
 * 在 max 字以内截断：优先停在句子边界，其次逗号，最差才硬切加省略号。
 * 目的是让摘要读得通——不要出现「……理念，在」这种半句。
 */
export function clipText(text, max = 90) {
  const s = String(text || '').trim()
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const floor = Math.floor(max * 0.4) // 太靠前的标点不要，否则删掉一半内容
  const 句末 = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '),
    head.lastIndexOf('\n'),
  )
  if (句末 >= floor) return head.slice(0, 句末 + 1).trim()
  const 逗号 = Math.max(
    head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('、'),
    head.lastIndexOf(','), head.lastIndexOf(';'),
  )
  if (逗号 >= floor) return head.slice(0, 逗号).trim() + '…'
  return head.trim() + '…'
}

export function makeEncoder({ store, adapters }) {
  const adaptersSafe = adapters || {}

  async function ingest(input) {
    const at = Number(input.at || Date.now())
    const session = String(input.session || 'unknown')
    const role = input.role === 'assistant' ? 'assistant' : 'user'
    const text = clean(input.text, 2000)
    if (!text) return { skipped: 'empty' }

    // L0-2 去重：消息身份优先，其次 (session, role, hash, ±5min)
    // 重放模式跳过把门（重放本来就是要把同一批重新建出来）
    const mkey = messageKey({ channel: input.channel, msgId: input.msgId })
    if (!input.skipDedup && mkey && store.seenMessages.has(mkey)) return { skipped: 'dup-message' }
    const hash = sha16(`${session}|${role}|${text}`)
    if (!input.skipDedup) {
      for (const [key, t] of store.seenMessages) {
        if (key === hash && Math.abs(at - t) < WINDOW_MS) return { skipped: 'dup-window' }
      }
      store.seenMessages.set(mkey || hash, at)
    }

    // L1-14 一次性编码 + 幂等：同一 raw 不重复处理
    // 重放时直接复用已有 raw 行，不再追加（否则 raw 会翻倍）
    const raw = input.replayRaw
      ? { ...input.replayRaw, at }
      : {
        id: newRawId(),
        session,
        role,
        text,
        at,
        day: localDay(at),
        clock: clockText(at),
        hash,
        source: {
          channel: input.channel || 'dsh',
          msgId: input.msgId || '',
          session,
          role,
        },
        confidence: Number(input.confidence ?? (role === 'user' ? 1 : 0.7)),
      }

    // L1-7 编码 gate（前额叶桩）→ R1：先 gate，再稀疏门
    const gate = adaptersSafe.prefrontal?.shouldRemember
      ? await callSafe(() => adaptersSafe.prefrontal.shouldRemember(text, { session, role, at }), true)
      : shouldRemember(text)

    const sal = adaptersSafe.amygdala?.salience
      ? await callSafe(() => adaptersSafe.amygdala.salience(text, { session, role, at }), salience(text, { fromUser: role === 'user' }))
      : salience(text, { fromUser: role === 'user' })

    const salScore0 = typeof sal === 'number' ? sal : (sal?.score ?? 0)
    // 心情差时记得更深：低谷里同一件事刻得更深（沿用情绪侧的 0.4 系数，且封顶 0.4）。
    // 情绪侧传 input.mood（-1..1）就能让这条落到记忆的显著性上，不是只写它自己的账本。
    const moodNow = Number(input?.mood)
    const moodBoost = Number.isFinite(moodNow) ? Math.min(0.4, 0.4 * Math.max(0, -moodNow)) : 0
    const salScore = Math.max(0, Math.min(1, salScore0 + moodBoost))
    const salSource = typeof sal === 'object' && sal?.source ? sal.source : 'rule'

    // L1-4 稀疏门：没过门只落 raw，不进索引
    // force：情绪写回（【情绪】…）是明确的情绪事件，不该被显著性门槛挡在外面。
    // 挡掉的话"这件事让我什么感觉"永远进不了库，记忆↔心情那条回路就断了。
    const force = Boolean(input?.force)
    const depth = force
      ? (salScore >= 0.55 ? 'deep' : 'standard')
      : depthOf(salScore)
    const bypass = Boolean(input.bypass) // L1-12 旁路：显式标记，不参与合并（R13）

    if (!input.replayRaw) await appendRaw({ ...raw, salience: salScore, salienceSource: salSource, depth, gate })

    if ((!gate && !force) || depth === 'shallow') {
      await appendJsonl(FILES.encode, { at, rawId: raw.id, action: 'raw-only', gate, depth, salience: salScore })
      return { rawId: raw.id, episodeId: null, depth, gate, salience: salScore }
    }

    // L1-1 绑定 + L1-5 膨胀展开 + L1-11 双通道
    const entities = extractEntities(text)
    const place = detectPlace(text)
    const type = detectType(text)
    const kw = keywords(text)
    const fingerprint = makeFingerprint(session, at, entities)

    // L1-9 点火：高显著性立即关闭上一段
    if (salScore >= 0.85) store.closeIfStale(session, at + 1)

    // L1-3 分离：只查同桶候选
    const candidates = store.candidates(session, at).map((ep) => ({
      episodeId: ep.id,
      hash: ep.textHash || '',
      entities: ep.entities || [],
      at: Number(ep.end || ep.start),
    }))
    const judge = bypass ? { kind: 'distinct' } : classify({ text, hash, entities, at }, candidates)

    if (judge.kind === 'duplicate') {
      await appendJsonl(FILES.encode, { at, rawId: raw.id, action: 'duplicate', episodeId: judge.id })
      return { rawId: raw.id, episodeId: judge.id, action: 'duplicate' }
    }

    let ep = null
    if (judge.kind === 'same' && !bypass) {
      ep = store.get(judge.id)
    }

    if (!ep) {
      // 新段开始：把同会话还开着的段全部关掉（否则 open 会漏关）
      for (const other of store.sessionEpisodes(session)) {
        if (other.state === 'open') {
          other.state = 'closed'
          other.closedAt = at
          store.touch(other)
        }
      }
      store.openBySession.delete(session)

      // 同一句话从另一个 session 又来一遍（导入 / 多窗口）：并进原来那条，别建第二条
      const twin = store.allEpisodes().find((x) => x.textHash === hash && !x.test)
      if (twin) {
        twin.rawIds = [...new Set([...twin.rawIds, raw.id])]
        twin.end = Math.max(Number(twin.end || 0), at)
        twin.version += 1
        twin.updatedAt = at
        store.touch(twin)
        store.addNode(`e:${twin.id}`, 'event', twin.summary)
        await appendJsonl(FILES.episodes, twin)
        return { rawId: raw.id, episodeId: twin.id, action: 'twin-merged', depth, salience: salScore }
      }

      // 新建 episode
      store.closeIfStale(session, at)
      ep = {
        id: newEpisodeId(session, at),
        anchor: { sessionId: session, channel: raw.source.channel, msgId: raw.source.msgId },
        fingerprint,
        start: at,
        end: at,
        seq: (store.allEpisodes().length + 1),
        rawIds: [],
        textHash: hash,
        // L1-5 多槽位展开（不是一句摘要）
        slots: {
          who: role,
          when: at,
          where: place,
          what: type,
          scene: place,
          // "怎么做的 / 用了什么方法"：从原话里抽"用的是 X"/"用 X 做 Y"。
          // 人回忆一件事，方法/工具是跟着事件一起留在印象里的，不能只留在摘要长句里。
          tool: (() => {
            const m = String(text).match(/(?:用的是?|使用了?|改用|换成|用了)\s*([^\s，。；、！？]{1,24})/u)
            return m ? m[1] : ''
          })(),
          entities: entities.slice(0, 8),
          action: kw.slice(0, 5),
        },
        summary: clipText(text),
        // 情绪效价：心情插件写回时带 meta.valence，用来做心境一致性检索
        // （低落时先想起糟心事）。没有就留 null，检索侧按 0 处理，不伪造。
        valence: (() => {
          const v = input?.valence ?? input?.meta?.valence
          const n = Number(v)
          return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : null
        })(),
        // 挂到"人"名下：换窗口也认得出是同一个人
        owner: OWNER,
        entities,
        keywords: kw,
        place,
        // 情绪写回单独成类：它是给心情通路看的，不该抢占"最近发生了什么"的位置。
        // 以前写的是 force ? 'emotion' : type——只要带 force 就算情绪，
        // 于是"强制写入的一条事实"也被标成情绪，皮层抽取时被当成情绪腔跳过（事实数 0）。
        // 现在只有真的是情绪（kind=affect 或标题以【情绪】开头）才标 emotion。
        type: (force && (input?.kind === 'affect' || String(text).startsWith('【情绪】'))) ? 'emotion' : type,
        // L2-7 相对时间：段内第几条
        relIndex: 0,
        // L2-15 置信度
        confidence: Number(raw.confidence),
        salience: salScore,
        salienceSource: salSource,
        depth,
        // L5-1 可及性 / L4-12 退场
        accessibility: Math.max(0.2, salScore),
        baseAccessibility: Math.max(0.2, salScore), // 衰减的基准，写一次就不再变
        // 测试数据：照样存、能查，但默认不参与日常检索、不参与巩固
        test: isTestText(text),
        transferState: 'held',
        state: 'open',
        version: 1,
        createdAt: at,
        updatedAt: at,
      }
      ep.rawIds.push(raw.id)
      store.addEpisode(ep)
      store.openBySession.set(session, ep.id)
      store.addNode(`e:${ep.id}`, 'event', ep.summary)
      // 落盘：episodes 是 append-only，同一 id 读的时候取 version 最大的那行
      await appendJsonl(FILES.episodes, ep)
      for (const ent of ep.entities.slice(0, 6)) {
        store.addNode(`x:${ent}`, 'entity', ent)
        store.addEdge(`e:${ep.id}`, `x:${ent}`, 'cooccur', 1)
      }
    } else {
      // 并进已有 episode
      ep.rawIds.push(raw.id)
      ep.end = Math.max(ep.end, at)
      ep.relIndex = Math.max(0, ep.rawIds.length - 1)
      // 效价要跟着这次写回一起并进来。
      // 以前只在"新建段"那条路上算 valence，并进旧段的话就丢了——
      // 心情插件写回的 -0.6 明明传进来了，段上仍是 null，
      // 于是 moodTrend 一条有效价都统计不到（心境一致性检索整条路是断的）。
      {
        const nv = Number(input?.valence ?? input?.meta?.valence)
        if (Number.isFinite(nv)) ep.valence = Math.max(-1, Math.min(1, nv))
      }
      ep.entities = [...new Set([...ep.entities, ...entities])].slice(0, 12)
      ep.keywords = [...new Set([...ep.keywords, ...kw])].slice(0, 12)
      ep.salience = Math.max(ep.salience, salScore)
      ep.test = Boolean(ep.test || isTestText(text)) // 并进来一条测试，整段算测试
      ep.version += 1
      ep.updatedAt = at
      store.touch(ep)
      store.addNode(`e:${ep.id}`, 'event', ep.summary)
      // 合并也是写一行新版本，不改旧行
      await appendJsonl(FILES.episodes, ep)
    }

    // L2-3 共现边、L2-4 时间边与因果/转折/结果候选
    const prev = store.sessionEpisodes(session).filter((x) => x.id !== ep.id && x.end <= at).at(-1)
    if (prev) store.addEdge(`e:${prev.id}`, `e:${ep.id}`, 'time', 1)
    for (const rel of detectRelations(text)) {
      store.addNode(`r:${rel.kind}`, 'relation', rel.kind)
      store.addEdge(`e:${ep.id}`, `r:${rel.kind}`, rel.kind, 0.4)
    }

    // L5-5 主动遗忘：新记忆写入时，把同实体的旧条目可及性打一下（R2 系数，不删）
    for (const other of store.sessionEpisodes(session)) {
      if (other.id === ep.id) continue
      const shared = (other.entities || []).filter((e) => entities.includes(e)).length
      if (shared > 0) {
        // 打的是基准值，不是当次算出来的可及性（否则会跟衰减互相叠加）
        other.baseAccessibility = Math.max(0.05, Number(other.baseAccessibility ?? other.salience ?? 0.3) * activeForgetFactor(shared))
        other.forgetTouchedAt = at
        store.touch(other)
      }
    }

    // L1-2 索引行（抽取式，不做语义压缩）
    const indexRow = {
      episodeId: ep.id,
      session,
      at,
      type,
      summary: ep.summary,
      entities: ep.entities.slice(0, 8),
      keywords: ep.keywords.slice(0, 8),
      place,
      slot: ep.slots,
      confidence: ep.confidence,
      accessibility: ep.accessibility,
      // 留给皮层的字段（E4/E8/E10）
      conceptIds: [],
      semanticRef: null,
      test: Boolean(ep.test),
      v: 1,
    }
    await appendJsonl(FILES.index, indexRow)

    // L4-12 退场信号：先空着，等 E15
    await appendJsonl(FILES.encode, {
      at, rawId: raw.id, episodeId: ep.id, action: judge.kind, depth,
      salience: salScore, fingerprint, entities: entities.slice(0, 6),
    })

    return { rawId: raw.id, episodeId: ep.id, action: judge.kind, depth, salience: salScore }
  }

  return { ingest }
}

/** 跨器官调用：写路径上必须快，超时就吃默认值（R15/R16/R18）。 */
async function callSafe(fn, fallback, timeoutMs = 50) {
  try {
    const p = Promise.resolve().then(fn)
    const timeout = new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
    return await Promise.race([p, timeout])
  } catch {
    return fallback
  }
}
