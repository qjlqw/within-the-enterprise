import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useUserStore } from '@/store/userStore'

interface AuthGuardProps {
  children: ReactNode
}

/**
 * 认证守卫组件
 * 未登录用户重定向到登录页，并携带来源路径以便登录后跳回
 */
function AuthGuard({ children }: AuthGuardProps) {
  const isAuthenticated = useUserStore((state) => state.isAuthenticated)
  const token = useUserStore((state) => state.token)
  const location = useLocation()

  // 既没有用户态也没有 token，则视为未登录
  if (!isAuthenticated && !token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  return <>{children}</>
}

export default AuthGuard
