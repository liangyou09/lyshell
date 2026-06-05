import React from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import MainWindow from './components/Layout/MainWindow'
import FloatWindow from './components/FloatWindow/FloatWindow'

const App: React.FC = () => {
  return (
    <HashRouter>
      <Routes>
        {/* 主窗口路由 */}
        <Route path="/" element={<MainWindow />} />
        <Route path="/session/*" element={<MainWindow />} />

        {/* 浮窗路由 */}
        <Route path="/float" element={<FloatWindow />} />
      </Routes>
    </HashRouter>
  )
}

export default App