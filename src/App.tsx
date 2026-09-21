import { BrowserRouter } from 'react-router-dom'
import { renderRoutes } from '@/config/routes'

function App() {
  return <BrowserRouter>{renderRoutes()}</BrowserRouter>
}

export default App
