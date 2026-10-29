import React from 'react'
import './commands/demo-stage'
import { HashRouter, Routes, Route } from 'react-router-dom'
import MainWindow from './components/Layout/MainWindow'
import { useHarnessRecovery } from './hooks/useHarnessRecovery'

const App: React.FC = () => {
  useHarnessRecovery()
  return (
    <HashRouter>
      <Routes>
        {/* 主窗口路由 */}
        <Route path="/" element={<MainWindow />} />
        <Route path="/session/*" element={<MainWindow />} />


      </Routes>
    </HashRouter>
  )
}

export default App
