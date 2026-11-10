/**
 * 临时诊断脚本：提取 promptfoo 最近一次评测中失败用例的断言明细
 * 用完可删
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(`${process.env.TEMP}/pf-copy.db`)
const evalId = process.argv[2] || 'eval-LcV-2026-11-10T07:27:01'
const rows = db
  .prepare(
    'SELECT eval_id, test_idx, test_case, error, success, grading_result FROM eval_results WHERE eval_id = ? ORDER BY test_idx'
  )
  .all(evalId)

for (const row of rows) {
  if (row.success) continue
  const vars = JSON.parse(row.test_case || '{}')?.vars || {}
  console.log(`\n=== [test#${row.test_idx}] ${vars.question} (expectedDocs: ${JSON.stringify(vars.expectedDocs)})`)
  if (row.error) console.log('  provider error:', String(row.error).slice(0, 200))
  if (row.grading_result) {
    const grading = JSON.parse(row.grading_result)
    console.log('  overall:', String(grading.reason || '').slice(0, 300))
    for (const c of grading.componentResults || []) {
      console.log(`   ${c.pass ? 'PASS' : 'FAIL'} score=${c.score}`)
      if (!c.pass) console.log(`      reason: ${String(c.reason || '').slice(0, 800)}`)
    }
  }
}
db.close()
