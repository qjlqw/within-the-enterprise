/**
 * A/B 对照报告（第 3 步）：对比两份 agent-evaluation 产物，输出指标 delta + 逐用例翻转
 *
 * 用法：
 *   node scripts/compare-reports.mjs <baseline.json> <experiment.json>
 *   node scripts/compare-reports.mjs                # 自动取 .artifacts 下最新的两份
 *
 * A/B 流程（开关在进程启动时读取，必须分两次跑）：
 *   $env:MEMORY_ENABLED='true';  npm run eval:agent
 *   $env:MEMORY_ENABLED='false'; npm run eval:agent
 *   node scripts/compare-reports.mjs
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const folder = path.dirname(fileURLToPath(new URL('../../.artifacts/', import.meta.url)))
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))

async function resolveReports() {
  if (args.length >= 2) return args.slice(0, 2)
  const files = (await fs.readdir(folder))
    .filter((f) => f.startsWith('agent-evaluation-') && f.endsWith('.json'))
    .sort()
  if (files.length < 2) {
    console.error('需要两份报告：node scripts/compare-reports.mjs <baseline.json> <experiment.json>')
    process.exit(1)
  }
  return [path.join(folder, files.at(-2)), path.join(folder, files.at(-1))]
}

// 需要对比的 summary 指标（越高越好的标 up，越低越好的标 down）
const METRICS = [
  ['completed', 'up'],
  ['failed', 'down'],
  ['citationAccuracy', 'up'],
  ['emptyAnswerRate', 'down'],
  ['failureRate', 'down'],
  ['latencyAvgMs', 'down'],
  ['latencyP95Ms', 'down'],
]

function fmt(v) {
  return v === null || v === undefined ? 'n/a' : String(v)
}

function deltaRow(key, dir, a, b) {
  const changed = a !== null && b !== null && a !== b
  let arrow = ''
  if (changed) {
    const better = dir === 'up' ? b > a : b < a
    arrow = better ? ' ↑ 改善' : ' ↓ 恶化'
  }
  return { key, baseline: fmt(a), experiment: fmt(b), delta: changed ? (b - a).toFixed(4) : '-', note: arrow }
}

async function main() {
  const [leftPath, rightPath] = await resolveReports()
  const [left, right] = await Promise.all(
    [leftPath, rightPath].map(async (p) => JSON.parse(await fs.readFile(p, 'utf8')))
  )

  console.log(`基线   : ${path.basename(leftPath)}（${left.date}）`)
  console.log(`实验   : ${path.basename(rightPath)}（${right.date}）`)
  if ((left.model || '') !== (right.model || '')) {
    console.log(`⚠️  两份报告模型不同：${left.model} vs ${right.model}，对比结论需谨慎`)
  }

  console.log('\n== 汇总指标 ==\n')
  const rows = []
  console.log('指标'.padEnd(20), '基线'.padEnd(14), '实验'.padEnd(14), 'delta'.padEnd(12), '备注')
  for (const [key, dir] of METRICS) {
    const row = deltaRow(key, dir, left.summary?.[key] ?? null, right.summary?.[key] ?? null)
    rows.push(row)
    console.log(row.key.padEnd(20), row.baseline.padEnd(14), row.experiment.padEnd(14), row.delta.padEnd(12), row.note)
  }
  for (const [key, label] of [
    ['inputAvg', 'token 输入均值'],
    ['outputAvg', 'token 输出均值'],
    ['toolCallsTotal', '工具调用总数'],
    ['modelCallsTotal', '模型调用总数'],
  ]) {
    const a = key === 'inputAvg' || key === 'outputAvg' ? left.summary?.tokens?.[key] : left.summary?.[key]
    const b = key === 'inputAvg' || key === 'outputAvg' ? right.summary?.tokens?.[key] : right.summary?.[key]
    const row = deltaRow(label, 'down', a ?? null, b ?? null)
    rows.push(row)
    console.log(row.key.padEnd(20), row.baseline.padEnd(14), row.experiment.padEnd(14), row.delta.padEnd(12), row.note)
  }

  // 逐用例翻转：引用正确性（sourceMatch）与失败状态的变化
  const leftById = new Map(left.results.map((r) => [r.id, r]))
  const flips = []
  for (const r of right.results) {
    const base = leftById.get(r.id)
    if (!base) continue
    const aMatch = base.sourceMatch === true
    const bMatch = r.sourceMatch === true
    const aFailed = base.status === 'failed'
    const bFailed = r.status === 'failed'
    if (aMatch !== bMatch || aFailed !== bFailed) {
      flips.push({
        id: r.id,
        baseline: `${aFailed ? 'failed' : aMatch ? 'sourceMatch' : 'miss'}`,
        experiment: `${bFailed ? 'failed' : bMatch ? 'sourceMatch' : 'miss'}`,
        question: r.question,
      })
    }
  }
  console.log('\n== 逐用例翻转 ==\n')
  if (!flips.length) {
    console.log('无翻转（两轮表现一致）')
  } else {
    for (const f of flips) {
      console.log(`[${f.id}] ${f.baseline} -> ${f.experiment} | ${String(f.question).slice(0, 40)}`)
    }
  }

  const out = path.join(folder, `compare-${Date.now()}.json`)
  await fs.writeFile(
    out,
    JSON.stringify({ baseline: path.basename(leftPath), experiment: path.basename(rightPath), summary: rows, flips }, null, 2),
  )
  console.log(`\n对比报告: ${out}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
