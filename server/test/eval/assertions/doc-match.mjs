/**
 * promptfoo 自定义断言：回答命中来源需覆盖 expectedDocs 中的全部文档 id。
 * 依赖 provider 在 metadata.sources 中回传 documentId 列表。
 *
 * 期望文档为空（域外/权限类用例）时直接通过——不越界由 llm-rubric 负责，
 * 本断言只管「该查到的文档是否都查到了」。
 *
 * @param {string} output  Agent 回答文本
 * @param {object} context promptfoo 断言上下文（vars / providerResponse 等）
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
export default function docMatch(output, context) {
  const expected = context?.vars?.expectedDocs || []
  const metadata = context?.providerResponse?.metadata
  if (!metadata || !Array.isArray(metadata.sources)) {
    return {
      pass: false,
      score: 0,
      reason: 'provider 未回传 metadata.sources，无法校验溯源文档；请确认 promptfoo 版本较新（>= 0.88）且 provider 返回了 metadata 字段',
    }
  }
  const actual = new Set(metadata.sources.map((source) => source.documentId))
  if (expected.length === 0) {
    return { pass: true, score: 1, reason: '无期望文档用例，溯源校验跳过（不越界由 rubric 断言负责）' }
  }
  const missing = expected.filter((id) => !actual.has(id))
  if (missing.length === 0) {
    return { pass: true, score: 1, reason: `溯源文档齐全：${[...actual].join(', ')}` }
  }
  return {
    pass: false,
    score: Number(((expected.length - missing.length) / expected.length).toFixed(4)),
    reason: `缺少溯源文档 ${missing.join(',')}，实际命中：${[...actual].join(', ') || '无'}`,
  }
}
