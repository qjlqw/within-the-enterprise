import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Form, Input, Button, Card, message, Tabs } from 'antd'
import type { TabsProps } from 'antd'
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons'
import { authApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { useUserStore } from '@/store/userStore'
import { USE_MOCK } from '@/config/api'
import type { LoginForm, RegisterForm } from '@/types'

interface LocationState {
  from?: string
}

function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const login = useUserStore((state) => state.login)
  const [loading, setLoading] = useState<boolean>(false)
  const [activeTab, setActiveTab] = useState<string>('login')

  // 登录后回到来源页
  const redirectAfterAuth = () => {
    const from = (location.state as LocationState | null)?.from
    navigate(from || '/', { replace: true })
  }

  const handleLogin = async (values: LoginForm) => {
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.auth : authApi
      const { token, user } = await api.login(values)
      login(user, token)
      message.success('登录成功')
      redirectAfterAuth()
    } catch (error) {
      console.error('登录失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async (values: RegisterForm) => {
    setLoading(true)
    try {
      const api = USE_MOCK ? mockApi.auth : authApi
      const { token, user } = await api.register(values)
      login(user, token)
      message.success('注册成功')
      redirectAfterAuth()
    } catch (error) {
      console.error('注册失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const items: TabsProps['items'] = [
    {
      key: 'login',
      label: '登录',
      children: (
        <Form<LoginForm> onFinish={handleLogin} autoComplete="off">
          <Form.Item
            name="email"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input prefix={<UserOutlined />} placeholder="邮箱" size="large" />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              size="large"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              size="large"
              block
            >
              登录
            </Button>
          </Form.Item>

          <div style={{ textAlign: 'center', color: '#999', fontSize: 12 }}>
            <p>演示账号：zhangsan@company.com / 123456</p>
          </div>
        </Form>
      ),
    },
    {
      key: 'register',
      label: '注册',
      children: (
        <Form<RegisterForm> onFinish={handleRegister} autoComplete="off">
          <Form.Item
            name="name"
            rules={[{ required: true, message: '请输入姓名' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="姓名" size="large" />
          </Form.Item>

          <Form.Item
            name="email"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input prefix={<MailOutlined />} placeholder="邮箱" size="large" />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="密码"
              size="large"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              size="large"
              block
            >
              注册
            </Button>
          </Form.Item>
        </Form>
      ),
    },
  ]

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card style={{ width: 400, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0, color: '#1890ff' }}>📚 企业内部知识库</h1>
          <p style={{ color: '#999', marginTop: 8 }}>让知识创造价值</p>
        </div>

        <Tabs activeKey={activeTab} onChange={setActiveTab} items={items} />
      </Card>
    </div>
  )
}

export default Login
