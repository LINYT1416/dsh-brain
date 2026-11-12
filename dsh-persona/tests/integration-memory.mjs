// 人格 ↔ 记忆 的真接线（不是拿假 hip 验的）：
// 把真的记忆插件起起来，写几段，再让人格的记忆桥去拿——
// 缓存要真有东西，且情绪条目不进"最近发生了什么"。
//
//   node tests/integration-memory.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fails = []
const ok = (c, m) => { if (!c) fails.push(m) }

const root = mkdtempSync(join(tmpdir(), 'persona-mem-'))
process.env.DSH_HOME = root
process.env.HIPPOCAMPUS_DIR = join(root, 'hippocampus')
process.env.CORTEX_DIR = join(root, 'cortex')

const { apply: applyMemory } = await import('file:///E:/memory/dsh-all/index.js')
const { createMemoryBridge } = await import('../bridge/memory.js')

const services = new Map()
const ctx = {
  systemPrompt: { context: () => () => {} },
  webServer: { register: () => () => {} },
  tools: { register: () => () => {}, get: () => null },
  agents: { list: () => [] },
  provide: (n, v) => services.set(n, v),
  set: (n, v) => services.set(n, v),
  get: (n) => services.get(n) || null,
  on: () => () => {},
  emit: () => true,
  effect: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
}
applyMemory(ctx)
const hip = services.get('memory.hippocampus')
ok(Boolean(hip), '记忆插件没 provide memory.hippocampus')

// 两段真事 + 一条情绪写回
await hip.write({ role: 'user', text: '明天想去海边走走，顺便吃个海鲜', session: 'p1' })
await hip.write({ role: 'user', text: '晚上改表格改到很晚，有点累', session: 'p1' })
await hip.write({
  role: 'assistant',
  text: '【情绪】委屈：他说"你行不行啊"',
  kind: 'affect',
  force: true,
  valence: -0.6,
  session: 'p1',
})

const bridge = createMemoryBridge((id) => services.get(id) || null)
ok(bridge.present() === true, 'bridge.present() 应为 true')

const r = await bridge.refresh(6)
ok(r?.ok === true, `refresh 失败：${JSON.stringify(r)}`)

const eps = bridge.episodes()
ok(eps.length >= 1, `人格拿到的记忆是空的（真实记忆里明明有东西）`)

const texts = eps.map((e) => String(e.brief || '')).join(' | ')
ok(texts.length > 0, '拿到的条目全是空 brief')
ok(!/【情绪】/.test(texts), `情绪条目漏进人格的 recent：${texts.slice(0, 200)}`)
ok(/海边|表格/.test(texts), `真实记忆没拿到：${texts.slice(0, 200)}`)

const st = bridge.status()
ok(Number(st?.cached) >= 1, `status.cached 是 ${st?.cached}，应为正数`)

rmSync(root, { recursive: true, force: true })

if (fails.length) {
  console.log(`FAIL ${fails.length}:`)
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log(`PASS 人格↔记忆（真实记忆 ${eps.length} 条进 recent，情绪条目被挡，cached ${st.cached}）`)
process.exit(0)
