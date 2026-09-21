import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDb, findDocument, allDocuments } from '../../src/db/index.js'
import { searchDocuments, readDocument, sourceIsValid } from '../../src/services/knowledgeService.js'
import { SourceRegistry, visibleText } from '../../src/agent/events.js'
import { createKnowledgeTools } from '../../src/agent/tools.js'

beforeEach(initDb)
test('published search is ranked and draft reading is denied without increasing views', () => {
  assert.equal(searchDocuments({ query: '入职' })[0].documentId, 4)
  assert.deepEqual(searchDocuments({ query: 'API' }), [])
  assert.throws(() => readDocument({ documentId: 3 }), { status: 404 })
  const views = findDocument(4).views
  readDocument({ documentId: 4 }); readDocument({ documentId: 4 })
  assert.equal(findDocument(4).views, views)
  assert.deepEqual(searchDocuments({ query: '报销政策' }), [])
})
test('read range and tool schema reject invalid IDs, excessive limits and injected identity', async () => {
  for (const documentId of [0, -1, 1.2, '4', NaN]) assert.throws(() => readDocument({ documentId }))
  assert.throws(() => readDocument({ documentId: 4, maxChars: 6001 }))
  const slice = readDocument({ documentId: 4, offset: 5, maxChars: 10 })
  assert.equal(slice.text, findDocument(4).content.slice(5, 15))
  assert.equal(slice.nextOffset, 15)
  const tools = createKnowledgeTools({ userId: 1, registry: new SourceRegistry(), signal: new AbortController().signal })
  await assert.rejects(tools[0].invoke({ query: '入职', userId: 2 }))
  await assert.rejects(tools[0].invoke({ query: '入职', limit: 11 }))
  assert.match(await tools[1].invoke({ documentId: 3 }), /未发布/)
})
test('citations are registered, bounded and revalidated against version, publication and deletion', () => {
  const registry = new SourceRegistry()
  const source = registry.register(readDocument({ documentId: 4 }))
  assert.equal(registry.validate('准备材料 [S1]')[0].url, '/document/4')
  assert.throws(() => registry.validate('[S999]'), { code: 'INVALID_SOURCE' })
  findDocument(4).version++
  assert.equal(sourceIsValid(source), false)
  assert.throws(() => registry.validate('[S1]'), { code: 'SOURCES_CHANGED' })
  findDocument(4).version--
  findDocument(4).status = 'draft'
  assert.equal(sourceIsValid(source), false)
  allDocuments().splice(allDocuments().findIndex((doc) => doc.id === 4), 1)
  assert.equal(sourceIsValid(source), false)
  assert.throws(() => new SourceRegistry([], 1).register(readDocument({ documentId: 1 })), { code: 'TOOL_LIMIT' })
})
test('visible output excludes reasoning blocks and provider metadata', () => {
  assert.equal(visibleText([{ type: 'reasoning', text: 'private' }, { type: 'text', text: '答案' }]), '答案')
})
