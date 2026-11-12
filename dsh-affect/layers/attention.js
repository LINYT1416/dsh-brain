// 注意层：丘脑门控 / 顶叶定向 / 凸显网络 / 窄化 / 黏着 / 脱离。覆盖 N01-N06。

import { clamp, decay } from '../core/consts.js'

export function create(cfg = {}) {
  const fresh = () => ({
    gate: 1, focus: 0.4, salienceNet: 0.2,
    narrowing: 0, sticky: 0, onBody: 0.3,
    target: 'chat', frame: 0,
  })
  let s = fresh()

  return {
    id: 'attention',
    cover: ['N01', 'N02', 'N03', 'N04', 'N05', 'N06'],
    step(w) {
      const dt = w.tx.dtMs
      const amy = w.get('amygdala')
      const hyp = w.get('hypothalamus')
      const threat = amy?.threat ?? 0
      const arousal = clamp(0.5 * threat + 0.5 * (hyp?.hpa?.cortisol ?? 0), 0, 1)

      // N01 门控：高唤醒时过滤无关信息
      s.gate = clamp(1 - 0.5 * arousal, 0.3, 1)
      // N03 凸显网络：高显著事件打断
      s.salienceNet = clamp((amy?.salience ?? 0) * s.gate, 0, 1)
      // N02 定向：新异刺激抢注意
      if (w.tx.events.some(e => e.type === 'user')) s.focus = clamp(0.4 + 0.5 * (amy?.novelty ?? 0), 0, 1)
      else s.focus = clamp(s.focus - 0.1 * (dt / 60_000), 0, 1)
      // N04 窄化：高情绪时只看见坏的
      s.narrowing = clamp(0.6 * threat + 0.2 * arousal, 0, 1)
      // N05 黏着：生气时越想越气；P18 自上而下能把它拉回来一点
      const topDown = w.get('pfc')?.topDown ?? 0.5
      s.sticky = clamp(s.sticky * decay(dt, 20) + 0.4 * threat * (1 - (w.get('pfc')?.bandwidth ?? 0.6)) * (1 - 0.3 * topDown), 0, 1)
      // N06 脱离：转移注意可回落
      const dis = w.tx.events.some(e => e.type === 'activity')
      if (dis) s.sticky *= 0.7
      // 对身体注意的比例（岛叶精度用）
      s.onBody = clamp(0.2 + 0.4 * s.sticky + 0.3 * s.narrowing, 0, 1)
      s.frame += 1
    },
    read() {
      return {
        frame: s.frame,
        gate: s.gate, focus: s.focus, salienceNet: s.salienceNet,
        narrowing: s.narrowing, sticky: s.sticky, onBody: s.onBody, target: s.target,
      }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
