import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Drawer, Empty, Input, Popconfirm, Spin, Tag, Tooltip, message } from 'antd'
import { CopyOutlined, DeleteOutlined, FileTextOutlined, HistoryOutlined, PlusOutlined, ReloadOutlined,
  RobotOutlined, SendOutlined, StopOutlined, AudioOutlined, AudioMutedOutlined } from '@ant-design/icons'
import Markdown from 'react-markdown'
import { useAgentChat } from '@/hooks/useAgentChat'
import { useSpeechInput } from '@/hooks/useSpeechInput'
import { useUserStore } from '@/store/userStore'
import './style.css'

export default function AgentPage() {
  const chat = useAgentChat()
  const token = useUserStore((state) => state.token)
  const [input, setInput] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => { setInput(''); setHistoryOpen(false) }, [token])
  const running = chat.busy || Boolean(chat.session?.run)
  const lastQuestion = [...(chat.session?.messages || [])].reverse().find((item) => item.role === 'user')?.content
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [chat.session?.messages, chat.activity])

  // 语音输入：识别结果实时追加到输入框
  // 用 ref 存"已确认文本"，避免中间结果拼接混乱
  const confirmedTextRef = useRef('')
  const speech = useSpeechInput({
    onStart: () => {
      // 录音开始时，把当前输入框文本作为基础
      confirmedTextRef.current = input
    },
    onResult: (text, isFinal) => {
      if (isFinal) {
        // 一句话结束：追加到已确认文本
        confirmedTextRef.current = (confirmedTextRef.current + ' ' + text).trim()
        setInput(confirmedTextRef.current)
      } else {
        // 中间结果：已确认文本 + 临时文本
        setInput((confirmedTextRef.current + ' ' + text).trim())
      }
    },
  })

  const send = async (text = input) => {
    const accepted = await chat.send(text)
    if (accepted) setInput((current) => current === text ? '' : current)
  }

  const history = <>
    <div className="agent-history-heading"><span>会话</span>
      <Tooltip title="新建会话"><Button aria-label="新建会话" type="text" icon={<PlusOutlined />}
        disabled={chat.busy || chat.loading} onClick={() => { void chat.select(); setHistoryOpen(false) }} /></Tooltip>
    </div>
    <div className="agent-session-list">
      {chat.sessions.map((item) => <div key={item.sessionId} className={`agent-session-row ${chat.session?.sessionId === item.sessionId ? 'selected' : ''}`}>
        <button className="agent-session-select" disabled={chat.busy || chat.loading}
          onClick={() => { void chat.select(item.sessionId); setHistoryOpen(false) }}>
          <span>{item.title}</span><small>{item.running ? '生成中' : new Date(item.updatedAt).toLocaleDateString('zh-CN')}</small>
        </button>
        <Popconfirm title="删除此会话？" onConfirm={() => chat.remove(item.sessionId)} okText="删除" cancelText="取消">
          <Tooltip title="删除会话"><Button aria-label={`删除会话 ${item.title}`} type="text" danger size="small"
            disabled={chat.busy || chat.loading} icon={<DeleteOutlined />} /></Tooltip>
        </Popconfirm>
      </div>)}
      {!chat.sessions.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无会话" />}
    </div>
  </>

  return <section className="agent-page">
    <aside className="agent-history">{history}</aside>
    <Drawer title="会话" open={historyOpen} onClose={() => setHistoryOpen(false)} placement="left" size={280}>{history}</Drawer>
    <main className="agent-conversation">
      <header className="agent-heading">
        <div><RobotOutlined /><h1>知识助手</h1></div>
        <Tooltip title="会话列表"><Button className="agent-mobile-history" aria-label="会话列表" icon={<HistoryOutlined />}
          onClick={() => setHistoryOpen(true)} /></Tooltip>
      </header>
      {chat.error && <Alert type="error" title={chat.error} showIcon />}
      {chat.session?.notice && <Alert type="warning" title={chat.session.notice} showIcon />}
      <div className="agent-messages" aria-busy={running}>
        {chat.loading ? <div className="agent-empty"><Spin /></div> : !chat.session?.messages.length ?
          <div className="agent-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" /></div> :
          chat.session.messages.map((item, index) => <article key={item.id} className={`agent-message agent-message-${item.role}`}>
            <div className="agent-message-label">{item.role === 'user' ? '我' : '知识助手'}
              {item.status === 'cancelled' && <Tag>已停止</Tag>}
              {item.status === 'failed' && <Tag color="error">未完成</Tag>}
            </div>
            {item.role === 'user' ? <div className="agent-user-text">{item.content}</div> : <>
              <div className="agent-markdown"><Markdown skipHtml disallowedElements={['img', 'iframe', 'script', 'style']}
                components={{ a: ({ children }) => <span>{children}</span> }}>{item.content}</Markdown></div>
              {item.error && <p className="agent-message-error">{item.error}</p>}
              {item.status === 'completed' && <div className="agent-sources">
                {item.sources.map((source) => <Link key={source.sourceId} to={`/document/${source.documentId}`}>
                  <FileTextOutlined /> [{source.sourceId}] {source.title} <small>v{source.version}</small>
                </Link>)}
              </div>}
              <div className="agent-message-actions">
                {item.content && <Tooltip title="复制回答"><Button size="small" type="text" aria-label="复制回答" icon={<CopyOutlined />}
                  onClick={() => { void navigator.clipboard.writeText(item.content).then(() => message.success('已复制')).catch(() => message.error('复制失败')) }} /></Tooltip>}
                {['failed', 'cancelled'].includes(item.status) && index === (chat.session?.messages.length || 0) - 1 && lastQuestion &&
                  <Tooltip title="重试"><Button size="small" type="text" aria-label="重试" icon={<ReloadOutlined />}
                    disabled={running || chat.loading} onClick={() => void send(lastQuestion)} /></Tooltip>}
              </div>
            </>}
          </article>)}
        {running && <div className="agent-activity" role="status"><Spin size="small" /> {chat.activity || '正在生成'}</div>}
        <div ref={bottom} />
      </div>
      <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <Input.TextArea aria-label="输入问题" placeholder="输入问题" value={input} maxLength={4000}
          autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!running && !chat.loading) void send()
            }
          }} />
        <div className="agent-composer-actions"><span>{input.length} / 4000</span>
          <div className="agent-composer-buttons">
            {speech.supported && (
              <Tooltip title={speech.listening ? '停止录音' : '语音输入'}>
                <Button aria-label={speech.listening ? '停止录音' : '语音输入'}
                  danger={speech.listening}
                  type={speech.listening ? 'primary' : 'default'}
                  icon={speech.listening ? <AudioMutedOutlined /> : <AudioOutlined />}
                  onClick={speech.toggle}
                  disabled={running}
                  className={speech.listening ? 'agent-mic-recording' : ''} />
              </Tooltip>
            )}
            {running ? <Tooltip title="停止生成"><Button aria-label="停止生成" danger icon={<StopOutlined />} onClick={() => void chat.stop()} /></Tooltip>
              : <Tooltip title="发送"><Button aria-label="发送" type="primary" htmlType="submit" icon={<SendOutlined />}
                disabled={!input.trim() || chat.loading} /></Tooltip>}
          </div>
        </div>
      </form>
    </main>
  </section>
}
