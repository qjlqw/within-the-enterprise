import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  initDb,
  findDocument,
  findUserById,
  createDocument,
  updateDocument,
  removeDocument,
} from '../../src/db/index.js'
import { searchDocuments, readDocument, sourceIsValid } from '../../src/services/knowledgeService.js'
import { SourceRegistry, visibleText } from '../../src/agent/events.js'
import { createKnowledgeTools } from '../../src/agent/tools.js'

// 数据层已迁移为 Supabase 直查：所有查询方法均为异步，调用方必须 await
beforeEach(initDb)

test('published search is ranked and draft reading is denied without increasing views', async () => {
  assert.equal((await searchDocuments({ query: '入职' }))[0].documentId, 4)
  assert.deepEqual(await searchDocuments({ query: 'zzz-no-such-term' }), [])
  await assert.rejects(readDocument({ documentId: 3 }), { status: 404 })
  const views = (await findDocument(4)).views
  await readDocument({ documentId: 4 }); await readDocument({ documentId: 4 })
  assert.equal((await findDocument(4)).views, views)
  assert.deepEqual(await searchDocuments({ query: '报销政策' }), [])
})

test('read range and tool schema reject invalid IDs, excessive limits and injected identity', async () => {
  for (const documentId of [0, -1, 1.2, '4', NaN]) await assert.rejects(readDocument({ documentId }))
  await assert.rejects(readDocument({ documentId: 4, maxChars: 6001 }))
  const slice = await readDocument({ documentId: 4, offset: 5, maxChars: 10 })
  assert.equal(slice.text, (await findDocument(4)).content.slice(5, 15))
  assert.equal(slice.nextOffset, 15)
  const tools = createKnowledgeTools({ userId: 1, registry: new SourceRegistry(), signal: new AbortController().signal })
  await assert.rejects(tools[0].invoke({ query: '入职', userId: 2 }))
  await assert.rejects(tools[0].invoke({ query: '入职', limit: 11 }))
  assert.match(await tools[1].invoke({ documentId: 3 }), /未发布/)
})

test('citations are registered, bounded and revalidated against version, publication and deletion', async () => {
  const registry = new SourceRegistry()
  // 改版/下线/删除演练使用临时文档：种子数据位于共享远端库，不能被测试直接改写
  const author = await findUserById(1)
  const temp = await createDocument({
    title: '引用校验临时文档',
    content: '临时正文内容，仅用于来源失效演练。',
    category: '测试',
    tags: [],
    status: 'published',
  }, author)
  const source = registry.register(await readDocument({ documentId: temp.id }))

  assert.equal((await registry.validate('演练引用 [S1]'))[0].url, `/document/${temp.id}`)
  await assert.rejects(registry.validate('[S999]'), { code: 'INVALID_SOURCE' })

  // 改版：文档更新后版本号变化，旧来源失效
  await updateDocument(temp.id, { title: '引用校验临时文档（改版）' })
  assert.equal(await sourceIsValid(source), false)
  await assert.rejects(registry.validate('[S1]'), { code: 'SOURCES_CHANGED' })

  // 下线：改为草稿后不再对 agent 可见
  await updateDocument(temp.id, { status: 'draft' })
  assert.equal(await sourceIsValid(source), false)

  // 删除：文档消失后来源失效
  await removeDocument(temp.id)
  assert.equal(await sourceIsValid(source), false)

  // 字符容量上限：预算连元数据都放不下时才抛 TOOL_LIMIT（彻底耗尽兜底）
  assert.throws(
    () => new SourceRegistry([], 1).register({ documentId: 4, title: 't', version: 1, offset: 0, text: '正文' }),
    { code: 'TOOL_LIMIT' },
  )
})

test('registry dedups repeated identical reads (no double charge) and soft-truncates over-budget fragments', () => {
  const frag = { documentId: 4, title: 't', version: 1, offset: 0, text: 'a'.repeat(2000), truncated: false, nextOffset: 2000 }

  // 1) 去重：同一文档同一偏移同一长度重复注册——分配新 sourceId 但不重复计费
  const r1 = new SourceRegistry([], 100000)
  const s1 = r1.register(frag)
  const s2 = r1.register({ ...frag })
  assert.notEqual(s2.sourceId, s1.sourceId)   // 编号连续不跳号
  assert.equal(r1.used.length, 2)              // 两次都进入 used（校验用）
  const charsAfterFirst = r1.chars
  r1.register({ ...frag })
  assert.equal(r1.chars, charsAfterFirst)      // 重复读取不增加体量

  // 2) 软截断：超出剩余预算时截断正文而非抛错
  const r2 = new SourceRegistry([], 300)
  const s3 = r2.register({ ...frag })   // 2000 字正文，预算 300
  assert.equal(s3.truncated, true)
  assert.equal(s3.nextOffset, null)
  assert.ok(s3.text.length < frag.text.length)
  assert.ok(s3.text.length > 0)         // 仍拿到部分正文
  assert.ok(JSON.stringify(s3).length <= 300)  // 实际体量不超预算

  // 3) 截断后的片段仍可被引用校验（正文是原文前缀，sourceIsValid 会通过）
  assert.equal(s3.text, frag.text.slice(0, s3.text.length))
})

test('visible output excludes reasoning blocks and provider metadata', () => {
  assert.equal(visibleText([{ type: 'reasoning', text: 'private' }, { type: 'text', text: '答案' }]), '答案')
})
