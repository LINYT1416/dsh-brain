// 海马体（情绪向）：只存"这件事让我什么感觉"。不存原话、不写记忆库。
// 覆盖 M01-M18。

import { clamp, decay, hash, dayKey } from '../core/consts.js'

const P = { writeThreshold: 0.22, maxEpisodes: 400, separation: 0.85, reconsolidationMax: 5 }

const BRIEF = {
  否定: '被否定了一下', 命令: '被催了一句', 冷: '被冷淡地顶了一下',
  热: '被夸了一下', '': '说了几句话',
}

export function create(cfg = {}) {
  const p = { ...P, ...cfg }
  const fresh = () => ({
    episodes: [], pending: [], schemas: [], persons: {}, lastRecall: null,
    encodes: 0, overnightAt: 0, reactivate: 0, frame: 0,
  })
  let s = fresh()

  /** 同一帧回填：编码这一步还拿不到"这一刻"的情绪（fuse 在后面才跑），
   *  等它出来再盖章，否则写回账本的 kind 永远是上一句的、或者空的。 */
  const stampLast = ({ kind } = {}) => {
    const e = s.episodes[s.episodes.length - 1]
    if (!e) return null
    if (!e.kind && kind) e.kind = String(kind)
    return e
  }

  const classify = (text) => {
    const t = String(text || '')
    if (/[滚闭嘴烦讨厌]|随便|都行|哦$|嗯$/.test(t)) return '冷'
    if (/^(快|赶紧|别|给我)/.test(t)) return '命令'
    if (/[不没别]/.test(t)) return '否定'
    if (/[哈嘿夸好乖爱谢]/.test(t)) return '热'
    return ''
  }

  /** 相似度：词面 hash 近似 + cue 相同 */
  const sim = (a, b) => (a.cue === b.cue ? 0.7 : 0.2) + (Math.abs(a.valence - b.valence) < 0.2 ? 0.3 : 0)

  return {
    id: 'hippocampus',
    cover: ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M11', 'M12', 'M13', 'M14', 'M15', 'M16', 'M17', 'M18', 'W03', 'C03'],
    /** X08：情景延迟落库——等这一帧的归因出来再提交 */
    commit() {
      if (!s.pending.length) return
      s.episodes.push(...s.pending)
      s.pending = []
      if (s.episodes.length > p.maxEpisodes) s.episodes = s.episodes.slice(-p.maxEpisodes)
    },
    stampLast,
    params: p,

    step(w) {
      const amy = w.get('amygdala')
      const ins = w.get('insula')
      const mood = w.mood ?? 0
      if (!amy) return
      s.lastRecall = null
      s.reactivate = Math.max(0, s.reactivate * 0.9)

      const stress = (w.get('hypothalamus')?.hpa?.cortisol ?? 0)
      const want = clamp((amy.rewardPE ?? 0) - 0.7 * amy.threat, -1, 1)

      for (const ev of w.tx.events) {
        if (ev.type !== 'user') continue
        const cue = classify(ev.text)
        // T04 乙酰胆碱：注意越集中，越容易记（写入门槛下降）
        const ach = w.get('neuromod')?.ach ?? 0.4
        if (amy.salience < p.writeThreshold - 0.05 * ach) continue

        // M08 提取：相似度 × 情绪一致性 × 新近
        const cands = s.episodes.map(e => ({
          e,
          score: 0.45 * sim(e, { cue, valence: want }) +
            0.25 * (1 - Math.abs(e.valence - (mood || 0)) / 2) +
            0.15 * Math.exp(-(w.tx.t1 - e.at) / (7 * 86400_000)) +
            0.10 * e.salience,
        })).sort((a, b) => b.score - a.score)

        let hits = cands.filter(c => c.score > 0.5)
        // M09 应激变窄
        if (stress > 0.6) hits = hits.slice(0, 1)

        if (hits.length) {
          const h = hits[0]
          // M03 模式完成：一点线索召回整条情景；M04 时间编码；M05 场景
          s.lastRecall = { hit: true, brief: h.e.triggerBrief, valence: h.e.valence, intensity: h.e.intensity, kind: h.e.kind ?? null, at: h.e.at, ageDays: Math.round((w.tx.t1 - h.e.at) / 86400_000), scene: h.e.scene }
          h.e.recalls = (h.e.recalls || 0) + 1
          // M07 再巩固：最多 5 次
          if ((h.e.reconsolidations || 0) < p.reconsolidationMax) {
            h.e.valence = clamp(h.e.valence * 0.85 + want * 0.15, -1, 1)
            h.e.reconsolidations = (h.e.reconsolidations || 0) + 1
          }
          // M15 情境恐惧：想起旧事 → 给杏仁核一个"重新激活"信号
          s.reactivate = 0.3
          continue
        }

        // M01 编码；M02 模式分离：太像就合并，不像才新建
        const near = s.episodes.find(e => sim(e, { cue, valence: want }) > p.separation)
        if (near) {
          near.intensity = clamp(near.intensity * 0.7 + (ins?.felt.intensity ?? 0.3) * 0.3, 0, 1)
          near.at = w.tx.t1
        } else {
          // M10 应激增强编码：皮质醇高时记得更牢
          const boost = stress > 0.5 ? 1.5 : 1
          s.pending.push({
            id: `ep_${hash(cue + want.toFixed(2) + w.tx.t1)}`,
            at: w.tx.t1, day: dayKey(w.tx.t1), cue,
            triggerBrief: BRIEF[cue] ?? BRIEF[''],
            // M01 情绪快照：当时是什么情绪、多强
            kind: w.emotions?.[0]?.kind ?? null,
            target: w.emotions?.[0]?.target ?? null,
            valence: want,
            intensity: clamp(ins?.felt.intensity ?? amy.salience, 0, 1),
            salience: amy.salience * boost,
            scene: w.scene || 'home',
            recalls: 0, reconsolidations: 0,
            // M18 失真：细节会漂
            distortion: 0,
          })
          s.encodes += 1
        }
      }

      // M06 夜间巩固：每天一次，强度降 20%、低强度淘汰（W03 隔夜再加工）
      // C03：隔夜加工只在这里做；再巩固只在白天提取时做，两者不重叠
      const today = dayKey(w.tx.t1)
      if (s.overnightAt !== today && (new Date(w.tx.t1).getHours() >= 3)) {
        s.overnightAt = today
        for (const e of s.episodes) {
          e.intensity *= 0.8                       // M16 隔夜再加工
          e.salience *= 0.95
        }
        s.episodes = s.episodes.filter(e => e.intensity > 0.08 || e.salience > 0.6)  // M14 遗忘
      }

      // M13 图式：同类 3 次
      const byCue = {}
      for (const e of s.episodes) byCue[e.cue] = (byCue[e.cue] || 0) + 1
      for (const [cue, n] of Object.entries(byCue)) {
        if (n >= 3 && !s.schemas.find(x => x.cue === cue)) {
          s.schemas.push({ cue, rule: cue === '冷' ? '他一冷下来就是不想理我' : `对${cue}的反应`, confidence: clamp(0.6 + 0.1 * n, 0, 0.95), since: w.tx.t1 })
        }
      }

      // M12 社会记忆：记住对方偏好（简化：记最近的情绪来源）
      const who = '他'
      s.persons[who] = s.persons[who] || { likes: 0, hurts: 0 }
      if (want > 0.2) s.persons[who].likes += 1
      if (want < -0.2) s.persons[who].hurts += 1

      // M11 未来模拟：焦虑时生成"还没发生"的担忧
      if ((amy.threat ?? 0) > 0.5 && (w.get('pfc')?.bandwidth ?? 1) < 0.5) {
        s.lastRecall = s.lastRecall || { hit: false, worry: '会不会一直这样' }
      }

      s.frame += 1
    },

    read() {
      return {
        frame: s.frame,
        recall: s.lastRecall,
        count: s.episodes.length + s.pending.length,
        encodes: s.encodes,
        schemas: s.schemas.slice(-3),
        persons: { ...s.persons },
        nostalgia: (s.episodes.some(e => e.valence > 0.4 && e.recalls > 1) ? 0.4 : 0),   // M17 怀旧
        reactivate: s.reactivate,   // M15 给杏仁核
        recent: s.episodes.slice(-3).map(e => ({ brief: e.triggerBrief, valence: e.valence, at: e.at })),
      }
    },
    snapshot: () => ({ ...s, episodes: s.episodes.map(e => ({ ...e })), pending: s.pending.map(e => ({ ...e })), schemas: s.schemas.map(x => ({ ...x })) }),
    restore(o) { if (o) s = { ...fresh(), ...o, episodes: (o.episodes || []).map(e => ({ ...e })), pending: (o.pending || []).map(e => ({ ...e })) } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
