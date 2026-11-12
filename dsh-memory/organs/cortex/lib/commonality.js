// 共性提取（F21）：多次经历提共性，偶性丢弃。
// 规则版：同主体+同谓词出现 ≥N 个不同客体 → 升一条“规律”型 cell。
export function groupByPredicate(cells) {
  const map = new Map()
  for (const c of cells) {
    if (c.retracted) continue
    const key = `${c.subject}|${c.predicate}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(c)
  }
  return map
}

/** 只有偏好类谓词能提炼成“规律”；计划/正在做/经历凑一起只会变成一句废话。 */
const PATTERN_PREDICATES = new Set(['喜欢', '讨厌', '偏好', '习惯', '爱', '不喜欢'])

/** 找共性：同谓词、不同客体、≥min 个 → 一条 rule。 */
export function findPatterns(cells, { min = 3 } = {}) {
  const out = []
  for (const [key, group] of groupByPredicate(cells)) {
    const predicate = key.split('|')[1]
    if (!PATTERN_PREDICATES.has(predicate)) continue
    const objects = [...new Set(group.map((c) => c.object).filter(Boolean))]
    if (objects.length < min) continue
    const [subject] = key.split('|')
    out.push({
      kind: 'concept',
      subject,
      predicate,
      object: objects.join('、'),
      text: `${subject}${predicate}：${objects.join('、')}`,
      source: 'inferred',
      confidence: 0.55,
      supportIds: group.flatMap((c) => c.supportIds || []),
      evidenceCount: objects.length,
      tags: ['pattern'],
    })
  }
  return out
}

/** 同一件事的多条证据合并（去重支撑 id）。 */
export function mergeEvidence(cells) {
  return {
    supportIds: [...new Set(cells.flatMap((c) => c.supportIds || []))],
    evidenceCount: new Set(cells.flatMap((c) => c.supportIds || [])).size || cells.length,
    lastSeen: Math.max(0, ...cells.map((c) => c.lastSeen || 0)),
  }
}
