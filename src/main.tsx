import { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/index.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

ReactDOM.createRoot(root).render(
  <ConfigProvider locale={zhCN}>
    <Suspense
      fallback={
        <Spin
          size="large"
          style={{ display: 'flex', justifyContent: 'center', marginTop: 100 }}
        />
      }
    >
      <App />
    </Suspense>
  </ConfigProvider>
)
