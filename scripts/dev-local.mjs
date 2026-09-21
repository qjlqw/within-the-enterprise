import { createServer } from 'vite'
import app from '../server/src/app.js'
import { config } from '../server/src/config/index.js'
import { initDb } from '../server/src/db/index.js'

initDb()
let backend
for (let port = config.port; port < config.port + 20; port++) {
  try {
    backend = await new Promise((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => resolve(server))
      server.once('error', reject)
    })
    break
  } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
}
if (!backend) throw new Error('No available backend port')
const backendURL = `http://127.0.0.1:${backend.address().port}`
let vite
try {
  vite = await createServer({ server: { host: '127.0.0.1', port: 3000, open: false,
    proxy: { '/api': { target: backendURL, changeOrigin: true } } } })
  await vite.listen()
  console.log(`KnowledgeAssistant=http://127.0.0.1:${vite.httpServer.address().port}/agent`)
  console.log(`Backend=${backendURL}`)
} catch (error) { backend.close(); throw error }
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await vite.close()
  backend.closeAllConnections()
  backend.close(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
