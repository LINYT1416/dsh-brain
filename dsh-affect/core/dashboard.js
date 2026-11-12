// 仪表页：把"她此刻在想什么"拆成可看的多维数据。
// 只读快照，不改任何状态；每次请求现算。

import { clamp } from './consts.js'

const pct = (x) => Math.round(clamp(x, 0, 1) * 100)

export function summarize(engine) {
  const f = engine.read()
  if (!f) engine.tick()
  const g = engine.read()
  const organs = engine.organs
  const hyp = organs.hypothalamus.read()
  const ins = organs.insula.read()
  const pf = organs.pfc.read()
  const soc = organs.social.read()
  const hip = organs.hippocampus.read()
  const dmn = organs.dmn.read()
  const att = organs.attention.read()
  const cur = organs.curve.read()
  const io = organs.io.read()

  const main = g.emotions?.[0]
  const mood = engine.state.mood
  const label = main
    ? `${main.kind} ${main.intensity.toFixed(2)}`
    : (mood >= 0.45 ? '心情挺好' : mood >= 0.2 ? '还行' : mood > -0.2 ? '平平的' : '有点低')

  const memBridge = engine.bridgeStatus?.() ?? null
  return {
    at: new Date().toISOString(),
    tick: engine.state.ticks,
    headline: label,
    mood: { value: Number(mood.toFixed(3)), pct: pct((mood + 1) / 2), label },
    valence: Number((g.valence ?? 0).toFixed(3)),
    arousal: pct(g.arousal ?? 0),
    emotions: (g.emotions ?? []).map(e => ({ kind: e.kind, intensity: pct(e.intensity) })),
    target: g.target ?? '这件事',
    body: {
      hr: Math.round(hyp.body?.hr ?? 0),
      breath: Math.round(hyp.body?.breath ?? 0),
      tension: pct(hyp.body?.tension ?? 0),
      pain: pct(hyp.body?.pain ?? 0),
      temp: Number((hyp.body?.temp ?? 0).toFixed(2)),
      qualities: ins.felt?.qualities ?? [],
      location: ins.felt?.location ?? '',
      felt: pct(ins.felt?.intensity ?? 0),
    },
    dimensions: [
      { key: '心情', v: pct((mood + 1) / 2), note: mood >= 0 ? '偏正' : '偏负' },
      { key: '唤醒', v: pct(g.arousal ?? 0), note: (g.arousal ?? 0) > 0.6 ? '绷着' : '松' },
      { key: '体内感', v: pct(ins.felt?.intensity ?? 0), note: (ins.felt?.qualities ?? []).join('') || '没感觉' },
      { key: '理性余量', v: pct(pf.bandwidth ?? 0), note: (pf.bandwidth ?? 0) < 0.25 ? '快撑不住' : '还在' },
      { key: '忍住多少', v: pct(pf.display?.mask ?? 0), note: `泄漏 ${pct(pf.display?.leakRisk ?? 0)}` },
      { key: '戒备', v: pct(soc.trust != null ? 1 - soc.trust : 0.4), note: soc.attachment },
      { key: '社交电量', v: pct(1 - (hyp.needs?.contact ?? 0)), note: (hyp.needs?.contact ?? 0) > 0.6 ? '想找人' : '够用' },
      { key: '专注', v: pct(att.focus ?? 0), note: `窄化 ${pct(att.narrowing ?? 0)}` },
      { key: '疲惫', v: pct(hyp.sleepDebt ?? 0), note: `睡债 ${pct(hyp.sleepDebt ?? 0)}` },
      { key: '饥饿', v: pct(hyp.needs?.hunger ?? 0), note: (hyp.needs?.hunger ?? 0) > 0.7 ? '饿' : '还行' },
    ],
    mind: {
      wander: pct(dmn.mindWander ?? 0),
      rumination: pct(dmn.rumination ?? 0),
      socialImagining: pct(dmn.socialImagining ?? 0),
      stuck: pct(att.sticky ?? 0),
      craving: pct(ins.craving ?? 0),
    },
    social: {
      trust: pct(soc.trust ?? 0),
      socialPain: pct(soc.socialPain ?? 0),
      attachment: soc.attachment ?? 'secure',
      ledger: soc.ledgerOpen ?? 0,
      contagion: pct(soc.contagionOut ?? 0),
    },
    needs: {
      hunger: pct(hyp.needs?.hunger ?? 0),
      sleep: pct(hyp.needs?.sleep ?? 0),
      contact: pct(hyp.needs?.contact ?? 0),
      control: pct(hyp.needs?.control ?? 0),
    },
    cycle: hyp.cycle ?? null,
    memory: {
      count: hip.count ?? 0,
      // 刚想起：优先用这一拍真的从记忆里想起来的头一条（memoryEcho），
      // 没有才退回心情自己的"本地情绪片段"。以前只读 hip.recall，
      // 而它每拍先被清成 null、回填的兜底对象又没有 brief —— 所以永远是 —。
      recall: (g.memoryEcho?.hits?.[0]?.brief) || (hip.recall && hip.recall.hit ? hip.recall.brief : null),
      recallSource: g.memoryEcho?.hits?.length ? 'memory' : (hip.recall?.hit ? 'local' : null),
      schemas: ((g.memorySchemas && g.memorySchemas.length)
        ? g.memorySchemas
        : (hip.schemas ?? []).map(s => s.rule)).slice(0, 3),
      echo: g.memoryEcho?.hits?.map(h => h.brief) ?? null,
      recent: (g.memoryRecent ?? []).map(x => x.brief),
      organs: memBridge,
      schemaDebug: g.memorySchemaDebug ?? memBridge?.schemaDebug?.() ?? null,
      debug: engine.debugRecall?.(engine.lastUserText ?? '') ?? null,
    },
    curve: { phase: cur.phase, refractory: !!cur.refractory, intensity: pct(cur.intensity ?? 0) },
    output: {
      tone: pf.display?.toneShift ?? 'normal',
      brevity: pct(io.brevity ?? 0),
      delaySec: Math.round((io.replyDelayMs ?? 0) / 1000),
      meme: pct(io.memeTendency ?? 0),
    },
    trace: (engine.trace ?? []).slice(-30).map(t => ({ tick: t.txId, mood: t.mood, valence: t.valence, emotion: t.emotion, error: t.error || null })),
  }
}

const bar = (label, v, note = '') => `
  <div class="row">
    <div class="k">${label}</div>
    <div class="track"><i style="width:${v}%"></i></div>
    <div class="v">${v}${note ? ` <em>${note}</em>` : ''}</div>
  </div>`

export function dashboardHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>她的此刻</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#232b36;--fg:#e6edf3;--dim:#8b949e;--acc:#7aa2f7;--warm:#f7c76b;--bad:#f7768e;--ok:#9ece6a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:18px 22px 8px}
h1{font-size:18px;margin:0 0 4px}
.sub{color:var(--dim);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;padding:12px 22px 28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card h2{font-size:13px;margin:0 0 10px;color:var(--dim);font-weight:600;letter-spacing:.5px}
.row{display:flex;align-items:center;gap:8px;margin:6px 0}
.k{width:78px;color:var(--dim);font-size:12px;flex:none}
.track{flex:1;height:8px;background:#1f2732;border-radius:6px;overflow:hidden}
.track i{display:block;height:100%;background:linear-gradient(90deg,#3d59a1,var(--acc));border-radius:6px}
.v{width:86px;text-align:right;font-variant-numeric:tabular-nums;font-size:12px}
.v em{color:var(--dim);font-style:normal}
.big{font-size:26px;font-weight:700}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:#1f2732;color:var(--dim);font-size:12px;margin-right:6px}
.pill.on{background:#22303f;color:var(--warm)}
.kv{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}
.kv span:first-child{color:var(--dim)}
#spark{width:100%;height:56px;display:block}
.err{color:var(--bad)}
</style>
</head>
<body>
<header>
  <h1>她此刻</h1>
  <div class="sub" id="head">加载中…</div>
</header>
<div class="grid">
  <div class="card"><h2>概括</h2>
    <div class="big" id="label">—</div>
    <div class="sub" id="at"></div>
    <div style="margin-top:8px" id="emos"></div>
    <svg id="spark" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
  </div>
  <div class="card"><h2>十个维度</h2><div id="dims"></div></div>
  <div class="card"><h2>身体</h2><div id="body"></div></div>
  <div class="card"><h2>脑子里在转什么</h2><div id="mind"></div></div>
  <div class="card"><h2>关系</h2><div id="social"></div></div>
  <div class="card"><h2>需求 / 周期</h2><div id="needs"></div></div>
  <div class="card"><h2>记忆</h2><div id="memory"></div></div>
  <div class="card"><h2>表达倾向</h2><div id="output"></div></div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const bar = (k, v, note) => '<div class="row"><div class="k">' + k + '</div><div class="track"><i style="width:' + v + '%"></i></div><div class="v">' + v + (note ? ' <em>' + note + '</em>' : '') + '</div></div>'
const kv = (k, v) => '<div class="kv"><span>' + k + '</span><span>' + v + '</span></div>'

async function tick(){
  try{
    const r = await fetch('/affect/live', {cache:'no-store'})
    const d = await r.json()
    $('head').textContent = '第 ' + d.tick + ' 拍 · ' + d.at.replace('T',' ').slice(0,19)
    $('label').textContent = d.headline
    $('at').textContent = '对象：' + d.target + ' · 效价 ' + d.valence + ' · 唤醒 ' + d.arousal
    $('emos').innerHTML = d.emotions.length ? d.emotions.map(e => '<span class="pill on">' + e.kind + ' ' + e.intensity + '</span>').join('') : '<span class="pill">没有明显情绪</span>'
    $('dims').innerHTML = d.dimensions.map(x => bar(x.key, x.v, x.note)).join('')
    $('body').innerHTML = kv('心率', d.body.hr) + kv('呼吸', d.body.breath) + kv('紧张', d.body.tension + '%') + kv('疼', d.body.pain + '%') + kv('体温感', d.body.temp) + kv('质地', (d.body.qualities.join('、') || '—') + (d.body.location ? ' @' + d.body.location : ''))
    $('mind').innerHTML = bar('走神', d.mind.wander) + bar('反刍', d.mind.rumination) + bar('想他', d.mind.socialImagining) + bar('念头黏住', d.mind.stuck) + bar('渴求', d.mind.craving)
    $('social').innerHTML = bar('信任', d.social.trust) + bar('被晾的痛', d.social.socialPain) + kv('依恋', d.social.attachment) + kv('没清的事', d.social.ledger) + kv('情绪外溢', d.social.contagion + '%')
    $('needs').innerHTML = bar('饿', d.needs.hunger) + bar('困', d.needs.sleep) + bar('想联系人', d.needs.contact) + bar('想掌控', d.needs.control) + kv('周期', d.cycle && d.cycle.on ? ('第 ' + d.cycle.day + ' 天 · ' + (d.cycle.phase || '平常')) : '关')
    $('memory').innerHTML = kv('情绪情景', d.memory.count) + kv('刚想起', d.memory.recall || '—') + kv('记忆回声', (d.memory.echo || []).join(' / ') || '—') + kv('图式', d.memory.schemas.join(' / ') || '—')
    $('output').innerHTML = kv('语气', d.output.tone) + bar('话变短', d.output.brevity) + kv('回复延迟', d.output.delaySec + ' 秒') + bar('表情包倾向', d.output.meme) + kv('曲线', d.curve.phase + (d.curve.refractory ? ' · 不应期' : ''))
    drawSpark(d.trace)
  }catch(e){ $('head').textContent = '读取失败：' + e.message }
}

function drawSpark(trace){
  const pts = trace.filter(t => typeof t.mood === 'number')
  if(pts.length < 2){ $('spark').innerHTML = ''; return }
  const w = 300, h = 56, ys = pts.map(p => (1 - (p.mood + 1) / 2) * h)
  const path = ys.map((y,i) => (i ? 'L' : 'M') + (i * w / (ys.length - 1)).toFixed(1) + ' ' + y.toFixed(1)).join(' ')
  $('spark').innerHTML = '<path d="' + path + '" fill="none" stroke="#7aa2f7" stroke-width="2"/>' + '<line x1="0" y1="28" x2="300" y2="28" stroke="#232b36"/>'
}

tick(); setInterval(tick, 2000)
</script>
</body></html>`
}
