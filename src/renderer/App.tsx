import React from 'react'
import './commands/demo-stage'
import { HashRouter, Routes, Route } from 'react-router-dom'
import MainWindow from './components/Layout/MainWindow'

const App: React.FC = () => {
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
