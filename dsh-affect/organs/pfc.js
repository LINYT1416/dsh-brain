// 前额叶皮层：刹车、方向盘、编剧。覆盖 P01-P23。
// 会累、会漏、会失败。永远理智的不是前额叶。

import { clamp, decay } from '../core/consts.js'

const P = {
  baseCap: 0.8, suppressionBase: 0.3, leakGain: 1.5,
  fatigueRate: 0.02, recoveryRate: 0.15,
  reappraisalCost: 0.15, reappraisalMax: 0.75,
}

export function create(cfg = {}) {
  const p = { ...P, ...cfg }
  const fresh = () => ({
    bandwidth: 0.7, cap: 0.8, load: 0.3, fatigue: 0.1,
    slots: 4, suppression: 0.3, mask: 0.3,
    toneShift: 'normal', brevity: 0.3, leakRisk: 0.2,
    attribution: { locus: 'other', stability: 'temporary', globality: 'specific', blame: '他', confidence: 0.5 },
    reappraisal: { strategy: 'none', success: false, cost: 0, at: 0 },
    conflict: 0, delay: { urge: 0, resisted: false, at: 0 },
    decision: { speak: true, now: true, yield: false, hold: false },
    repair: 0, timePressure: 0, pfcGain: 0.5,
    labeling: 0, selfRef: 0.5, counterfactual: 0, regret: 0, moral: 0,
    error: 0,
    frame: 0,
  })
  let s = fresh()

  return {
    id: 'pfc',
    cover: ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21', 'P22', 'P23', 'C05'],
    params: p,

    step(w) {
      const dt = w.tx.dtMs
      const h = clamp(dt / 3600_000, 0, 24)
      const hyp = w.get('hypothalamus')
      const amy = w.get('amygdala')
      const ins = w.get('insula')
      const hip = w.get('hippocampus')
      const soc = w.get('social')
      const att = w.get('attention')
      if (!hyp) return

      const felt = ins?.felt.intensity ?? 0
      const threat = amy?.threat ?? 0

      // P16 带宽：受下丘脑上限、疲劳、情绪占用、资源池（C01）影响；取 min 不相乘（C05）
      const lim = w.limits?.inhibit ?? 1
      const cap = Math.min(p.baseCap, hyp.bandwidthCap, 1 - 0.2 * s.fatigue) * (0.7 + 0.3 * lim)
      // P01 工作记忆槽位：同时处理的事情越多，带宽越少
      const busy = clamp((w.tx.events.length + (w.queue ?? 0)) / 5, 0, 1)
      s.slots = clamp(4 - Math.floor(busy * 3), 1, 4)
      s.load = clamp(0.35 * s.suppression + 0.25 * clamp(felt - 0.5, 0, 1) + 0.2 * s.conflict + 0.1 * busy, 0, 1)
      s.cap = cap
      s.bandwidth = clamp(s.bandwidth * decay(dt, 60) + (cap - s.load) * (1 - Math.exp(-h * 2)), 0, 1)
      // 接口一致性：带宽永远不许超过上限
      s.bandwidth = Math.min(s.bandwidth, s.cap)

      // P02/P03 抑制：想露多少 vs 该露多少
      const relationship = soc?.relationship ?? 'close'
      const want = clamp(0.4 + 0.6 * felt, 0, 1)
      const should = relationship === 'stranger' ? 0.35 : threat > 0.5 ? 0.4 : 0.62
      s.suppression = clamp(p.suppressionBase + 0.4 * (want - should), 0, 0.95)
      s.load = clamp(s.load + 0.25 * s.suppression, 0, 1)
      s.mask = s.suppression
      s.brevity = clamp(0.3 + 0.5 * s.suppression, 0, 1)
      s.leakRisk = clamp((1 - s.bandwidth) * s.suppression * p.leakGain, 0, 1)

      // P04 重评：三条件 + 冷却（不能每帧都重评，否则带宽被自己吃掉）
      const evidence = hip?.recall?.hit || (hip?.count ?? 0) > 0
      // M13 图式：如果她已经有"他就是这样"的结论，重评会被挡住
      const schemaBlocks = (hip?.schemas ?? []).some(x => x.confidence > 0.7)
      const sinceTry = w.tx.t1 - (s.reappraisal.at || 0)
      const can = s.bandwidth > 0.3 && evidence && threat > 0.3 && sinceTry > 300_000 && !schemaBlocks
      const roll = w.rng()
      if (can && roll < p.reappraisalMax) {
        // P15 调节策略选择：按关系挑策略
        s.reappraisal = { strategy: pickStrategy(relationship), success: true, cost: p.reappraisalCost, at: w.tx.t1 }
        s.bandwidth = clamp(s.bandwidth - p.reappraisalCost, 0, 1)
      } else if (can) {
        s.reappraisal = { strategy: 'failed', success: false, cost: 0.1, at: w.tx.t1 }
        s.bandwidth = clamp(s.bandwidth - 0.1, 0, 1)
      }

      // P08 错误监测：自己说了重话 → 不适上升
      for (const ev of w.tx.events) {
        if (ev.type === 'assistant' && /你行不行|做不好|随便|闭嘴|烦不烦|算了/.test(ev.text)) s.error = clamp(s.error + 0.2, 0, 1)
      }
      s.error = clamp(s.error * decay(dt, 20), 0, 1)
      s.conflict = clamp(s.conflict + 0.2 * s.error, 0, 1)

      // P07 冲突：想说 vs 该说
      s.conflict = clamp(Math.abs(want - should) * 0.7 + (s.delay.urge > 0.4 ? 0.3 : 0), 0, 1)

      // P06 价值整合：值不值得为这事翻脸
      s.value = clamp(0.5 + 0.4 * (soc?.trust ?? 0.6) - 0.3 * threat + 0.2 * (soc?.comfort ?? 0), 0, 1)
      // P12 心理理论：带宽够才猜得准对方
      s.theoryOfMind = clamp(0.3 + 0.5 * s.bandwidth + 0.2 * (soc?.trust ?? 0.6), 0, 1)
      // P18 自上而下注意控制
      s.topDown = clamp(s.bandwidth * 0.9, 0, 1)
      // P20 自我参照
      s.selfRef = clamp(0.5 + 0.3 * (soc?.selfOther ?? 0.5), 0, 1)

      // P11 归因（带置信度）
      const hostile = (w.get('bias')?.hostile ?? 0)
      const selfBlame = (amy?.rewardPE ?? 0) < -0.2 && threat < 0.2
      s.attribution = selfBlame
        ? { locus: 'self', stability: 'temporary', globality: 'specific', blame: '自己', confidence: 0.7 }
        : threat > 0.6
          ? { locus: 'other', stability: hostile > 0.6 ? 'stable' : 'temporary', globality: hostile > 0.6 ? 'global' : 'specific', blame: '他', confidence: 0.45 + 0.3 * hostile }
          : { locus: 'circumstance', stability: 'temporary', globality: 'specific', blame: '环境', confidence: 0.5 }

      // P14 表达规则
      const displayRules = relationship === 'stranger' ? 0.2 : relationship === 'close' ? 0.7 : 0.4
      const valence = clamp((amy?.rewardPE ?? 0) - 0.7 * threat, -1, 1)
      s.toneShift = s.bandwidth < 0.15 ? 'flat'
        : (valence < -0.25 || felt > 0.45 || s.suppression > 0.55) ? 'hard'
          : (valence > -0.05 && threat < 0.15 && felt < 0.3) ? 'soft' : 'normal'

      // P05 消退增益（给杏仁核）
      s.pfcGain = clamp(s.bandwidth * (1 - 0.3 * hyp.sleepDebt), 0, 1)

      // P09/P10 决策与延迟
      s.decision = {
        speak: s.bandwidth > 0.15,
        now: s.bandwidth > 0.35,
        yield: s.value > 0.55 && threat < 0.6,   // P06：值不值得低头
        hold: s.delay.resisted,
      }
      if (s.delay.urge > 0.5 && s.bandwidth > 0.35) {
        s.delay.resisted = true
        if (w.tx.t1 - (s.delay.at || 0) > 600_000) { s.delay.urge *= 1.2; s.delay.resisted = false; s.delay.at = w.tx.t1 }
      }

      // P09 延迟满足：想说的话压着
      if (threat > 0.45 && s.bandwidth > 0.3) s.delay.urge = clamp(s.delay.urge + 0.2, 0, 1)
      else s.delay.urge = clamp(s.delay.urge * 0.9, 0, 1)
      // P19 命名：她把自己感觉说出口
      for (const ev of w.tx.events) {
        if (ev.type === 'assistant' && /我(有点|好像|可能|觉得)/.test(String(ev.text || ''))) s.labeling = clamp(s.labeling + 0.2, 0, 1)
      }

      // P19 命名：说出来就轻一点
      const label = (w.get('io')?.labeled ?? 0)
      if (label) s.labeling = clamp(s.labeling + 0.3, 0, 1)

      // P21 反事实 / P17 后悔
      if ((amy?.rewardPE ?? 0) < -0.3) s.counterfactual = clamp(s.counterfactual + 0.2, 0, 1)
      s.regret = clamp(s.counterfactual * 0.5 + s.conflict * 0.3, 0, 1)

      // P22 事后找补：说重了会补一句
      if (threat > 0.5 && s.bandwidth > 0.4 && s.repair < 1) s.repair = clamp(s.repair + 0.1, 0, 1)

      // P23 时间压力：赶时间时压住情绪
      s.timePressure = clamp((w.get('hypothalamus')?.needs?.meaning ?? 0) * 0.2, 0, 1)
      if (s.timePressure > 0.5) s.suppression = clamp(s.suppression + 0.1, 0, 0.95)

      // 疲劳
      s.fatigue = clamp(s.fatigue + p.fatigueRate * h * (s.suppression + 0.4) - p.recoveryRate * h * (hyp.sleepDebt < 0.3 ? 1 : 0.3), 0, 1)
      s.selfRef = clamp(0.5 + 0.3 * (soc?.selfOther ?? 0.5), 0, 1)
      s.moral = clamp(s.moral * 0.99 + (threat > 0.6 ? 0.05 : 0), 0, 1)   // P13 道德判断
      s.frame += 1
    },

    read() {
      return {
        frame: s.frame,
        bandwidth: s.bandwidth, cap: s.cap, load: s.load, fatigue: s.fatigue, slots: s.slots,
        display: { mask: s.mask, toneShift: s.toneShift, brevity: s.brevity, leakRisk: s.leakRisk, rules: 0.7 },
        attribution: { ...s.attribution },
        reappraisal: { ...s.reappraisal },
        conflict: s.conflict,
        decision: { ...s.decision },
        pfcGain: s.pfcGain,
        repair: s.repair,
        regret: s.regret,
        error: s.error,
        value: s.value,
    theoryOfMind: s.theoryOfMind,
    topDown: s.topDown,
    moral: s.moral,
    selfRef: s.selfRef,
    labeling: s.labeling,
        timePressure: s.timePressure,
      }
    },
    snapshot: () => ({ ...s, attribution: { ...s.attribution }, reappraisal: { ...s.reappraisal }, decision: { ...s.decision } }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}

function pickStrategy(rel) {
  const pool = rel === 'close' ? ['换框架', '找反例', '拉远'] : ['拉远', '接受']
  return pool[Math.floor(Math.random() * pool.length)]
}
