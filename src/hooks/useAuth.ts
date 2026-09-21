import { useState, useEffect, useCallback } from 'react'
import { authApi } from '@/services/api'
import { mockApi } from '@/services/mock'
import { useUserStore } from '@/store/userStore'
import { USE_MOCK } from '@/config/api'
import type { LoginForm, User } from '@/types'

interface UseAuthResult {
  user: Omit<User, 'password'> | null
  loading: boolean
  login: (credentials: LoginForm) => Promise<Omit<User, 'password'>>
  logout: () => void
}

/**
 * 用户认证 Hook
 * 基于全局 userStore + 后端 API，统一暴露登录/登出/当前用户
 */
export function useAuth(): UseAuthResult {
  const storeUser = useUserStore((state) => state.user)
  const loginStore = useUserStore((state) => state.login)
  const logoutStore = useUserStore((state) => state.logout)
  const token = useUserStore((state) => state.token)
  const isAuthenticated = useUserStore((state) => state.isAuthenticated)

  const [user, setUser] = useState<Omit<User, 'password'> | null>(storeUser)
  const [loading, setLoading] = useState<boolean>(!isAuthenticated && !!token)

  // 如果有 token 但没有用户信息（刷新页面场景），自动拉取一次当前用户
  useEffect(() => {
    let active = true
    if (token && !storeUser) {
      setLoading(true)
      const api = USE_MOCK ? mockApi.auth : authApi
      api
        .getCurrentUser()
        .then((u) => {
          if (active) {
            setUser(u)
            loginStore(u, token)
          }
        })
        .catch(() => {
          if (active) {
            logoutStore()
            setUser(null)
          }
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    } else {
      setUser(storeUser)
      setLoading(false)
    }
    return () => {
      active = false
    }
  }, [storeUser, token, loginStore, logoutStore])

  const login = useCallback(
    async (credentials: LoginForm): Promise<Omit<User, 'password'>> => {
      const api = USE_MOCK ? mockApi.auth : authApi
      const { token: newToken, user: userInfo } = await api.login(credentials)
      loginStore(userInfo, newToken)
      setUser(userInfo)
      return userInfo
    },
    [loginStore]
  )

  const logout = useCallback(() => {
    logoutStore()
    setUser(null)
  }, [logoutStore])

  return { user, loading, login, logout }
}
