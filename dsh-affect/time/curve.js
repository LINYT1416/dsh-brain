// 情绪曲线：五段 + 二次高峰 + 不应期 + 惯性 + 强度-时长权衡。
// 覆盖 W01 W02 W06 W07 W08 W09 W10。

import { clamp } from '../core/consts.js'

const PHASES = ['attack', 'peak', 'plateau', 'decay', 'residual']

export function create() {
  const fresh = () => ({
    onsetAt: 0, intensity: 0.1, last: 0.1,
    refractoryUntil: 0, secondPeakAt: 0,
    ambivalence: 0, phase: 'attack', frame: 0,
  })
  let s = fresh()

  return {
    id: 'curve',
    cover: ['W01', 'W02', 'W06', 'W07', 'W08', 'W09', 'W10'],
    step(w) {
      const now = w.tx.t1
      const ins = w.get('insula')
      const amy = w.get('amygdala')
      const dmn = w.get('dmn')
      const raw = clamp(ins?.felt.intensity ?? 0, 0, 1)
      const threat = amy?.threat ?? 0

      // W01 五段：发作快、平台、衰减、残留
      if (raw > s.intensity + 0.12) { s.onsetAt = now; s.intensity = raw }
      else s.intensity = clamp(raw, 0, 1)
      const age = now - s.onsetAt
      const phase = age < 2_000 ? 'attack' : age < 180_000 ? 'peak' : age < 1_200_000 ? 'plateau' : age < 10_800_000 ? 'decay' : 'residual'

      // W09 强度-时长权衡：高强度半衰短
      const half = s.intensity > 0.7 ? 40 : s.intensity > 0.4 ? 90 : 150
      const shaped = phase === 'attack' ? s.intensity * 0.7
        : phase === 'peak' ? s.intensity
          : phase === 'plateau' ? s.intensity * 0.95
            : phase === 'decay' ? s.intensity * Math.exp(-(age - 1_200_000) / (half * 60_000))
              : s.intensity * 0.15

      // W02 二次高峰：反刍把火又拱起来
      let second = 0
      if ((dmn?.rumination ?? 0) > 0.4 && age > 300_000) {
        second = 0.15 * (dmn.rumination)
        s.secondPeakAt = now
      }

      // W08 不应期：强威胁后一段时间哄不动
      if (threat > 0.6) s.refractoryUntil = Math.max(s.refractoryUntil, now + 600_000)
      const refractory = now < s.refractoryUntil

      // W07 惯性：变化有上限
      const target = clamp(shaped + second, 0, 1)
      const maxStep = 0.25
      s.last = clamp(s.last + clamp(target - s.last, -maxStep, maxStep), 0, 1)

      // W10 矛盾情绪：两股同时高于 0.4
      s.ambivalence = clamp((w.emotions ?? []).filter(e => e.intensity > 0.4).length > 1 ? 1 : 0, 0, 1)

      s.intensity = s.last
      s.phase = phase
      s.frame += 1
    },
    read() {
      const now = Date.now()
      return {
        frame: s.frame,
        phase: s.phase,
        intensity: s.intensity,
        refractory: s.refractoryUntil > now,   // W08 不应期：真的看时间
        ambivalence: s.ambivalence,
        secondPeak: s.secondPeakAt,
      }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
