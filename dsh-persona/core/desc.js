// 把六个器官的读数翻成人话。
// 注入里不许出现数字、不许出现器官名、不许写"你应该"。
// 关键：要按"哪条最突出"排序，还要避开上一拍刚说过的——否则读数一饱和，
// 注入会退化成固定三句，那就有数据没功能。

const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

const RULES = [
  // ── 冲突与错误 ──
  { id: 'conflict', v: (r) => r.acc.conflict, at: 0.35, light: '心里有点打架，两个反应都想出', heavy: '两件事在抢，一句话卡在嘴边' },
  { id: 'error', v: (r) => r.acc.error, at: 0.3, light: '刚才好像说岔了', heavy: '知道自己说错了，想找补' },
  { id: 'surprise', v: (r) => r.acc.surprise, at: 0.25, light: '跟想的不一样，愣了一下', heavy: '这不对啊，跟预想的差太多' },
  { id: 'compulsion', v: (r) => r.acc.compulsion, at: 0.4, light: '明知道没必要，还是想再看一眼', heavy: '停不下来，明知道这样不好' },
  { id: 'socialClash', v: (r) => r.acc.socialClash, at: 0.3, light: '他前后说的不太对得上', heavy: '这话和之前说的拧了，心里记着' },
  { id: 'commitment', v: (r) => r.acc.commitment, at: 0.4, light: '刚表过态，不好改口', heavy: '说来话长，反正我现在不能反口' },
  // ── 自我 ──
  { id: 'protect', v: (r) => r.mpfc.protecting, at: 0.3, light: '有点想护着', heavy: '护短那根筋被挑起来了，先护再讲理' },
  { id: 'lowEsteem', v: (r) => 1 - r.mpfc.esteem, at: 0.55, light: '有点怀疑自己', heavy: '心里在打鼓，怕自己不行' },
  { id: 'idealGap', v: (r) => r.mpfc.idealGap, at: 0.36, light: '离想成为的样子还差一截', heavy: '知道该是什么样，就是做不到' },
  { id: 'discomfort', v: (r) => r.mpfc.discomfort, at: 0.35, light: '这么做有点不像我', heavy: '别扭，这不像我会做的事' },
  { id: 'blameSelf', v: (r) => r.mpfc.blameSelf, at: 0.62, light: '这事可能怪我', heavy: '先怪自己，习惯性的' },
  // ── 价值与面子 ──
  { id: 'shame', v: (r) => r.ofc.shame, at: 0.3, light: '有点下不来台', heavy: '面子上过不去，不太想接这句' },
  { id: 'unfair', v: (r) => r.ofc.unfair, at: 0.3, light: '心里有点不服', heavy: '凭什么啊，这话我不认' },
  { id: 'expectGap', v: (r) => Math.abs(r.ofc.expectGap ?? 0), at: 0.25, light: '和想的不太一样', heavy: '落差有点大，一时没缓过来' },
  { id: 'satiation', v: (r) => r.str.satiation, at: 0.3, light: '有点腻了', heavy: '翻来覆去就这些，提不起劲' },
  // ── 习惯与冲动 ──
  { id: 'primed', v: (r) => r.str.primed, at: 0.45, light: '顺手就想这么回', heavy: '话说出口之前就已经决定好了' },
  { id: 'broken', v: (r) => r.str.broken, at: 0.3, light: '节奏被打断了一下', heavy: '被打断了，有点没跟上' },
  { id: 'stop', v: (r) => r.str.stop, at: 0.5, light: '有点收不住', heavy: '该停了，但还在往下说' },
  { id: 'wanting', v: (r) => r.str.wanting, at: 0.45, light: '有点想要', heavy: '想要得很，虽然知道没什么用' },
  // ── 读人 ──
  { id: 'offense', v: (r) => r.tpj.offense, at: 0.3, light: '有点被戳到', heavy: '被戳到了，嘴上会硬一点' },
  { id: 'misread', v: (r) => r.tpj.misread, at: 0.3, light: '有点拿不准他什么意思', heavy: '可能把人的话读岔了，但还没反应过来' },
  { id: 'deception', v: (r) => r.tpj.deception, at: 0.3, light: '他这话听着有点飘', heavy: '不太信，但先不戳破' },
  { id: 'ingroup', v: (r) => r.tpj.ingroup, at: 0.5, light: '是"我们"这边的事', heavy: '自己人的事，得上心' },
  // ── 故事 ──
  { id: 'nostalgia', v: (r) => r.pcc.nostalgia, at: 0.3, light: '有点想起以前的事', heavy: '旧事被勾起来了，一时半会儿回不来' },
  { id: 'discontinuity', v: (r) => 1 - r.pcc.continuity, at: 0.45, light: '有点不像平时的自己', heavy: '有点不认识自己了' },
  { id: 'crisis', v: (r) => r.pcc.crisis, at: 0.3, light: '有点乱，说不清自己在哪', heavy: '不知道自己在干嘛，也不知道为什么' },
]

const SAFE = {
  str: { primed: 0, broken: 0, stop: 0.2, wanting: 0, satiation: 0, top: [] },
  acc: { conflict: 0, error: 0, surprise: 0, compulsion: 0, socialClash: 0, commitment: 0 },
  ofc: { value: 0.5, warm: 0, guilt: 0, shame: 0, unfair: 0, expectGap: 0 },
  mpfc: { relevance: 0, esteem: 0.5, protecting: 0, idealGap: 0.3, discomfort: 0, blameSelf: 0.5 },
  pcc: { nostalgia: 0, continuity: 0.78, crisis: 0, anchors: [] },
  tpj: { offense: 0, misread: 0, deception: 0, ingroup: 0, air: 0.5 },
}

const PHRASE = {
  ping: '看见"在吗"就想先回一句',
  vent: '一听人说累就自动接话',
  cmd: '被催的时候会先顶半句',
  joke: '有人开玩笑会先笑',
  greet: '早晚那句客套还记得回',
  ask: '被问问题就先给个答案',
  talk: '聊天的时候有一套固定的接法',
}

export function describe(fused, { max = 3, prev = [] } = {}) {
  // 某个器官挂了也得说得出话来——注入不能因为一个模块抛错就整段消失
  const r = {}
  for (const k of Object.keys(SAFE)) r[k] = { ...SAFE[k], ...((fused && fused.reads && fused.reads[k]) || {}) }

  // 按"超出阈值的比例"排，不按绝对值——绝对值会饱和，比例不会
  const scored = RULES
    .map((rule, idx) => ({ rule, idx, ratio: (Number(rule.v(r)) || 0) / rule.at }))
    .filter((x) => x.ratio >= 1)
    .sort((a, b) => b.ratio - a.ratio)

  const picked = []
  for (const x of scored) {
    if (picked.length >= max) break
    const heavy = x.ratio >= 1.5
    const line = heavy ? x.rule.heavy : x.rule.light
    if (picked.some((p) => p.line === line)) continue
    picked.push({ line, id: x.rule.id, ratio: x.ratio, heavy })
  }

  // 跟上一拍一样、又没到"特别强"的，换掉——避免注入卡成复读
  const prevSet = new Set(prev || [])
  if (prevSet.size && picked.length) {
    const spare = scored
      .map((x) => ({ x, line: x.ratio >= 1.5 ? x.rule.heavy : x.rule.light }))
      .filter((s) => !picked.some((p) => p.line === s.line) && !prevSet.has(s.line))
    for (let i = 0; i < picked.length && spare.length; i += 1) {
      if (!prevSet.has(picked[i].line) || picked[i].ratio >= 2.2) continue
      const next = spare.shift()
      picked[i] = { line: next.line, id: next.x.rule.id, ratio: next.x.ratio, heavy: next.x.ratio >= 1.5 }
    }
  }

  const out = picked.map((p) => p.line)

  // 习惯最强的那个单独说一句——这是最像人的地方
  const top = r.str?.top?.[0]
  if (top && top.s >= 0.5 && out.length < max + 1) {
    const line = PHRASE[top.cue]
    if (line && !out.includes(line)) out.push(line)
  }

  if (!out.length) out.push('没什么，就是平常那样')
  return out
}

export function dump(fused) {
  if (!fused) return null
  const r = fused.reads
  return {
    hex: fused.hex,
    traits: fused.traits,
    stable: fused.stable,
    signatures: fused.signatures,
    reads: {
      str: r.str, acc: r.acc, ofc: r.ofc,
      mpfc: r.mpfc, pcc: r.pcc, tpj: r.tpj,
    },
  }
}

export { RULES }
