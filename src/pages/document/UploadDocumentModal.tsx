import { useState } from 'react'
import { Modal, Upload, Select, Switch, message, Form, Alert } from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { InboxOutlined } from '@ant-design/icons'
import { documentApi } from '@/services/api'

const { Dragger } = Upload
const { Option } = Select

interface UploadDocumentModalProps {
  open: boolean
  onClose: () => void
  onUploaded: () => void
}

const categoryOptions = [
  { label: '技术文档', value: '技术文档' },
  { label: '规范', value: '规范' },
  { label: '培训', value: '培训' },
  { label: '其他', value: '其他' },
]

/**
 * 文档上传弹窗
 * - 支持 Markdown / TXT / DOCX，服务端解析正文、提取标题
 * - 默认存为草稿；勾选"立即发布"后创建并异步建立向量索引
 */
function UploadDocumentModal({ open, onClose, onUploaded }: UploadDocumentModalProps) {
  const [form] = Form.useForm()
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    form.resetFields()
    setFileList([])
  }

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      const file = fileList[0]?.originFileObj as File | undefined
      if (!file) {
        message.warning('请先选择要上传的文件')
        return
      }
      const formData = new FormData()
      formData.append('file', file)
      formData.append('category', values.category)
      formData.append('status', values.publish ? 'published' : 'draft')
      if (values.tags?.length) formData.append('tags', JSON.stringify(values.tags))

      setSubmitting(true)
      const result = await documentApi.upload(formData)
      message.success(`《${result.doc.title}》上传成功`)
      if (result.indexJob) {
        message.info('向量索引任务已入队，将在后台异步建立，可稍后在列表检索验证')
      }
      result.warnings.forEach((w) => message.warning(w))
      reset()
      onUploaded()
      onClose()
    } catch (error) {
      // 拦截器已统一提示错误；校验错误不提示
      if (!(error as { errorFields?: unknown[] })?.errorFields) {
        console.error('上传文档失败:', error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    reset()
    onClose()
  }

  return (
    <Modal
      title="上传文档"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="上传"
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
      width={520}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="支持 Markdown（.md）、TXT（.txt）、Word（.docx），单文件不超过 10MB；PDF 暂不支持"
      />
      <Form form={form} layout="vertical" initialValues={{ category: undefined, publish: false, tags: [] }}>
        <Form.Item
          name="category"
          label="分类"
          rules={[{ required: true, message: '请选择分类' }]}
        >
          <Select placeholder="请选择分类">
            {categoryOptions.map((c) => (
              <Option key={c.value} value={c.value}>
                {c.label}
              </Option>
            ))}
          </Select>
        </Form.Item>

        <Form.Item label="文件" required>
          <Dragger
            accept=".md,.markdown,.txt,.docx"
            maxCount={1}
            fileList={fileList}
            beforeUpload={(file) => {
               // 手动接管上传：拦截 antd 自动上传，将 RcFile 正确包装为 UploadFile
              // RcFile 本身就是 File 的子类，额外带 uid/percent 等属性
              setFileList([{
                uid: file.uid,
                name: file.name,
                size: file.size,
                type: file.type,
                status: 'done',
                originFileObj: file,
              } as UploadFile])
              return false
            }}
            onRemove={() => setFileList([])}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
            <p className="ant-upload-hint">标题取文件名或文档首个标题，正文由服务端解析</p>
          </Dragger>
        </Form.Item>

        <Form.Item name="tags" label="标签">
          <Select mode="tags" placeholder="输入标签后回车，最多 10 个" tokenSeparators={[',']} />
        </Form.Item>

        <Form.Item name="publish" label="立即发布" valuePropName="checked">
          <Switch checkedChildren="发布" unCheckedChildren="草稿" />
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default UploadDocumentModal
