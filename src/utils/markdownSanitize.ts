import { defaultSchema, type Options } from 'rehype-sanitize'

/** 明确禁止的标签：可执行脚本、可嵌入页面、样式与表单劫持 */
const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'base',
  'link',
  'meta',
])

/** 事件属性：onclick / onerror / onload 等 */
const EVENT_ATTRIBUTE = /^on/i

/** 会改变元素行为或执行代码的属性 */
const DANGEROUS_ATTRIBUTE = /^(action|formaction|is|style|srcdoc)$/i

/** 只允许安全协议，javascript:、data:、vbscript: 等一律丢弃 */
const SAFE_PROTOCOLS = {
  href: ['http', 'https', 'mailto', 'tel'],
  src: ['http', 'https'],
  cite: ['http', 'https'],
}

/**
 * Markdown 渲染白名单。
 * 以 GitHub 默认规则为基础，进一步剔除事件属性与可执行标签，
 * 保证用户提交的内容无法注入 HTML 行为。
 */
export const markdownSanitizeSchema: Options = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !FORBIDDEN_TAGS.has(tag)),
  attributes: Object.fromEntries(
    Object.entries(defaultSchema.attributes ?? {}).map(([tag, rules]) => [
      tag,
      rules.filter((rule) => {
        const name = Array.isArray(rule) ? rule[0] : rule
        return !EVENT_ATTRIBUTE.test(name) && !DANGEROUS_ATTRIBUTE.test(name)
      }),
    ])
  ),
  protocols: { ...defaultSchema.protocols, ...SAFE_PROTOCOLS },
  strip: ['script', 'style', 'iframe', 'object', 'embed'],
}
