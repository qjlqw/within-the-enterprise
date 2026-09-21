import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Form,
  Input,
  Select,
  Button,
  Card,
  message,
  Radio,
  Divider,
  Spin,
} from 'antd'
import { SaveOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import MDEditor from '@uiw/react-md-editor'
import { documentApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { USE_MOCK } from '@/config/api'
import type { DocumentForm } from '@/types'

const { Option } = Select

function DocumentEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [form] = Form.useForm<DocumentForm>()
  const [loading, setLoading] = useState<boolean>(false)
  const [content, setContent] = useState<string>('')
  const [submitting, setSubmitting] = useState<boolean>(false)

  useEffect(() => {
    if (id) {
      loadDocument()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const loadDocument = async () => {
    if (!id) return
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      const data = await api.getDetail(id)
      form.setFieldsValue({
        title: data.title,
        category: data.category,
        tags: data.tags,
        status: data.status,
      })
      setContent(data.content)
    } catch (error) {
      console.error('加载文档失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const onFinish = async (values: DocumentForm) => {
    if (!content.trim()) {
      message.error('请输入文档内容')
      return
    }

    setSubmitting(true)
    try {
      const api = USE_MOCK ? mockApi.documents : documentApi
      const saveData: DocumentForm = {
        ...values,
        content,
      }

      if (id) {
        await api.update(id, saveData)
        message.success('文档更新成功')
      } else {
        await api.create(saveData)
        message.success('文档创建成功')
      }
      navigate('/document')
    } catch (error) {
      console.error('保存失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
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

      <Card title={id ? '编辑文档' : '新建文档'}>
        <Form form={form} layout="vertical" onFinish={onFinish} size="large">
          <Form.Item
            name="title"
            label="文档标题"
            rules={[{ required: true, message: '请输入文档标题' }]}
          >
            <Input placeholder="请输入文档标题" maxLength={100} showCount />
          </Form.Item>

          <Form.Item
            name="category"
            label="文档分类"
            rules={[{ required: true, message: '请选择文档分类' }]}
          >
            <Select placeholder="请选择文档分类">
              <Option value="技术文档">技术文档</Option>
              <Option value="规范">规范</Option>
              <Option value="培训">培训</Option>
              <Option value="产品">产品</Option>
              <Option value="其他">其他</Option>
            </Select>
          </Form.Item>

          <Form.Item name="tags" label="标签" tooltip="按回车添加多个标签">
            <Select
              mode="tags"
              placeholder="输入标签后按回车"
              maxTagCount="responsive"
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Form.Item name="status" label="发布状态" initialValue="draft">
            <Radio.Group>
              <Radio value="draft">草稿</Radio>
              <Radio value="published">立即发布</Radio>
            </Radio.Group>
          </Form.Item>

          <Form.Item label="文档内容" required tooltip="支持 Markdown 语法">
            <div data-color-mode="light">
              <MDEditor
                value={content}
                onChange={(val) => setContent(val ?? '')}
                height={500}
                preview="live"
              />
            </div>
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              icon={<SaveOutlined />}
              loading={submitting}
              size="large"
            >
              {id ? '更新文档' : '创建文档'}
            </Button>
            <Button
              style={{ marginLeft: 8 }}
              onClick={() => navigate('/document')}
              size="large"
            >
              取消
            </Button>
          </Form.Item>
        </Form>

        <Divider />

        <Card type="inner" title="Markdown 语法速查" size="small">
          <div
            style={{
              fontSize: 12,
              color: '#666',
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 8,
            }}
          >
            <span>
              <code># 标题</code> - 一级标题
            </span>
            <span>
              <code>**粗体**</code> - 粗体文本
            </span>
            <span>
              <code>*斜体*</code> - 斜体文本
            </span>
            <span>
              <code>[链接](url)</code> - 超链接
            </span>
            <span>
              <code>![图片](url)</code> - 图片
            </span>
            <span>
              <code>- 列表项</code> - 无序列表
            </span>
            <span>
              <code>1. 列表项</code> - 有序列表
            </span>
            <span>
              <code>代码块</code> - 代码块
            </span>
            <span>
              <code>&gt; 引用</code> - 引用文本
            </span>
          </div>
        </Card>
      </Card>
    </div>
  )
}

export default DocumentEditor
