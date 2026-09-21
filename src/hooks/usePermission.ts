import { useUserStore } from '@/store/userStore'
import type { UserRole } from '@/types'

type RoleCheck = UserRole | UserRole[]

interface UsePermissionResult {
  user: ReturnType<typeof useUserStore.getState>['user']
  isAuthenticated: boolean
  hasPermission: (role?: RoleCheck) => boolean
  hasAnyRole: (roles: UserRole[]) => boolean
  hasAllRoles: (roles: UserRole[]) => boolean
  isAdmin: () => boolean
  isEditor: () => boolean
}

/**
 * 权限检查 Hook
 *
 * @example
 * // 检查单个角色
 * if (hasPermission('admin')) { ... }
 *
 * // 检查任意一个角色
 * if (hasAnyRole(['admin', 'editor'])) { ... }
 *
 * // 检查所有角色
 * if (hasAllRoles(['admin', 'manager'])) { ... }
 */
export function usePermission(): UsePermissionResult {
  const user = useUserStore((state) => state.user)
  const isAuthenticated = useUserStore((state) => state.isAuthenticated)

  /**
   * 检查用户是否有指定角色
   * @param role - 角色名或角色列表
   */
  const hasPermission = (role?: RoleCheck): boolean => {
    if (!isAuthenticated || !user?.roles) return false
    if (!role) return true

    const userRoles = user.roles || []

    // 支持传入单个角色或角色数组
    if (Array.isArray(role)) {
      return role.some((r) => userRoles.includes(r))
    }
    return userRoles.includes(role)
  }

  /**
   * 检查用户是否有任何一个指定角色（OR 逻辑）
   */
  const hasAnyRole = (roles: UserRole[]): boolean => {
    if (!isAuthenticated || !user?.roles) return false
    return roles.some((role) => user.roles.includes(role))
  }

  /**
   * 检查用户是否拥有所有指定角色（AND 逻辑）
   */
  const hasAllRoles = (roles: UserRole[]): boolean => {
    if (!isAuthenticated || !user?.roles) return false
    return roles.every((role) => user.roles.includes(role))
  }

  /** 检查是否是管理员 */
  const isAdmin = (): boolean => hasPermission('admin')

  /** 检查是否是编辑者 */
  const isEditor = (): boolean => hasPermission('editor')

  return {
    user,
    isAuthenticated,
    hasPermission,
    hasAnyRole,
    hasAllRoles,
    isAdmin,
    isEditor,
  }
}
