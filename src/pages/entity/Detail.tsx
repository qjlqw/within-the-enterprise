import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Descriptions, Tag, Button, Space, Card, Spin, message, Typography, List, Empty } from 'antd'
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { entityApi } from '@/services/api'
import AuthButton from '@/components/AuthButton'
import type { EntityDetail, EntityStatus } from '@/types'

const { Title, Paragraph, Text } = Typography

const statusTagMap: Record<EntityStatus, { color: string; text: string }> = {
  pending: { color: 'orange', text: '待复核' },
  confirmed: { color: 'green', text: '已确认' },
  rejected: { color: 'red', text: '已驳回' },
}

function EntityDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState<boolean>(true)
  const [entity, setEntity] = useState<EntityDetail | null>(null)

  const fetchEntity = useCallback(async () => {
    if (!id) return
    setLoading(true)
    try {
      const data = await entityApi.getDetail(id)
      setEntity(data)
    } catch (error) {
      console.error('获取实体失败:', error)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchEntity()
  }, [fetchEntity])

  const handleConfirm = async () => {
    if (!id) return
    try {
      await entityApi.confirm(id)
      message.success('已确认实体')
      fetchEntity()
    } catch (error) {
      console.error('确认实体失败:', error)
    }
  }

  const handleReject = async () => {
    if (!id) return
    try {
      await entityApi.reject(id)
      message.success('已驳回实体')
      fetchEntity()
    } catch (error) {
      console.error('驳回实体失败:', error)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }

  if (!entity) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <p>实体不存在</p>
        <Button onClick={() => navigate('/entity')}>返回列表</Button>
      </div>
    )
  }

  const statusInfo = statusTagMap[entity.status]

  return (
    <div>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/entity')}
        style={{ marginBottom: 16 }}
      >
        返回列表
      </Button>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <Title level={2} style={{ marginBottom: 8 }}>
            {entity.name}
          </Title>
          <Space>
            {entity.type && <Tag color="blue">{entity.type}</Tag>}
            <Tag color={statusInfo.color}>{statusInfo.text}</Tag>
            <Text type="secondary">更新时间：{entity.updatedAt || '-'}</Text>
          </Space>
        </div>

        {entity.aliases.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <Text strong>别名：</Text>
            <Space size={4}>
              {entity.aliases.map((a) => (
                <Tag key={a} color="cyan">
                  {a}
                </Tag>
              ))}
            </Space>
          </div>
        )}

        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="摘要">
            <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
              {entity.summary || '（暂无摘要）'}
            </Paragraph>
          </Descriptions.Item>
        </Descriptions>

        {entity.status === 'pending' && (
          <Space style={{ marginTop: 16 }}>
            <AuthButton
              roles={['admin', 'editor']}
              type="primary"
              icon={<CheckOutlined />}
              onClick={handleConfirm}
            >
              确认
            </AuthButton>
            <AuthButton
              roles={['admin', 'editor']}
              danger
              icon={<CloseOutlined />}
              onClick={handleReject}
            >
              驳回
            </AuthButton>
          </Space>
        )}
      </Card>

      <Card title="关联关系" style={{ marginBottom: 16 }}>
        {entity.relations.length === 0 ? (
          <Empty description="暂无关系" />
        ) : (
          <List
            dataSource={entity.relations}
            renderItem={(r) => (
              <List.Item>
                <Space>
                  <Tag color={r.direction === 'out' ? 'blue' : 'purple'}>
                    {r.direction === 'out' ? '出向' : '入向'}
                  </Tag>
                  <Text strong>{r.predicate}</Text>
                  <Text type="secondary">→</Text>
                  {r.target.name ? (
                    <a onClick={() => navigate(`/entity/${r.target.id}`)}>
                      {r.target.name}
                    </a>
                  ) : (
                    <Text type="secondary">（已删除）</Text>
                  )}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      <Card title="来源文档">
        {entity.sourceDocs.length === 0 ? (
          <Empty description="暂无来源文档" />
        ) : (
          <List
            dataSource={entity.sourceDocs}
            renderItem={(doc) => (
              <List.Item>
                <a onClick={() => navigate(`/document/${doc.id}`)}>{doc.title}</a>
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  )
}

export default EntityDetailPage
