import { Input } from 'antd'
import type { InputProps } from 'antd'

const { Search } = Input

interface SearchBarProps extends Omit<InputProps, 'onSearch'> {
  /** 搜索回调 */
  onSearch?: (value: string) => void
  /** 占位符 */
  placeholder?: string
  /** 默认值 */
  defaultValue?: string
  /** 宽度 */
  width?: number | string
}

/**
 * 搜索栏组件
 */
function SearchBar({
  onSearch,
  placeholder = '搜索...',
  defaultValue = '',
  width = 300,
  style,
  ...rest
}: SearchBarProps) {
  return (
    <Search
      placeholder={placeholder}
      defaultValue={defaultValue}
      onSearch={onSearch}
      style={{ width, ...style }}
      allowClear
      {...rest}
    />
  )
}

export default SearchBar
