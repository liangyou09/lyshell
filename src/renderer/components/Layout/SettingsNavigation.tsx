import React from 'react'

const paths: Record<string, React.ReactNode> = {
  appearance: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 0 0 16Z" fill="currentColor" stroke="none" /></>,
  terminal: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01m3 0h.01" /></>,
  downloads: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" /></>,
  browser: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z" /></>,
  env: <><path d="M4 7h5m4 0h7M4 17h9m4 0h3" /><circle cx="11" cy="7" r="2" /><circle cx="15" cy="17" r="2" /></>,
  general: <><path d="m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9" /></>,
  network: <><path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0M12 20h.01" /></>,
  privacy: <><path d="M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5" /></>,
  sitePermissions: <><path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
  passwords: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  plugin: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>
}

export const SettingsGlyph: React.FC<{ name: string }> = ({ name }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.plugin}</svg>

export const SettingsBackGlyph: React.FC = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m7-7-7 7 7 7" /></svg>

export interface SettingsNavigationItem {
  key: string
  label: string
  hint?: string
  icon: string
}

export const SettingsNavigation: React.FC<{
  label: string
  items: SettingsNavigationItem[]
  onSelect: (key: string) => void
}> = ({ label, items, onSelect }) => <nav className="settings-nav" aria-label={label}>
  {items.map(item => <button key={item.key} type="button" className="settings-nav-item" aria-label={item.label} onClick={() => onSelect(item.key)}>
    <span className="settings-nav-icon"><SettingsGlyph name={item.icon} /></span>
    <span className="settings-nav-copy"><span className="settings-nav-label">{item.label}</span>{item.hint && <span className="settings-nav-hint">{item.hint}</span>}</span>
    <svg className="settings-nav-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
  </button>)}
</nav>
