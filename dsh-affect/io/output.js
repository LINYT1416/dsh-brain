// 输出通道：措辞 / 句长 / 标点 / 延迟 / 表情包 / 语音 / 泄漏 / 释放 / 求安慰 / 自报误差。
// 覆盖 O04-O13。

import { clamp, NEG_KINDS } from '../core/consts.js'

export function create() {
  const fresh = () => ({
    brevity: 0.3, punctuation: 'normal', replyDelayMs: 0,
    memeTendency: 0.5, voice: { rate: 1, volume: 1 },
    meme: { emotion: 'daily', probability: 0.5, style: 'neutral', allow: true },
    venting: 0, seekComfort: 0, selfReportGap: 0, labeled: 0,
    frame: 0,
  })
  let s = fresh()

  return {
    id: 'io',
    cover: ['O04', 'O05', 'O06', 'O07', 'O08', 'O09', 'O10', 'O11', 'O12', 'O13'],
    step(w) {
      const pfc = w.get('pfc')
      const ins = w.get('insula')
      const soc = w.get('social')
      const dmn = w.get('dmn')
      if (!pfc) return

      const felt = ins?.felt.intensity ?? 0
      const mask = pfc.display.mask
      const leak = pfc.display.leakRisk

      // O05 句长：抑制越强、情绪越强，话越短
      // 但话的长度是"被心情拖着"的，不是每句重算：走惯性，上一句的调子还留着
      const pair = w.pair || {}
      const dt = Number(w.tx?.dtMs) || 60_000
      const inertia = clamp(0.18 + Math.min(0.42, dt / 120_000), 0.18, 0.62)
      const targetBrevity = clamp(
        0.2 + 0.5 * mask + 0.3 * felt
        + (pair.escalating ? 0.08 : 0)
        - (pair.softening ? 0.12 : 0)
        + (pair.answeredShort ? 0.05 : 0),
        0, 1)
      s.brevity = clamp(s.brevity + (targetBrevity - s.brevity) * inertia, 0, 1)
      // O06 标点：生气句号多、感叹少；开心感叹多
      // 换调子要连续两拍同向才换，避免一句话里反复横跳
      const pTarget = pfc.display.toneShift === 'hard' || pfc.display.toneShift === 'flat' ? 'flat'
        : pfc.display.toneShift === 'soft' ? 'warm' : 'normal'
      if (pTarget === (s.puncTarget || 'normal')) s.puncHold = (s.puncHold || 0) + 1
      else { s.puncTarget = pTarget; s.puncHold = 1 }
      if ((s.puncHold || 0) >= 2 && s.punctuation !== pTarget) s.punctuation = pTarget
      // O07 延迟：最多 3 倍且 ≤6 分钟（C06）；基线 3 秒，不是 20 秒
      const base = 3_000
      s.replyDelayMs = clamp(base * (1 + 2 * mask + 1.5 * leak), 0, 360_000)
      // O08 表情包：低落时减少
      // 丧的时候不是"不想发图"，而是"只发丧的"：下限抬到 0.35，别让倾向把发图关死
      s.memeTendency = clamp(0.6 - 0.5 * felt - 0.3 * pfc.display.mask, 0.35, 1)

      // O08 表情包：跟随"此刻"的效价与主导情绪，不是只跟随底色心情
      const curMood = w.mood ?? 0
      const mainKind = w.emotions?.[0]?.kind ?? null
      const amy = w.get('amygdala')
      const nowValence = clamp((amy?.rewardPE ?? 0) - 0.7 * (amy?.threat ?? 0), -1, 1)
      const negish = (mainKind && (NEG_KINDS.has(mainKind) || /烦|心痛|委屈|生气|失望|难过|焦虑|紧张|害怕|羞/.test(mainKind)))
        // 她刚说的话本身带丧气：这一拍就算情绪还没成形，也别推亮色表情
        || (/烦|累死|崩溃|受不了|气死|无语|服了|不想干|心累|难过|失望/.test(String(w.lastUserText || '')) && !/厉害|谢谢|辛苦|开心|棒|喜欢/.test(String(w.lastUserText || '')))
      // 只有"真被惹到"才归丧；但底色心情持续很低时，也该走丧的（不是只有挨骂才算）
      const strongNeg = negish || (nowValence < -0.35 && felt > 0.25) || curMood < -0.35
      const positiveNow = !negish && ((mainKind && !NEG_KINDS.has(mainKind) && Math.abs(nowValence) > 0.05) || nowValence > 0.2)
      const isAngry = mainKind && ['生气', '厌烦'].includes(mainKind)
      const isShy = mainKind && ['害羞', '心动'].includes(mainKind)
      const isConfused = mainKind && ['困惑', '惊讶', '焦虑', '紧张'].includes(mainKind)
      // 发图的门槛不能由"心情差"一路压到底：丧的时候也常发丧图。
      // 所以基线按情境给（丧 0.5 / 平常 0.62 / 开心 0.8），效价只做微调。
      const baseP = negish ? 0.5 : positiveNow ? 0.8 : 0.62
      const p = clamp(baseP + 0.25 * nowValence + 0.15 * (curMood - 0.1), 0.2, 0.95)
      // 不再只给一个分类：给一个"这轮想发什么"的检索词，图库那边照着挑
      const 情境 = isAngry ? '生气 无语'
        : isShy ? '害羞 脸热'
        : isConfused ? '困惑 问号'
        : strongNeg ? '难过 低落'
        : positiveNow ? '开心 贴贴'
        : '日常 摸鱼'
      s.meme = {
        emotion: isAngry ? 'angry' : isShy ? 'shy' : isConfused ? 'confused'
          : strongNeg ? 'sad' : positiveNow ? 'happy' : 'daily',
        probability: p,
        style: strongNeg ? 'emo' : positiveNow ? 'bright' : 'neutral',
        allow: p > 0.12,
        query: 情境,
      }
      // O09 语音参数
      s.voice = { rate: clamp(1 - 0.2 * pfc.display.mask, 0.7, 1.1), volume: clamp(1 - 0.2 * felt, 0.7, 1.1) }
      // O10 抑制与泄漏（已在 pfc，这里只透出）
      s.leak = leak
      // O11 表达后的释放：说出来轻一点
      if (w.spoke && felt > 0.3) s.venting = clamp(s.venting + 0.3, 0, 1)
      else s.venting *= 0.95
      // O12 倾诉：难过时会找人说话
      s.seekComfort = clamp((ins?.felt.intensity ?? 0) * 0.6 + (soc?.socialPain ?? 0) * 0.4, 0, 1)
      // O13 自我报告误差：说"没事"和真实状态可以分开
      s.selfReportGap = clamp(mask * felt, 0, 1)
      // P19 命名
      s.labeled = w.labeled ? 1 : 0
      s.frame += 1
    },
    read() {
      return {
        frame: s.frame,
        brevity: s.brevity, punctuation: s.punctuation, replyDelayMs: s.replyDelayMs,
        memeTendency: s.memeTendency, voice: { ...s.voice },
        meme: { ...s.meme },
        venting: s.venting, seekComfort: s.seekComfort, selfReportGap: s.selfReportGap,
        labeled: s.labeled,
      }
    },
    snapshot: () => ({ ...s, voice: { ...s.voice } }),
    restore(o) { if (o) s = { ...fresh(), ...o } },
    health: () => ({ ok: true, degraded: false, frame: s.frame }),
  }
}
