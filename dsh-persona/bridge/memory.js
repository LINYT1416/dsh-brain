// 记忆接缝：只读。
// 引擎是同步的，记忆检索是异步的——所以这里只回一份缓存，缓存由 index 在后台刷新。
// 拿不到就是空数组，不伪造。

// 情绪写回条目（【情绪】xxx）的摘要信息量接近零，不该进"最近发生了什么"。
// type 和三个文本字段都看：老数据的标签可能只在 summary 里。
const EMOTION_TAG = '【情绪】'
const isEmotionRow = (h) => h?.type === 'emotion'
  || ['brief', 'summary', 'text', 'title'].some((k) => String(h?.[k] ?? '').startsWith(EMOTION_TAG))


export function createMemoryBridge(get) {
  const cache = { episodes: [], at: 0, ok: false }

  return {
    present() {
      try { return Boolean(get('memory.hippocampus')) } catch { return false }
    },

    setEpisodes(list) {
      cache.episodes = Array.isArray(list) ? list.slice(-20) : []
      cache.at = Date.now()
      cache.ok = cache.episodes.length > 0
    },

    /** 引擎每帧同步取，只读缓存 */
    episodes() {
      return cache.episodes
    },

    status() {
      return {
        hippocampus: (() => { try { return Boolean(get('memory.hippocampus')) } catch { return false } })(),
        cortex: (() => { try { return Boolean(get('memory.cortex')) } catch { return false } })(),
        cached: cache.episodes.length,
        at: cache.at,
      }
    },

    /** 她自己的说话样本：扫最近 90 天的 assistant 原话，带时间戳（用于时间加权），取最新的一批 */
    async assistantSamples(k = 60) {
      let hip = null
      try { hip = get('memory.hippocampus') } catch { hip = null }
      if (!hip || typeof hip.raw !== 'function') return []
      let rows = []
      try {
        const out = await hip.raw({ days: 90, limit: 800 })
        rows = Array.isArray(out) ? out : (Array.isArray(out?.rows) ? out.rows : [])
      } catch { return [] }
      const out = []
      const seen = new Set()
      for (const r of rows) {
        const role = String(r?.role || r?.message?.role || '')
        const text = String(r?.text || r?.message?.text || r?.content || '').trim()
        if (role !== 'assistant' || text.length < 6) continue
        // 结构化写回记录不是她的话（【情绪】xxx 之类），不能拿来估语气
        if (/^【[^】]*】/.test(text)) continue
        const key = text.slice(0, 20)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ text, at: Number(r?.at || r?.ts || r?.time || r?.createdAt || 0) })
      }
      return out.slice(-Math.max(1, k))
    },

    async refresh(k = 8) {
      let hip = null
      try { hip = get('memory.hippocampus') } catch { hip = null }
      if (!hip) return { ok: false, reason: 'no-hippocampus' }

      // 以前这里调的是 hip.recall('')：空查询在记忆侧是"直接短路返回空数组"，
      // 所以这个缓存一次也没满过——线上 cached:0、pcc.anchors:0、nostalgia:0 全是这个原因。
      // 要"最近发生过什么"应该用 episodes()，不是拿空串去检索。
      try {
        let rows = []
        if (typeof hip.episodes === 'function') {
          const raw = await hip.episodes({ limit: Math.max(3, k * 3) })
          rows = Array.isArray(raw) ? raw : []
        } else if (typeof hip.recall === 'function') {
          // 老版本没有 episodes 才退回检索，且给一个真查询（不能用空串）
          const out = await hip.recall('最近发生的事', { k })
          rows = Array.isArray(out) ? out : (out?.hits || out?.items || [])
        }
        this.setEpisodes(rows
          .filter((h) => !isEmotionRow(h))
          .map((h) => ({
            brief: String(h.brief || h.summary || '').slice(0, 40),
            // 没有效价就是 null，不拿 0 顶：0 是"中性"，null 是"不知道"。
            // 注意 Number(null) === 0 —— 必须先判空，否则 null 会被悄悄变成 0。
            valence: (h.valence === null || h.valence === undefined || h.valence === '')
              ? null
              : (Number.isFinite(Number(h.valence)) ? Number(h.valence) : null),
            at: h.at ?? null,
            type: String(h.type || ''),
          })))
        return { ok: true, n: cache.episodes.length, dropped: rows.length - cache.episodes.length }
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) }
      }
    },
  }
}
