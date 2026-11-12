// 输入偏置：心情差只看见坏的 / 敌意归因 / 心境一致。
// 覆盖 O01 O02 O03。作用在"解读"上，不是"表达"上。

import { clamp } from '../core/consts.js'

export function create() {
  const fresh = () => ({ neg: 0, hostile: 0, congruent: 0, frame: 0 })
  let s = fresh()

  return {
    id: 'bias',
    cover: ['O01', 'O02', 'O03'],
    step(w) {
      const mood = w.mood ?? 0
      const amy = w.get('amygdala')
      const soc = w.get('social')
      const hip = w.get('hippocampus')
      const nmod = w.get('neuromod')
      // O01 负性偏置：心情越低，越容易把中性读成负面
      s.neg = clamp(-mood * 0.6 + 0.2 * (nmod?.ne ?? 0.3), 0, 1)
      // O02 敌意归因：信任低 + 被这个人伤过（M12 社会记忆）
      const hurts = hip?.persons?.他?.hurts ?? 0
      s.hostile = clamp((1 - (soc?.trust ?? 0.6)) * 0.5 + 0.4 * ((amy?.threat ?? 0) > 0.5 ? 1 : 0) + 0.05 * hurts, 0, 1)
      // O03 心境一致性：记忆检索的偏置量
      s.congruent = clamp(Math.abs(mood), 0, 1)
      s.frame += 1
    },
    read() {
      return { frame: s.frame, neg: s.neg, hostile: s.hostile, congruent: s.congruent }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
