import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { markdownSanitizeSchema } from '../src/utils/markdownSanitize.ts'

/** 与 src/components/SafeMarkdown 完全一致的渲染链路 */
const render = (source) =>
  renderToStaticMarkup(
    createElement(
      Markdown,
      { rehypePlugins: [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]] },
      source
    )
  )

test('script 标签及其内容被移除', () => {
  const html = render('正文\n\n<script>alert(document.cookie)</script>')
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('alert(document.cookie)'))
  assert.ok(html.includes('正文'))
})

test('事件属性被剥离', () => {
  const html = render('<img src="https://example.com/a.png" onerror="alert(1)">')
  assert.ok(!/onerror/i.test(html))
  assert.ok(!html.includes('alert(1)'))
  assert.ok(html.includes('<img'))
  assert.ok(html.includes('src="https://example.com/a.png"'))
})

test('javascript: 协议链接被丢弃', () => {
  const markdownLink = render('[点我](javascript:alert(1))')
  assert.ok(!markdownLink.includes('javascript:'))
  assert.ok(!markdownLink.includes('href'))

  const rawLink = render('<a href="javascript:alert(1)" onclick="alert(2)">点我</a>')
  assert.ok(!rawLink.includes('javascript:'))
  assert.ok(!/onclick/i.test(rawLink))
})

test('iframe 等嵌入标签被移除', () => {
  const html = render('<iframe src="https://evil.example"></iframe>')
  assert.ok(!html.includes('<iframe'))
  assert.ok(!html.includes('evil.example'))
})

test('普通 Markdown 仍能正确渲染', () => {
  const html = render('## 标题\n\n**加粗** 与 [官网](https://example.com)')
  assert.ok(html.includes('<h2>标题</h2>'))
  assert.ok(html.includes('<strong>加粗</strong>'))
  assert.ok(html.includes('href="https://example.com"'))
})
