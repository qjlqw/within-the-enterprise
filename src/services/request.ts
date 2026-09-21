import axios, {
  AxiosError,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios'
import { message } from 'antd'
import { useUserStore } from '@/store/userStore'
import type { ApiResponse } from '@/types'

// 创建 axios 实例
const request = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 10000,
})

// 请求拦截器
request.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = useUserStore.getState().token
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error: unknown) => {
    return Promise.reject(error)
  }
)

// 响应拦截器：拆分数据并返回业务数据
request.interceptors.response.use(
  (response: AxiosResponse<ApiResponse>) => {
    const payload = response.data
    if (payload.code !== 200) {
      message.error(payload.message || '请求失败')
      return Promise.reject(new Error(payload.message || '请求失败'))
    }
    // 通过类型断言把业务数据回传给调用方
    return payload.data as unknown as AxiosResponse
  },
  (error: AxiosError<ApiResponse>) => {
    if (error.response) {
      const { status, data } = error.response
      switch (status) {
        case 401:
          if (error.config?.headers?.Authorization !== `Bearer ${useUserStore.getState().token}`) break
          message.error('未登录或登录已过期')
          useUserStore.getState().logout()
          setTimeout(() => {
            if (!useUserStore.getState().token) window.location.href = '/login'
          }, 1000)
          break
        case 403:
          message.error('没有权限访问该资源')
          break
        case 404:
          message.error('请求的资源不存在')
          break
        case 500:
          message.error('服务器错误')
          break
        default:
          message.error(data?.message || '请求失败，请稍后重试')
      }
    } else {
      message.error('网络错误，请检查网络连接')
    }
    return Promise.reject(error)
  }
)

// 提供泛型方法签名，方便调用处拿到具体类型
export interface TypedRequest {
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>
  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>
  delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>
}

export default request as unknown as TypedRequest & typeof axios
