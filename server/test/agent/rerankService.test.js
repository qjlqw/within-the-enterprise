import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { rerank, isRerankReady } from '../../src/services/rerankService.js'
import { config } from '../../src/config/index.js'

/**
 * 启动一个可控的 mock rerank 服务
 * @param {(req: {method:string,url:string,headers:object,body:any}, res:http.ServerResponse) => void|Promise<void>} handler
 */
async function startMock(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf-8')
    const body = raw ? JSON.parse(raw) : {}
    try {
      await handler({ method: req.method, url: req.url, headers: req.headers, body }, res)
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err?.message || err) }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseURL = `http://127.0.0.1:${server.address().port}`
  after(() => server.close())
  return baseURL
}

const DOCUMENTS = ['报销流程说明', '入职需要准备材料', '完全无关的菜谱内容']

test('dashscope 风格：请求路径/请求体/鉴权正确，结果按分数降序', async () => {
  let captured = null
  const baseURL = await startMock((req, res) => {
    captured = req
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        output: {
          results: [
            { index: 1, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.42 },
            { index: 2, relevance_score: 0.05 },
          ],
        },
      }),
    )
  })

  const saved = {
    enabled: config.rag.rerankEnabled,
    key: config.rag.rerankApiKey,
    model: config.rag.rerankModel,
    base: config.rag.rerankBaseURL,
    style: config.rag.rerankApiStyle,
    topN: config.rag.rerankTopN,
    timeout: config.rag.rerankTimeoutMs,
  }
  Object.assign(config.rag, {
    rerankEnabled: true,
    rerankApiKey: 'test-secret',
    rerankModel: 'gte-rerank-v2',
    rerankBaseURL: baseURL,
    rerankApiStyle: '',
    rerankTopN: 5,
    rerankTimeoutMs: 8000,
  })
  try {
    assert.equal(isRerankReady(), true)
    const results = await rerank({ query: '入职材料', documents: DOCUMENTS })

    assert.equal(captured.method, 'POST')
    assert.equal(captured.url, '/api/v1/services/rerank/text-rerank/text-rerank')
    assert.equal(captured.headers.authorization, 'Bearer test-secret')
    assert.equal(captured.body.model, 'gte-rerank-v2')
    assert.equal(captured.body.input.query, '入职材料')
    assert.deepEqual(captured.body.input.documents, DOCUMENTS)
    assert.equal(captured.body.parameters.return_documents, false)
    assert.equal(captured.body.parameters.top_n, 3)

    assert.deepEqual(
      results.map((r) => r.index),
      [1, 0, 2],
    )
    assert.equal(results[0].score, 0.91)
  } finally {
    Object.assign(config.rag, saved)
  }
})

test('compatible 风格（qwen3-rerank）：走 /compatible-api/v1/reranks，顶层 results', async () => {
  let captured = null
  const baseURL = await startMock((req, res) => {
    captured = req
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.8 },
          { index: 1, relevance_score: 0.3 },
        ],
      }),
    )
  })

  const saved = { ...config.rag }
  Object.assign(config.rag, {
    rerankEnabled: true,
    rerankApiKey: 'test-secret',
    rerankModel: 'qwen3-rerank',
    rerankBaseURL: baseURL,
    rerankApiStyle: '',
    rerankTopN: 2,
    rerankTimeoutMs: 8000,
  })
  try {
    const results = await rerank({ query: '报销', documents: DOCUMENTS, topN: 2 })
    assert.equal(captured.url, '/compatible-api/v1/reranks')
    assert.equal(captured.body.query, '报销')
    assert.equal(captured.body.top_n, 2)
    assert.ok(!('input' in captured.body))
    assert.equal(results.length, 2)
    assert.equal(results[0].index, 0)
  } finally {
    Object.assign(config.rag, saved)
  }
})

test('未开启或缺密钥时返回 null（调用方走融合排序）', async () => {
  const saved = { enabled: config.rag.rerankEnabled, key: config.rag.rerankApiKey }
  try {
    config.rag.rerankEnabled = false
    config.rag.rerankApiKey = 'k'
    assert.equal(isRerankReady(), false)
    assert.equal(await rerank({ query: 'q', documents: DOCUMENTS }), null)

    config.rag.rerankEnabled = true
    config.rag.rerankApiKey = ''
    assert.equal(isRerankReady(), false)
    assert.equal(await rerank({ query: 'q', documents: DOCUMENTS }), null)

    assert.equal(await rerank({ query: 'q', documents: [] }), null)
  } finally {
    Object.assign(config.rag, saved)
  }
})

test('非 2xx / 非法响应 / 超时均抛错，由调用方降级', async (t) => {
  // 500
  let base500 = await startMock((_req, res) => {
    res.statusCode = 500
    res.end('boom')
  })
  // 空 results
  const baseEmpty = await startMock((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ output: { results: [] } }))
  })
  // 超时不响应
  const baseSlow = await startMock(() => {})

  const saved = { ...config.rag }
  Object.assign(config.rag, {
    rerankEnabled: true,
    rerankApiKey: 'test-secret',
    rerankModel: 'gte-rerank-v2',
    rerankApiStyle: 'dashscope',
  })
  try {
    config.rag.rerankBaseURL = base500
    await assert.rejects(() => rerank({ query: 'q', documents: DOCUMENTS }), /rerank 500/)

    config.rag.rerankBaseURL = baseEmpty
    await assert.rejects(() => rerank({ query: 'q', documents: DOCUMENTS }), /results/)

    config.rag.rerankBaseURL = baseSlow
    config.rag.rerankTimeoutMs = 80
    const started = Date.now()
    await assert.rejects(() => rerank({ query: 'q', documents: DOCUMENTS }))
    assert.ok(Date.now() - started < 1000, '超时应快速中止而不是长时间挂起')
  } finally {
    Object.assign(config.rag, saved)
  }
})
