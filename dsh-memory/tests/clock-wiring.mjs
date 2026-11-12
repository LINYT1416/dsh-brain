// 接线检查：三个器官真的挂到同一个拍子上了吗
//
// 单测只证明 clock.js 本身对；这个证明"器官确实用它"——
// 否则哪天有人又把 setInterval 加回来，单测照样绿，线上却又多出三个钟。
//
//   node tests/clock-wiring.mjs
import { apply } from 'dsh-all'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// 必须从 dsh-all **自己那个目录**加载 clock，不能用相对路径 ../lib/clock.js：
// profile 里的 dsh-all 是软链/联接，两条路径会变成两个模块实例，
// 仪表读到的是另一个空实例（我第一次就是这么被坑的）。
const entry = fileURLToPath(import.meta.resolve('dsh-all'))
const { stats, reset } = await import(pathToFileURL(join(dirname(entry), 'lib', 'clock.js')).href)

const fails = []
const ok = (c, m) => { if (!c) fails.push(m) }

const services = new Map()
const fakeAgent = {
  id: 'clock-agent',
  ctx: {
    systemPrompt: { context: () => () => {} },
    effect(fn) { if (typeof fn === 'function') fn() },
    on() { return () => {} },
    emit() { return true },
    get: (n) => ctx.get(n),
  },
}

// 注意：effect 是"登记清理函数"，**不能立即执行**。
// 我第一版写成 `effect(fn){ fn() }`，结果器官注册完拍子立刻被自己的 disposer 注销，
// 仪表看到的就是"一个任务都没有"——假阴性比假阳性更难查。
const cleanups = []
function effect(fn) { if (typeof fn === 'function') cleanups.push(fn); return () => {} }

const ctx = {
  tools: { register: () => () => {} },
  webServer: { register: () => () => {} },
  agents: { list: () => [fakeAgent] },
  provide: (n, v) => services.set(n, v),
  set: (n, v) => services.set(n, v),
  get(n) {
    if (n === 'tools') return ctx.tools
    if (n === 'webServer') return ctx.webServer
    if (n === 'agents') return ctx.agents
    return services.get(n) || null
  },
  effect,
  on() { return () => {} },
  emit() { return true },
}

reset()
apply(ctx)

const names = stats().jobs.map((j) => j.name).sort()

// 五个周期性动作都该在同一个钟里
for (const want of ['amygdala.tick', 'cortex.shallow', 'cortex.deep', 'hippocampus.shallow', 'hippocampus.deep']) {
  ok(names.includes(want), `拍子上缺 ${want}，实际有：${names.join(', ')}`)
}

// 周期要对（别把 5 分钟写成 50 分钟那种）
const byName = Object.fromEntries(stats().jobs.map((j) => [j.name, j]))
ok(byName['amygdala.tick']?.everyMs === 5 * 60_000, `amygdala 周期错：${byName['amygdala.tick']?.everyMs}`)
ok(byName['cortex.shallow']?.everyMs === 5 * 60_000, `cortex.shallow 周期错：${byName['cortex.shallow']?.everyMs}`)
ok(byName['hippocampus.shallow']?.everyMs === 10 * 60_000, `hippocampus.shallow 周期错：${byName['hippocampus.shallow']?.everyMs}`)
ok(byName['cortex.deep']?.atHour === 3, `cortex.deep 该定在 3 点：${JSON.stringify(byName['cortex.deep'])}`)
ok(byName['hippocampus.deep']?.atHour === 3, `hippocampus.deep 该定在 3 点：${JSON.stringify(byName['hippocampus.deep'])}`)

reset()

if (fails.length) {
  console.log(`FAIL ${fails.length}:`)
  for (const f of fails) console.log(' - ' + f)
  process.exit(1)
}
console.log(`PASS 器官都挂在同一个拍子上（${names.length} 个到期点：${names.join(' / ')}）`)
process.exit(0)
