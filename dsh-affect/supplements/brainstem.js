// 脑干唤醒层：呼吸、心率、觉醒、惊跳、自主耦合。覆盖 B01-B05。

import { clamp } from '../core/consts.js'

export function create() {
  const fresh = () => ({ respiration: 14, heartRate: 70, arousal: 0.4, startle: 0, coupling: 0.5, frame: 0 })
  let s = fresh()

  return {
    id: 'brainstem',
    cover: ['B01', 'B02', 'B03', 'B04', 'B05'],
    step(w) {
      const hyp = w.get('hypothalamus')
      const amy = w.get('amygdala')
      const sym = hyp?.autonomic?.sym ?? 0.3
      const threat = amy?.threat ?? 0
      // B01/B02 由自主神经驱动
      s.respiration = clamp(12 + 8 * sym, 6, 30)
      s.heartRate = clamp(60 + 45 * sym - 10 * (hyp?.autonomic?.par ?? 0.6), 45, 140)
      // B03 觉醒：与睡眠压力取 max（C09），不相加
      const sleepPressure = hyp?.sleepDebt ?? 0.2
      s.arousal = clamp(Math.max(0.2 + 0.6 * sym, 1 - sleepPressure), 0, 1)
      // B04 惊跳：突发消息
      if (w.tx.events.some(e => e.type === 'user') && threat > 0.5) s.startle = clamp(s.startle + 0.4, 0, 1)
      s.startle *= 0.7
      // B05 呼吸-心率耦合
      s.coupling = clamp(0.3 + 0.4 * sym * (1 - s.arousal * 0.2), 0, 1)
      s.frame += 1
    },
    read() {
      return { frame: s.frame, respiration: s.respiration, heartRate: s.heartRate, arousal: s.arousal, startle: s.startle, coupling: s.coupling }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
