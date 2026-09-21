import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Descriptions,
  Avatar,
  Tag,
  Space,
  Button,
  Upload,
  message,
  Modal,
  Form,
  Input,
  Spin,
} from 'antd'
import type { UploadProps } from 'antd'
import {
  UserOutlined,
  MailOutlined,
  EditOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { userApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { useUserStore } from '@/store/userStore'
import { USE_MOCK } from '@/config/api'
import type { UpdateProfileForm, UserStats } from '@/types'

const { Meta } = Card

function Profile() {
  const user = useUserStore((state) => state.user)
  const updateUser = useUserStore((state) => state.updateUser)
  const [loading, setLoading] = useState<boolean>(false)
  const [submitting, setSubmitting] = useState<boolean>(false)
  const [stats, setStats] = useState<UserStats | null>(null)
  const [showEditModal, setShowEditModal] = useState<boolean>(false)
  const [form] = Form.useForm<UpdateProfileForm>()

  const fetchStats = useCallback(async () => {
    if (!user?.id) return
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.users : userApi
      const data = await api.getStats(user.id)
      setStats(data)
    } catch (error) {
      console.error('获取统计失败:', error)
    } finally {
      setLoading(false)
    }
  }, [user?.id])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  const uploadProps: UploadProps = {
    showUploadList: false,
    beforeUpload: (file) => {
      const isImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)
      if (!isImage) {
        message.error('只能上传 JPG/PNG/GIF/WEBP 格式的图片')
        return Upload.LIST_IGNORE
      }
      const isLt2M = file.size / 1024 / 1024 < 2
      if (!isLt2M) {
        message.error('图片大小不能超过 2MB')
        return Upload.LIST_IGNORE
      }
      // 上传头像
      const formData = new FormData()
      formData.append('avatar', file)
      const api = USE_MOCK ? mockApi.users : userApi
      api
        .uploadAvatar(formData)
        .then((res) => {
          updateUser({ avatar: res.avatar })
          message.success('头像上传成功')
        })
        .catch((error) => {
          console.error('头像上传失败:', error)
          message.error('头像上传失败')
        })
      return false
    },
  }

  const handleUpdateProfile = async (values: UpdateProfileForm) => {
    setSubmitting(true)
    try {
      const api = USE_MOCK ? mockApi.users : userApi
      const updated = await api.updateProfile(values)
      updateUser(updated)
      message.success('更新成功')
      setShowEditModal(false)
    } catch (error) {
      console.error('更新失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Spin spinning={loading}>
      {/* 用户信息卡片 */}
      <Card style={{ marginBottom: 16 }}>
        <Meta
          avatar={
            <Upload {...uploadProps}>
              <Avatar
                size={100}
                src={user?.avatar || undefined}
                icon={<UserOutlined />}
                style={{ backgroundColor: '#1890ff', cursor: 'pointer' }}
              />
              <div style={{ textAlign: 'center', fontSize: 12, color: '#999', marginTop: 4 }}>
                <UploadOutlined /> 上传头像
              </div>
            </Upload>
          }
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h2 style={{ margin: 0 }}>{user?.name}</h2>
              <Button
                type="link"
                icon={<EditOutlined />}
                onClick={() => {
                  form.setFieldsValue({
                    name: user?.name,
                    department: user?.department,
                  })
                  setShowEditModal(true)
                }}
              >
                编辑资料
              </Button>
            </div>
          }
          description={
            <Space size={16} style={{ marginTop: 16 }}>
              <Tag color="blue">{user?.department || '未填写'}</Tag>
              <Tag color="green">{user?.roles?.[0] || '普通用户'}</Tag>
            </Space>
          }
        />
      </Card>

      {/* 统计卡片 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 'bold', color: '#1890ff' }}>
              {stats?.documents || 0}
            </div>
            <div style={{ color: '#666', marginTop: 8 }}>📄 文档数</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 'bold', color: '#52c41a' }}>
              {stats?.likes || 0}
            </div>
            <div style={{ color: '#666', marginTop: 8 }}>👍 获赞数</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 'bold', color: '#faad14' }}>
              {stats?.favorites || 0}
            </div>
            <div style={{ color: '#666', marginTop: 8 }}>⭐ 收藏数</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 'bold', color: '#722ed1' }}>
              {stats?.views || 0}
            </div>
            <div style={{ color: '#666', marginTop: 8 }}>👁️ 浏览数</div>
          </div>
        </div>
      </Card>

      {/* 个人信息 */}
      <Card title="个人信息" style={{ marginBottom: 16 }}>
        <Descriptions column={2}>
          <Descriptions.Item label="邮箱">
            <MailOutlined /> {user?.email}
          </Descriptions.Item>
          <Descriptions.Item label="部门">{user?.department}</Descriptions.Item>
          <Descriptions.Item label="角色">
            <Tag color="blue">{user?.roles?.[0] || '普通用户'}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="积分">
            <Tag color="gold">{user?.points || 0} 分</Tag>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 编辑资料弹窗 */}
      <Modal
        title="编辑资料"
        open={showEditModal}
        onCancel={() => setShowEditModal(false)}
        footer={null}
      >
        <Form form={form} layout="vertical" onFinish={handleUpdateProfile}>
          <Form.Item
            name="name"
            label="姓名"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="department" label="部门">
            <Input />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              保存
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </Spin>
  )
}

export default Profile
