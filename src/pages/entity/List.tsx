import { useState, useEffect, useCallback } from 'react'
import { Table, Button, Tag, Space, Radio, Pagination, Tooltip, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { EyeOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { entityApi } from '@/services/api'
import AuthButton from '@/components/AuthButton'
import type { Entity, EntityStatus } from '@/types'
import './index.scss'

type StatusFilter = EntityStatus | 'all'

const statusOptions: { label: string; value: StatusFilter }[] = [
  { label: '待复核', value: 'pending' },
  { label: '已确认', value: 'confirmed' },
  { label: '已驳回', value: 'rejected' },
  { label: '全部', value: 'all' },
]

const statusTagMap: Record<EntityStatus, { color: string; text: string }> = {
  pending: { color: 'orange', text: '待复核' },
  confirmed: { color: 'green', text: '已确认' },
  rejected: { color: 'red', text: '已驳回' },
}

function EntityList() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState<boolean>(false)
  const [entities, setEntities] = useState<Entity[]>([])
  const [total, setTotal] = useState<number>(0)
  const [status, setStatus] = useState<StatusFilter>('pending')
  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(10)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])

  const fetchEntities = useCallback(async () => {
    setLoading(true)
    try {
      const { list, total: t } = await entityApi.getList({
        status: status === 'all' ? undefined : status,
        page,
        pageSize,
      })
      setEntities(list)
      setTotal(t)
    } catch (error) {
      console.error('获取实体列表失败:', error)
    } finally {
      setLoading(false)
    }
  }, [status, page, pageSize])

  useEffect(() => {
    fetchEntities()
  }, [fetchEntities])

  const handleStatusChange = (v: StatusFilter) => {
    setStatus(v)
    setPage(1)
  }

  const handleConfirm = async (id: number) => {
    try {
      await entityApi.confirm(id)
      message.success('已确认实体')
      fetchEntities()
    } catch (error) {
      console.error('确认实体失败:', error)
    }
  }

  const handleConfirmBatch = async () => {
    try {
      await entityApi.confirmBatch(selectedRowKeys.map(Number))
      message.success('已确认实体')
      fetchEntities()
    } catch (error) {
      console.error('确认实体失败:', error)
    }
  }

  const handleRejectBatch = async () => {
    try {
      await entityApi.rejectBatch(selectedRowKeys.map(Number))
      message.success('已驳回实体')
      fetchEntities()
    } catch (error) {
      console.error('驳回实体失败:', error)
    }
  }

  const handleReject = async (id: number) => {
    try {
      await entityApi.reject(id)
      message.success('已驳回实体')
      fetchEntities()
    } catch (error) {
      console.error('驳回实体失败:', error)
    }
  }
  const rowSelection = {
    onChange: (selectedRowKeys: React.Key[]) => {
      setSelectedRowKeys(selectedRowKeys)
    },
    getCheckboxProps: (record: Entity) => ({
      disabled: record.status != "pending", // Column configuration not to be checked
      name: record.name,
    }),
  };

  const columns: ColumnsType<Entity> = [
    {
      title: '词条名',
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (name: string, record) => (
        <span
          style={{ fontWeight: 500, cursor: 'pointer', color: '#1890ff' }}
          onClick={() => navigate(`/entity/${record.id}`)}
        >
          {name}
        </span>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 100,
      render: (type: string) => (type ? <Tag color="blue">{type}</Tag> : '-'),
    },
    {
      title: '别名',
      dataIndex: 'aliases',
      key: 'aliases',
      width: 180,
      render: (aliases: string[]) => (
        <Space size={4}>
          {aliases?.slice(0, 3).map((a) => (
            <Tag key={a} color="cyan">
              {a}
            </Tag>
          ))}
          {aliases && aliases.length > 3 && <Tag>+{aliases.length - 3}</Tag>}
        </Space>
      ),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      key: 'summary',
      ellipsis: true,
      render: (summary: string) => (
        <Tooltip title={summary}>
          <span style={{ color: '#666' }}>{summary || '-'}</span>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 90,
      render: (s: EntityStatus) => {
        const { color, text } = statusTagMap[s]
        return <Tag color={color}>{text}</Tag>
      },
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 160,
      render: (t: string | null) => t || '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/entity/${record.id}`)}
          >
            查看
          </Button>
          {record.status === 'pending' && (
            <>
              <AuthButton
                roles={['admin', 'editor']}
                type="link"
                icon={<CheckOutlined />}
                onClick={() => handleConfirm(record.id)}
              >
                确认
              </AuthButton>
              <AuthButton
                roles={['admin', 'editor']}
                type="link"
                danger
                icon={<CloseOutlined />}
                onClick={() => handleReject(record.id)}
              >
                驳回
              </AuthButton>
            </>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div className='group-buttons'>
        <Radio.Group
          options={statusOptions}
          optionType="button"
          value={status}
          onChange={(e) => handleStatusChange(e.target.value)}
        />
        <div>
          <Button onClick={() => handleConfirmBatch()} disabled={selectedRowKeys.length === 0}>
            批量确认
          </Button>
          <Button onClick={() => handleRejectBatch()} disabled={selectedRowKeys.length === 0}>
            批量驳回
          </Button>
        </div>
      </div>

      <Table
        rowSelection={{
          type: 'checkbox',
          ...rowSelection,
        }}
        columns={columns}
        dataSource={entities}
        loading={loading}
        rowKey="id"
        pagination={false}
      />

      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Pagination
          current={page}
          pageSize={pageSize}
          total={total}
          onChange={(p, s) => {
            setPage(p)
            setPageSize(s)
          }}
          showSizeChanger
          showTotal={(t) => `共 ${t} 条`}
        />
      </div>
    </div>
  )
}

export default EntityList
