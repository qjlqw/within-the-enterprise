import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import puppeteer from 'puppeteer'
import { createServer } from 'vite'
import express from '../server/node_modules/express/index.js'
import authRoutes from '../server/src/routes/auth.js'
import documentRoutes from '../server/src/routes/documents.js'
import { initDb } from '../server/src/db/index.js'
import { errorHandler } from '../server/src/middleware/error.js'
import { createAgentRouter } from '../server/src/routes/agent.js'
import { SessionStore } from '../server/src/agent/sessionStore.js'
import { SourceRegistry } from '../server/src/agent/events.js'
import { readDocument } from '../server/src/services/knowledgeService.js'
import { ApiError } from '../server/src/utils/response.js'

process.env.NODE_ENV = 'test'
initDb()
const app = express()
app.use(express.json())
app.use('/api/auth', authRoutes)
app.use('/api/documents', documentRoutes)
const store = new SessionStore()
const histories = []
let enabled = true
let slowCalls = 0
app.use('/api/agent', createAgentRouter({ store,
  checkConfig: () => { if (!enabled) throw new ApiError(503, '知识助手模型尚未配置') },
  runner: async ({ message, history, signal, emit, onEvidence }) => {
    histories.push(history)
    if (message === '慢问题' && slowCalls++ === 0) {
      emit('token', { delta: '正在整理资料' })
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    signal.throwIfAborted()
    emit('tool_start', { toolCallId: 'read', name: 'read_document' })
    const registry = new SourceRegistry(history.sources)
    const source = registry.register(readDocument({ documentId: 4 }))
    onEvidence([...history.sources, source])
    emit('tool_end', { toolCallId: 'read', name: 'read_document', status: 'completed' })
    const text = `准备入职材料、领取办公设备、开通系统账号。[${source.sourceId}]\n\n培训包括产品培训、技术培训、安全培训。\n\n<script>window.__unsafe = true</script>\n[外部链接](javascript:alert(1))\n![外部图片](https://example.invalid/pixel.png)`
    for (const delta of text.match(/.{1,12}|\n/g)) {
      signal.throwIfAborted()
      emit('token', { delta })
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return { text, sources: registry.validate(text), evidence: registry.used, usage: {} }
  },
}))
app.use(errorHandler)
const backend = app.listen(0, '127.0.0.1')
await once(backend, 'listening')
const vite = await createServer({ server: { host: '127.0.0.1', port: 0, open: false,
  proxy: { '/api': { target: `http://127.0.0.1:${backend.address().port}`, changeOrigin: true } } } })
let browser
let page
try {
  await vite.listen()
  const baseURL = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = await puppeteer.launch({ headless: true })
  page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewport({ width: 1440, height: 1000 })
  const login = async (email) => {
    await page.waitForSelector('input[placeholder="邮箱"]')
    await page.type('input[placeholder="邮箱"]', email)
    await page.type('input[placeholder="密码"]', '123456')
    await page.click('button[type="submit"]')
    await page.waitForFunction(() => location.pathname !== '/login')
    await page.goto(`${baseURL}/agent`)
    await page.waitForSelector('textarea[aria-label="输入问题"]')
    await page.waitForFunction(() => !document.querySelector('.agent-empty .ant-spin'))
  }
  const ask = async (text) => {
    await page.waitForSelector('[role="dialog"]', { hidden: true })
    await page.type('textarea[aria-label="输入问题"]', text)
    await page.waitForFunction(() => !document.querySelector('button[aria-label="发送"]')?.disabled, { polling: 100 })
    await page.click('button[aria-label="发送"]')
  }
  const waitComplete = async (count) => {
    await page.waitForFunction((expected) => document.querySelectorAll('.agent-sources a').length >= expected
      && !document.querySelector('button[aria-label="停止生成"]'), {}, count)
  }
  await page.goto(`${baseURL}/login`)
  await login('zhangsan@company.com')
  await ask('新员工入职需要做什么？')
  await waitComplete(1)
  assert.equal(await page.$eval('.agent-sources a', (el) => el.getAttribute('href')), '/document/4')
  assert.equal(await page.evaluate(() => Boolean(window.__unsafe)), false)
  assert.equal(await page.$$eval('.agent-markdown a, .agent-markdown img, .agent-markdown script', (els) => els.length), 0)
  await fs.mkdir('.artifacts', { recursive: true })
  await page.screenshot({ path: '.artifacts/agent-desktop.png', fullPage: true })
  await ask('培训有哪些？')
  await waitComplete(2)
  assert.equal(histories.at(-1).messages.length, 2)
  await page.reload()
  await waitComplete(2)
  await ask('慢问题')
  await page.waitForFunction(() => document.body.textContent.includes('正在整理资料'))
  await page.click('button[aria-label="停止生成"]')
  await page.waitForFunction(() => document.body.textContent.includes('已停止') && !document.querySelector('button[aria-label="停止生成"]'))
  await page.click('button[aria-label="重试"]')
  await waitComplete(3)
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.waitForSelector('.agent-layout .ant-layout-sider-zero-width')
  await page.waitForFunction(() => document.querySelector('.agent-layout .ant-layout-sider')?.getBoundingClientRect().width <= 1, { polling: 100 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: '.artifacts/agent-mobile.png', fullPage: true })
  await page.click('button[aria-label="会话列表"]')
  await page.waitForSelector('[role="dialog"] button[aria-label="新建会话"]', { visible: true })
  await page.click('[role="dialog"] button[aria-label="新建会话"]')
  await page.waitForFunction(() => document.querySelectorAll('.agent-message').length === 0 && !document.querySelector('.agent-empty .ant-spin'))
  enabled = false
  await ask('模型未配置时测试')
  await page.waitForFunction(() => document.querySelector('.agent-conversation .ant-alert')?.textContent.includes('模型尚未配置'))
  await page.screenshot({ path: '.artifacts/agent-unconfigured.png', fullPage: true })
  enabled = true
  await page.setViewport({ width: 1440, height: 1000 })
  await page.waitForSelector('.ant-layout-header .ant-dropdown-trigger', { visible: true })
  await page.click('.ant-layout-header .ant-dropdown-trigger')
  await page.locator('::-p-text(退出登录)').click()
  await page.waitForFunction(() => location.pathname === '/login')
  await login('lisi@company.com')
  assert.equal(await page.$$eval('.agent-session-row', (els) => els.length), 0)
  assert.equal(await page.$$eval('.agent-message', (els) => els.length), 0)
  assert.equal(await page.$eval('textarea[aria-label="输入问题"]', (el) => el.value), '')
  assert.deepEqual(errors, [])
  console.log('UI smoke passed: login, streaming, citations, Markdown safety, follow-up, reload, cancel, retry, mobile history, missing model, account isolation.')
} catch (error) {
  if (page) {
    await fs.mkdir('.artifacts', { recursive: true })
    await page.screenshot({ path: '.artifacts/agent-failure.png', fullPage: true })
    console.error(await page.evaluate(() => ({ url: location.href, width: innerWidth,
      sider: document.querySelector('.ant-layout-sider')?.outerHTML.slice(0, 400),
      siderWidth: document.querySelector('.ant-layout-sider')?.getBoundingClientRect().width,
      text: document.body.innerText.slice(-1500) })))
  }
  throw error
} finally {
  await browser?.close()
  await vite.close()
  backend.closeAllConnections()
  await new Promise((resolve) => backend.close(resolve))
}
