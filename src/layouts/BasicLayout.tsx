import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Input, Avatar, Dropdown, Space, Badge } from 'antd'
import type { MenuProps } from 'antd'
import {
  FileTextOutlined,
  SearchOutlined,
  TrophyOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BellOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useUserStore } from '@/store/userStore'
import type { User } from '@/types'

const { Header, Sider, Content } = Layout

type MenuItem = Required<MenuProps>['items'][number]

const menuItems: MenuItem[] = [
  { key: '/document', icon: <FileTextOutlined />, label: '文档管理' },
  { key: '/search', icon: <SearchOutlined />, label: '搜索' },
  { key: '/agent', icon: <RobotOutlined />, label: '知识助手' },
  { key: '/points', icon: <TrophyOutlined />, label: '积分排行' },
  { key: '/profile', icon: <UserOutlined />, label: '个人中心' },
]

function BasicLayout() {
  const [collapsed, setCollapsed] = useState<boolean>(false)
  const navigate = useNavigate()
  const location = useLocation()
  const isAgent = location.pathname === '/agent'
  const user = useUserStore((state) => state.user)
  const logout = useUserStore((state) => state.logout)

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const userMenuItems: MenuProps['items'] = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人中心',
      onClick: () => navigate('/profile'),
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      onClick: handleLogout,
    },
  ]

  const TriggerIcon = collapsed ? MenuUnfoldOutlined : MenuFoldOutlined
  const userName = (user as Omit<User, 'password'> | null)?.name

  return (
    <Layout className={isAgent ? 'agent-layout' : undefined} style={{ minHeight: '100vh' }}>
      <Sider trigger={null} collapsible collapsed={collapsed} theme="light" width={224}
        breakpoint={isAgent ? 'lg' : undefined} collapsedWidth={isAgent ? 0 : 80}
        onBreakpoint={(broken) => { if (isAgent) setCollapsed(broken) }}>
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <span style={{ fontSize: 20 }}>📚</span>
          {!collapsed && (
            <h2 style={{ margin: '0 0 0 8px', color: '#1890ff', fontSize: 18 }}>知识库</h2>
          )}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0 }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <TriggerIcon
              className="trigger"
              onClick={() => setCollapsed(!collapsed)}
              style={{ fontSize: 18, cursor: 'pointer' }}
            />
            <Input.Search
              placeholder="搜索文档..."
              style={{ width: 300 }}
              onSearch={(value) => navigate(`/search?q=${value}`)}
              allowClear
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Badge count={5} size="small">
              <BellOutlined style={{ fontSize: 18, cursor: 'pointer', color: '#666' }} />
            </Badge>
            <QuestionCircleOutlined style={{ fontSize: 18, cursor: 'pointer', color: '#666' }} />
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#1890ff' }} />
                <span style={{ color: '#666' }}>{userName}</span>
              </Space>
            </Dropdown>
          </div>
        </Header>
        <Content style={{ margin: 24, padding: 24, background: '#fff', borderRadius: 8 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}

export default BasicLayout
