import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import {
  Card,
  Input,
  Button,
  Avatar,
  Space,
  message,
  Typography,
  Divider,
} from 'antd'
import {
  MessageOutlined,
  LikeOutlined,
  LikeFilled,
  DeleteOutlined,
  MessageFilled,
} from '@ant-design/icons'
import { commentApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { useUserStore } from '@/store/userStore'
import { USE_MOCK } from '@/config/api'
import type { Comment } from '@/types'

const { TextArea } = Input
const { Text } = Typography

function CommentList() {
  const { id: documentId } = useParams<{ id: string }>()
  const user = useUserStore((state) => state.user)
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [content, setContent] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [likedComments, setLikedComments] = useState<Set<number>>(new Set())
  const [replyTarget, setReplyTarget] = useState<number | null>(null)
  const [replyContent, setReplyContent] = useState<string>('')

  const fetchComments = useCallback(async () => {
    if (!documentId) return
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.comments : commentApi
      const data = await api.getList(documentId)
      setComments(data || [])
    } catch (error) {
      console.error('获取评论失败:', error)
    } finally {
      setLoading(false)
    }
  }, [documentId])

  useEffect(() => {
    fetchComments()
  }, [fetchComments])

  const handleSubmit = async () => {
    if (!documentId) return
    if (!content.trim()) {
      message.warning('请输入评论内容')
      return
    }

    setSubmitting(true)
    try {
      const api = USE_MOCK ? mockApi.comments : commentApi
      await api.create(documentId, { content })
      message.success('评论成功')
      setContent('')
      fetchComments()
    } catch (error) {
      console.error('发表评论失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  const handleLike = async (commentId: number) => {
    if (!documentId) return
    if (likedComments.has(commentId)) return

    try {
      const api = USE_MOCK ? mockApi.comments : commentApi
      await api.like(documentId, commentId)
      setComments(
        comments.map((c) => (c.id === commentId ? { ...c, likes: c.likes + 1 } : c))
      )
      setLikedComments(new Set(likedComments).add(commentId))
      message.success('点赞成功')
    } catch (error) {
      console.error('点赞评论失败:', error)
    }
  }

  const handleDelete = async (commentId: number) => {
    if (!documentId) return
    try {
      const api = USE_MOCK ? mockApi.comments : commentApi
      await api.delete(documentId, commentId)
      message.success('删除成功')
      fetchComments()
    } catch (error) {
      console.error('删除评论失败:', error)
    }
  }

  const handleReply = async (parentId: number) => {
    if (!documentId) return
    if (!replyContent.trim()) {
      message.warning('请输入回复内容')
      return
    }
    try {
      const api = USE_MOCK ? mockApi.comments : commentApi
      await api.reply(documentId, parentId, { content: replyContent })
      message.success('回复成功')
      setReplyContent('')
      setReplyTarget(null)
      fetchComments()
    } catch (error) {
      console.error('回复评论失败:', error)
    }
  }

  return (
    <Card
      title={
        <Space>
          <MessageOutlined />
          <span>评论 ({comments.length})</span>
        </Space>
      }
      size="small"
    >
      {/* 发表评论 */}
      <div style={{ marginBottom: 24 }}>
        <TextArea
          rows={3}
          placeholder="写下你的评论..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{ marginBottom: 8 }}
        />
        <div style={{ textAlign: 'right' }}>
          <Button
            type="primary"
            onClick={handleSubmit}
            loading={submitting}
            disabled={!content.trim()}
          >
            发表评论
          </Button>
        </div>
      </div>

      <Divider style={{ margin: '0 0 16px' }} />

      {/* 评论列表 */}
      <div>
        {loading && <div style={{ textAlign: 'center', padding: 20 }}>加载中...</div>}
        {!loading && comments.length === 0 && (
          <div style={{ textAlign: 'center', color: '#999', padding: 20 }}>
            暂无评论，快来抢沙发吧
          </div>
        )}
        {!loading && comments.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {comments.map((comment) => (
              <div
                key={comment.id}
                style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}
              >
                <div style={{ display: 'flex', gap: 12 }}>
                  <Avatar style={{ backgroundColor: '#1890ff' }}>
                    {comment.userName[0]}
                  </Avatar>
                  <div style={{ flex: 1 }}>
                    <Space>
                      <Text strong>{comment.userName}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {comment.createdAt}
                      </Text>
                    </Space>
                    <div>
                      <Text style={{ display: 'block', margin: '8px 0' }}>
                        {comment.content}
                      </Text>
                      <Space size={16}>
                        <Button
                          type="text"
                          size="small"
                          icon={
                            likedComments.has(comment.id) ? (
                              <LikeFilled style={{ color: '#ff4d4f' }} />
                            ) : (
                              <LikeOutlined />
                            )
                          }
                          onClick={() => handleLike(comment.id)}
                        >
                          {comment.likes}
                        </Button>
                        <Button
                          type="text"
                          size="small"
                          icon={<MessageFilled />}
                          onClick={() =>
                            setReplyTarget(replyTarget === comment.id ? null : comment.id)
                          }
                        >
                          回复
                        </Button>
                        {comment.userId === user?.id && (
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => handleDelete(comment.id)}
                          >
                            删除
                          </Button>
                        )}
                      </Space>

                      {/* 回复输入框 */}
                      {replyTarget === comment.id && (
                        <div style={{ marginTop: 12 }}>
                          <TextArea
                            rows={2}
                            placeholder={`回复 @${comment.userName}...`}
                            value={replyContent}
                            onChange={(e) => setReplyContent(e.target.value)}
                          />
                          <div style={{ marginTop: 8, textAlign: 'right' }}>
                            <Space>
                              <Button
                                size="small"
                                onClick={() => {
                                  setReplyTarget(null)
                                  setReplyContent('')
                                }}
                              >
                                取消
                              </Button>
                              <Button
                                type="primary"
                                size="small"
                                onClick={() => handleReply(comment.id)}
                                disabled={!replyContent.trim()}
                              >
                                回复
                              </Button>
                            </Space>
                          </div>
                        </div>
                      )}

                      {/* 回复列表 */}
                      {comment.replies && comment.replies.length > 0 && (
                        <div
                          style={{
                            marginTop: 12,
                            marginLeft: 32,
                            paddingLeft: 12,
                            borderLeft: '2px solid #f0f0f0',
                          }}
                        >
                          {comment.replies.map((reply) => (
                            <div key={reply.id} style={{ marginBottom: 8 }}>
                              <Space>
                                <Avatar size="small" style={{ backgroundColor: '#52c41a' }}>
                                  {reply.userName[0]}
                                </Avatar>
                                <Text strong style={{ fontSize: 12 }}>
                                  {reply.userName}
                                </Text>
                                <Text type="secondary" style={{ fontSize: 12 }}>
                                  {reply.createdAt}
                                </Text>
                              </Space>
                              <div style={{ marginTop: 4, marginLeft: 32 }}>
                                <Text style={{ fontSize: 13 }}>{reply.content}</Text>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

export default CommentList
