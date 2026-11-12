// 时间节律：周节律 / 季节光照 / 长期人格漂移。覆盖 W04 W05 W06。

import { clamp, dayKey } from '../core/consts.js'

export function create() {
  const fresh = () => ({ weekly: 0, seasonal: 0, drift: 0, lastDay: '', frame: 0 })
  let s = fresh()

  return {
    id: 'rhythm',
    cover: ['W04', 'W05', 'W06'],
    step(w) {
      const d = new Date(w.tx.t1)
      const dow = d.getDay() // 0 周日
      // W04 周节律：周一最低，周五最高
      s.weekly = dow === 1 ? -0.12 : dow === 5 ? 0.08 : dow === 0 || dow === 6 ? 0.04 : 0
      // W05 季节：按日长近似（简化 ±0.05）
      const month = d.getMonth() + 1
      s.seasonal = (month >= 5 && month <= 8) ? 0.03 : (month === 12 || month <= 2) ? -0.05 : 0
      // W06 长期漂移：按天累积心情
      const today = dayKey(w.tx.t1)
      if (s.lastDay !== today) {
        s.lastDay = today
        s.drift = clamp(s.drift * 0.98 + (w.mood ?? 0) * 0.02, -0.3, 0.3)
      }
      s.frame += 1
    },
    read() {
      return { frame: s.frame, weekly: s.weekly, seasonal: s.seasonal, drift: s.drift, bias: clamp(s.weekly + s.seasonal + s.drift, -0.4, 0.4) }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
