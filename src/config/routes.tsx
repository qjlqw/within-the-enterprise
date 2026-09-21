// 路由配置文件
// 采用 React Router 原生 useRoutes 配置对象模式，配置完全驱动渲染
import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import {
  useRoutes,
  useLocation,
  matchPath,
  Navigate,
  type RouteObject,
} from 'react-router-dom'
import { Spin, Result, Button } from 'antd'
import BasicLayout from '@/layouts/BasicLayout'
import AuthGuard from '@/components/AuthGuard'
import { useUserStore } from '@/store/userStore'

// 懒加载页面组件
const Login = lazy(() => import('@/pages/Login'))
const DocumentList = lazy(() => import('@/pages/document/List'))
const DocumentDetail = lazy(() => import('@/pages/document/Detail'))
const DocumentEditor = lazy(() => import('@/pages/document/Editor'))
const SearchPage = lazy(() => import('@/pages/search'))
const Profile = lazy(() => import('@/pages/profile'))
const Points = lazy(() => import('@/pages/points'))
const AgentPage = lazy(() => import('@/pages/agent'))

// 路由 handle 自定义字段类型
interface RouteHandle {
  /** 页面标题，自动同步到 document.title */
  title?: string
}

// 路由配置：完全由配置驱动渲染（直接复用 React Router 的 RouteObject 类型）
const routes: RouteObject[] = [
  {
    path: '/login',
    element: (
      <GuestGuard>
        <Login />
      </GuestGuard>
    ),
    handle: { title: '登录' },
  },
  {
    path: '/',
    element: (
      <AuthGuard>
        <BasicLayout />
      </AuthGuard>
    ),
    children: [
      { index: true, element: <Navigate to="/document" replace /> },
      { path: 'document', element: <DocumentList />, handle: { title: '文档管理' } },
      { path: 'document/:id', element: <DocumentDetail />, handle: { title: '文档详情' } },
      { path: 'document/editor/:id?', element: <DocumentEditor />, handle: { title: '文档编辑' } },
      { path: 'search', element: <SearchPage />, handle: { title: '搜索' } },
      { path: 'agent', element: <AgentPage />, handle: { title: '知识助手' } },
      { path: 'profile', element: <Profile />, handle: { title: '个人中心' } },
      { path: 'points', element: <Points />, handle: { title: '积分排行' } },
    ],
  },
  {
    path: '*',
    element: <NotFound />,
    handle: { title: '页面不存在' },
  },
]

/**
 * 已登录用户访问登录页时自动跳回首页
 */
function GuestGuard({ children }: { children: ReactNode }) {
  const isAuthenticated = useUserStore((state) => state.isAuthenticated)
  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

/**
 * 404 兜底页
 */
function NotFound() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Result
        status="404"
        title="404"
        subTitle="抱歉，您访问的页面不存在。"
        extra={
          <Button type="primary" onClick={() => (window.location.href = '/')}>
            返回首页
          </Button>
        }
      />
    </div>
  )
}

/**
 * 路由级 Suspense fallback
 */
function RouteFallback() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 300,
      }}
    >
      <Spin />
    </div>
  )
}

/**
 * 递归遍历路由配置，根据当前 pathname 找到匹配路由的 handle.title
 * （BrowserRouter 非 data router，无法用 useMatches，需自行匹配）
 */
function findMatchedTitle(
  routeList: RouteObject[],
  pathname: string,
  parentPath = ''
): string | undefined {
  for (const route of routeList) {
    // index 路由：仅当父路径完全匹配时生效
    if (route.index) {
      if (matchPath(parentPath || '/', pathname)) {
        return (route.handle as RouteHandle | undefined)?.title
      }
      continue
    }
    if (!route.path) continue

    const full = `${parentPath}/${route.path}`.replace(/\/+/g, '/')
    if (matchPath(full, pathname)) {
      // 子路由优先返回更具体的标题；若无则用父级标题
      const childTitle = route.children
        ? findMatchedTitle(route.children, pathname, full)
        : undefined
      return (
        childTitle ?? (route.handle as RouteHandle | undefined)?.title
      )
    }
  }
  return undefined
}

/**
 * 根据当前匹配路由的 handle.title 自动设置 document.title
 */
function TitleUpdater() {
  const location = useLocation()
  useEffect(() => {
    const title = findMatchedTitle(routes, location.pathname)
    document.title = title ? `${title} - 企业内部知识库` : '企业内部知识库'
  }, [location.pathname])
  return null
}

function AppRoutes() {
  const element = useRoutes(routes)
  return (
    <>
      <TitleUpdater />
      <Suspense fallback={<RouteFallback />}>{element}</Suspense>
    </>
  )
}

export function renderRoutes(): ReactNode {
  return <AppRoutes />
}

export default routes
