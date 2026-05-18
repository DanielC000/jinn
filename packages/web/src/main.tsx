import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ClientProviders } from './app/client-providers'
import DashboardPage from './app/page'
import './app/globals.css'

const ChatPage = lazy(() => import('./app/chat/page'))
const CronPage = lazy(() => import('./app/cron/page'))
const KanbanPage = lazy(() => import('./app/kanban/page'))
const LogsPage = lazy(() => import('./app/logs/page'))
const OrgPage = lazy(() => import('./app/org/page'))
const SettingsPage = lazy(() => import('./app/settings/page'))
const SkillsPage = lazy(() => import('./app/skills/page'))

function App() {
  return (
    <BrowserRouter>
      <ClientProviders>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/cron" element={<CronPage />} />
            <Route path="/kanban" element={<KanbanPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/org" element={<OrgPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
          </Routes>
        </Suspense>
      </ClientProviders>
    </BrowserRouter>
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(<App />)
