import { useState, useEffect, useCallback } from 'react'
import {
  Table,
  Button,
  Tag,
  Space,
  Input,
  Popconfirm,
  message,
  Select,
  Pagination,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  StarOutlined,
  FireOutlined,
  CloudUploadOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { documentApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { USE_MOCK } from '@/config/api'
import AuthButton from '@/components/AuthButton'
import UploadDocumentModal from './UploadDocumentModal'
import type { Document, DocumentStatus } from '@/types'

const { Search } = Input
const { Option } = Select

interface CategoryOption {
  label: string
  value: string
}

const categoryOptions: CategoryOption[] = [
  { label: '技术文档', value: '技术文档' },
  { label: '规范', value: '规范' },
  { label: '培训', value: '培训' },
  { label: '其他', value: '其他' },
]

function DocumentList() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState<boolean>(false)
  const [documents, setDocuments] = useState<Document[]>([])
  const [total, setTotal] = useState<number>(0)
  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(10)
  const [keyword, setKeyword] = useState<string>('')
  const [category, setCategory] = useState<string>('')
  const [uploadOpen, setUploadOpen] = useState<boolean>(false)

  const fetchDocuments = useCallback(async () => {
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      const { list, total: t } = await api.getList({
        page,
        pageSize,
        keyword,
        category,
      })
      setDocuments(list)
      setTotal(t)
    } catch (error) {
      console.error('获取文档列表失败:', error)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, keyword, category])

  useEffect(() => {
    fetchDocuments()
  }, [fetchDocuments])

  const handleSearch = () => {
    setPage(1)
    fetchDocuments()
  }

  const handleDelete = async (id: number) => {
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      await api.delete(id)
      message.success('删除成功')
      fetchDocuments()
    } catch (error) {
      console.error('删除失败:', error)
    }
  }

  const columns: ColumnsType<Document> = [
    {
      title: '文档标题',
      dataIndex: 'title',
      key: 'title',
      width: 300,
      render: (title: string, record) => (
        <div>
          <div
            style={{ fontWeight: 500, cursor: 'pointer', color: '#1890ff' }}
            onClick={() => navigate(`/document/${record.id}`)}
          >
            {title}
          </div>
          <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
            <FireOutlined style={{ marginRight: 4 }} /> {record.views} 次浏览
          </div>
        </div>
      ),
    },
    { title: '作者', dataIndex: 'authorName', key: 'authorName', width: 100 },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 100,
      filters: categoryOptions.map((c) => ({ text: c.label, value: c.value })),
      onFilter: (value, record) => record.category === value,
      render: (cat: string) => <Tag color="blue">{cat}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 80,
      render: (status: DocumentStatus) => (
        <Tag color={status === 'published' ? 'green' : 'orange'}>
          {status === 'published' ? '已发布' : '草稿'}
        </Tag>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      key: 'tags',
      width: 150,
      render: (tags?: string[]) => (
        <Space size={4}>
          {tags?.slice(0, 3).map((tag) => (
            <Tag key={tag} color="cyan">
              {tag}
            </Tag>
          ))}
          {tags && tags.length > 3 && <Tag>+{tags.length - 3}</Tag>}
        </Space>
      ),
    },
    {
      title: '互动',
      key: 'interaction',
      width: 100,
      render: (_, record) => (
        <Space size={8}>
          <span title="点赞">
            <StarOutlined /> {record.likes}
          </span>
          <span title="收藏">
            <FireOutlined /> {record.favorites}
          </span>
        </Space>
      ),
    },
    { title: '更新时间', dataIndex: 'updatedAt', key: 'updatedAt', width: 160 },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space>
          <Button
            type="link"
            icon={<EyeOutlined />}
            onClick={() => navigate(`/document/${record.id}`)}
          >
            查看
          </Button>

          {/* 编辑按钮 - 管理员/编辑者可见 */}
          <AuthButton
            roles={['admin', 'editor']}
            mode="hidden"
            type="link"
            icon={<EditOutlined />}
            onClick={() => navigate(`/document/editor/${record.id}`)}
          >
            编辑
          </AuthButton>

          {/* 删除按钮 - 仅管理员可见，无权限时禁用 */}
          <AuthButton roles="admin" mode="disabled" type="link" danger icon={<DeleteOutlined />}>
            <Popconfirm
              title="确定删除？"
              onConfirm={() => handleDelete(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <span>删除</span>
            </Popconfirm>
          </AuthButton>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', gap: 12 }}>
          <Search
            placeholder="搜索文档标题..."
            style={{ width: 250 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={handleSearch}
            allowClear
          />
          <Select
            placeholder="分类"
            style={{ width: 120 }}
            value={category || undefined}
            onChange={(v) => setCategory(v ?? '')}
            allowClear
          >
            {categoryOptions.map((c) => (
              <Option key={c.value} value={c.value}>
                {c.label}
              </Option>
            ))}
          </Select>
        </div>
        {!USE_MOCK && (
          <Space>
            <Button icon={<CloudUploadOutlined />} onClick={() => setUploadOpen(true)}>
              上传文档
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate('/document/editor')}
            >
              新建文档
            </Button>
          </Space>
        )}
        {USE_MOCK && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => navigate('/document/editor')}
          >
            新建文档
          </Button>
        )}
      </div>

      <Table
        columns={columns}
        dataSource={documents}
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

      <UploadDocumentModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={fetchDocuments}
      />
    </div>
  )
}

export default DocumentList
