import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Descriptions,
  Tag,
  Button,
  Space,
  Divider,
  Typography,
  Avatar,
  Card,
  message,
  Modal,
  Popconfirm,
  Spin,
} from 'antd'
import {
  ArrowLeftOutlined,
  EditOutlined,
  StarOutlined,
  HistoryOutlined,
  LikeOutlined,
  EyeOutlined,
} from '@ant-design/icons'
import MDEditor from '@uiw/react-md-editor'
import { documentApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { USE_MOCK } from '@/config/api'
import { usePermission } from '@/hooks/usePermission'
import AuthButton from '@/components/AuthButton'
import CommentList from '@/pages/comment'
import type { Document, DocumentVersion } from '@/types'

const { Title, Text } = Typography

function DocumentDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isAdmin } = usePermission()
  const [loading, setLoading] = useState<boolean>(true)
  const [doc, setDoc] = useState<Document | null>(null)
  const [versions, setVersions] = useState<DocumentVersion[]>([])
  const [showVersions, setShowVersions] = useState<boolean>(false)
  const [isLiked, setIsLiked] = useState<boolean>(false)
  const [isFavorited, setIsFavorited] = useState<boolean>(false)

  // 标记仅供未使用校验通过
  void isAdmin

  const fetchDocument = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      const data = await api.getDetail(id)
      setDoc(data)
    } catch (error) {
      console.error('获取文档失败:', error)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchDocument()
  }, [fetchDocument])

  const fetchVersions = async () => {
    if (!id) return
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      const data = await api.getVersions(id)
      setVersions(data)
      setShowVersions(true)
    } catch (error) {
      console.error('获取版本历史失败:', error)
    }
  }

  const handleLike = async () => {
    if (!id || isLiked || !doc) return
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      await api.like(id)
      setDoc({ ...doc, likes: doc.likes + 1 })
      setIsLiked(true)
      message.success('点赞成功')
    } catch (error) {
      console.error('点赞失败:', error)
    }
  }

  const handleFavorite = async () => {
    if (!id || isFavorited || !doc) return
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      await api.favorite(id)
      setDoc({ ...doc, favorites: doc.favorites + 1 })
      setIsFavorited(true)
      message.success('收藏成功')
    } catch (error) {
      console.error('收藏失败:', error)
    }
  }

  const handleDelete = async () => {
    if (!id) return
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      await api.delete(id)
      message.success('删除成功')
      navigate('/document')
    } catch (error) {
      console.error('删除失败:', error)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }

  if (!doc) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <p>文档不存在</p>
        <Button onClick={() => navigate('/document')}>返回列表</Button>
      </div>
    )
  }

  return (
    <div>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/document')}
        style={{ marginBottom: 16 }}
      >
        返回列表
      </Button>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 24 }}>
          <Title level={2} style={{ marginBottom: 16 }}>
            {doc.title}
          </Title>
          <Space>
            <Avatar style={{ backgroundColor: '#1890ff' }}>{doc.authorName[0]}</Avatar>
            <span style={{ fontWeight: 500 }}>{doc.authorName}</span>
            <Tag color="blue">{doc.category}</Tag>
            <Tag color={doc.status === 'published' ? 'green' : 'orange'}>
              {doc.status === 'published' ? '已发布' : '草稿'}
            </Tag>
          </Space>
        </div>

        <Descriptions bordered column={4} size="small">
          <Descriptions.Item label="创建时间">{doc.createdAt}</Descriptions.Item>
          <Descriptions.Item label="更新时间">{doc.updatedAt}</Descriptions.Item>
          <Descriptions.Item label="版本">v{doc.version}</Descriptions.Item>
          <Descriptions.Item label="浏览数">
            <EyeOutlined /> {doc.views}
          </Descriptions.Item>
          <Descriptions.Item label="点赞数">
            <LikeOutlined /> {doc.likes}
          </Descriptions.Item>
          <Descriptions.Item label="收藏数">
            <StarOutlined /> {doc.favorites}
          </Descriptions.Item>
          <Descriptions.Item label="标签" span={2}>
            <Space>
              {doc.tags?.map((tag) => (
                <Tag key={tag} color="cyan">
                  {tag}
                </Tag>
              ))}
            </Space>
          </Descriptions.Item>
        </Descriptions>

        <Divider />

        <Space style={{ marginBottom: 16 }}>
          <Button icon={<LikeOutlined />} onClick={handleLike} disabled={isLiked}>
            点赞 {isLiked && '(已赞)'}
          </Button>
          <Button
            icon={<StarOutlined />}
            onClick={handleFavorite}
            disabled={isFavorited}
          >
            收藏 {isFavorited && '(已收藏)'}
          </Button>
          <Button icon={<HistoryOutlined />} onClick={fetchVersions}>
            版本历史
          </Button>

          {/* 编辑按钮 - 管理员/编辑者可见 */}
          <AuthButton
            roles={['admin', 'editor']}
            type="primary"
            icon={<EditOutlined />}
            onClick={() => navigate(`/document/editor/${id}`)}
          >
            编辑
          </AuthButton>

          {/* 删除按钮 - 仅管理员可见 */}
          <AuthButton roles="admin" mode="disabled" danger>
            <Popconfirm
              title="确定删除该文档？"
              onConfirm={handleDelete}
              okText="确定"
              cancelText="取消"
            >
              <span>删除</span>
            </Popconfirm>
          </AuthButton>
        </Space>

        <div data-color-mode="light">
          <MDEditor.Markdown
            source={doc.content}
            style={{
              background: '#fff',
              padding: '24px 0',
              minHeight: 300,
            }}
          />
        </div>
      </Card>

      {/* 版本历史弹窗 */}
      <Modal
        title="版本历史"
        open={showVersions}
        onCancel={() => setShowVersions(false)}
        footer={null}
        width={600}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {versions.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 12,
                border: '1px solid #f0f0f0',
                borderRadius: 8,
              }}
            >
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  版本 v{item.version}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {item.authorName} 于 {item.updatedAt} 修改
                </Text>
              </div>
              <Button size="small" onClick={() => message.info(`查看 v${item.version}（演示）`)}>
                查看
              </Button>
            </div>
          ))}
          {versions.length === 0 && (
            <div style={{ textAlign: 'center', color: '#999', padding: 20 }}>
              暂无版本记录
            </div>
          )}
        </div>
      </Modal>

      <Divider />

      {/* 评论区 */}
      <CommentList />
    </div>
  )
}

export default DocumentDetail
