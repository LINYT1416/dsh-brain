// 岛叶：身体读数 → 感受质地。覆盖 I01-I16（敬畏一条已豁免）。
// 输出不是情绪标签，是"堵/紧/沉"这种质地；允许误标。

import { clamp, decay, TEXTURES } from '../core/consts.js'

const P = { precisionBase: 0.4, precisionGain: 0.6, textureMax: 3 }

export function create(cfg = {}) {
  const p = { ...P, ...cfg }
  const fresh = () => ({
    intensity: 0.1, qualities: [], location: '', precision: 0.5,
    disgust: 0, resonance: 0, mislabel: 0.2,
    craving: 0, wait: 0, risk: 0.2, bodySelf: 0.5, awareness: 0.5,
    lastBody: { hr: 70, tension: 0.3, gut: 0 },
    frame: 0,
  })
  let s = fresh()

  const pick = (v, a) => {
    if (v < -0.15 && a > 0.55) return { qualities: ['紧', '发麻'], location: '胸口' }
    if (v < -0.15) return { qualities: ['沉', '发闷'], location: '胸口' }
    if (v < -0.4 && a < 0.35) return { qualities: ['空', '乏'], location: '全身' }
    if (v > 0.2 && a > 0.55) return { qualities: ['热', '轻'], location: '脸' }
    if (v > 0.2) return { qualities: ['暖', '松'], location: '全身' }
    return { qualities: [], location: '' }
  }

  return {
    id: 'insula',
    cover: ['I01', 'I02', 'I03', 'I04', 'I05', 'I08', 'I09', 'I10', 'I11', 'I12', 'I13', 'I14', 'I15', 'I16', 'C10'],
    params: p,

    step(w) {
      const dt = w.tx.dtMs
      const hyp = w.get('hypothalamus')
      const amy = w.get('amygdala')
      if (!hyp) return
      const b = hyp.body
      s.lastBody = b

      const arousal = clamp(0.45 * (amy?.threat ?? 0) + 0.25 * hyp.hpa.cortisol + 0.3 * s.intensity, 0, 1)
      const valence = clamp((amy?.rewardPE ?? 0) - 0.7 * (amy?.threat ?? 0), -1, 1)

      // I15 精度：注意身体时更清晰
      const attn = w.get('attention')
      s.precision = clamp(p.precisionBase + p.precisionGain * (attn?.onBody ?? 0.3), 0.3, 1)

      // I01-I05 内感受误差；C10：先算局部，再乘全局调质增益
      // I02 呼吸 / I03 胃肠 / I04 体温 都进同一条误差
      const err = clamp(
        Math.abs(b.hr - 70) / 60 + Math.abs(b.tension - 0.3) * 0.5 +
        Math.abs(b.gut) * 0.2 + b.pain * 0.4 +
        Math.abs((b.breath ?? 14) - 14) / 40 + Math.abs(b.temp ?? 0) * 0.15,
        0, 1,
      )
      const gain = clamp((w.get('neuromod')?.gain ?? 1) * (1 + 0.15 * ((w.get('endocrine')?.estrogen ?? 0.5) - 0.5)), 0.5, 1.9)
      // 以前这里是"每拍往累加器里加一笔"：s.intensity*decay(dt,4分钟) + 常数流入。
      // 衰减时间常数是 4 分钟，流入却不按 dt 归一 —— 于是每一拍都在净增长，
      // 十几拍就能从 0.02 涨到 0.66，人还没被说什么就已经"心痛 0.66"。
      // 体内感应该是"渐渐靠近一个稳态"，不是随拍子次数无限累加。
      // 一句话进来，身体要先"当下一紧"（尖峰），再靠上面那条稳态慢慢退。
      // 只有稳态的话，单句重话在身体上看不出来——测试和真人都能感觉出来这不对。
      // 被说重话的时候身体要"当下一紧"：一部分来自这句话的效价（尖峰），
      // 一部分来自杏仁核已经升起来的威胁。少了这两项，身体对一句话毫无反应，
      // 只有"聊久了越来越难受"——那是反的。
      const spike = 0.35 * Math.max(0, -valence) + 0.50 * (amy?.threat ?? 0)
      const target = clamp((0.30 * err * s.precision + 0.20 * Math.abs(valence) + 0.20 * arousal * s.precision) * gain + spike, 0, 1)
      // 收敛要分两头：往上冲要快（被人当众说一句，身体立刻紧），
      // 往回落要慢（那句过了，身体还得缓一会儿）。两头加起来才是"越聊越难受"的解药：
      // 不是不难受，是难受会到顶、会退。
      const kUp = Math.max(1 - decay(dt, 0.10), 0.5)   // 强刺激一拍就到一半
      const kDown = 1 - decay(dt, 0.35)                // 平复约 20 秒
      const kSettle = target > s.intensity ? kUp : kDown
      s.intensity = clamp(s.intensity + (target - s.intensity) * kSettle, 0, 1)

      // I13/M08 记忆再体验：想起旧事，身体会重新紧一下（不是只影响评价）
      const echo = w.memoryEcho
      if (echo && Array.isArray(echo.hits) && echo.hits.length) {
        const strongest = echo.hits.reduce((a, h) => (Math.abs(h.valence) > Math.abs(a.valence) ? h : a), echo.hits[0])
        const recencyBoost = 0.12 + 0.20 * Math.abs(strongest.valence)
        // 一次回忆只在"还有空间"里抬一下，不然连着想起几次就叠满了
        s.intensity = clamp(s.intensity + recencyBoost * (1 - s.intensity), 0, 1)
        s.memoryReplay = { brief: strongest.brief, valence: strongest.valence, at: w.tx.t1 }
      } else if (s.memoryReplay && w.tx.t1 - s.memoryReplay.at > 600_000) {
        s.memoryReplay = null
      }

      // 上软顶：持续负性也不会把"体内感"钉死在 100
      s.intensity = clamp(s.intensity, 0, 0.95)
      if (s.intensity > 0.8) s.intensity -= 0.02 * (s.intensity - 0.8)

      // I11 等待：越等越烦
      const missed = w.tx.events.some(e => e.type === 'user')
      s.wait = missed ? 0 : clamp(s.wait + dt / 600_000, 0, 1)
      if (missed) s.wait *= 0.2

      // I12 风险/不确定
      s.risk = clamp(0.2 + 0.5 * (amy?.novelty ?? 0) + 0.2 * (hyp.hpa.cortisol ?? 0), 0, 1)

      // I08 厌恶：要有真的厌恶线索，不能因为"饿得胃不舒服"就算厌恶
      const disgustCue = b.gut < -0.6 && (hyp.needs?.hunger ?? 0) < 0.7
      s.disgust = clamp(0.55 * (disgustCue ? 1 : 0) + 0.25 * Math.max(0, -valence - 0.4), 0, 1)

      // I13 共情共振
      const social = w.get('social')
      s.resonance = clamp(0.6 * (social?.otherFelt ?? 0) * (social?.similarity ?? 0.5), 0, 0.7)

      // I14 渴求
      s.craving = clamp(0.3 * (hyp.needs.contact ?? 0) + 0.2 * (hyp.needs.hunger ?? 0), 0, 1)

      // I10 身体自我感
      s.bodySelf = clamp(0.5 + 0.3 * s.intensity, 0, 1)
      // I09 情绪意识
      s.awareness = clamp(0.5 + 0.3 * s.precision, 0, 1)
      // I16 误标：归因不清时更容易把身体不适当情绪
      const conf = w.get('pfc')?.attribution?.confidence ?? 0.5
      s.mislabel = clamp(0.3 + 0.4 * s.intensity - 0.3 * conf, 0, 1)

      const picked = pick(valence, arousal)
      // 强度够但情绪中性时，也得有个身体感（按唤醒高低给一个）
      let qs = picked.qualities
      let loc = picked.location
      if (!qs.length && s.intensity > 0.3) {
        qs = arousal > 0.55 ? ['紧'] : ['沉']
        loc = arousal > 0.55 ? '胸口' : '全身'
      }
      // 强度太低就不该有质地词（防止"心里松"出现在几乎没情绪的时候）
      const strong = s.intensity > 0.22
      s.qualities = strong ? qs.filter(q => TEXTURES.includes(q)).slice(0, p.textureMax) : []
      s.location = strong ? loc : ''
      s.frame += 1
    },

    read() {
      return {
        frame: s.frame,
        felt: {
          intensity: s.intensity,
          qualities: s.qualities,
          location: s.location,
          precision: s.precision,
        },
        disgust: s.disgust,
        resonance: s.resonance,
        mislabel: s.mislabel,
        craving: s.craving,
        wait: s.wait,
        risk: s.risk,
        bodySelf: s.bodySelf,
        awareness: s.awareness,
        memoryReplay: s.memoryReplay ?? null,
        bodyBudget: clamp(1 - 0.3 * (1 - s.intensity) - 0.2 * s.wait, 0.1, 1),
      }
    },
    snapshot: () => ({ ...s, qualities: [...s.qualities] }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
