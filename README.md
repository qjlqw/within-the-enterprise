# 企业内部知识库系统

> 企业知识库平台，支持 Markdown 文档、版本管理、关键词检索和知识助手。当前后端使用内存数据，未接入 Elasticsearch。

## 知识助手

登录后进入 `/agent`，支持已发布文档问答、摘要、对比、多轮会话、来源引用和停止生成。
后端通过 LangChain.js 接入通义千问兼容接口，默认关闭；在 `server/.env` 中配置模型后启用。
完整配置、接口、验证命令和演示限制见 [知识助手接入与验收](docs/知识助手接入与验收.md)。

## 📋 项目信息

- **项目名称**: 企业内部知识库系统
- **开发时间**: 2025.01 - 2025.03
- **技术栈**: React、Ant Design、Markdown 编辑器、Elasticsearch

## ✨ 功能特性

### 📄 文档管理
- ✅ 文档创建、编辑、删除
- ✅ Markdown 富文本编辑
- ✅ 文档分类与标签
- ✅ 版本管理（历史版本查看）
- ✅ 草稿/发布状态管理
- ✅ 文档浏览统计

### 🔍 全文搜索
- ✅ 关键词搜索（标题、内容、标签）
- ✅ 搜索结果高亮
- ✅ 热门搜索推荐
- ✅ 智能文档推荐
- ✅ 搜索用时显示

### 💬 评论互动
- ✅ 文档评论
- ✅ 评论点赞
- ✅ 评论回复
- ✅ 评论删除

### 🏆 积分体系
- ✅ 积分规则（发布、点赞、收藏、评论）
- ✅ 积分排行榜（Top 10）
- ✅ 个人积分明细
- ✅ 每日积分上限

### 👤 用户系统
- ✅ 用户登录/注册
- ✅ 个人信息管理
- ✅ 头像上传
- ✅ 用户统计（文档数、获赞数等）

### 🔐 权限控制
- ✅ 角色管理（admin、editor、user）
- ✅ 路由守卫
- ✅ 文档操作权限（仅作者/管理员可编辑删除）

## 🛠️ 技术栈

| 类型 | 技术 | 版本 |
|------|------|------|
| **框架** | React | 19.x |
| **UI 组件** | Ant Design | 6.x |
| **路由** | React Router | 7.x |
| **构建工具** | Vite | 7.x |
| **图标** | @ant-design/icons | 6.x |
| **Markdown 编辑器** | @uiw/react-md-editor | latest |
| **HTTP 客户端** | Axios | latest |
| **状态管理** | Zustand | latest |
| **日期处理** | Day.js | latest |

## 📦 快速开始

### 环境要求

- Node.js 22 LTS（>= 22.12，已验证 22.23.2）
- npm >= 9.x

### 安装依赖

```bash
npm install
npm --prefix server install
```

### 启动开发服务器

```bash
npm run dev
```

另一个终端运行 `npm --prefix server run dev`，后端默认监听 8080。模型密钥只配置在 `server/.env`，不能放入 `VITE_*` 环境变量。

访问 http://localhost:3000

**演示账号**: 
- 邮箱：zhangsan@company.com
- 密码：123456

### 构建生产版本

```bash
npm run build
```

### 预览生产构建

```bash
npm run preview
```

## 📁 项目结构

```
Stady/
├── public/                 # 静态资源
├── src/
│   ├── assets/            # 图片、字体等资源
│   ├── components/        # 公共组件
│   │   ├── AuthGuard/     # 认证守卫组件
│   │   ├── DeleteConfirm/ # 删除确认组件
│   │   ├── SearchBar/     # 搜索栏组件
│   │   └── Permission/    # 权限控制组件
│   ├── config/            # 配置文件
│   ├── hooks/             # 自定义 Hooks
│   │   ├── useAuth.js     # 认证 Hook
│   │   └── useDocument.js # 文档列表 Hook
│   ├── layouts/           # 布局组件
│   │   └── BasicLayout.jsx # 基础布局
│   ├── pages/             # 页面组件
│   │   ├── Login/         # 登录/注册页
│   │   ├── document/      # 文档相关页面
│   │   │   ├── List.jsx   # 文档列表
│   │   │   ├── Detail.jsx # 文档详情
│   │   │   └── Editor.jsx # 文档编辑
│   │   ├── search/        # 搜索页面
│   │   ├── profile/       # 个人中心
│   │   ├── points/        # 积分排行
│   │   └── comment/       # 评论组件
│   ├── services/          # API 服务
│   │   ├── request.js     # Axios 封装
│   │   ├── api.js         # API 接口定义
│   │   └── mock.js        # Mock 数据服务
│   ├── store/             # 状态管理
│   │   └── userStore.js   # 用户状态
│   ├── styles/            # 样式文件
│   ├── utils/             # 工具函数
│   ├── App.jsx            # 应用入口
│   └── main.jsx           # 入口文件
├── index.html
├── vite.config.js
├── package.json
└── README.md
```

## 🔌 API 接口

### 认证接口
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/register` - 用户注册
- `GET /api/auth/me` - 获取当前用户
- `POST /api/auth/logout` - 退出登录

### 文档接口
- `GET /api/documents` - 获取文档列表
- `GET /api/documents/:id` - 获取文档详情
- `POST /api/documents` - 创建文档
- `PUT /api/documents/:id` - 更新文档
- `DELETE /api/documents/:id` - 删除文档
- `GET /api/documents/:id/versions` - 获取版本历史
- `POST /api/documents/:id/like` - 点赞文档
- `POST /api/documents/:id/favorite` - 收藏文档

### 搜索接口
- `GET /api/search?q=keyword` - 搜索文档
- `GET /api/search/recommend` - 获取推荐
- `GET /api/search/hot` - 热门搜索

### 评论接口
- `GET /api/documents/:id/comments` - 获取评论
- `POST /api/documents/:id/comments` - 创建评论
- `DELETE /api/documents/:id/comments/:commentId` - 删除评论
- `POST /api/documents/:id/comments/:commentId/like` - 点赞评论

### 积分接口
- `GET /api/points/ranking` - 积分排行
- `GET /api/points/detail` - 积分明细
- `GET /api/points/rules` - 积分规则

## 📊 积分规则

| 行为 | 积分 | 每日上限 |
|------|------|----------|
| 发布文档 | +10 | 50 |
| 文档被点赞 | +1 | 20 |
| 文档被收藏 | +2 | 20 |
| 发布评论 | +1 | 10 |

## 🎨 界面预览

### 登录页
- 支持登录/注册切换
- 表单验证
- 记住登录状态

### 文档列表页
- 表格展示文档信息
- 分类筛选
- 关键词搜索
- 分页功能

### 文档详情页
- Markdown 渲染
- 版本历史
- 点赞收藏
- 评论互动

### 文档编辑页
- Markdown 编辑器
- 实时预览
- 分类标签选择
- 草稿/发布选项

### 搜索页
- 全文搜索
- 结果高亮
- 热门搜索
- 智能推荐

### 积分排行页
- 积分规则展示
- 排行榜 Top10
- 个人积分明细

## 🔧 配置说明

### 环境变量

创建 `.env` 文件：

```env
VITE_API_BASE_URL=http://localhost:8080/api
VITE_APP_MODE=development
```

### Mock 数据

项目内置了 Mock 数据服务，默认使用 Mock 数据进行演示。
要切换到真实 API，修改各页面中的 `useMock` 变量：

```javascript
const useMock = false  // 使用真实 API
```

## 📝 开发规范

### 代码风格
- 使用 ES6+ 语法
- 组件采用函数式 + Hooks
- 统一使用 Ant Design 组件

### Git 提交规范
```
feat: 新功能
fix: 修复 bug
docs: 文档更新
style: 代码格式
refactor: 重构
test: 测试
chore: 构建/工具
```

## 🚀 后续优化

- [ ] 接入真实 Elasticsearch 服务
- [ ] 添加文档权限管理
- [ ] 实现文档协作编辑
- [ ] 添加消息通知系统
- [ ] 支持文件上传
- [ ] 添加数据可视化报表
- [ ] 移动端适配优化
- [ ] 添加单元测试

## 📄 License

ISC

## 👥 开发团队

企业内部知识库系统开发团队

---

*Built with React + Ant Design + Vite*
