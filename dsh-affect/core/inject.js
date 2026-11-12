// 注入文本：5~7 行，只给线索。不写数值、不写往事、不写"你应该"、每轮要变。
// 覆盖 J01-J08。

import { ACTION, NEG_KINDS } from './consts.js'

const TONE = {
  soft: '语气会软一点，话也愿意多说两句',
  normal: '心里什么样，话里就是什么样',
  hard: '话会短、带点刺，但不会真翻脸',
  flat: '不太想接，回得很省',
}

const MOOD_WORD = (v) => {
  if (v <= -0.45) return '闷闷的'
  if (v <= -0.2) return '有点不乐意'
  if (v >= 0.45) return '心情挺好'
  if (v >= 0.2) return '还行，挺松的'
  return '平平的'
}

export function render(fused, { hour = 21, lastLine = '', tick = 0 } = {}) {  const { emotions, mood, felt, display, recall, arousal, attribution } = fused
  const main = emotions[0]
  const lines = []

  const when = hour >= 22 || hour < 6 ? '这会儿（夜里）' : hour >= 18 ? '这会儿（晚上）' : hour >= 12 ? '这会儿（下午）' : '这会儿（上午）'
  const head = main
    ? (NEG_KINDS.has(main.kind) ? `${main.kind}压着，还没散` : `心里是松的，有点${main.kind}`)
    : MOOD_WORD(mood)
  lines.push(`${when}：${head}`)

  if (main) {
    const second = emotions[1]
    const mixed = second ? `，还掺着一点${second.kind}` : ''
    const vague = felt.intensity > 0.45 && attribution?.locus === 'other' ? '，说不清是冲你还是冲今天' : ''
    lines.push(`心里：${main.kind}${mixed}${vague}`)
  } else if (mood <= -0.2) {
    lines.push('心里：有点闷，没具体的事')
  }

  if (felt?.qualities?.length) {
    lines.push(`身体：${felt.location || '胸口'}${felt.qualities.slice(0, 2).join('、')}`)
  }

  if (display) {
    lines.push(`嘴上：${TONE[display.toneShift] || TONE.normal}`)
    if (display.leakRisk > 0.45) lines.push('其实有点忍不住，话会漏出来')
  }

  if (main && ACTION[main.kind] && felt.intensity > 0.3) {
    lines.push(`想做的：${ACTION[main.kind]}`)
  }

  if (recall?.hit && recall.intensity > 0.45) {
    const when = recall.ageDays > 3 ? '那回' : '上次'
    const emo = recall.kind ? `，当时是${recall.kind}` : ''
    lines.push(`${when}好像也这样：${recall.brief}${emo}`)
  }
  // 记忆里翻出来的事（只读记忆器官给的摘要，不是编的；必须截短，不许把原文/长句带进来）
  if (fused.memoryEcho?.hits?.length) {
    const raw = String(fused.memoryEcho.hits[0].brief || '').replace(/\s+/g, ' ')
    if (raw) {
      // 截断要带省略号，不能把词切一半就丢出来
      const brief = [...raw].length > 16 ? [...raw].slice(0, 16).join('') + '…' : raw
      lines.push(`这事以前有过：${brief}`)
    }
  }

  if (fused.socialPain > 0.4 && !recall?.hit) {
    lines.push('有点被晾着的感觉')
  }

  if (fused.repair > 0.5) {
    lines.push('想补一句：刚才那话是不是重了')
  } else if (fused.seekComfort > 0.65 && !main) {
    lines.push('想找个人说说话')
  }

  if (fused.startle > 0.35) lines.push('刚被吓了一下，还没缓过来')
  if (fused.withdraw > 0.35) lines.push('身上不太舒服，不想多说话')
  // D01/D05 走神与社交想象；M17 怀旧
  if (!main && fused.idle > 0.5) lines.push('一个人待着，有点走神')
  else if (!main && fused.socialImagining > 0.4) lines.push('想知道他这会儿在干嘛')
  if (fused.nostalgia > 0.35 && main && !NEG_KINDS.has(main.kind)) lines.push('有点想起以前的事')

  // 表情包：io 里那份才是当拍算出来的；fused.meme 可能还没回写，两个都看
  const meme = fused.meme || fused.io?.meme
  if (meme) {
    // 表情包不是"有情绪就发"：倾向和概率低到一定程度，就算有情绪也不发。
    // memеTendency / meme.probability 这两个数以前算完没人用，白算。
    const ioM = fused.io?.meme || {}
    const prob = Number(ioM.probability ?? meme.probability ?? 0.5)
    const tend = Number(fused.io?.memeTendency ?? 0.5)
    // 不只给"要不要发"，还给"去搜什么"——图库按这个词挑，命中不了宁可不发
    const q = String(ioM.query || meme.query || '').trim()
    const tail = q ? '（搜：' + q + '）' : ''
    if (ioM.allow === false || prob < 0.18 || tend < 0.12) lines.push('表情包：不想发图')
    // 语气要是指令，不是心情旁白：模型读到"不太想发"就真不发了，这是之前很少发图的直接原因
    else if (meme.style === 'bright') lines.push('表情包：发一张开心的' + tail)
    else if (meme.style === 'emo') lines.push('表情包：发一张丧的' + tail)
    else lines.push('表情包：这一条顺手发一张' + tail)
  }

  // J01：5~7 行。不够就用此刻的需求补，但不许重复、不许编
  const has = (prefix) => lines.some(l => l.startsWith(prefix))
  const n = fused.needs || {}
  if (!has('心里')) {
    // 意义感是慢变量：够高了才让"没劲"压过普通的心情陈述
    if ((n.meaning ?? 0) > 0.6) lines.push('心里：有点没劲，不知道图什么')
    else lines.push(mood <= -0.2 ? '心里：有点闷，没具体的事' : '心里：没什么大事，平着')
  }
  // 身体那一行常常已经被"体感"（胸口沉之类）占了。
  // 以前这里写的是 `if (!has('身体'))`——于是渴/饿/困/冷永远轮不上，
  // 需求等于白算。现在改成"有就并入同一行"，两件事本来也不冲突。
  const needBit = (() => {
    if ((n.hunger ?? 0) > 0.7) return '有点饿'
    if ((n.thirst ?? 0) > 0.7) return '嘴巴干，想喝水'
    if ((n.sleep ?? 0) > 0.55 || (fused.energy ?? 1) < 0.35) return '有点乏'
    if ((n.warmth ?? 0) > 0.6) return '有点冷'
    if ((n.contact ?? 0) > 0.6) return '想被人搭理一下'
    return ''
  })()
  if (needBit) {
    const bodyIdx = lines.findIndex(l => l.startsWith('身体'))
    if (bodyIdx >= 0) lines[bodyIdx] = `${lines[bodyIdx]}，${needBit}`
    else lines.push(`身体：${needBit}`)
  }
  if (!has('想做的')) {
    if ((n.control ?? 0) > 0.62) lines.push('想做的：想自己做回主')
    else if ((n.contact ?? 0) > 0.65) lines.push('想做的：想找人说说话')
    else if ((n.hunger ?? 0) > 0.7) lines.push('想做的：想吃点东西')
    else if ((n.sleep ?? 0) > 0.6) lines.push('想做的：想躺一会儿')
  }
  // 意义感是慢变量，够高了才说；不强塞
  if (!has('心里') && (n.meaning ?? 0) > 0.6) lines.push('心里：有点没劲，不知道图什么')

  lines.push('上面这些是全部线索：只按它说，别补细节、别编往事。说话方式优先于场景习惯——短句、不列清单、不加粗、不总结、不客服腔；正事照做，口吻还是她的。')

  // 行序：此刻 → 心里 → 其余（心里这一行永远紧跟开头）
  const heartIdx = lines.findIndex(l => l.startsWith('心里'))
  let out = lines.slice(0, 7)
  if (heartIdx > 1) {
    const [h] = out.splice(heartIdx, 1)
    out.splice(1, 0, h)
  }
  // J05 每轮必变：重复时不是加个前缀糊过去，而是换措辞（至少两行不同）
  // J05 每轮必变：不只换开头，嘴上/身体/表情包也按轮次换说法（不加前缀糊弄）
  const seed = Number(tick) || 0
  const variant = Math.floor(seed / 3) % 3
  // —— 嘴上这一行必须由输出通道算出来 ——
  // 以前是三条写死的话按轮次轮换：io 里算出来的 brevity / punctuation / replyDelayMs
  // 一个都没进文本，属于"算了但没人用"。现在这三个直接决定这一行说什么。
  const io = fused.io || {}
  const brev = Number(io.brevity ?? 0.3)
  const punc = String(io.punctuation || 'normal')
  const delayMs = Number(io.replyDelayMs ?? 0)
  const short = brev >= 0.6
  const flat = punc === 'flat'
  const warm = punc === 'warm'
  const slow = delayMs >= 20_000
  // 「说出来了会轻一点」——以前算完没人用。别的人听不出来，但她自己知道。
  const vent = Number(fused.io?.venting ?? 0)
  const ventBit = vent > 0.4 ? '，说出来了会松一点' : ''
  const TAIL = ['', '，问一句答一句', '，该做的事照做']
  function mouthLine() {
    const tail = TAIL[variant] || ''
    const slowBit = slow ? (flat || short ? '，回得也慢' : '，只是回得慢') : ''
    if (short && flat) return `嘴上：话很短，句号多、问句少${slowBit}${ventBit}`
    if (short) return `嘴上：话会比平时短${tail}${slowBit}${ventBit}`
    if (flat) return `嘴上：句子短，句号多，不太接话${slowBit}${ventBit}`
    if (warm) return `嘴上：语气是软的，愿意多说两句${slowBit}${ventBit}`
    return `嘴上：${TONE[display?.toneShift] || TONE.normal}${tail}${ventBit}`
  }
  const BODY = ['身体：胸口沉', '身体：有点发闷', '身体：提不起劲']
  // 这行是给模型的"动作指令"，不是心情旁白。
  // 以前 emo 写的是"不太想发/没心思发"，模型照做就不发了——这是很少发图的根因之一。
  const MEME = {
    bright: ['表情包：发一张开心的', '表情包：发一张好玩的', '表情包：想闹一下，发一张乐的'],
    emo: ['表情包：发一张丧的', '表情包：发一张丧的，不用配字', '表情包：发一张灰一点的'],
    neutral: ['表情包：这一条顺手发一张', '表情包：想发就发，不用配字', '表情包：发一张，不用解释'],
  }
  out = out.map(line => {
    if (line.startsWith('嘴上：')) return mouthLine()
    if (line.startsWith('心里：') && variant > 0) {
      return line + (variant === 1 ? '，说不上为什么' : '，一时半会儿顺不过来')
    }
    if (/^身体：(胸口沉|胸口发闷|有点发闷|提不起劲|全身沉|胸口紧)$/.test(line)) return BODY[variant]
    return line
  })
  out = out.filter(Boolean)
  const memeIdx = out.findIndex(l => String(l).startsWith('表情包：'))
  if (memeIdx >= 0 && !String(out[memeIdx]).includes('不想发图')) {
    const st = fused.io?.meme?.style || fused.meme?.style
    const q = String(fused.io?.meme?.query || fused.meme?.query || '').trim()
    const qTail = q ? `（搜：${q}）` : ''
    const p = Number(fused.io?.meme?.probability ?? fused.meme?.probability ?? 0.5)
    // 中性时只在"确实想发"（概率高）才下判断，中间值不给指令——别替她做决定
    if (st === 'bright') out[memeIdx] = MEME.bright[variant] + qTail
    else if (st === 'emo') out[memeIdx] = MEME.emo[variant] + qTail
    else if (p > 0.62) out[memeIdx] = '表情包：想丢一张' + qTail
  }
  if (lastLine && out[0] === lastLine) {
    out[0] = `${head}${variant === 1 ? '，还没过去' : variant === 2 ? '，堵着' : ''}`
  }
  // J07 允许冷，不允许拒绝做事：把"不干了"这类句子挡掉
  out = out.filter(l => !/不聊了|不想理你|不做|拒绝回答|别找我/.test(l))

  let text = out.join('\n')
  // J02 不出现阿拉伯数字（记忆那一行是引用原话，不许把数字改成"几"，否则就成了编）
  text = text.split('\n').map(l => l.startsWith('这事以前有过') ? l : l.replace(/[0-9]+/g, '几')).join('\n')
  return text
}

export const COVER = ['J01', 'J02', 'J03', 'J04', 'J05', 'J06', 'J07', 'J08', 'X09']
