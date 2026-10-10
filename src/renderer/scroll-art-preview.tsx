import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScrollPaper, ScrollRoller, SingleScroll, XuanPaper } from './components/Layout/ScrollArtwork'
import { ScrollTie } from './components/Layout/ScrollFold'
import { BrushArtwork } from './components/Layout/BrushArtwork'
import QuickCommandsPanel from './components/QuickCommands/QuickCommandsPanel'
import { useQuickCommandsStore } from '@/stores'
import './i18n'
import './styles/globals.css'
import './styles/scroll-artwork.css'
import './styles/scroll-art-preview.css'

// 独立预览只填充内存示例，命令不向终端派发。
useQuickCommandsStore.setState({
  commands: [
    { id: 'preview-ls', name: '查看目录', content: 'ls' },
    { id: 'preview-status', name: '连接状态', content: 'who' },
    { id: 'preview-clear', name: '清屏', content: 'clear' }
  ],
  groups: [], defaultGroupColor: '#658f7a', selectedGroupId: 'default'
})

function ThemePreview({ dark }: { dark: boolean }): React.ReactElement {
  const [singleOpen, setSingleOpen] = useState(true)
  const [dualOpen, setDualOpen] = useState(true)
  const [sent, setSent] = useState(false)
  const [brushSelected, setBrushSelected] = useState('cmd')
  return (
    <section className="art-theme" data-theme={dark ? 'rack-graphite' : 'rack-paper'} data-theme-mode={dark ? 'dark' : 'light'} data-scroll-material="jade">
      <h2>{dark ? '深色 · 墨绢与青玉' : '浅色 · 宣纸与白玉'}</h2>
      <p>轴头与轴肩保持比例，纸面止于轴肩内侧。</p>
      <h3>快捷命令 · 木匣盖与玉章匣盘</h3>
      <QuickCommandsPanel />
      <h3>宣纸输入框 · 会话搜索 / 地址筛选</h3>
      <div className="art-search-samples">
        {[true, false].map(large => (
          <label key={String(large)} className={`scroll-search open art-search ${large ? 'scroll-search-lg' : 'scroll-search-web'}`}>
            <span aria-hidden="true" className="scroll-search-paper scroll-search-paper-l" />
            <span aria-hidden="true" className="scroll-search-paper scroll-search-paper-r" />
            <span aria-hidden="true" className="scroll-search-rod scroll-search-rod-l" />
            <span aria-hidden="true" className="scroll-search-rod scroll-search-rod-r" />
            <input className="scroll-search-input" aria-label={large ? '会话搜索示例' : '地址筛选示例'} placeholder={large ? '搜索会话…' : '输入地址或筛选内容…'} defaultValue={large ? '开发服务器' : ''} />
          </label>
        ))}
      </div>
      <h3>纯宣纸 · 无轴体、无裱边</h3>
      <XuanPaper className="art-xuan-sample"><p className="art-copy">纸面本身的纤维与轻微起伏</p><p className="art-copy art-muted">自然纹理，保留清晰的输入文字。</p></XuanPaper>
      <h3>双画轴 · 点击轴体展开 / 收起</h3>
      <div className={`scroll-dual art-dual ${dualOpen ? 'open' : 'rolled'}`} style={{ height: dualOpen ? 174 : 'var(--scroll-dual-rolled-height, 20px)' }}>
        <button type="button" className="scroll-dual-rod" aria-label="上轴开合" aria-expanded={dualOpen} onClick={() => setDualOpen(!dualOpen)}><span aria-hidden="true" className="rod-caps" /><span className="scroll-dual-tie"><ScrollTie /></span></button>
        <div className="scroll-dual-paper" {...(dualOpen ? {} : { inert: '' })}>
          <div className="art-compose"><form onSubmit={e => { e.preventDefault(); setSent(true) }}>
            <textarea aria-label="示例输入" placeholder="写点什么…" defaultValue="查看当前会话的连接状态" />
            <button type="submit">发送</button><span role="status">{sent ? '已发送，画轴保持展开' : ''}</span>
          </form></div>
        </div>
        <button type="button" className="scroll-dual-rod scroll-dual-rod-b" aria-label="下轴开合" aria-expanded={dualOpen} onClick={() => setDualOpen(!dualOpen)}><span aria-hidden="true" className="rod-caps" /><span className="scroll-dual-tie"><ScrollTie /></span></button>
      </div>
      <h3>单画轴 · 可复用的垂卷</h3>
      <SingleScroll open={singleOpen} onToggle={() => setSingleOpen(!singleOpen)} label="单画轴开合" count={2}>
        <div className="art-session"><span>开发服务器</span><span>SSH</span></div>
        <div className="art-session"><span>本地终端</span><span>PTY</span></div>
      </SingleScroll>
      <h3>独立单轴 · 展开轴 / 收卷轴</h3>
      <div className="art-axes"><ScrollRoller/><ScrollRoller rolled/></div>
      <h3>丝绳美术 · 绳结细节与实际尺寸</h3>
      <div className="art-tie-samples scroll-head rolled"><ScrollTie group/><span className="art-tie-size"><ScrollTie group/></span></div>
      <h3>毛笔美术 · 完整细节与启动按钮尺寸</h3>
      <div className="art-brush-detail"><BrushArtwork /></div>
      <div className="brush-rack art-brush-rack">
        {['cmd', 'PS', 'PS7', 'PS+'].map(label => (
          <button key={label} type="button" className={`brush art-brush-button ${brushSelected === label ? 'on' : ''}`} aria-pressed={brushSelected === label} onClick={() => setBrushSelected(label)}>
            <span className="brush-label">{label}</span><BrushArtwork />
          </button>
        ))}
      </div>
      <h3>独立纸张 · 宣纸纤维与窄裱绢</h3>
      <ScrollPaper><p className="art-copy">输入文字与纸面保持清晰对比。</p><p className="art-copy art-muted">空白画心，可用于命令、筛选或内容卡片。</p></ScrollPaper>
    </section>
  )
}

createRoot(document.getElementById('root')!).render(
  <main className="art-gallery"><h1>LyShell · 中国书画画轴</h1><p>两套实际组件与资产。点击轴体可比较开合，输入框可检查文字对比。</p><div className="art-comparison"><ThemePreview dark={false}/><ThemePreview dark/></div></main>
)
