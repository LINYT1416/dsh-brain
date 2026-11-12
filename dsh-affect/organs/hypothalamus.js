// 下丘脑：需求、节律、HPA、自主神经、周期。覆盖 H01-H20。

import { clamp, decay, gauss, hourOf, nightFraction } from '../core/consts.js'

const P = {
  hungerRate: 0.06, contactRate: 0.10, thirstRate: 0.05,
  cortTau1: 8, cortTau2: 70,
}

export function create(cfg = {}) {
  const p = { ...P, ...cfg }
  const fresh = () => ({
    hunger: 0.28, thirst: 0.2, sleep: 0.15, warmth: 0.1,
    contact: 0.35, control: 0.2, meaning: 0.2,
    sleepDebt: 0.15, cortisol: 0.15, ne: 0.1, stressLoad: 0,
    sleepGate: 1, energyAlloc: 1,    sym: 0.3, par: 0.6,
    temp: 0.1, pain: 0.15, painGate: 1,
    oxytocin: 0.3, vasopressin: 0.3, testosterone: 0.5,
    estrogen: 0.5, cycleDay: 14, cycleOn: cfg?.cycle?.on !== false, cycleStart: cfg?.cycle?.lastStart || (Date.now() - 12 * 86400_000), cycleLen: cfg?.cycle?.len || 28,
    stimulant: 0, caffeine: 0,
    aggression: 0.1, freeze: 0,
    frame: 0,
  })
  let s = fresh()

  const wave = (h) =>
    // H05 昼夜节律：双相波，不用随机游走
    0.55 + 0.25 * gauss(h, 10, 3) + 0.20 * gauss(h, 20, 2.5) - 0.18 * gauss(h, 15, 2) - 0.25 * gauss(h, 3.5, 2)

  return {
    id: 'hypothalamus',
    cover: ['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H10', 'H11', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17', 'H18', 'H19', 'H20'],
    params: p,

    step(w) {
      const dt = w.tx.dtMs
      const h = clamp(dt / 3600_000, 0, 24)
      const amy = w.get('amygdala')
      const threat = amy?.threat ?? 0
      const hour = hourOf(w.tx.t1)
      const night = hour >= 23 || hour < 6
      const nightTalking = w.tx.events.some(e => e.type === 'user')

      // H03 饿到一定程度会自己去吃（不需要谁提醒）
      if (s.hunger > 0.85 && !nightTalking) {
        s.hunger = 0.2
        s.ateAt = w.tx.t1
      }

      // H03/H02/H17 需求漂移
      // 这里必须只按"过了多少小时"涨。以前额外挂了个 +0.05 的常数，
      // 等于每拍加 5 个点——面板每秒刷新一次就是每秒涨 5 点，看着像发疯。
      s.hunger = clamp(s.hunger + p.hungerRate * h * (night ? 1.2 : 1), 0, 1)
      s.thirst = clamp(s.thirst + p.thirstRate * h, 0, 1)
      s.sleep = clamp(s.sleep + 0.05 * h * (night ? 2 : 1), 0, 1)
      // 社交/掌控/意义/温度：各有漂移，也有被满足的路径
      s.contact = clamp(s.contact + (w.tx.events.some(e => e.type === 'user') ? -0.05 : 0.10 * h), 0, 1)
      s.control = clamp(s.control + (threat > 0.5 ? 0.08 * h : -0.03 * h), 0, 1)
      s.meaning = clamp(s.meaning + 0.004 * h, 0, 1)
      s.warmth = clamp(s.warmth + (night ? 0.02 * h : -0.02 * h), 0, 1)
      // H04 睡眠：按区间里"落在夜里"的比例还睡眠债；正在说话只减半，不整段扣掉
      const nightFrac = nightFraction(w.tx.t0, w.tx.t1)
      if (nightFrac > 0.05) {
        const eff = nightTalking ? 0.5 : 1
        s.sleepDebt = clamp(s.sleepDebt - 0.15 * h * nightFrac * eff, 0, 1)
        s.sleep = clamp(s.sleep - 0.2 * h * nightFrac * eff, 0, 1)
      } else {
        s.sleepDebt = clamp(s.sleepDebt + 0.03 * h, 0, 1)
      }
      // H14 预期性：饭点前加速（同样按小时算，不能每一拍都加一点）
      if (hour > 11 && hour < 12.5) s.hunger = clamp(s.hunger + 0.06 * h, 0, 1)

      // H06 HPA 二阶（解析解）
      const k1 = 1 - Math.exp(-h * 60 / p.cortTau1)
      const k2 = 1 - Math.exp(-h * 60 / p.cortTau2)
      const drive = threat * 0.8 + s.stressLoad * 0.2
      s.cortisol = clamp(s.cortisol + (drive - s.cortisol) * k1 * 0.5, 0, 1)
      s.cortisol = clamp(s.cortisol - s.cortisol * k2 * 0.25, 0, 1)
      // H11 应激累积与受体下调
      s.stressLoad = clamp(s.stressLoad + (threat > 0.5 ? 0.03 : -0.01) * h, 0, 1)

      // H07 自主神经
      // 以前写的是 * 0.25 * Math.min(1, h*4 + 0.2)：那个 +0.2 等于"每一拍至少走 20% 的一步"，
      // 面板一秒刷新一次，交感/副交感就每拍走 5%，心率几分钟能跑十几点。改成按时间常数收敛。
      const aSym = 1 - Math.exp(-h / (3 / 60))   // 3 分钟量级
      const aPar = 1 - Math.exp(-h / (5 / 60))   // 5 分钟量级
      s.sym = clamp(s.sym + (0.25 + 0.6 * threat + 0.2 * s.stimulant - s.sym) * aSym, 0, 1)
      s.par = clamp(s.par + (0.7 - 0.3 * threat - s.par) * aPar, 0, 1)

      // H19 咖啡因半衰 5h
      s.stimulant = clamp(s.stimulant + s.caffeine * 0.6 - s.stimulant * (1 - decay(dt, 300)), 0, 1)
      s.caffeine *= decay(dt, 300)

      // H08 攻击：威胁 × 管不住 × 睾酮（E04 从上一帧读）
      const test = w.get('endocrine')?.testosterone ?? 0.5
      s.aggression = clamp((0.1 + 0.7 * threat * (1 - (w.get('pfc')?.bandwidth ?? 0.6))) * (1 + 0.3 * (test - 0.5)), 0, 1)
      // B01/B02 呼吸与心率由脑干给（上一帧），这里只做兜底
      const bs = w.get('brainstem')
      s.bsHr = bs?.heartRate ?? null
      s.bsBreath = bs?.respiration ?? null
      // H12 疼痛门控
      s.painGate = clamp(1 - 0.4 * s.sym, 0.3, 1)
      // H10 依恋激素
      s.oxytocin = clamp(s.oxytocin + (0.3 - s.oxytocin) * (1 - decay(dt, 120)), 0, 1)
      // H13 进食 / H19 咖啡因：从对话里读（没有 activity 事件时也不至于永远不触发）
      for (const ev of w.tx.events) {
        const t = String(ev.text || '')
        if (ev.type === 'activity') {
          if (/吃|饭/.test(ev.kind || '')) s.hunger = 0.2
          if (/睡/.test(ev.kind || '')) s.sleepDebt = Math.max(0, s.sleepDebt - 0.4)
        } else if (ev.type === 'user') {
          if (/咖啡|拿铁|美式|奶茶|茶/.test(t)) s.caffeine = clamp(s.caffeine + 0.3, 0, 1)
          if (/吃了|吃完|外卖|泡面|做饭|面条|面包/.test(t)) s.hunger = Math.max(0.1, s.hunger - 0.35)
        }
      }
      // H15 周期：默认开；按距离上次开始的天数算相位
      if (s.cycleOn) {
        const days = Math.floor((w.tx.t1 - new Date(s.cycleStart).getTime()) / 86400_000)
        const len = Number(s.cycleLen) || 28
        s.cycleDay = ((days % len) + len) % len + 1
        const pre = s.cycleDay > len - 4     // 经前
        const period = s.cycleDay <= 5       // 经期
        s.estrogen = period ? 0.3 : pre ? 0.35 : 0.6
        s.cyclePhase = period ? '经期' : pre ? '经前' : '平常'
      } else {
        s.cyclePhase = null
        s.estrogen = 0.5
      }
      // H16 能量分配：生病时省电
      s.energyAlloc = 1 - 0.3 * (w.get('sickness')?.inflammation ?? 0) - 0.2 * (w.get('sickness')?.fatigue ?? 0)

      // H18 入睡/醒来：深夜且睡眠压力高时，反应变慢
      s.sleepGate = clamp(1 - (night ? 0.35 : 0) - s.sleepDebt * 0.25, 0.25, 1)
      // H10 依恋激素：与内分泌模块对齐（上一帧）
      const endo = w.get('endocrine')
      if (endo) {
        s.oxytocin = endo.oxytocin
        s.testosterone = endo.testosterone
        s.estrogen = endo.estrogen
      }
      s.ne = amy?.ne ?? s.ne
      s.frame += 1
    },

    read() {
      const hour = hourOf(Date.now())
      const energyWave = wave(hour)
      const energy = clamp(energyWave * (1 - 0.5 * s.sleepDebt) * (1 - 0.2 * s.hunger) * (s.energyAlloc ?? 1), 0, 1)
      const thresholdShift = clamp(-0.3 * s.sleepDebt - 0.15 * s.hunger - 0.1 * Math.max(0, s.cortisol - 0.5)
        - (s.cyclePhase === '经前' ? 0.2 : s.cyclePhase === '经期' ? 0.15 : 0), -0.6, 0.2)
      const moodBias = clamp(0.15 * (energy - 0.5) - 0.1 * s.sleepDebt, -0.3, 0.2)
      const heartRate = clamp(60 + 45 * s.sym - 10 * s.par + 8 * s.cortisol, 45, 140)
      // H17 体温：下午高、深夜低（有来源，不是摆设）
      const temp = clamp(0.25 * Math.cos(((hour - 14) / 24) * 2 * Math.PI) - 0.1 * s.sleepDebt, -1, 1)
      // H12 疼痛：久坐 + 缺觉会酸；没有外部疼痛事件时的基线
      const pain = clamp(0.05 + 0.3 * s.sleepDebt + 0.15 * (1 - energy), 0, 1)
      s.temp = temp
      s.pain = pain
      return {
        frame: s.frame,
        body: {
          hr: s.bsHr ?? heartRate,
          hrv: clamp(85 - 40 * s.sym - 20 * s.sleepDebt, 10, 120),
          breath: s.bsBreath ?? clamp(12 + 8 * s.sym, 6, 30),
          gut: clamp(-0.6 * s.sym - 0.3 * s.hunger, -1, 1),
          temp,
          tension: clamp(0.3 + 0.5 * s.sym, 0, 1),
          pain: clamp(pain * s.painGate, 0, 1),
        },
        needs: { hunger: s.hunger, thirst: s.thirst, sleep: s.sleep, contact: s.contact, control: s.control, meaning: s.meaning, warmth: s.warmth },
        hpa: { cortisol: s.cortisol, ne: s.ne },
        rhythm: { energy, moodBias, thresholdShift },
        sleepDebt: s.sleepDebt,
        sleepGate: s.sleepGate,
        bandwidthCap: clamp((0.9 - 0.5 * s.sleepDebt - 0.3 * s.hunger - 0.1 * s.stressLoad) * s.sleepGate, 0.2, 1),
        autonomic: { sym: s.sym, par: s.par },
        hormones: { oxytocin: s.oxytocin, vasopressin: s.vasopressin, testosterone: s.testosterone, estrogen: s.estrogen },
        aggression: s.aggression,
        cycle: { on: s.cycleOn, day: s.cycleDay, phase: s.cyclePhase || null },
        stimulant: s.stimulant,
      }
    },
    snapshot: () => ({ ...s }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
