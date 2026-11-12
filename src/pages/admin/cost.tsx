import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, Table, Typography, Space, Segmented, Spin, Result } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  DollarOutlined,
  MessageOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { observabilityApi } from '@/services/api'
import type { UsageDayRow, UsageUserRow } from '@/services/api'
import { useUserStore } from '@/store/userStore'

const { Text } = Typography

function AdminCost() {
  const user = useUserStore((state) => state.user)
  const isAdmin = !!user?.roles?.includes('admin')

  const [days, setDays] = useState<number>(7)
  const [loading, setLoading] = useState<boolean>(false)
  const [daily, setDaily] = useState<UsageDayRow[]>([])
  const [topUsers, setTopUsers] = useState<UsageUserRow[]>([])

  const fetchSummary = useCallback(async (d: number) => {
    setLoading(true)
    try {
      const data = await observabilityApi.getUsageSummary(d)
      setDaily(data.daily || [])
      setTopUsers(data.topUsers || [])
    } catch (error) {
      console.error('获取用量汇总失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) fetchSummary(days)
  }, [isAdmin, days, fetchSummary])

  const totals = useMemo(
    () =>
      daily.reduce(
        (acc, row) => ({
          agentRuns: acc.agentRuns + (row.agentRuns || 0),
          chars: acc.chars + (row.chars || 0),
          tokensIn: acc.tokensIn + (row.tokensIn || 0),
          tokensOut: acc.tokensOut + (row.tokensOut || 0),
        }),
        { agentRuns: 0, chars: 0, tokensIn: 0, tokensOut: 0 },
      ),
    [daily]
  )

  const dailyColumns: ColumnsType<UsageDayRow> = [
    { title: '日期', dataIndex: 'date', key: 'date' },
    { title: '问答次数', dataIndex: 'agentRuns', key: 'agentRuns' },
    {
      title: '输入字符量',
      dataIndex: 'chars',
      key: 'chars',
      sorter: (a, b) => a.chars - b.chars,
    },
    { title: '输入 Tokens', dataIndex: 'tokensIn', key: 'tokensIn' },
    { title: '输出 Tokens', dataIndex: 'tokensOut', key: 'tokensOut' },
  ]

  const userColumns: ColumnsType<UsageUserRow> = [
    {
      title: '用户',
      dataIndex: 'userId',
      key: 'userId',
      render: (id: number) => (
        <Space>
          <UserOutlined />
          <span>用户 #{id}</span>
        </Space>
      ),
    },
    {
      title: '问答次数',
      dataIndex: 'runs',
      key: 'runs',
      defaultSortOrder: 'descend',
      sorter: (a, b) => a.runs - b.runs,
    },
    {
      title: '输入字符量',
      dataIndex: 'chars',
      key: 'chars',
      sorter: (a, b) => a.chars - b.chars,
    },
  ]

  if (!isAdmin) {
    return (
      <Result
        status="403"
        title="403"
        subTitle="仅管理员可查看成本看板"
      />
    )
  }

  return (
    <Spin spinning={loading}>
      <Card
        title={
          <Space>
            <DollarOutlined />
            <span>成本看板（近 {days} 天）</span>
          </Space>
        }
        extra={
          <Segmented
            options={[
              { label: '近 7 天', value: 7 },
              { label: '近 30 天', value: 30 },
            ]}
            value={days}
            onChange={(v) => setDays(v as number)}
          />
        }
        style={{ marginBottom: 16 }}
        size="small"
      >
        <Space size="large" wrap>
          <Space size={8}>
            <MessageOutlined />
            <Text type="secondary">问答总次数：</Text>
            <Text strong>{totals.agentRuns}</Text>
          </Space>
          <Space size={8}>
            <Text type="secondary">输入字符总量：</Text>
            <Text strong>{totals.chars}</Text>
          </Space>
          <Space size={8}>
            <Text type="secondary">输入 Tokens：</Text>
            <Text strong>{totals.tokensIn}</Text>
          </Space>
          <Space size={8}>
            <Text type="secondary">输出 Tokens：</Text>
            <Text strong>{totals.tokensOut}</Text>
          </Space>
        </Space>
      </Card>

      <Card title="📅 每日用量" size="small" style={{ marginBottom: 16 }}>
        <Table
          columns={dailyColumns}
          dataSource={daily}
          rowKey="date"
          pagination={false}
          size="small"
        />
      </Card>

      <Card title="🏆 用户用量 Top 10" size="small">
        <Table
          columns={userColumns}
          dataSource={topUsers}
          rowKey="userId"
          pagination={false}
          size="small"
        />
      </Card>
    </Spin>
  )
}

export default AdminCost
