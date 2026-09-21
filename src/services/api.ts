import request from './request'
import type {
  AuthResult,
  ChangePasswordForm,
  Comment,
  CommentForm,
  Document,
  DocumentForm,
  DocumentQuery,
  DocumentUploadResult,
  DocumentVersion,
  IndexJob,
  LoginForm,
  PaginatedList,
  PointsRecord,
  PointsRule,
  RankingUser,
  RegisterForm,
  SearchResult,
  UpdateProfileForm,
  User,
  UserStats,
} from '@/types'

// 用户认证相关 API
export const authApi = {
  // 登录
  login: (credentials: LoginForm): Promise<AuthResult> =>
    request.post('/auth/login', credentials),

  // 注册
  register: (data: RegisterForm): Promise<AuthResult> =>
    request.post('/auth/register', data),

  // 获取当前用户信息
  getCurrentUser: (): Promise<Omit<User, 'password'>> => request.get('/auth/me'),

  // 退出登录
  logout: (): Promise<void> => request.post('/auth/logout'),

  // 刷新 token
  refreshToken: (): Promise<{ token: string }> => request.post('/auth/refresh'),

  // 修改密码
  changePassword: (data: ChangePasswordForm): Promise<void> =>
    request.put('/auth/password', data),
}

// 文档相关 API
export const documentApi = {
  // 获取文档列表
  getList: (params: DocumentQuery): Promise<PaginatedList<Document>> =>
    request.get('/documents', { params }),

  // 获取文档详情
  getDetail: (id: number | string): Promise<Document> =>
    request.get(`/documents/${id}`),

  // 创建文档
  create: (data: DocumentForm): Promise<Document> =>
    request.post('/documents', data),

  // 上传 Markdown / TXT / DOCX 文件，服务端解析为文档
  upload: (data: FormData): Promise<DocumentUploadResult> =>
    request.post('/documents/upload', data, {
      headers: { 'Content-Type': 'multipart/form-data' },
      // 文件解析 + 首次入队可能略慢
      timeout: 30000,
    }),

  // 查询文档最近的异步索引任务状态
  getIndexJob: (id: number | string): Promise<IndexJob> =>
    request.get(`/documents/index-jobs/${id}`),

  // 重试失败的索引任务
  retryIndexJob: (id: number | string): Promise<{ jobId: string; status: string }> =>
    request.post(`/documents/index-jobs/${id}/retry`),

  // 更新文档
  update: (id: number | string, data: DocumentForm): Promise<Document> =>
    request.put(`/documents/${id}`, data),

  // 删除文档
  delete: (id: number | string): Promise<void> =>
    request.delete(`/documents/${id}`),

  // 获取文档版本历史
  getVersions: (id: number | string): Promise<DocumentVersion[]> =>
    request.get(`/documents/${id}/versions`),

  // 回滚到指定版本
  rollback: (id: number | string, versionId: number): Promise<void> =>
    request.post(`/documents/${id}/rollback`, { versionId }),

  // 收藏文档
  favorite: (id: number | string): Promise<void> =>
    request.post(`/documents/${id}/favorite`),

  // 取消收藏
  unfavorite: (id: number | string): Promise<void> =>
    request.delete(`/documents/${id}/favorite`),

  // 获取收藏列表
  getFavorites: (params: DocumentQuery): Promise<PaginatedList<Document>> =>
    request.get('/documents/favorites', { params }),

  // 点赞文档
  like: (id: number | string): Promise<void> =>
    request.post(`/documents/${id}/like`),

  // 取消点赞
  unlike: (id: number | string): Promise<void> =>
    request.delete(`/documents/${id}/like`),
}

// 搜索相关 API
export const searchApi = {
  // 搜索文档
  search: (keyword: string, params?: Record<string, unknown>): Promise<SearchResult> =>
    request.get('/search', { params: { q: keyword, ...params } }),

  // 获取推荐文档
  recommend: (params?: Record<string, unknown>): Promise<Document[]> =>
    request.get('/search/recommend', { params }),

  // 获取热门搜索
  getHotSearches: (): Promise<string[]> => request.get('/search/hot'),

  // 获取搜索历史
  getSearchHistory: (): Promise<string[]> => request.get('/search/history'),

  // 清除搜索历史
  clearSearchHistory: (): Promise<void> => request.delete('/search/history'),
}

// 评论相关 API
export const commentApi = {
  // 获取评论列表
  getList: (
    documentId: number | string,
    params?: Record<string, unknown>
  ): Promise<Comment[]> =>
    request.get(`/documents/${documentId}/comments`, { params }),

  // 创建评论
  create: (documentId: number | string, data: CommentForm): Promise<Comment> =>
    request.post(`/documents/${documentId}/comments`, data),

  // 回复评论
  reply: (
    documentId: number | string,
    commentId: number,
    data: CommentForm
  ): Promise<Comment> =>
    request.post(
      `/documents/${documentId}/comments/${commentId}/reply`,
      data
    ),

  // 删除评论
  delete: (documentId: number | string, commentId: number): Promise<void> =>
    request.delete(`/documents/${documentId}/comments/${commentId}`),

  // 点赞评论
  like: (documentId: number | string, commentId: number): Promise<void> =>
    request.post(`/documents/${documentId}/comments/${commentId}/like`),
}

// 积分相关 API
export const pointsApi = {
  // 获取积分排行
  getRanking: (params?: { limit?: number }): Promise<RankingUser[]> =>
    request.get('/points/ranking', { params }),

  // 获取个人积分明细
  getDetail: (
    params?: Record<string, unknown>
  ): Promise<PaginatedList<PointsRecord>> =>
    request.get('/points/detail', { params }),

  // 获取积分规则
  getRules: (): Promise<PointsRule[]> => request.get('/points/rules'),
}

// 用户相关 API
export const userApi = {
  // 获取用户信息
  getProfile: (userId: number | string): Promise<Omit<User, 'password'>> =>
    request.get(`/users/${userId}`),

  // 更新用户信息
  updateProfile: (data: UpdateProfileForm): Promise<Omit<User, 'password'>> =>
    request.put('/users/profile', data),

  // 上传头像
  uploadAvatar: (data: FormData): Promise<{ avatar: string }> =>
    request.post('/users/avatar', data, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  // 获取用户文档列表
  getUserDocuments: (
    userId: number | string,
    params?: DocumentQuery
  ): Promise<PaginatedList<Document>> =>
    request.get(`/users/${userId}/documents`, { params }),

  // 获取用户统计
  getStats: (userId: number | string): Promise<UserStats> =>
    request.get(`/users/${userId}/stats`),
}
