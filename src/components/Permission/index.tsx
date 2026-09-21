import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { usePermission } from '@/hooks/usePermission'
import type { UserRole } from '@/types'

type RoleCheck = UserRole | UserRole[]
type PermissionMode = 'hidden' | 'disabled'

interface PermissionProps {
  /** 允许的角色列表 */
  roles?: RoleCheck
  /** 子组件 */
  children: ReactNode
  /** 无权限时显示的内容 */
  fallback?: ReactNode
  /** 模式：'hidden'隐藏 / 'disabled'禁用 */
  mode?: PermissionMode
}

/**
 * 权限控制组件
 * 根据用户权限渲染子组件
 *
 * @example
 * // 基础用法 - 只有管理员可见
 * <Permission roles="admin">
 *   <Button>删除</Button>
 * </Permission>
 *
 * // 禁用模式 - 无权限时显示禁用状态
 * <Permission roles="admin" mode="disabled">
 *   <Button>删除</Button>
 * </Permission>
 */
function Permission({
  roles = [],
  children,
  fallback = null,
  mode = 'hidden',
}: PermissionProps) {
  const { hasPermission } = usePermission()

  // 检查是否有权限
  const hasAuth = hasPermission(roles as RoleCheck)

  // 无权限且模式为隐藏
  if (!hasAuth && mode === 'hidden') {
    return <>{fallback}</>
  }

  // 无权限且模式为禁用
  if (!hasAuth && mode === 'disabled') {
    // 如果是单个子元素，添加 disabled 属性
    if (children && typeof children === 'object' && 'props' in (children as ReactElement)) {
      const child = children as ReactElement<{ disabled?: boolean }>
      return cloneElement(child, { disabled: true })
    }
    return <>{children}</>
  }

  // 有权限，渲染子组件
  return <>{children}</>
}

export default Permission
