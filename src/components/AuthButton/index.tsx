import { Button, type ButtonProps } from 'antd'
import { usePermission } from '@/hooks/usePermission'
import type { UserRole } from '@/types'
import type { ReactNode } from 'react'

type RoleCheck = UserRole | UserRole[]
type AuthMode = 'hidden' | 'disabled'

interface AuthButtonProps extends Omit<ButtonProps, 'onClick'> {
  /** 允许的角色列表 */
  roles?: RoleCheck
  /** 按钮内容 */
  children?: ReactNode
  /** 权限不足时的模式：'hidden'隐藏 / 'disabled'禁用 */
  mode?: AuthMode
  /** 无权限时显示的内容（可选） */
  fallback?: ReactNode
  /** 点击事件 */
  onClick?: React.MouseEventHandler<HTMLElement>
}

/**
 * 权限按钮组件
 * 根据用户权限控制按钮的显示/禁用状态
 *
 * @example
 * // 基础用法 - 只有管理员可见
 * <AuthButton roles="admin">删除</AuthButton>
 *
 * // 多个角色 - 管理员或编辑者可见
 * <AuthButton roles={['admin', 'editor']}>编辑</AuthButton>
 *
 * // 禁用模式 - 无权限时按钮禁用
 * <AuthButton roles="admin" mode="disabled">删除</AuthButton>
 */
function AuthButton({
  roles = [],
  children,
  mode = 'hidden',
  fallback,
  onClick,
  ...rest
}: AuthButtonProps) {
  const { hasPermission } = usePermission()

  // 检查是否有权限
  const hasAuth = hasPermission(roles as RoleCheck)

  // 无权限且模式为隐藏
  if (!hasAuth && mode === 'hidden') {
    return <>{fallback ?? null}</>
  }

  // 无权限且模式为禁用
  if (!hasAuth && mode === 'disabled') {
    return (
      <Button disabled {...rest}>
        {children ?? '无权限'}
      </Button>
    )
  }

  // 有权限，渲染正常按钮
  return (
    <Button onClick={onClick} {...rest}>
      {children}
    </Button>
  )
}

export default AuthButton
