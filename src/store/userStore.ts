import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UpdateProfileForm, User } from '@/types'

interface UserState {
  user: Omit<User, 'password'> | null
  token: string | null
  isAuthenticated: boolean
  login: (userData: Omit<User, 'password'>, token: string) => void
  logout: () => void
  updateUser: (userData: UpdateProfileForm) => void
  addPoints: (points: number) => void
}

// 用户状态管理
export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      // 登录
      login: (userData, token) => {
        set({
          user: userData,
          token,
          isAuthenticated: true,
        })
      },

      // 登出
      logout: () => {
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        })
      },

      // 更新用户信息
      updateUser: (userData) => {
        const current = get().user
        if (!current) return
        set({ user: { ...current, ...userData } })
      },

      // 更新积分
      addPoints: (points) => {
        const current = get().user
        if (!current) return
        set({
          user: {
            ...current,
            points: (current.points || 0) + points,
          },
        })
      },
    }),
    {
      name: 'user-storage',
    }
  )
)
