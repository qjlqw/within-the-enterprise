import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Table,
  Avatar,
  Progress,
  Typography,
  Badge,
  Space,
  Divider,
  Spin,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  TrophyOutlined,
  GiftOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { pointsApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { useUserStore } from '@/store/userStore'
import { USE_MOCK } from '@/config/api'
import type { PointsRecord, PointsRule, RankingUser } from '@/types'

const { Text } = Typography

function Points() {
  const user = useUserStore((state) => state.user)
  const [loading, setLoading] = useState<boolean>(false)
  const [ranking, setRanking] = useState<RankingUser[]>([])
  const [pointsRecords, setPointsRecords] = useState<PointsRecord[]>([])
  const [rules, setRules] = useState<PointsRule[]>([])

  const fetchRanking = useCallback(async () => {
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.points : pointsApi
      const data = await api.getRanking({ limit: 10 })
      setRanking(data)
    } catch (error) {
      console.error('获取排行失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchPointsRecords = useCallback(async () => {
    try {
      const api = USE_MOCK ? mockApi.points : pointsApi
      const data = await api.getDetail()
      setPointsRecords(data.list || [])
    } catch (error) {
      console.error('获取积分记录失败:', error)
    }
  }, [])

  const fetchRules = useCallback(async () => {
    try {
      const api = USE_MOCK ? mockApi.points : pointsApi
      const data = await api.getRules()
      setRules(data)
    } catch (error) {
      console.error('获取积分规则失败:', error)
    }
  }, [])

  useEffect(() => {
    fetchRanking()
    fetchPointsRecords()
    fetchRules()
  }, [fetchRanking, fetchPointsRecords, fetchRules])

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <TrophyOutlined style={{ fontSize: 20, color: '#ffd700' }} />
    if (rank === 2) return <Badge count="2" style={{ backgroundColor: '#c0c0c0', fontSize: 14 }} />
    if (rank === 3) return <Badge count="3" style={{ backgroundColor: '#cd7f32', fontSize: 14 }} />
    return <span style={{ fontSize: 16, fontWeight: 'bold', color: '#999' }}>{rank}</span>
  }

  const getPointsColor = (points: number): string => {
    if (points > 0) return '#52c41a'
    if (points < 0) return '#ff4d4f'
    return '#666'
  }

  const columns: ColumnsType<RankingUser> = [
    {
      title: '排名',
      dataIndex: 'rank',
      key: 'rank',
      width: 80,
      render: (rank: number) => getRankIcon(rank),
    },
    {
      title: '用户',
      dataIndex: 'name',
      key: 'name',
      render: (_, record) => (
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Avatar
            icon={<UserOutlined />}
            style={{ marginRight: 8, backgroundColor: '#1890ff' }}
          />
          <div>
            <div style={{ fontWeight: 500 }}>{record.name}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.department}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: '积分',
      dataIndex: 'points',
      key: 'points',
      width: 200,
      sorter: (a, b) => (a.points || 0) - (b.points || 0),
      render: (points: number) => (
        <div>
          <Progress
            percent={(points / 3000) * 100}
            strokeColor={{ '0%': '#108ee9', '100%': '#87d068' }}
            showInfo={false}
            size="small"
            style={{ marginBottom: 4 }}
          />
          <Text strong style={{ fontSize: 16, color: '#1890ff' }}>
            {points}
          </Text>
        </div>
      ),
    },
  ]

  return (
    <Spin spinning={loading}>
      {/* 积分规则卡片 */}
      <Card title="📋 积分规则" style={{ marginBottom: 16 }} size="small">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
          }}
        >
          {rules.map((rule) => (
            <Card key={rule.type} size="small" type="inner">
              <div style={{ textAlign: 'center' }}>
                <GiftOutlined style={{ fontSize: 24, color: '#faad14' }} />
                <div style={{ marginTop: 8 }}>{rule.name}</div>
                <Text strong style={{ color: '#52c41a', fontSize: 18 }}>
                  +{rule.points}
                </Text>
                <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  每日上限：{rule.dailyLimit}
                </Text>
              </div>
            </Card>
          ))}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        {/* 积分排行榜 */}
        <Card
          title={
            <Space>
              <TrophyOutlined />
              <span>积分排行榜</span>
            </Space>
          }
          extra={<Text type="secondary">月度更新</Text>}
        >
          <Table
            columns={columns}
            dataSource={ranking}
            rowKey="id"
            pagination={false}
            size="small"
          />
        </Card>

        {/* 个人积分明细 */}
        <Card title="📊 我的积分" size="small">
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 48, fontWeight: 'bold', color: '#1890ff' }}>
              {user?.points || 0}
            </div>
            <Text type="secondary">当前积分</Text>
          </div>

          <Divider>积分明细</Divider>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pointsRecords.slice(0, 10).map((item) => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid #f0f0f0',
                }}
              >
                <div>
                  <div style={{ fontSize: 13 }}>{item.description}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {item.createdAt}
                  </Text>
                </div>
                <Text strong style={{ color: getPointsColor(item.points) }}>
                  {item.points > 0 ? '+' : ''}
                  {item.points}
                </Text>
              </div>
            ))}
            {pointsRecords.length === 0 && (
              <div style={{ textAlign: 'center', color: '#999', padding: '20px 0' }}>
                暂无积分记录
              </div>
            )}
          </div>
        </Card>
      </div>
    </Spin>
  )
}

export default Points
