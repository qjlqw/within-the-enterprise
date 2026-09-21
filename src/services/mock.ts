// Mock 数据服务 - 用于开发和演示
import type {
  AuthResult,
  Comment,
  CommentForm,
  Document,
  DocumentForm,
  DocumentQuery,
  DocumentVersion,
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

// 模拟用户数据
const mockUsers: (User & { password: string })[] = [
  { id: 1, name: '张三', email: 'zhangsan@company.com', password: '123456', roles: ['admin'], department: '技术部', avatar: '', points: 2580 },
  { id: 2, name: '李四', email: 'lisi@company.com', password: '123456', roles: ['user'], department: '产品部', avatar: '', points: 2180 },
  { id: 3, name: '王五', email: 'wangwu@company.com', password: '123456', roles: ['user'], department: '技术部', avatar: '', points: 1950 },
  { id: 4, name: '赵六', email: 'zhaoliu@company.com', password: '123456', roles: ['editor'], department: '运营部', avatar: '', points: 1680 },
]

// 模拟文档数据
const mockDocuments: Document[] = [
  {
    id: 1,
    title: 'React 入门教程',
    content:
      '# React 入门教程\n\n## 一、React 简介\n\nReact 是一个用于构建用户界面的 JavaScript 库。\n\n## 二、核心概念\n\n### 1. 组件\n\n组件是 React 的基本构建单元。\n\n### 2. Props\n\nProps 是组件之间传递数据的方式。\n\n### 3. State\n\nState 是组件内部的状态管理。',
    authorId: 1,
    authorName: '张三',
    category: '技术文档',
    tags: ['React', '前端', '教程'],
    status: 'published',
    views: 128,
    likes: 23,
    favorites: 15,
    version: 3,
    createdAt: '2025-02-15 10:00:00',
    updatedAt: '2025-03-01 14:30:00',
  },
  {
    id: 2,
    title: '项目规范文档',
    content:
      '# 项目规范文档\n\n## 一、代码规范\n\n### 1. 命名规范\n- 变量使用小驼峰\n- 组件使用大驼峰\n- 常量使用大写 + 下划线\n\n## 二、Git 规范\n\n- feat: 新功能\n- fix: 修复 bug\n- docs: 文档更新',
    authorId: 2,
    authorName: '李四',
    category: '规范',
    tags: ['规范', '团队'],
    status: 'published',
    views: 89,
    likes: 12,
    favorites: 8,
    version: 2,
    createdAt: '2025-02-20 09:00:00',
    updatedAt: '2025-02-28 16:00:00',
  },
  {
    id: 3,
    title: 'API 接口文档',
    content:
      '# API 接口文档\n\n## 接口列表\n\n### 1. 用户认证\n- POST /api/auth/login\n- POST /api/auth/register\n- POST /api/auth/logout\n\n### 2. 文档管理\n- GET /api/documents\n- POST /api/documents\n- PUT /api/documents/:id\n- DELETE /api/documents/:id',
    authorId: 3,
    authorName: '王五',
    category: '技术文档',
    tags: ['API', '后端'],
    status: 'draft',
    views: 56,
    likes: 8,
    favorites: 3,
    version: 1,
    createdAt: '2025-02-25 14:00:00',
    updatedAt: '2025-02-27 11:00:00',
  },
  {
    id: 4,
    title: '新员工入职指南',
    content:
      '# 新员工入职指南\n\n## 一、入职准备\n\n1. 准备入职材料\n2. 领取办公设备\n3. 开通系统账号\n\n## 二、熟悉环境\n\n1. 了解公司文化\n2. 熟悉团队成员\n3. 了解工作流程\n\n## 三、培训内容\n\n1. 产品培训\n2. 技术培训\n3. 安全培训',
    authorId: 4,
    authorName: '赵六',
    category: '培训',
    tags: ['入职', '培训'],
    status: 'published',
    views: 234,
    likes: 45,
    favorites: 28,
    version: 5,
    createdAt: '2025-01-10 08:00:00',
    updatedAt: '2025-02-26 10:00:00',
  },
  {
    id: 5,
    title: 'Elasticsearch 实战指南',
    content:
      '# Elasticsearch 实战指南\n\n## 一、Elasticsearch 简介\n\nElasticsearch 是一个分布式搜索和分析引擎。\n\n## 二、核心概念\n\n### 1. 索引 (Index)\n\n索引是具有相似特征的文档集合。\n\n### 2. 文档 (Document)\n\n文档是 Elasticsearch 中的基本信息单位。\n\n### 3. 映射 (Mapping)\n\n映射定义了索引中字段的数据类型。',
    authorId: 1,
    authorName: '张三',
    category: '技术文档',
    tags: ['Elasticsearch', '搜索', '后端'],
    status: 'published',
    views: 176,
    likes: 32,
    favorites: 21,
    version: 2,
    createdAt: '2025-02-10 11:00:00',
    updatedAt: '2025-02-25 15:30:00',
  },
]

// 模拟评论数据
const mockComments: Comment[] = [
  { id: 1, documentId: 1, userId: 2, userName: '李四', content: '很详细的教程，学习了！', likes: 5, replies: [], createdAt: '2025-02-16 10:00:00' },
  { id: 2, documentId: 1, userId: 3, userName: '王五', content: '对新手很友好，赞！', likes: 3, replies: [{ id: 3, documentId: 1, userId: 1, userName: '张三', content: '谢谢支持！', likes: 0, replies: [], createdAt: '2025-02-16 11:00:00' }], createdAt: '2025-02-17 14:00:00' },
  { id: 4, documentId: 1, userId: 4, userName: '赵六', content: '希望能出更多 React 相关的教程', likes: 8, replies: [], createdAt: '2025-02-18 09:00:00' },
]

// 模拟积分记录
const mockPointsRecords: PointsRecord[] = [
  { id: 1, userId: 1, type: 'publish', points: 10, description: '发布文档《React 入门教程》', createdAt: '2025-02-15 10:00:00' },
  { id: 2, userId: 1, type: 'like', points: 1, description: '文档被点赞', createdAt: '2025-02-16 10:00:00' },
  { id: 3, userId: 2, type: 'publish', points: 10, description: '发布文档《项目规范文档》', createdAt: '2025-02-20 09:00:00' },
  { id: 4, userId: 1, type: 'favorite', points: 2, description: '文档被收藏', createdAt: '2025-02-21 14:00:00' },
]

// 积分规则
const pointsRules: PointsRule[] = [
  { type: 'publish', name: '发布文档', points: 10, dailyLimit: 50 },
  { type: 'like', name: '文档被点赞', points: 1, dailyLimit: 20 },
  { type: 'favorite', name: '文档被收藏', points: 2, dailyLimit: 20 },
  { type: 'comment', name: '发布评论', points: 1, dailyLimit: 10 },
]

// 热门搜索历史（内存保存）
let mockHotSearches: string[] = ['React', 'Elasticsearch', '项目规范', 'API 文档', '入职指南']
let mockSearchHistory: string[] = []

// 辅助函数
const delay = (ms = 500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const generateToken = (): string =>
  Math.random().toString(36).substring(2) + Date.now().toString(36)

const toNumberId = (id: number | string): number => parseInt(String(id), 10)

const stripPassword = (user: User & { password: string }): Omit<User, 'password'> => {
  const { password: _password, ...rest } = user
  return rest
}

// Mock 接口错误
const buildError = (status: number, message: string): { response: { status: number; data: { message: string } } } => ({
  response: { status, data: { message } },
})

// Mock API 实现
export const mockApi = {
  // 认证相关
  auth: {
    login: async ({ email, password }: LoginForm): Promise<AuthResult> => {
      await delay()
      const user = mockUsers.find((u) => u.email === email && u.password === password)
      if (!user) {
        throw buildError(401, '邮箱或密码错误')
      }
      return { token: generateToken(), user: stripPassword(user) }
    },

    register: async (data: RegisterForm): Promise<AuthResult> => {
      await delay()
      const newUser: User & { password: string } = {
        id: mockUsers.length + 1,
        name: data.name,
        email: data.email,
        password: data.password,
        roles: ['user'],
        points: 0,
        avatar: '',
        department: '',
      }
      mockUsers.push(newUser)
      return { token: generateToken(), user: stripPassword(newUser) }
    },

    getCurrentUser: async (): Promise<Omit<User, 'password'>> => {
      await delay()
      // 模拟返回第一个用户
      return stripPassword(mockUsers[0])
    },

    logout: async (): Promise<void> => {
      await delay(100)
    },
  },

  // 文档相关
  documents: {
    getList: async (params: DocumentQuery = {}): Promise<PaginatedList<Document>> => {
      await delay()
      const { page = 1, pageSize = 10, category, keyword } = params
      let filtered: Document[] = [...mockDocuments]

      if (category) {
        filtered = filtered.filter((d) => d.category === category)
      }
      if (keyword) {
        const kw = keyword.toLowerCase()
        filtered = filtered.filter(
          (d) =>
            d.title.toLowerCase().includes(kw) ||
            d.content.toLowerCase().includes(kw)
        )
      }

      const start = (page - 1) * pageSize
      const end = start + pageSize
      return {
        list: filtered.slice(start, end),
        total: filtered.length,
      }
    },

    getDetail: async (id: number | string): Promise<Document> => {
      await delay()
      const doc = mockDocuments.find((d) => d.id === toNumberId(id))
      if (!doc) {
        throw buildError(404, '文档不存在')
      }
      // 增加浏览量
      doc.views += 1
      return doc
    },

    create: async (data: DocumentForm): Promise<Document> => {
      await delay()
      const newDoc: Document = {
        id: mockDocuments.length + 1,
        title: data.title,
        content: data.content,
        authorId: 1,
        authorName: '张三',
        category: data.category,
        tags: data.tags ?? [],
        status: data.status || 'draft',
        views: 0,
        likes: 0,
        favorites: 0,
        version: 1,
        createdAt: new Date().toLocaleString('zh-CN'),
        updatedAt: new Date().toLocaleString('zh-CN'),
      }
      mockDocuments.push(newDoc)
      return newDoc
    },

    update: async (id: number | string, data: DocumentForm): Promise<Document> => {
      await delay()
      const index = mockDocuments.findIndex((d) => d.id === toNumberId(id))
      if (index === -1) {
        throw buildError(404, '文档不存在')
      }
      const current = mockDocuments[index]
      mockDocuments[index] = {
        ...current,
        ...data,
        version: current.version + 1,
        updatedAt: new Date().toLocaleString('zh-CN'),
      }
      return mockDocuments[index]
    },

    delete: async (id: number | string): Promise<void> => {
      await delay()
      const index = mockDocuments.findIndex((d) => d.id === toNumberId(id))
      if (index === -1) {
        throw buildError(404, '文档不存在')
      }
      mockDocuments.splice(index, 1)
    },

    getVersions: async (id: number | string): Promise<DocumentVersion[]> => {
      await delay()
      const doc = mockDocuments.find((d) => d.id === toNumberId(id))
      if (!doc) {
        throw buildError(404, '文档不存在')
      }
      // 模拟版本历史
      return Array.from({ length: doc.version }, (_, i) => ({
        id: i + 1,
        version: i + 1,
        updatedAt: new Date(Date.now() - i * 86400000).toLocaleString('zh-CN'),
        authorName: doc.authorName,
      }))
    },

    like: async (id: number | string): Promise<void> => {
      await delay()
      const doc = mockDocuments.find((d) => d.id === toNumberId(id))
      if (!doc) {
        throw buildError(404, '文档不存在')
      }
      doc.likes += 1
    },

    unlike: async (id: number | string): Promise<void> => {
      await delay()
      const doc = mockDocuments.find((d) => d.id === toNumberId(id))
      if (!doc) {
        throw buildError(404, '文档不存在')
      }
      doc.likes = Math.max(0, doc.likes - 1)
    },

    favorite: async (id: number | string): Promise<void> => {
      await delay()
      const doc = mockDocuments.find((d) => d.id === toNumberId(id))
      if (!doc) {
        throw buildError(404, '文档不存在')
      }
      doc.favorites += 1
    },

    unfavorite: async (id: number | string): Promise<void> => {
      await delay()
      const doc = mockDocuments.find((d) => d.id === toNumberId(id))
      if (!doc) {
        throw buildError(404, '文档不存在')
      }
      doc.favorites = Math.max(0, doc.favorites - 1)
    },

    getFavorites: async (params: DocumentQuery = {}): Promise<PaginatedList<Document>> => {
      await delay()
      // 模拟返回点赞/收藏数较高的文档作为收藏列表
      const { page = 1, pageSize = 10 } = params
      const filtered = [...mockDocuments].sort((a, b) => b.favorites - a.favorites)
      const start = (page - 1) * pageSize
      return {
        list: filtered.slice(start, start + pageSize),
        total: filtered.length,
      }
    },
  },

  // 搜索相关
  search: {
    search: async (keyword: string): Promise<SearchResult> => {
      await delay(300)
      const kw = keyword.toLowerCase()
      const results = mockDocuments.filter(
        (d) =>
          d.title.toLowerCase().includes(kw) ||
          d.content.toLowerCase().includes(kw) ||
          d.tags.some((t) => t.toLowerCase().includes(kw))
      )
      // 记录到历史
      if (keyword && !mockSearchHistory.includes(keyword)) {
        mockSearchHistory = [keyword, ...mockSearchHistory].slice(0, 10)
      }
      return {
        list: results,
        total: results.length,
        highlight: keyword,
      }
    },

    recommend: async (): Promise<Document[]> => {
      await delay()
      // 返回点赞最多的文档
      return [...mockDocuments].sort((a, b) => b.likes - a.likes).slice(0, 5)
    },

    getHotSearches: async (): Promise<string[]> => {
      await delay(100)
      return [...mockHotSearches]
    },

    getSearchHistory: async (): Promise<string[]> => {
      await delay(100)
      return [...mockSearchHistory]
    },

    clearSearchHistory: async (): Promise<void> => {
      await delay(100)
      mockSearchHistory = []
    },
  },

  // 评论相关
  comments: {
    getList: async (documentId: number | string): Promise<Comment[]> => {
      await delay()
      return mockComments.filter((c) => c.documentId === toNumberId(documentId))
    },

    create: async (
      documentId: number | string,
      data: CommentForm
    ): Promise<Comment> => {
      await delay()
      const newComment: Comment = {
        id: mockComments.length + 1,
        documentId: toNumberId(documentId),
        userId: 1,
        userName: '张三',
        content: data.content,
        likes: 0,
        replies: [],
        createdAt: new Date().toLocaleString('zh-CN'),
      }
      mockComments.push(newComment)
      return newComment
    },

    reply: async (
      documentId: number | string,
      commentId: number,
      data: CommentForm
    ): Promise<Comment> => {
      await delay()
      const parent = mockComments.find(
        (c) => c.documentId === toNumberId(documentId) && c.id === commentId
      )
      if (!parent) {
        throw buildError(404, '评论不存在')
      }
      const reply: Comment = {
        id: mockComments.length + 1,
        documentId: toNumberId(documentId),
        userId: 1,
        userName: '张三',
        content: data.content,
        likes: 0,
        replies: [],
        createdAt: new Date().toLocaleString('zh-CN'),
      }
      parent.replies.push(reply)
      return reply
    },

    delete: async (
      documentId: number | string,
      commentId: number
    ): Promise<void> => {
      await delay()
      const index = mockComments.findIndex(
        (c) => c.documentId === toNumberId(documentId) && c.id === commentId
      )
      if (index === -1) {
        throw buildError(404, '评论不存在')
      }
      mockComments.splice(index, 1)
    },

    like: async (
      documentId: number | string,
      commentId: number
    ): Promise<void> => {
      await delay()
      const comment = mockComments.find(
        (c) => c.documentId === toNumberId(documentId) && c.id === commentId
      )
      if (!comment) {
        throw buildError(404, '评论不存在')
      }
      comment.likes += 1
    },
  },

  // 积分相关
  points: {
    getRanking: async (params: { limit?: number } = {}): Promise<RankingUser[]> => {
      await delay()
      const { limit = 10 } = params
      return [...mockUsers]
        .sort((a, b) => (b.points || 0) - (a.points || 0))
        .slice(0, limit)
        .map((u, i) => ({ ...stripPassword(u), rank: i + 1 }))
    },

    getDetail: async (): Promise<PaginatedList<PointsRecord>> => {
      await delay()
      const list = mockPointsRecords.filter((r) => r.userId === 1)
      return {
        list,
        total: list.length,
      }
    },

    getRules: async (): Promise<PointsRule[]> => {
      await delay(100)
      return [...pointsRules]
    },
  },

  // 用户相关
  users: {
    getProfile: async (userId: number | string): Promise<Omit<User, 'password'>> => {
      await delay()
      const user = mockUsers.find((u) => u.id === toNumberId(userId))
      if (!user) {
        throw buildError(404, '用户不存在')
      }
      return stripPassword(user)
    },

    updateProfile: async (data: UpdateProfileForm): Promise<Omit<User, 'password'>> => {
      await delay()
      const user = mockUsers[0]
      Object.assign(user, data)
      return stripPassword(user)
    },

    uploadAvatar: async (_data: FormData): Promise<{ avatar: string }> => {
      await delay()
      return { avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${Date.now()}` }
    },

    getUserDocuments: async (
      userId: number | string,
      params: DocumentQuery = {}
    ): Promise<PaginatedList<Document>> => {
      await delay()
      const { page = 1, pageSize = 10 } = params
      const filtered = mockDocuments.filter((d) => d.authorId === toNumberId(userId))
      const start = (page - 1) * pageSize
      return {
        list: filtered.slice(start, start + pageSize),
        total: filtered.length,
      }
    },

    getStats: async (userId: number | string): Promise<UserStats> => {
      await delay()
      const userDocs = mockDocuments.filter((d) => d.authorId === toNumberId(userId))
      return {
        documents: userDocs.length,
        likes: userDocs.reduce((sum, d) => sum + d.likes, 0),
        favorites: userDocs.reduce((sum, d) => sum + d.favorites, 0),
        views: userDocs.reduce((sum, d) => sum + d.views, 0),
      }
    },
  },
}
