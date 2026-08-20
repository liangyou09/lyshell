import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface DownloadConfig {
  defaultDir: string
  serverDirs: Record<string, string>
  autoCreateServerSubdir: boolean
}

/**
 * 下载配置面板
 */
const DownloadConfigPanel: React.FC = () => {
  const [config, setConfig] = useState<DownloadConfig>({
    defaultDir: '',
    serverDirs: {},
    autoCreateServerSubdir: true
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const { t } = useTranslation()

  // 加载配置
  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.getDownloadConfig()
      if (result.success) {
        setConfig(result.data)
      }
    } catch (error) {
      console.error('Failed to load config:', error)
    }
    setLoading(false)
  }

  // 保存配置
  const handleSave = async () => {
    setSaving(true)
    try {
      await window.electronAPI.setDownloadConfig(config)
      alert(t('fileManager.configSaved'))
    } catch (error) {
      console.error('Failed to save config:', error)
      alert(t('fileManager.saveFailed'))
    }
    setSaving(false)
  }

  // 选择目录
  const handleSelectDir = async () => {
    const result = await window.electronAPI.showOpenDialog({
      title: t('fileManager.selectDefaultDirTitle'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setConfig({ ...config, defaultDir: result.filePaths[0] })
    }
  }

  // 打开目录
  const handleOpenDir = (dir: string) => {
    window.electronAPI.openFolder(dir)
  }

  return (
    <div className="flex flex-col h-full p-4">
      <h2 className="text-lg text-white mb-4">{t('fileManager.settingsTitle')}</h2>

      {loading ? (
        <div className="text-gray-500">{t('fileManager.loading')}</div>
      ) : (
        <div className="space-y-4">
          {/* 默认下载目录 */}
          <div className="space-y-2">
            <label className="text-sm text-gray-300">{t('fileManager.defaultDirLabel')}</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={config.defaultDir}
                onChange={(e) => setConfig({ ...config, defaultDir: e.target.value })}
                className="flex-1 px-3 py-2 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
              />
              <button
                onClick={handleSelectDir}
                className="px-3 py-2 bg-[#3C3C3C] text-gray-300 hover:text-white rounded text-sm"
              >
                {t('fileManager.browse')}
              </button>
              <button
                onClick={() => handleOpenDir(config.defaultDir)}
                className="px-3 py-2 bg-[#3C3C3C] text-gray-300 hover:text-white rounded text-sm"
              >
                {t('fileManager.open')}
              </button>
            </div>
            <p className="text-xs text-gray-500">{t('fileManager.defaultDirHint')}</p>
          </div>

          {/* 自动创建服务器子目录 */}
          <div className="space-y-2">
            <label className="text-sm text-gray-300 flex items-center gap-2">
              <input
                type="checkbox"
                checked={config.autoCreateServerSubdir}
                onChange={(e) => setConfig({ ...config, autoCreateServerSubdir: e.target.checked })}
                className="w-4 h-4"
              />
              {t('fileManager.autoCreateSubdir')}
            </label>
            <p className="text-xs text-gray-500">
              {t('fileManager.autoCreateSubdirHint')}
            </p>
          </div>

          {/* 说明 */}
          <div className="mt-4 p-3 bg-[#2D2D30] rounded text-xs text-gray-400">
            <p className="mb-2">{t('fileManager.notesTitle')}</p>
            <ul className="list-disc list-inside space-y-1">
              <li>{t('fileManager.note1')}</li>
              <li>{t('fileManager.note2')}</li>
              <li>{t('fileManager.note3')}</li>
            </ul>
          </div>

          {/* 保存按钮 */}
          <div className="mt-4 flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-4 py-2 rounded text-sm ${
                saving ? 'bg-gray-500 text-gray-400' : 'bg-[#0078D4] text-white hover:bg-[#006CBD]'
              }`}
            >
              {saving ? t('fileManager.saving') : t('fileManager.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default DownloadConfigPanel