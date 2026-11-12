// 社会层：自我/他人、心智化、共情、排斥、依恋、账本、地位、传染、共情疲劳、态度、信任。
// 覆盖 S01-S12。

import { clamp, decay } from '../core/consts.js'

export function create(cfg = {}) {
  const fresh = () => ({
    selfOther: 0.7, mindRead: 0.5, affectiveEmpathy: 0.5, cognitiveEmpathy: 0.5,
    socialPain: 0, attachment: 'secure', ledger: [], status: 0.5,
    contagionOut: 0, empathyFatigue: 0,
    attitude: {}, trust: 0.6,
    otherFelt: 0, similarity: 0.6, comfort: 0,
    relationship: 'close', frame: 0,
  })
  let s = fresh()

  return {
    id: 'social',
    cover: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12'],
    step(w) {
      const dt = w.tx.dtMs
      const amy = w.get('amygdala')
      const ins = w.get('insula')
      const hip = w.get('hippocampus')
      const threat = amy?.threat ?? 0

      // S01 自我/他人区分：威胁对象是不是"他"
      s.selfOther = clamp(0.5 + 0.4 * (amy?.kind === 'negative' ? 1 : 0), 0, 1)
      // S02 心智化：带宽高才猜得准
      s.mindRead = clamp(0.3 + 0.6 * (w.get('pfc')?.bandwidth ?? 0.6), 0, 1)
      // S03 情感共情
      s.affectiveEmpathy = clamp(0.5 * (ins?.resonance ?? 0) + 0.3 * s.trust, 0, 1)
      // S04 认知共情
      s.cognitiveEmpathy = clamp(0.4 + 0.4 * s.mindRead, 0, 1)
      // S05 社会排斥痛：被冷落
      const cold = amy?.kind === 'negative' && (amy?.cue === '冷')
      const talking = w.tx.events.some(e => e.type === 'user')
      s.socialPain = clamp(s.socialPain * decay(dt, 15) + (cold ? 0.35 : 0) - (talking && !cold ? 0.15 : 0), 0, 1)
      // S06 依恋：延迟回复 → 焦虑（只对对方行为，不因自己延迟）
      const gap = w.gapMs ?? 0
      if (s.attachment === 'anxious' && gap > 300_000) s.socialPain = clamp(s.socialPain + 0.05, 0, 1)
      // S07 账本：没清的事
      if (threat > 0.6 && !s.ledger.find(x => !x.cleared)) s.ledger.push({ at: w.tx.t1, reason: '那句话说重了', cleared: false })
      if (amy?.kind === 'apology') for (const l of s.ledger) l.cleared = true
      // S08 地位
      s.status = clamp(s.status + (threat > 0.5 ? -0.02 : 0.01) * (dt / 3600_000), 0, 1)
      // S09 情绪传染（她→他）
      s.contagionOut = clamp(0.5 * (ins?.felt.intensity ?? 0) + 0.3 * (w.mood ?? 0) * -1, 0, 1)
      // S10 共情疲劳
      if (w.tx.events.some(e => e.type === 'other_distress')) s.empathyFatigue = clamp(s.empathyFatigue + 0.15, 0, 1)
      s.empathyFatigue = clamp(s.empathyFatigue * decay(dt, 240), 0, 1)
      // S06 依恋模型：信任低 → 焦虑型；信任高 → 安全型
      s.attachment = s.trust < 0.4 ? 'anxious' : s.trust > 0.7 ? 'secure' : 'avoidant'
      s.trust = clamp(s.trust + (amy?.kind === 'apology' ? 0.05 : 0) - (threat > 0.7 ? 0.1 : 0) * (dt / 60_000), 0, 1)
      // S11 对人的态度：长期累积，反过来拉信任
      const who2 = '他'
      s.attitude[who2] = clamp((s.attitude[who2] ?? 0) + (threat > 0.5 ? -0.02 : 0.01), -1, 1)
      // 信任：一次互动只加一点，封顶 0.85——两天聊天不可能变满分
      // 信任慢慢长：这里以前是 +0.006/拍（不看时间），面板一开就几十拍，几分钟信任就满。
      // 现在按小时走：态度好时每小时 +0.36，天花板 0.85。
      s.trust = clamp(s.trust + 0.36 * (dt / 3600_000) * s.attitude[who2], 0, 0.85)
      // 对方状态（供岛叶共振）
      s.otherFelt = clamp((w.other ?? 0), 0, 1)
      s.comfort = clamp((s.trust - 0.5) * 2, 0, 1)
      s.frame += 1
    },
    read() {
      return {
        frame: s.frame,
        selfOther: s.selfOther, mindRead: s.mindRead,
        affectiveEmpathy: s.affectiveEmpathy, cognitiveEmpathy: s.cognitiveEmpathy,
        socialPain: s.socialPain, attachment: s.attachment, status: s.status,
        contagionOut: s.contagionOut, empathyFatigue: s.empathyFatigue,
        attitude: { ...s.attitude }, trust: s.trust,
        otherFelt: s.otherFelt, similarity: s.similarity, comfort: s.comfort,
        relationship: s.relationship,
        ledgerOpen: s.ledger.filter(l => !l.cleared).length,
      }
    },
    snapshot: () => ({ ...s, ledger: s.ledger.map(l => ({ ...l })), attitude: { ...s.attitude } }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
