#!/usr/bin/env node
/**
 * 推理链回放 CLI（P0' 度量地基）：
 *   node scripts/replay-reasoning.js --q 关键词 [--date 2026-11-12]
 *
 * 读取 server/.runtime/logs/audit-YYYY-MM-DD.log（observability 按天切分的 JSONL），
 * 筛出 action == "agent.reasoning.trace" 且 question 或任一工具调用命中关键词的记录，
 * 按时间顺序打印 runId、question、reasoning 与每步工具调用。
 *
 * 仅依赖 node 内置模块，不触发应用初始化（db/config 等）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOG_DIR = path.resolve(__dirname, '../.runtime/logs')
const EVENT = 'agent.reasoning.trace'

const USAGE = `用法：node scripts/replay-reasoning.js --q <关键词> [--date YYYY-MM-DD]

选项：
  --q      必填，命中 question 或任一工具调用（tool/args）的关键词（不区分大小写）
  --date   可选，审计日志日期，默认今天（UTC，与审计文件切分一致），格式 YYYY-MM-DD
  --help   显示本帮助

日志目录：${LOG_DIR}`

function parseArgs(argv) {
  const args = { q: null, date: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else if (argv[i] === '--q' || argv[i] === '-q') args.q = argv[++i] ?? null
    else if (argv[i] === '--date') args.date = argv[++i] ?? null
  }
  return args
}

/** 读取并解析 JSONL（坏行静默跳过） */
function readTraceEntries(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const entries = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { entries.push(JSON.parse(trimmed)) } catch { /* 跳过坏行 */ }
  }
  return entries
}

/** reasoning 兼容两种落盘形态：分块数组（当前）或单字符串 */
function joinReasoning(entry) {
  const value = entry.reasoningChunks ?? entry.reasoning
  return Array.isArray(value) ? value.join('') : String(value ?? '')
}

function printEntry(entry, index) {
  const reasoning = joinReasoning(entry)
  const toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : []
  console.log(`\n[${index + 1}] ${entry.time || '(无时间)'}  runId=${entry.runId || '(无)'}`)
  console.log(`  sessionId=${entry.sessionId ?? '(无)'}  userId=${entry.userId ?? '(无)'}`)
  console.log(`  question: ${entry.question || '(空)'}`)
  console.log(`  reasoning (${reasoning.length} 字符):`)
  console.log(reasoning ? reasoning.split('\n').map((line) => `    ${line}`).join('\n') : '    (无推理正文)')
  console.log(`  工具调用 (${toolCalls.length} 步):`)
  if (!toolCalls.length) console.log('    (无)')
  for (const [i, call] of toolCalls.entries()) {
    console.log(`    #${i + 1} ${call.tool}  ok=${call.ok}  returnedChars=${call.returnedChars}`)
    if (call.args) console.log(`       args: ${call.args}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(USAGE); return }
  if (!args.q) { console.log(USAGE); process.exitCode = 1; return }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`日期格式应为 YYYY-MM-DD，收到：${args.date}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const date = args.date || new Date().toISOString().slice(0, 10)
  const file = path.join(LOG_DIR, `audit-${date}.log`)
  const entries = readTraceEntries(file)
  if (entries === null) {
    console.log(`未找到审计日志文件：${file}`)
    console.log(`该日期可能没有审计记录，或日期写法不对（示例：--date ${new Date().toISOString().slice(0, 10)}）。`)
    return
  }
  const keyword = args.q.toLowerCase()
  const hits = entries
    .filter((entry) => (entry.action || entry.event) === EVENT)
    .filter((entry) => {
      const inQuestion = typeof entry.question === 'string' && entry.question.toLowerCase().includes(keyword)
      const inTools = (Array.isArray(entry.toolCalls) ? entry.toolCalls : []).some((call) =>
        String(call?.tool ?? '').toLowerCase().includes(keyword)
        || String(call?.args ?? '').toLowerCase().includes(keyword))
      return inQuestion || inTools
    })
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')))
  if (!hits.length) {
    console.log(`在 ${file} 中未找到命中的 ${EVENT} 记录（关键词：${args.q}）。`)
    return
  }
  console.log(`命中 ${hits.length} 条 ${EVENT} 记录（共 ${entries.length} 条审计，文件：${file}）`)
  hits.forEach(printEntry)
}

main()
