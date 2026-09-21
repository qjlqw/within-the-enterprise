# API 接口文档

## 知识助手接口

以下接口统一使用 Bearer Token，普通响应仍为 `{ code, message, data }`。
跨用户访问会话统一返回 404。知识助手只读取已发布文档，所有角色遵循相同规则。

| 方法 | 路径 | 请求与响应 |
| --- | --- | --- |
| POST | `/api/agent/sessions` | 创建会话，返回 `sessionId`、标题、时间、空消息列表及 `run` |
| GET | `/api/agent/sessions?page=1&pageSize=20` | 当前用户的 `{ list, total }`；pageSize 最大 20 |
| GET | `/api/agent/sessions/:id` | 返回 `messages`、来源校验后的历史、`notice` 和 `run` |
| DELETE | `/api/agent/sessions/:id` | 删除会话并取消正在执行的请求 |
| POST | `/api/agent/sessions/:id/messages` | JSON `{ message, clientMessageId }`，成功返回 SSE |
| POST | `/api/agent/sessions/:id/cancel` | JSON `{ runId }`，幂等取消指定运行；旧 runId 不影响新运行 |

`message` 为 1-4000 字符，`clientMessageId` 为 UUID。消息请求不接受额外字段。
会话上限 20/用户，闲置 24 小时过期；每会话最多提交 200 次，达到后新建会话。
同一用户最多一个运行中请求，每分钟最多提交 10 次。重复 ID 和并发请求返回 409，限额返回 429。
助手未启用、模型配置不完整或总会话容量已满返回 503。鉴权、参数和配置错误在开始写流前返回 JSON。

SSE 使用 `event: <type>` 和 JSON `data: <payload>`，空行分隔。事件字段如下：

| 事件 | 字段 |
| --- | --- |
| start | `runId, sessionId, messageId` |
| tool_start | `toolCallId, name` |
| tool_end | `toolCallId, name, status` |
| token | `messageId, delta` |
| sources | `items: [{ sourceId, documentId, title, version, offset, text, url, ... }]` |
| done | `runId, status: completed/cancelled, usage?` |
| error | `runId, code, message` |

`done` 和 `error` 均是终态；没有终态的 EOF 表示中断，不能当作成功。服务端每 15 秒发送心跳注释。
`usage` 包含模型/工具调用次数、输入/输出 token 和首个正文增量延迟；供应商未返回用量时 token 计数可能为 0。
最终来源 URL 由服务端构造，页面仅在回答完成后显示引用链接。
已更新、撤回或删除的引用会触发历史清空；仅完整回答进入模型上下文。
断流后先 GET 会话状态，再使用新 `clientMessageId` 重试。

部署、模型配置和测试说明见 [知识助手接入与验收](知识助手接入与验收.md)。

## 基本信息

- **Base URL**: `http://localhost:8080/api`
- **开发环境**: `http://localhost:3000` (通过 Vite 代理转发)
- **认证方式**: Bearer Token

## 接口列表

---

### 1. 用户认证

#### 1.1 登录
- **接口**: `POST /api/auth/login`
- **说明**: 用户登录，获取 token
- **请求参数**:
  ```json
  {
    "email": "zhangsan@company.com",
    "password": "123456"
  }
  ```
- **响应示例**:
  ```json
  {
    "code": 200,
    "message": "success",
    "data": {
      "token": "eyJhbGc...",
      "user": {
        "id": 1,
        "name": "张三",
        "email": "zhangsan@company.com",
        "roles": ["admin"],
        "department": "技术部",
        "avatar": "",
        "points": 2580
      }
    }
  }
  ```

#### 1.2 注册
- **接口**: `POST /api/auth/register`
- **说明**: 新用户注册
- **请求参数**:
  ```json
  {
    "name": "新用户",
    "email": "newuser@company.com",
    "password": "123456",
    "department": "技术部"
  }
  ```

#### 1.3 获取当前用户信息
- **接口**: `GET /api/auth/me`
- **说明**: 获取当前登录用户信息
- **Headers**: `Authorization: Bearer <token>`
- **响应示例**:
  ```json
  {
    "code": 200,
    "data": {
      "id": 1,
      "name": "张三",
      "email": "zhangsan@company.com",
      "roles": ["admin"],
      "department": "技术部"
    }
  }
  ```

#### 1.4 退出登录
- **接口**: `POST /api/auth/logout`
- **说明**: 用户退出登录

#### 1.5 刷新 Token
- **接口**: `POST /api/auth/refresh`
- **说明**: 刷新访问令牌

#### 1.6 修改密码
- **接口**: `PUT /api/auth/password`
- **说明**: 修改用户密码
- **请求参数**:
  ```json
  {
    "oldPassword": "123456",
    "newPassword": "new123456"
  }
  ```

---

### 2. 文档管理

#### 2.1 获取文档列表
- **接口**: `GET /api/documents`
- **说明**: 获取文档列表（支持分页、筛选）
- **请求参数**:
  | 参数 | 类型 | 必填 | 说明 |
  |------|------|------|------|
  | page | number | 否 | 页码，默认 1 |
  | pageSize | number | 否 | 每页数量，默认 10 |
  | category | string | 否 | 分类筛选 |
  | keyword | string | 否 | 关键词搜索 |

- **响应示例**:
  ```json
  {
    "code": 200,
    "data": {
      "list": [
        {
          "id": 1,
          "title": "React 入门教程",
          "authorId": 1,
          "authorName": "张三",
          "category": "技术文档",
          "tags": ["React", "前端", "教程"],
          "status": "published",
          "views": 128,
          "likes": 23,
          "favorites": 15,
          "version": 3,
          "createdAt": "2025-02-15 10:00:00",
          "updatedAt": "2025-03-01 14:30:00"
        }
      ],
      "total": 50
    }
  }
  ```

#### 2.2 获取文档详情
- **接口**: `GET /api/documents/:id`
- **说明**: 获取单个文档详情

#### 2.3 创建文档
- **接口**: `POST /api/documents`
- **说明**: 创建新文档
- **请求参数**:
  ```json
  {
    "title": "新文档标题",
    "content": "# 文档内容\n\n支持 Markdown",
    "category": "技术文档",
    "tags": ["标签 1", "标签 2"],
    "status": "draft"
  }
  ```

#### 2.4 更新文档
- **接口**: `PUT /api/documents/:id`
- **说明**: 更新文档内容

#### 2.5 删除文档
- **接口**: `DELETE /api/documents/:id`
- **说明**: 删除指定文档

#### 2.6 获取文档版本历史
- **接口**: `GET /api/documents/:id/versions`
- **说明**: 获取文档的版本历史

#### 2.7 回滚到指定版本
- **接口**: `POST /api/documents/:id/rollback`
- **说明**: 回滚文档到指定版本
- **请求参数**:
  ```json
  {
    "versionId": 1
  }
  ```

#### 2.8 收藏/取消收藏文档
- **接口**: `POST /api/documents/:id/favorite`
- **接口**: `DELETE /api/documents/:id/favorite`

#### 2.9 获取收藏列表
- **接口**: `GET /api/documents/favorites`

#### 2.10 点赞/取消点赞文档
- **接口**: `POST /api/documents/:id/like`
- **接口**: `DELETE /api/documents/:id/like`

---

### 3. 搜索

#### 3.1 搜索文档
- **接口**: `GET /api/search`
- **说明**: 搜索文档
- **请求参数**:
  | 参数 | 类型 | 必填 | 说明 |
  |------|------|------|------|
  | q | string | 是 | 搜索关键词 |
  | page | number | 否 | 页码 |
  | pageSize | number | 否 | 每页数量 |

- **响应示例**:
  ```json
  {
    "code": 200,
    "data": {
      "list": [...],
      "total": 10,
      "highlight": "React"
    }
  }
  ```

#### 3.2 获取推荐文档
- **接口**: `GET /api/search/recommend`

#### 3.3 获取热门搜索
- **接口**: `GET /api/search/hot`
- **响应示例**:
  ```json
  {
    "code": 200,
    "data": ["React", "Elasticsearch", "项目规范", "API 文档", "入职指南"]
  }
  ```

#### 3.4 获取/清除搜索历史
- **接口**: `GET /api/search/history`
- **接口**: `DELETE /api/search/history`

---

### 4. 评论

#### 4.1 获取评论列表
- **接口**: `GET /api/documents/:documentId/comments`
- **请求参数**:
  | 参数 | 类型 | 必填 | 说明 |
  |------|------|------|------|
  | page | number | 否 | 页码 |
  | pageSize | number | 否 | 每页数量 |

#### 4.2 创建评论
- **接口**: `POST /api/documents/:documentId/comments`
- **请求参数**:
  ```json
  {
    "content": "这是一条评论"
  }
  ```

#### 4.3 回复评论
- **接口**: `POST /api/documents/:documentId/comments/:commentId/reply`

#### 4.4 删除评论
- **接口**: `DELETE /api/documents/:documentId/comments/:commentId`

#### 4.5 点赞评论
- **接口**: `POST /api/documents/:documentId/comments/:commentId/like`

---

### 5. 积分

#### 5.1 获取积分排行
- **接口**: `GET /api/points/ranking`
- **请求参数**:
  | 参数 | 类型 | 必填 | 说明 |
  |------|------|------|------|
  | limit | number | 否 | 返回数量，默认 10 |

#### 5.2 获取个人积分明细
- **接口**: `GET /api/points/detail`

#### 5.3 获取积分规则
- **接口**: `GET /api/points/rules`
- **响应示例**:
  ```json
  {
    "code": 200,
    "data": [
      { "type": "publish", "name": "发布文档", "points": 10, "dailyLimit": 50 },
      { "type": "like", "name": "文档被点赞", "points": 1, "dailyLimit": 20 },
      { "type": "favorite", "name": "文档被收藏", "points": 2, "dailyLimit": 20 },
      { "type": "comment", "name": "发布评论", "points": 1, "dailyLimit": 10 }
    ]
  }
  ```

---

### 6. 用户

#### 6.1 获取用户信息
- **接口**: `GET /api/users/:userId`

#### 6.2 更新用户信息
- **接口**: `PUT /api/users/profile`
- **请求参数**:
  ```json
  {
    "name": "新名字",
    "department": "新部门"
  }
  ```

#### 6.3 上传头像
- **接口**: `POST /api/users/avatar`
- **Content-Type**: `multipart/form-data`

#### 6.4 获取用户文档列表
- **接口**: `GET /api/users/:userId/documents`

#### 6.5 获取用户统计
- **接口**: `GET /api/users/:userId/stats`
- **响应示例**:
  ```json
  {
    "code": 200,
    "data": {
      "documents": 10,
      "likes": 150,
      "favorites": 80,
      "views": 2000
    }
  }
  ```

---

## 统一响应格式

```json
{
  "code": 200,      // 状态码，200 表示成功
  "message": "success",  // 消息提示
  "data": {}        // 响应数据
}
```

## 错误码说明

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 401 | 未登录或登录已过期 |
| 403 | 没有权限访问该资源 |
| 404 | 请求的资源不存在 |
| 500 | 服务器错误 |

## 联调说明

1. **启动开发服务器**: `npm run dev`
2. **代理配置**: 所有 `/api` 请求会自动转发到 `http://localhost:8080`
3. **修改后端地址**: 如需连接其他环境，请修改 `.env` 中的 `VITE_API_BASE_URL`
