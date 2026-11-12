// 病感行为：炎症 → 低落 / 疲劳 / 退缩 / 痛觉敏化。覆盖 F01-F04。

import { clamp, decay } from '../core/consts.js'

export function create() {
  const fresh = () => ({ inflammation: 0, fatigue: 0, withdraw: 0, hyperalgesia: 0, frame: 0 })
  let s = fresh()

  return {
    id: 'sickness',
    cover: ['F01', 'F02', 'F03', 'F04'],
    step(w) {
      const dt = w.tx.dtMs
      const h = clamp(dt / 3600_000, 0, 24)
      // 由外部事件触发（生病），没有就自然消退
      s.inflammation = clamp(s.inflammation * decay(dt, 1440), 0, 1)
      s.fatigue = clamp(s.inflammation * 0.8, 0, 1)      // F02 疲劳
      s.withdraw = clamp(s.inflammation * 0.7, 0, 1)     // F03 社交退缩
      s.hyperalgesia = clamp(s.inflammation * 0.6, 0, 1)
      for (const ev of w.tx.events) {
        if (ev.type === 'sick') s.inflammation = clamp(s.inflammation + 0.5, 0, 1)
      }
      s.frame += 1
    },
    read() {
      return { frame: s.frame, inflammation: s.inflammation, fatigue: s.fatigue, withdraw: s.withdraw, hyperalgesia: s.hyperalgesia }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
