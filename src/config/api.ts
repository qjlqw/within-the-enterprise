// 全局配置 - 接口模式切换
// true: 使用 Mock 数据
// false: 使用真实后端 API
export const USE_MOCK = false

// 后端 API 地址
export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080/api'
