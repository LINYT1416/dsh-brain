// 默认模式网络：走神、自我参照、反刍、心理时间、社交想象。覆盖 D01-D05。

import { clamp, decay } from '../core/consts.js'

export function create() {
  const fresh = () => ({ mindWander: 0, selfThought: 0.2, rumination: 0, mentalTime: 0.3, socialImagining: 0.2, idleMs: 0, frame: 0, anchors: 0, chapters: 0 })
  let s = fresh()

  return {
    id: 'dmn',
    cover: ['D01', 'D02', 'D03', 'D04', 'D05'],
    step(w) {
      const dt = w.tx.dtMs
      const amy = w.get('amygdala')
      const ins = w.get('insula')
      const talking = w.tx.events.some(e => e.type === 'user')
      s.idleMs = talking ? 0 : s.idleMs + dt

      // 自我参照/反刍不能凭空：拿真实记忆当锚点，记忆没接上就老实是空
      const echo = w.memoryEcho
      const recent = Array.isArray(w.memoryRecent) ? w.memoryRecent : []
      const memHits = Array.isArray(echo?.hits) ? echo.hits.length : 0
      const memTone = Number(echo?.tone ?? 0)
      s.anchors = memHits
      s.chapters = recent.length

      // D01 走神：没人说话 10 分钟后开始
      s.mindWander = clamp(s.mindWander + (s.idleMs > 600_000 ? 0.1 : -0.2) * (dt / 60_000), 0, 1)
      // D02 自我参照：真实旧事会把人拉回自己身上
      s.selfThought = clamp(0.2 + 0.4 * s.mindWander + 0.3 * (ins?.felt.intensity ?? 0) + 0.2 * Math.min(1, memHits / 3), 0, 1)
      // D03 反刍：负性事件后反复；想起的旧事是负的，也会启动
      const neg = (amy?.threat ?? 0) > 0.4 || (memHits > 0 && memTone < -0.15)
      // 想起负性旧事的那一拍就要起作用，不能等下一分钟的时间积分
      if (neg && !s.lastNegMem) s.rumination = clamp(s.rumination + 0.15, 0, 1)
      s.lastNegMem = neg
      s.rumination = clamp(s.rumination * decay(dt, 25) + (neg ? 0.15 : -0.05) * (dt / 60_000), 0, 1)
      // D04 心理时间
      s.mentalTime = clamp(s.mentalTime + (neg ? 0.05 : 0) * (dt / 60_000), 0, 1)
      // D05 社交想象
      s.socialImagining = clamp(s.socialImagining * decay(dt, 60) + (s.idleMs > 300_000 ? 0.05 : 0), 0, 1)
      s.frame += 1
    },
    read() {
      return { frame: s.frame, mindWander: s.mindWander, selfThought: s.selfThought, rumination: s.rumination, mentalTime: s.mentalTime, socialImagining: s.socialImagining, idleMs: s.idleMs, anchors: s.anchors, chapters: s.chapters }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
