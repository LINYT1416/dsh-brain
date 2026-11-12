// 杏仁核：A 段快评（先反应）+ B 段衰减/消退/泛化（后解释）。
// 覆盖 A01-A21。不产生感受、不做标签、不存原话。

import { clamp, decay, pragmatics, sat } from '../core/consts.js'

const P = {
  tauThreat: 8, tauNe: 25, tauCort: 70,
  sensGain: 0.15, sensMax: 2.5,
  threatStepCap: 0.35,
  generalizePower: 2,
  contextGain: 0.1,
}

export function create(cfg = {}) {
  const p = { ...P, ...cfg }
  const fresh = () => ({
    threat: 0.05, fastThreat: 0, rewardPE: 0, novelty: 0,
    ne: 0.1, cort: 0.1, freeze: 0, captureUntil: 0,
    sens: {}, safety: {}, exposures: {}, context: {}, generalized: {},
    lastKind: 'neutral', cue: '', lastLen: 0,
    frame: 0, stale: false,
  })
  let s = fresh()

  const cueOf = (f) => (f.cold ? '冷' : f.imperative ? '命令' : f.negation ? '否定' : f.warm ? '热' : '')

  return {
    id: 'amygdala',
    cover: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'K06', 'X04'],
    params: p,

    /** A 段：只做快评，不衰减（先反应） */
    fast(w) {
      let threatIn = 0, warm = 0, novelty = 0, cue = ''
      for (const ev of w.tx.events) {
        if (ev.type !== 'user' && ev.type !== 'assistant') continue
        const f = pragmatics(ev.text)
        if (f.apology) {
          s.threat = Math.max(0.05, s.threat * 0.45)
          for (const k of Object.keys(s.sens)) s.sens[k] = Math.max(1, s.sens[k] * 0.9)
          s.lastKind = 'apology'
          continue
        }
        // A01 低路：语用特征，几十毫秒
        threatIn = Math.max(threatIn, clamp(
          0.35 * f.cold + 0.15 * (f.negation > 0 ? 1 : 0) + 0.40 * f.imperative +
          0.12 * Math.min(1, f.secondPerson / 3) + 0.10 * Math.min(1, f.intensifier / 2) +
          0.20 * (f.exclaim > 0 ? 1 : 0),
          0, 0.9,
        ))
        // A14 社会性线索：轻蔑/排斥
        if (/呵呵|随便你|关我什么事|你开心就好/.test(ev.text)) threatIn = Math.max(threatIn, 0.45)
        // A15 替代学习：对方难受，自己也紧一下
        if (/难受|崩溃|哭了|失眠|压力大|烦死/.test(ev.text)) s.threat = clamp(s.threat + 0.10, 0, 1)
        // A16 不确定性：模糊比确定更吓人
        if (/也许|可能|大概|不确定|不知道|看情况/.test(ev.text)) s.threat = clamp(s.threat + 0.05, 0, 1)
        // A21 自我评价：她说了重话，自己也会被点着
        if (ev.type === 'assistant' && /你行不行|做不好|随便|闭嘴|烦不烦|算了/.test(ev.text)) s.threat = clamp(s.threat + 0.08, 0, 1)
        warm = Math.max(warm, f.polarity > 0 ? 0.55 : 0)
        novelty = clamp(Math.abs(f.length - s.lastLen) / 40, 0, 1)
        cue = cueOf(f)
        s.lastKind = f.polarity > 0 ? 'positive' : (f.polarity < 0 || f.cold) ? 'negative' : 'neutral'
        s.lastLen = f.length
      }
      const sens = cue ? (s.sens[cue] ?? 1) : 1
      const hype = w.get('hypothalamus')
      const sleepDebt = hype?.sleepDebt ?? 0.2
      const before = s.threat
      // A12 敏化 + tone 放大 + A19 缺觉抬增益
      s.threat = clamp(s.threat * decay(w.tx.dtMs, p.tauThreat) +
        threatIn * sens * (1 + 0.6 * s.ne) * (1 + 0.6 * sleepDebt), 0, 1)
      s.threat = Math.min(s.threat, before + p.threatStepCap)   // 单帧熔断
      s.fastThreat = s.threat
      s.rewardPE = warm > 0 ? clamp(warm - 0.1, -1, 1) : 0
      // 记忆先验：想起的事会先把威胁垫高一点（只读记忆，不写它）
      const echo = w.memoryEcho
      if (echo) {
        const neg = Math.max(0, -echo.tone)
        const pos = Math.max(0, echo.tone)
        s.threat = clamp(s.threat + 0.12 * neg, 0, 1)
        s.rewardPE = clamp(s.rewardPE + 0.05 * pos, -1, 1)
      }
      s.memSalience = w.memorySalience ?? null
      s.novelty = novelty
      s.cue = cue
      if (threatIn > 0.2 && cue) {
        // A05 线索学习：同一类线索反复被扎 → 敏化
        s.sens[cue] = Math.min(p.sensMax, (s.sens[cue] ?? 1) + p.sensGain)
        s.exposures[cue] = (s.exposures[cue] || 0) + 1
      }
      s.freeze = sat(s.threat * 3) * (s.threat > 0.75 ? 1 : 0.2)   // A20
      // A17 注意捕获：高唤醒时同窗口条目一起加权
      if (s.threat > 0.6) s.captureUntil = w.tx.t1 + 5000
      s.frame += 1
    },

    /** B 段：慢回路修正（A02）、消退、泛化、情境 */
    step(w) {
      const dt = w.tx.dtMs
      // A02 慢评：归因到位后，威胁可被下调
      const pfc = w.get('pfc')
      if (pfc && pfc.attribution) {
        if (pfc.attribution.locus === 'circumstance') s.threat *= 0.92
        if (pfc.attribution.confidence > 0.7 && s.threat > 0.3) s.threat *= 0.96
      }
      // A07 消退：pfcGain 压 safety（X04：用上一帧的增益，避免同帧成环）
      const gain = w.prevGain ?? 0.5
      if (s.cue) s.safety[s.cue] = clamp((s.safety[s.cue] ?? 0) + 0.02 * gain * s.threat, 0, 1)
      // M15 想起旧事 → 威胁被重新激活
      const re = w.get('hippocampus')?.reactivate ?? 0
      if (re) s.threat = clamp(s.threat + 0.2 * re, 0, 1)
      for (const k of Object.keys(s.safety)) {
        if (s.cue !== k) s.safety[k] *= Math.pow(0.97, dt / 3600_000)   // A08 自发恢复
      }
      // A13 适应：无威胁重复暴露
      for (const k of Object.keys(s.sens)) {
        if (k !== s.cue) s.sens[k] = Math.max(1, s.sens[k] * Math.pow(0.97, dt / 3600_000))
      }
      // A06 情境恐惧
      const scene = w.scene || 'home'
      s.context[scene] = clamp((s.context[scene] ?? 0) * 0.999 + 0.001 * s.threat, 0, 1)
      // A09/A10 复燃与应激复现：高皮质醇时旧恐惧回升
      if (s.cort > 0.6 && s.cue && s.safety[s.cue]) {
        s.threat = clamp(s.threat + 0.05 * s.safety[s.cue], 0, 1)
      }
      // A11 泛化
      for (const [k, v] of Object.entries(s.sens)) {
        if (k !== s.cue) s.generalized[k] = Math.max(v * 0.25, s.generalized[k] ?? 0)
      }
      // tone
      s.ne = clamp(s.ne * decay(dt, p.tauNe) + 0.4 * s.fastThreat, 0, 1)
      s.cort = clamp(s.cort * decay(dt, p.tauCort) + 0.03 * s.threat, 0, 1)
      s.frame += 1
    },

    /** A15/A16/A21 由外部注入的事件 */
    inject({ vicarious = 0, uncertainty = 0, selfThreat = 0 } = {}) {
      if (vicarious) s.threat = clamp(s.threat + 0.1 * vicarious, 0, 1)
      if (uncertainty) s.threat = clamp(s.threat + 0.08 * uncertainty, 0, 1)
      if (selfThreat) s.threat = clamp(s.threat + 0.1 * selfThreat, 0, 1)
    },

    read() {
      const sensMax = Math.max(1, ...Object.values(s.sens))
      // A03 显著性：威胁 + 奖赏 + 新异 + 余韵，饱和
      // A18 这个 salience 就是给海马体的编码门控
      const salience = sat(1.2 * s.threat + 0.8 * Math.abs(s.rewardPE) + 0.5 * s.novelty + 0.3 * (s.ne + s.cort) / 2 + 0.3 * (s.memSalience ?? 0))
      return {
        frame: s.frame,
        threat: s.threat, fastThreat: s.fastThreat, // K06 先有快评，后有慢评
        rewardPE: s.rewardPE, novelty: s.novelty,   // A04
        salience: clamp(salience, 0, 1), ne: s.ne, cort: s.cort,
        sensMax, freeze: s.freeze, kind: s.lastKind, cue: s.cue,
        capture: s.captureUntil > Date.now() ? 0.5 : 0,   // A17
        context: { ...s.context }, safety: { ...s.safety },
      }
    },
    snapshot: () => ({ ...s, sens: { ...s.sens }, safety: { ...s.safety }, exposures: { ...s.exposures }, context: { ...s.context }, generalized: { ...s.generalized } }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
