import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config/index.js'
import { initDb } from '../src/db/index.js'
import { assertModelConfigured } from '../src/agent/model.js'
import { runAgent } from '../src/agent/index.js'

const smoke = process.argv.includes('--smoke')
try { assertModelConfigured() } catch (error) {
  console.error(`${error.message}。请先配置 server/.env；未执行真实模型验证。`)
  process.exitCode = 2
}
if (!process.exitCode) {
  initDb()
  const cases = JSON.parse(await fs.readFile(new URL('../test/agent/evaluation.json', import.meta.url), 'utf8'))
  const histories = new Map()
  const report = { date: new Date().toISOString(), node: process.version, model: config.agent.model,
    baseURL: config.agent.baseURL, mode: smoke ? 'smoke' : 'evaluation', results: [] }
  for (const item of smoke ? cases.slice(0, 2) : cases) {
    const history = histories.get(item.followUpTo) || { messages: [], sources: [] }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.agent.timeoutMs)
    const started = Date.now()
    try {
      const result = await runAgent({ userId: 1, message: item.question, history, signal: controller.signal })
      const actualDocuments = [...new Set(result.sources.map((source) => source.documentId))]
      const sourceMatch = item.documents.every((id) => actualDocuments.includes(id))
      report.results.push({ ...item, answer: result.text, actualDocuments, sourceMatch,
        usage: result.usage, durationMs: Date.now() - started, semanticReview: 'pending' })
      histories.set(item.id, { messages: [...history.messages, { role: 'user', content: item.question }, { role: 'assistant', content: result.text }], sources: result.evidence })
      console.log(JSON.stringify({ id: item.id, status: 'completed', sourceMatch, ...result.usage }))
      if (smoke && (!sourceMatch || (item.id === 'onboarding' && result.usage.toolCalls < 2))) process.exitCode = 1
    } catch (error) {
      report.results.push({ id: item.id, status: 'failed', code: error.code || 'MODEL_ERROR', durationMs: Date.now() - started })
      console.error(JSON.stringify({ id: item.id, status: 'failed', code: error.code || 'MODEL_ERROR' }))
      process.exitCode = 1
    } finally { clearTimeout(timer) }
  }
  if (smoke) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 300)
    try {
      await runAgent({ userId: 1, message: '检索并详细对比所有已发布的技术文档', history: { messages: [], sources: [] }, signal: controller.signal })
      report.cancellation = 'completed_before_cancel; rerun required'
      process.exitCode = 1
    } catch {
      report.cancellation = controller.signal.aborted ? 'cancelled' : 'model_error'
      if (!controller.signal.aborted) process.exitCode = 1
    } finally { clearTimeout(timer) }
  }
  // 汇总指标：引用正确率（正例）、空回答率、失败率、延迟、Token 成本
  const completed = report.results.filter((r) => !r.status || r.status !== 'failed')
  const failed = report.results.filter((r) => r.status === 'failed')
  const positive = completed.filter((r) => Array.isArray(r.documents) && r.documents.length > 0)
  const citationHits = positive.filter((r) => r.sourceMatch).length
  const emptyAnswers = failed.filter((r) => r.code === 'EMPTY_RESPONSE').length
  const latencies = report.results.map((r) => r.durationMs || 0).sort((a, b) => a - b)
  const sum = (list, key) => list.reduce((acc, r) => acc + (r.usage?.[key] || 0), 0)
  const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0)
  report.summary = {
    total: report.results.length,
    completed: completed.length,
    failed: failed.length,
    // 引用正确率：正例中回答覆盖全部期望文档的比例（[Sx] 引用经 sourceIsValid 校验）
    citationAccuracy: positive.length ? Number((citationHits / positive.length).toFixed(4)) : null,
    positiveCases: positive.length,
    // 空回答率 / 失败率
    emptyAnswerRate: Number((emptyAnswers / report.results.length).toFixed(4)),
    failureRate: Number((failed.length / report.results.length).toFixed(4)),
    // 延迟
    latencyAvgMs: avg(latencies),
    latencyP95Ms: latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] || 0,
    // Token 成本
    tokens: {
      inputTotal: sum(completed, 'inputTokens'),
      outputTotal: sum(completed, 'outputTokens'),
      inputAvg: avg(completed.map((r) => r.usage?.inputTokens || 0)),
      outputAvg: avg(completed.map((r) => r.usage?.outputTokens || 0)),
    },
    toolCallsTotal: sum(completed, 'toolCalls'),
    modelCallsTotal: sum(completed, 'modelCalls'),
  }
  console.log('[summary]', JSON.stringify(report.summary, null, 2))

  const folder = new URL('../../.artifacts/', import.meta.url)
  await fs.mkdir(folder, { recursive: true })
  const path = new URL(`agent-${smoke ? 'smoke' : 'evaluation'}-${Date.now()}.json`, folder)
  await fs.writeFile(path, JSON.stringify(report, null, 2))
  console.log(`Evaluation report: ${fileURLToPath(path)}`)
}
