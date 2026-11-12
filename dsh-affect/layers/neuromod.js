// 调质层：蓝斑 / 中脑 / 中缝 / 基底前脑 / 垂体。覆盖 T01-T08。
// 全局增益，不做局部判断；局部模块先算，再乘这里（顺序见 C10）。

import { clamp, decay } from '../core/consts.js'

const P = { tauNe: 40, tauDa: 25, tau5ht: 180, tauAch: 60 }

export function create(cfg = {}) {
  const p = { ...P, ...cfg }
  const fresh = () => ({
    ne: 0.3, da: 0.5, serotonin: 0.5, ach: 0.4,
    oxytocin: 0.35, vasopressin: 0.3, opioid: 0.3, endocannabinoid: 0.2,
    frame: 0,
  })
  let s = fresh()

  return {
    id: 'neuromod',
    cover: ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'],
    params: p,
    step(w) {
      const dt = w.tx.dtMs
      const amy = w.get('amygdala')
      const hyp = w.get('hypothalamus')
      const soc = w.get('social')
      const threat = amy?.threat ?? 0
      const reward = amy?.rewardPE ?? 0
      const h = clamp(dt / 3600_000, 0, 24)

      // T01 NE：威胁抬升，蓝斑
      s.ne = clamp(s.ne * decay(dt, p.tauNe) + 0.5 * threat + 0.1 * (hyp?.stimulant ?? 0), 0, 1)
      // T02 DA：奖赏预测误差，落空时低于基线
      s.da = clamp(0.5 + 0.5 * reward * (1 - 0.3 * s.ne), 0, 1)
      // T03 5-HT：被压低时冲动上升
      s.serotonin = clamp(s.serotonin * decay(dt, p.tau5ht) + 0.02 * (reward > 0 ? 1 : 0.3) - 0.02 * (threat > 0.5 ? 1 : 0), 0, 1)
      // T04 ACh：注意集中时上升
      s.ach = clamp(s.ach + (0.4 + 0.3 * (w.get('attention')?.focus ?? 0.3) - s.ach) * 0.1 * Math.min(1, h * 3 + 0.2), 0, 1)
      // T05 催产素：亲密互动
      s.oxytocin = clamp(s.oxytocin + ((hyp?.hormones?.oxytocin ?? 0.3) - s.oxytocin) * 0.1 * Math.min(1, h * 2 + 0.1), 0, 1)
      // T06 加压素：被冒犯
      s.vasopressin = clamp(s.vasopressin * decay(dt, 90) + 0.4 * threat * (hyp?.aggression ?? 0.1), 0, 1)
      // T07 阿片：被安抚
      s.opioid = clamp(s.opioid * decay(dt, 60) + 0.3 * (soc?.comfort ?? 0), 0, 1)
      // T08 内源性大麻素：运动后
      s.endocannabinoid = clamp(s.endocannabinoid * decay(dt, 120) + (w.activity === 'sport' ? 0.3 : 0), 0, 1)
      s.frame += 1
    },
    read() {
      return {
        frame: s.frame,
        ne: s.ne, da: s.da, serotonin: s.serotonin, ach: s.ach,
        oxytocin: s.oxytocin, vasopressin: s.vasopressin, opioid: s.opioid, endocannabinoid: s.endocannabinoid,
        // 全局增益：高 NE 时所有阈值下调
        gain: clamp(1 + 0.4 * (s.ne - 0.3) - 0.2 * (s.serotonin - 0.5), 0.5, 1.8),
      }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
