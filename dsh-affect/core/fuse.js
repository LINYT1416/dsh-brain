// 融合层：把 15 个模块的 read() 合成"此刻的她"。
// 情绪是"评价向量 × 原型"构造出来的，不是 if-else。

import { clamp, PROTOTYPES, NEG_KINDS } from './consts.js'
import { analyzeMessage } from './context.js'

const toUnit = (x) => (clamp(x, -1, 1) + 1) / 2
const vec = (a) => [clamp(a.relevance, 0, 1), toUnit(a.goal), clamp(a.agencyOther, 0, 1), clamp(a.certainty, 0, 1), clamp(a.coping, 0, 1), toUnit(a.norm), clamp(a.novelty, 0, 1)]
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map(x => x / n) }
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)

const RAW = PROTOTYPES.map(p => [p.v[0], toUnit(p.v[1]), p.v[2], p.v[3], p.v[4], toUnit(p.v[5]), p.v[6]])
const MEAN = Array.from({ length: 7 }, (_, i) => RAW.reduce((s, v) => s + v[i], 0) / RAW.length)
const CENT = RAW.map(v => norm(v.map((x, i) => x - MEAN[i])))

export function appraisalOf(amy, { trust = 0.6, bandwidth = 0.6, neg = 0, hostile = 0, context = null, threatGain = 1 } = {}) {
  // threatGain：同一次威胁，对一个"更容易被扎到"的人意味着更多。
  // 默认 1，人格不写就跟原来的数一模一样。
  const threat = clamp((amy?.threat ?? 0) * (1 + 0.3 * neg) * threatGain, 0, 1)
  // 静息威胁是噪声，不是"这句话不顺"。
  // 以前 goal = rewardPE - 0.8 * threat，而杏仁核静息威胁约 0.05，
  // 于是任何中性话都拿到 goal ≈ -0.04：心情被一路拖着往下，
  // 十轮纯技术对话就能从 0.10 掉到 0.00，还会凭空冒出"厌烦/心痛"。
  // 减掉地板之后再算：中性话真的回到 0，真威胁该多冲还是多冲。
  const pos = clamp(amy?.rewardPE ?? 0, 0, 1)
  const kind = amy?.kind ?? 'neutral'
  let goal = clamp((amy?.rewardPE ?? 0) - 0.8 * threat, -1, 1)
  let coping = clamp(0.30 + 0.6 * bandwidth - 0.45 * threat + 0.15 * pos, 0, 1)
  let normv = threat > 0.5 ? -0.4 : 0
  let agencyOther = threat > 0.2 || pos > 0.2 ? 0.85 : 0.45
  if (kind === 'apology') { goal = clamp(goal + 0.45, -1, 1); coping = clamp(coping + 0.25, 0, 1); normv = 0.2; agencyOther = 0.9 }
  if (kind === 'positive') { goal = clamp(goal + 0.15, -1, 1); normv = 0.15; agencyOther = 0.9 }

  let relevance = clamp(0.30 + 0.55 * trust + 0.25 * threat + 0.10 * pos, 0, 1)
  let certainty = clamp(0.55 + 0.25 * (1 - (amy?.novelty ?? 0)), 0, 1)

  // 上下文修正：同一句话，在"刚被抱怨过"和"只是问个问题"里意义不一样
  if (context) {
    if (context.complaint) { goal = clamp(goal - 0.18, -1, 1); coping = clamp(coping - 0.08, 0, 1) }
    if (context.praise) { goal = clamp(goal + 0.10, -1, 1); relevance = clamp(relevance + 0.05, 0, 1) }
    if (context.question) { certainty = clamp(certainty + 0.10, 0, 1); relevance = clamp(relevance + 0.05, 0, 1) }
    if (context.rush) { coping = clamp(coping - 0.12, 0, 1); certainty = clamp(certainty - 0.05, 0, 1) }
    if (context.addressed) relevance = clamp(relevance + 0.08, 0, 1)
    if (context.moodTrend < -0.3) { goal = clamp(goal - 0.08, -1, 1); agencyOther = clamp(agencyOther + 0.1, 0, 1) }
  }

  return {
    relevance,
    goal, agencyOther,
    certainty,
    coping, norm: normv,
    novelty: clamp(amy?.novelty ?? 0, 0, 1),
  }
}

export function constructEmotions(appraisal, arousal = 0.4, opts = {}) {
  const floor = Number(opts.floor ?? 0.05)
  const v = vec(appraisal)
  const centered = norm(v.map((x, i) => x - MEAN[i]))
  const mag = Math.min(1, Math.hypot(...v) / 2.2)
  // 先按符号与规范限制候选，再在候选里挑最像的——顺序反过来就永远挑错
  const allowed = PROTOTYPES.map((p, i) => ({ p, i })).filter(({ p }) => {
    if (appraisal.goal < -0.05 && !NEG_KINDS.has(p.kind)) return false
    if (appraisal.goal > 0.05 && NEG_KINDS.has(p.kind)) return false
    if ((appraisal.norm ?? 0) >= -0.1 && (p.kind === '内疚' || p.kind === '羞耻')) return false
    return true
  })
  const scored = (allowed.length ? allowed : PROTOTYPES.map((p, i) => ({ p, i })))
    .map(({ p, i }) => ({ kind: p.kind, sim: dot(centered, CENT[i]) }))
    .sort((a, b) => b.sim - a.sim)
  const top = scored.filter(x => x.sim > 0.35).slice(0, 3)
  const list = (top.length ? top : [scored[0]]).map(x => ({
    kind: x.kind,
    intensity: clamp((0.5 + 0.5 * x.sim) * (0.55 + 0.45 * mag) * (0.6 + 0.4 * arousal), 0, 1),
  }))
  if (!list.length) return []
  const main = list[0]
  const out = [main, ...list.slice(1).filter(e => e.intensity >= 0.65 * main.intensity)].filter(e => e.intensity >= floor)
  // 语境明确时不许空手：哪怕很弱，也给最像的那个
  if (!out.length && opts.force && scored.length) return [{ kind: scored[0].kind, intensity: 0.12 }]
  return out
}

export function fuse(world, mood, persona) {
  const g = (id) => world.get(id)
  const amy = g('amygdala'), hyp = g('hypothalamus'), ins = g('insula'), hip = g('hippocampus')
  const pf = g('pfc'), soc = g('social'), att = g('attention'), nm = g('neuromod')
  const dmn = g('dmn'), endo = g('endocrine'), sick = g('sickness'), cur = g('curve')
  const rhy = g('rhythm'), bi = g('bias'), io = g('io')

  const threat = amy?.threat ?? 0
  // 人格三旋钮（默认中性：1 / 0 / 1）——人格不写，数值和以前一模一样。
  //   threatGain   同一次威胁，对更在意的人更扎
  //   baselineMood 底色偏移（向上/向下的长期基调）
  //   sensitivity  感受强度（身体的动静被放大的倍数）
  const pg = clamp(Number(persona?.threatGain ?? 1), 0.5, 2)
  const pSens = clamp(Number(persona?.sensitivity ?? 1), 0.5, 2)
  const pBase = clamp(Number(persona?.baselineMood ?? 0), -0.2, 0.2)
  const felt = ins?.felt ?? { intensity: 0, qualities: [], location: '' }
  const arousal = clamp(0.40 * threat + 0.25 * (hyp?.hpa?.cortisol ?? 0) + 0.25 * felt.intensity + 0.10 * (nm?.ne ?? 0.3), 0, 1)

  const appraisal = appraisalOf(amy, {
    trust: soc?.trust ?? 0.6,
    bandwidth: pf?.bandwidth ?? 0.6,
    neg: bi?.neg ?? 0,
    hostile: bi?.hostile ?? 0,
    context: world.context ?? null,
    threatGain: pg,
  })
  // 重评成功：把"顺不顺意"往回调一点
  if (pf?.reappraisal?.success) appraisal.goal = clamp(appraisal.goal + 0.12, -1, 1)
  // P13 道德判断：越界会让"该不该"更负
  if ((pf?.moral ?? 0) > 0.4) appraisal.norm = clamp(appraisal.norm - 0.2, -1, 1)

  // 语境直接看用户这句话本身：world.context 是给措辞用的，这里不能用它当准绳
  // 只看"这一拍"用户说了什么：不能回退到 context.lastText，
  // 那是一句话的旧影子，安静下来以后还挂着，会让心情一直按在被骂的那句上。
  const _utext = world.lastUserText || ''
  const _flags = _utext ? analyzeMessage(_utext) : null
  // 明确的好话/坏话，给评价一个"地板/天花板"。
  // 不这么做的话：被怼过一次之后 appraisal.goal 一直是负的，
  // 后面每一句都被判成坏消息——包括"你太厉害了"，人不是这么记仇的。
  // 只在字面明确时校准，且幅度有限（不是退回关键词判决）。
  if (_flags && !_flags.complaint) {
    if (_flags.praise) appraisal.goal = clamp(Math.max(appraisal.goal, 0.25), -1, 1)
  }
  if (_flags && !_flags.praise) {
    // 被骂不是「有点不顺」：直接把「顺不顺」压到更低，不然它还不如无关的闲聊掉得多
    if (_flags.complaint) appraisal.goal = clamp(Math.min(appraisal.goal, -0.5), -1, 1)
  }
  // 情绪由身上的状态定，文本只是旁证：
  // 以前只要字面像抱怨/夸奖就强制出情绪，没接记忆时等于退回关键词规则版。
  // 现在先看评价强度和唤醒度，文本只在"身体已经有点动静"时帮忙推一把。
  const mental = Math.max(Math.abs(appraisal.goal), appraisal.relevance * 0.5, Number(arousal) * 0.6)
  const textHint = !!(_flags && (_flags.complaint || _flags.praise))
  // 没有新的「话」在评价：上一次的判断要随时间淡掉，否则安静待着也会被旧评价按着
  if (!textHint) appraisal.goal = clamp(appraisal.goal * (arousal > 0.6 ? 0.7 : 0.35), -1, 1)
  const forced = mental > 0.5 || (textHint && mental > 0.12)
  const rawEmotions = constructEmotions(appraisal, arousal, { force: forced })
  let emotions = rawEmotions.slice()
  const candidates = rawEmotions.map(e => e.kind)
  // 语境明确（在抱怨 / 在夸）时不许被平线闸门吃掉，弱也要给一个最像的
  // 符号与规范约束：顺心程度为负时不许出正面情绪；没违背规范就不许出内疚/羞耻
  const goalSign = appraisal.goal
  if (goalSign < -0.05) emotions = emotions.filter(e => NEG_KINDS.has(e.kind))
  else if (goalSign > 0.05) emotions = emotions.filter(e => !NEG_KINDS.has(e.kind))
  if ((appraisal.norm ?? 0) >= -0.1) emotions = emotions.filter(e => e.kind !== '内疚' && e.kind !== '羞耻')
  // 归因决定方向：不怪自己的时候，也不该冒出内疚/羞耻
  const locus = pf?.attribution?.locus ?? 'circumstance'
  if (locus !== 'self') emotions = emotions.filter(e => e.kind !== '内疚' && e.kind !== '羞耻')
  // 中性输入不该硬凑出一个情绪：目标几乎没动、威胁也低，就让她平静
  const flat = Math.abs(appraisal.goal) < 0.16 && (amy?.threat ?? 0) < 0.3 && Math.abs(amy?.rewardPE ?? 0) < 0.15
  if (flat && !forced) {
    // 平线闸门以前会把余温也一起清掉，所以"骂完下一句就没了"。
    // 有最近事件、还在保质期内，就留一个慢慢变淡的余温。
    const _lk = globalThis.__AFFECT_LAST_KIND__
    const _age2 = globalThis.__AFFECT_LABEL_AGE__ ?? 0
    emotions = (_lk && _age2 < 3)
      ? [{ kind: _lk, intensity: clamp(0.42 - 0.05 * _age2, 0.32, 0.42), from: 'linger' }]
      : []
  }
  // 强制语境下如果全被阈值滤掉，至少留最像的一个（弱情绪也是情绪）
  // ── 情绪标签的门与惯性 ───────────────────────────────
  // 她的判断决定这一拍有没有情绪：这句话被评价过（抱怨/夸奖/被吓/达成/受挫）才出标签。
  // 但情绪有惯性：刚被怼完，接下来几句没被惹也还带着余温，随历史权重淡下去。
  const _hasEvent = Boolean(
    (textHint) || forced ||
    Math.abs(appraisal.goal) >= 0.3 ||
    threat >= 0.5 ||
    Math.abs(Number(amy?.rewardPE ?? 0)) >= 0.3
  )
  const _hist = (globalThis.__AFFECT_APPRAISAL_HIST__ ||= [])
  const _now = Date.now()
  _hist.push({ at: _now, goal: Number(appraisal.goal) || 0, event: _hasEvent })
  while (_hist.length > 16) _hist.shift()
  let _inertia = 0
  let _wsum = 0
  for (let i = _hist.length - 1; i >= 0; i -= 1) {
    const h = _hist[i]
    if (_now - h.at > 30 * 60 * 1000) break
    const w = Math.pow(0.8, _hist.length - 1 - i)
    _inertia += h.goal * w
    _wsum += w
  }
  _inertia = _wsum ? _inertia / _wsum : 0
  // 分工：kind 由她"对这句话的评价"给（当场就有），强度由杏仁核给（威胁/体感多重）。
  const _eventKind = _flags && _flags.complaint ? '委屈' : _flags && _flags.praise ? '安心' : null
  if (_eventKind) globalThis.__AFFECT_LAST_KIND__ = _eventKind
  if (_eventKind && !emotions.some((e) => e.kind === _eventKind)) {
    emotions.unshift({ kind: _eventKind, intensity: clamp(0.24 + 0.5 * Math.max(threat, felt.intensity, 0.3), 0, 1), from: 'appraisal' })
  }
  emotions = emotions.map((e) => ({
    ...e,
    intensity: clamp((e.intensity ?? 0.3) * (0.55 + 0.45 * threat + 0.3 * felt.intensity), 0, 1),
  }))
  if (process.env.DSH_FUSE_DEBUG) {
    console.error('[fuse]', JSON.stringify({ utext: _utext.slice(0, 30), complaint: !!_flags?.complaint, praise: !!_flags?.praise, event: _hasEvent, threat: Number(threat.toFixed(2)), kinds: emotions.map((e) => e.kind) }))
  }

  if (!_hasEvent) {
    const _last = globalThis.__AFFECT_LAST_KIND__
    if (!emotions.length && _last && (globalThis.__AFFECT_LABEL_AGE__ ?? 0) < 3) {
      emotions = [{ kind: _last, intensity: clamp(0.30 - 0.07 * (globalThis.__AFFECT_LABEL_AGE__ ?? 0), 0.08, 0.3), from: 'linger' }]
    }
  }
  if (!_hasEvent) {
    // 这一句没被惹到也没被夸到：不凭空生成新情绪，只留惯性余温（而且会越来越淡）
    // 余温由上面的 linger 块负责；这里不再二次覆盖（以前这里会把余温清成空）
  }

  // 字面明确的这句：她自己当场就给出反应，不等杏仁核慢慢涨。
  if (!emotions.length && _flags && (_flags.complaint || _flags.praise)) {
    emotions = [{ kind: _flags.complaint ? '委屈' : '安心', intensity: 0.34, from: 'text' }]
  }

  // 标签的保质期：连续几拍都没有新事件，旧情绪就该散了，不能一直挂着。
  const _age = (globalThis.__AFFECT_LABEL_AGE__ = (_hasEvent ? 0 : (globalThis.__AFFECT_LABEL_AGE__ ?? 0) + 1))
  if (!_hasEvent && _age >= 3) emotions = []

  if (forced && !emotions.length && rawEmotions.length) {
    emotions = [{ ...rawEmotions[0], intensity: Math.max(0.12, rawEmotions[0].intensity) }]
  }
  // 情绪强度不能超过身体的感受强度：身体没起来，嘴上就不该那么重
  // sensitivity 放大的是"身体的动静"这一项——敏感的人同样的体感，情绪更重
  emotions = emotions.map(e => ({ ...e, intensity: clamp(e.intensity * clamp(0.35 + 0.65 * felt.intensity * pSens, 0, 1.2), 0, 1) }))
  // 不应期：强威胁后，正性情绪先压住
  if (cur?.refractory) emotions = emotions.map(e => NEG_KINDS.has(e.kind) ? e : { ...e, intensity: e.intensity * 0.4 })
  // 矛盾情绪
  const ambivalence = emotions.length > 1 ? clamp(emotions[1].intensity / Math.max(0.01, emotions[0].intensity), 0, 1) : 0

  // 和 appraisal 同一个道理：静息威胁不该被算成"这句不顺"。
  // 不扣地板的话，任何一句话的效价都带着 -0.018 的底色，
  // 心情就会一路向那个负值回落（十轮从 0.10 到 0.075，什么都没发生）。
  // 被真正安抚时威胁感往下走（一边道歉一边继续指责的不算）。
  // 不这么做，"对不起"说出口、身体还绷着，心情永远回不来。
  const soothed = !!(_flags && !_flags.complaint && (_flags.praise || /对不起|抱歉|是我说重|我错|别生气|别往心里去/.test(_utext)))
  const threatV = clamp(threat * pg * (soothed ? 0.55 : 1), 0, 1)
  // 被安抚：当场把旧情绪换掉，别让"委屈"再多挂几拍
  if (soothed) {
    globalThis.__AFFECT_LAST_KIND__ = '安心'
    globalThis.__AFFECT_LABEL_AGE__ = 0
    emotions = emotions.filter((e) => !NEG_KINDS.has(e.kind))
    if (!emotions.length) emotions = [{ kind: '安心', intensity: 0.3, from: 'soothe' }]
  }
  const valence = clamp(
    0.55 * ((amy?.rewardPE ?? 0) - 0.7 * threatV) +
    // 她自己对这句话的判断也要算进去：但只在"这句正在被评价"的时候算，
    // 不然一句坏话会像欠债一样把心情永远按在水下。
    (textHint ? 0.25 * appraisal.goal : 0) +
    // 阴阳怪气：字面在夸，实际在刺——要压心情，不能靠"夸"的词面往回拉
    (textHint && _flags?.sarcasm ? -0.20 : 0) +
    // 被安抚时要有实打实的拉力，否则"回底色"会把道歉的效果吃掉
    (soothed ? 0.22 : 0) +
    // 人格的在意程度：同样一句难听的，越在意的人越疼一点点
    // （只用 threatV 不够——它到顶就饱和了，1.8 和 1.0 分不出来）
    (textHint && _flags?.complaint ? -0.10 * (pg - 1) : 0) +
    0.20 * ((persona.moodBase ?? 0.1) - mood) +
    0.15 * (hyp?.rhythm?.moodBias ?? 0) +
    0.10 * (soc?.trust ? (soc.trust - 0.5) : 0),
    -1, 1,
  )

  // 没有新事件：这一拍不该长出新的情绪，只保留余温
  if (!_hasEvent) emotions = emotions.filter((e) => e.from === 'linger')

  const moodTarget = clamp(
    (persona.moodBase ?? 0.1) + pBase + 0.45 * valence + 0.15 * (rhy?.bias ?? 0) + 0.1 * (hyp?.rhythm?.moodBias ?? 0) - 0.1 * (sick?.inflammation ?? 0)
      // 没人说话、也没新事：心情往底色回一点（恢复，不是继续往水里沉）
      + (textHint ? 0 : 0.06),
    -1, 1,
  )

  const display = {
    mask: pf?.display?.mask ?? 0.3,
    toneShift: pf?.display?.toneShift ?? 'normal',
    brevity: clamp((pf?.display?.brevity ?? 0.3) * 0.6 + (io?.brevity ?? 0.3) * 0.4, 0, 1),
    leakRisk: pf?.display?.leakRisk ?? 0.2,
    rules: soc?.relationship === 'stranger' ? 0.2 : soc?.relationship === 'close' ? 0.7 : 0.4,
  }

  // X07：情绪对象由评价的"谁造成的"裁决，不由各器官各标一个
  const target = (() => {
    const locus = pf?.attribution?.locus ?? 'circumstance'
    if (locus === 'self') return '自己'
    if (locus === 'other') return '他'
    return '这件事'
  })()
  // 兜底：语境明确（抱怨/夸）却空手时，保留最像的那个弱情绪——情绪不许凭空消失
  if (!emotions.length && forced && rawEmotions.length) {
    emotions = [{ ...rawEmotions[0], intensity: Math.max(0.15, rawEmotions[0].intensity) }]
  }
  // 最后一刀：这一拍没有「硬事件」（她刚说的话被评价成好/坏，或拿到明显正反馈），
  // 就只准余温留在情绪里。注意：不能拿累积的威胁值当事件——
  // 否则只是"时间过去了、人累了"，也会被当成被惹到，凭空冒出心痛/厌烦。
  const _hardEvent = textHint || Number(amy?.rewardPE ?? 0) >= 0.35 || felt.intensity >= 0.35
  if (!_hardEvent) emotions = emotions.filter((e) => e.from === 'linger')

  // 阴阳怪气：字面是夸，实际是刺——负性放大一点，别被哄高兴
  if (_flags?.sarcasm) {
    emotions = emotions.map((e) => (NEG_KINDS.has(e.kind) ? { ...e, intensity: clamp((e.intensity ?? 0) * 1.25, 0, 1) } : e))
  }
  // 中性话这一拍：上一句留下的情绪只是余温，不算"新冒出来的"
  if (Boolean(textHint) && !(_flags?.complaint || _flags?.praise || _flags?.sarcasm)) {
    emotions = emotions.map((e) => ({ ...e, from: 'linger' }))
  }
  // 越想越气：反刍高的时候，同一件不顺的事会被放大（人就是这么自己气自己）
  const _rum = clamp(Number(dmn?.rumination ?? 0), 0, 1)
  if (_rum > 0.3) {
    emotions = emotions.map((e) => (NEG_KINDS.has(e.kind) ? { ...e, intensity: clamp((e.intensity ?? 0) * (1 + 0.35 * _rum), 0, 1) } : e))
  }

  // 情绪按强度排序：主导情绪必须是强度最高的那个（不许我插进去的那条永远排第一）
  emotions.sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0))

  return {
    valence, arousal, mood, moodTarget, appraisal, emotions, ambivalence, target,
    felt: { ...felt, intensity: clamp(cur?.intensity ?? felt.intensity, 0, 1) },
    body: hyp?.body ?? {},
    display,
    attribution: pf?.attribution ?? { locus: 'circumstance', confidence: 0.5 },
    bandwidth: pf?.bandwidth ?? 0.6,
    needs: hyp?.needs ?? {},
    energy: hyp?.rhythm?.energy ?? 0.6,
    recall: hip?.recall ?? null,
    trust: soc?.trust ?? 0.6,
    socialPain: soc?.socialPain ?? 0,
    attachment: soc?.attachment ?? 'secure',
    trustLedger: soc?.ledgerOpen ?? 0,
    mindRead: soc?.mindRead ?? 0.5,
    empathy: soc?.affectiveEmpathy ?? 0.5,
    rumination: dmn?.rumination ?? 0,
    mindWander: dmn?.mindWander ?? 0,
    attention: { focus: att?.focus ?? 0.4, narrowing: att?.narrowing ?? 0, sticky: att?.sticky ?? 0 },
    curve: { phase: cur?.phase ?? 'peak', refractory: cur?.refractory ?? false },
    rhythm: { weekly: rhy?.weekly ?? 0, seasonal: rhy?.seasonal ?? 0, drift: rhy?.drift ?? 0 },
    io: io ?? {},
    sickness: sick ?? {},
    hormones: endo ?? {},
    startle: g('brainstem')?.startle ?? 0,
    withdraw: sick?.withdraw ?? 0,
    repair: pf?.repair ?? 0,
    regret: pf?.regret ?? 0,
    error: pf?.error ?? 0,
    seekComfort: io?.seekComfort ?? 0,
    selfReportGap: io?.selfReportGap ?? 0,
    sleepGate: hyp?.sleepGate ?? 1,
    nostalgia: hip?.nostalgia ?? 0,
    idle: dmn?.mindWander ?? 0,
    socialImagining: dmn?.socialImagining ?? 0,
    persons: hip?.persons ?? {},
    attitude: soc?.attitude ?? {},
    contagion: soc?.contagionOut ?? 0,
    schemas: hip?.schemas ?? [],
    attachment: soc?.attachment ?? 'secure',
    memoryEcho: world.memoryEcho ?? null,
    memorySchemas: world.memorySchemas ?? null,
    memorySchemaDebug: world.memorySchemaDebug ?? null,
    memoryRecent: world.memoryRecent ?? null,
    context: world.context ?? null,
    at: world.tx?.t1 ?? 0,
    txId: world.tx?.txId ?? 0,
    candidates,
    meme: io?.meme ?? null,
    stale: world.get('pfc')?.frame !== world.get('io')?.frame,
  }
}

