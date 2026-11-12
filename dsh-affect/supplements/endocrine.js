// 神经内分泌：皮质醇 / 催产素 / 雌激素 / 睾酮 / 甲状腺。覆盖 E01-E05。
// 大多由下丘脑驱动，这里做慢速整合与个体差异。

import { clamp, decay } from '../core/consts.js'

export function create() {
  const fresh = () => ({ cortisol: 0.15, oxytocin: 0.35, estrogen: 0.5, testosterone: 0.5, thyroid: 0.6, frame: 0 })
  let s = fresh()

  return {
    id: 'endocrine',
    cover: ['E01', 'E02', 'E03', 'E04', 'E05'],
    step(w) {
      const dt = w.tx.dtMs
      const hyp = w.get('hypothalamus')
      const soc = w.get('social')
      const amy = w.get('amygdala')
      // E01 皮质醇跟随 HPA，但更慢
      s.cortisol = clamp(s.cortisol + ((hyp?.hpa?.cortisol ?? 0.15) - s.cortisol) * (1 - decay(dt, 90)), 0, 1)
      // E02 催产素：亲密与信任
      s.oxytocin = clamp(s.oxytocin + ((soc?.trust ?? 0.6) * 0.6 - s.oxytocin) * (1 - decay(dt, 120)), 0, 1)
      // E03 雌激素：周期相位
      const cyc = hyp?.cycle ?? { on: false, day: 14 }
      if (cyc.on) s.estrogen = clamp(cyc.day < 5 ? 0.3 : cyc.day > 23 ? 0.35 : 0.6, 0, 1)
      // E04 睾酮：竞争失败后下降
      s.testosterone = clamp(s.testosterone * decay(dt, 720) + ((amy?.threat ?? 0) > 0.5 ? 0.4 : 0.55) * (1 - decay(dt, 720)), 0, 1)
      // E05 甲状腺（简化成一个"低能量"标量）
      s.thyroid = clamp(s.thyroid * decay(dt, 4320) + 0.6 * (1 - decay(dt, 4320)), 0, 1)
      s.frame += 1
    },
    read() {
      return { frame: s.frame, cortisol: s.cortisol, oxytocin: s.oxytocin, estrogen: s.estrogen, testosterone: s.testosterone, thyroid: s.thyroid }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
