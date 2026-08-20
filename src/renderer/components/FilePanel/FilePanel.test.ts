import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/components/FilePanel/FilePanel.tsx'),
  'utf-8'
)

describe('FilePanel 下载失败交互', () => {
  const downloadHandler = SOURCE.slice(
    SOURCE.indexOf('const handleDownload = async'),
    SOURCE.indexOf('// 删除文件')
  )

  it('下载目录失败时显示错误，不回退到任意路径保存对话框', () => {
    expect(downloadHandler).not.toContain('showSaveDialog')
    expect(downloadHandler).toContain("title: t('file.downloadFailedTitle')")
  })

  it('等待后端接受下载请求后才提示开始', () => {
    const awaitAt = downloadHandler.indexOf('const result = await window.electronAPI.fileDownload(')
    const successAt = downloadHandler.indexOf("alert(t('file.downloadStartedWithPath'")
    expect(awaitAt).toBeGreaterThan(-1)
    expect(successAt).toBeGreaterThan(awaitAt)
    expect(downloadHandler).toContain('if (!result.success)')
  })
})
