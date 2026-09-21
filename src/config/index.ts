// 应用配置
interface AppConfig {
  appName: string
  pagination: {
    pageSize: number
    pageSizeOptions: string[]
  }
  upload: {
    maxSize: number
    accept: string[]
  }
  editor: {
    minHeight: number
    placeholder: string
  }
}

const config: AppConfig = {
  // 应用名称
  appName: '企业内部知识库系统',

  // 分页配置
  pagination: {
    pageSize: 10,
    pageSizeOptions: ['10', '20', '50', '100'],
  },

  // 上传配置
  upload: {
    maxSize: 10 * 1024 * 1024, // 10MB
    accept: ['.md', '.txt', '.pdf', '.doc', '.docx'],
  },

  // 编辑器配置
  editor: {
    minHeight: 400,
    placeholder: '请输入文档内容，支持 Markdown 语法...',
  },
}

export default config
