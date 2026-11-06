import type { CSSProperties } from 'react'
import Markdown, { type Options } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import '@uiw/react-markdown-preview/markdown.css'
import { markdownSanitizeSchema } from '@/utils/markdownSanitize'

/** 先解析原始 HTML，再按白名单清洗，避免 script / iframe / 事件属性 / 危险协议进入页面 */
const REHYPE_PLUGINS: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, markdownSanitizeSchema],
]

interface SafeMarkdownProps {
  /** 待渲染的 Markdown 内容 */
  source?: string | null
  className?: string
  style?: CSSProperties
}

/**
 * 安全的 Markdown 渲染组件
 * 所有用户可提交的内容都必须经过此组件渲染，禁止直接使用会解析原始 HTML 的预览组件。
 */
function SafeMarkdown({ source, className, style }: SafeMarkdownProps) {
  return (
    <div
      className={className ? `wmde-markdown ${className}` : 'wmde-markdown'}
      style={style}
      data-color-mode="light"
    >
      <Markdown rehypePlugins={REHYPE_PLUGINS}>{source ?? ''}</Markdown>
    </div>
  )
}

export default SafeMarkdown
