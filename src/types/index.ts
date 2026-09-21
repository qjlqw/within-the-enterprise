// 全局共享类型定义

/** 用户角色 */
export type UserRole = 'admin' | 'editor' | 'user'

/** 文档状态 */
export type DocumentStatus = 'draft' | 'published'

/** 积分变动类型 */
export type PointsType = 'publish' | 'like' | 'favorite' | 'comment'

/** 通用 API 响应结构（真实后端返回体） */
export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

/** 分页请求参数 */
export interface PaginationParams {
  page?: number
  pageSize?: number
  keyword?: string
  category?: string
}

/** 分页列表响应 */
export interface PaginatedList<T> {
  list: T[]
  total: number
}

/** 用户信息 */
export interface User {
  id: number
  name: string
  email: string
  password?: string
  roles: UserRole[]
  department?: string
  avatar?: string
  points?: number
}

/** 登录/注册返回 */
export interface AuthResult {
  token: string
  user: Omit<User, 'password'>
}

/** 登录表单 */
export interface LoginForm {
  email: string
  password: string
}

/** 注册表单 */
export interface RegisterForm extends LoginForm {
  name: string
}

/** 修改密码表单 */
export interface ChangePasswordForm {
  oldPassword: string
  newPassword: string
  confirmPassword?: string
}

/** 文档 */
export interface Document {
  id: number
  title: string
  content: string
  authorId: number
  authorName: string
  category: string
  tags: string[]
  status: DocumentStatus
  views: number
  likes: number
  favorites: number
  version: number
  createdAt: string
  updatedAt: string
}

/** 创建/更新文档载荷 */
export interface DocumentForm {
  title: string
  category: string
  tags?: string[]
  status: DocumentStatus
  content: string
}

/** 文档查询参数 */
export interface DocumentQuery extends PaginationParams {
  sortBy?: string
}

/** 文件上传解析结果 */
export interface DocumentUploadResult {
  doc: Document
  indexJob: { jobId: string; status: string } | null
  warnings: string[]
}

/** 文档异步索引任务状态 */
export interface IndexJob {
  jobId?: string
  docId?: number
  status: 'pending' | 'processing' | 'waiting' | 'retrying' | 'done' | 'failed' | 'none'
  attempts?: number
  indexed?: number
  lastError?: string | null
  updatedAt?: string
}

/** 文档版本 */
export interface DocumentVersion {
  id: number
  version: number
  updatedAt: string
  authorName: string
}

/** 评论 */
export interface Comment {
  id: number
  documentId: number
  userId: number
  userName: string
  content: string
  likes: number
  replies: Comment[]
  createdAt: string
}

/** 创建评论载荷 */
export interface CommentForm {
  content: string
}

/** 搜索结果 */
export interface SearchResult {
  list: Document[]
  total: number
  highlight?: string
}

/** 积分记录 */
export interface PointsRecord {
  id: number
  userId: number
  type: PointsType
  points: number
  description: string
  createdAt: string
}

/** 积分规则 */
export interface PointsRule {
  type: PointsType
  name: string
  points: number
  dailyLimit: number
}

/** 排行榜用户 */
export interface RankingUser extends User {
  rank: number
}

/** 用户统计 */
export interface UserStats {
  documents: number
  likes: number
  favorites: number
  views: number
}

/** 更新个人资料载荷 */
export interface UpdateProfileForm {
  name?: string
  department?: string
  avatar?: string
}
