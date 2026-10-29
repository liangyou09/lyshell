/** 调宽时保留 guest 的视口大小，由外层裁剪旧画面，松手后再让网页重新布局。 */
export function retainWebviewViewports(root: HTMLElement): () => void {
  // 先读完所有尺寸，再批量写入；不触碰导航、实例或网页内部状态。
  const views = [...root.querySelectorAll<HTMLElement>('webview')].map(view => ({
    view,
    rect: view.getBoundingClientRect(),
    width: view.style.getPropertyValue('width'), height: view.style.getPropertyValue('height'),
    widthPriority: view.style.getPropertyPriority('width'), heightPriority: view.style.getPropertyPriority('height')
  })).filter(({ rect }) => rect.width > 0 && rect.height > 0)
  for (const { view, rect } of views) {
    view.style.setProperty('width', `${rect.width}px`)
    view.style.setProperty('height', `${rect.height}px`)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    for (const { view, width, height, widthPriority, heightPriority } of views) {
      if (width) view.style.setProperty('width', width, widthPriority)
      else view.style.removeProperty('width')
      if (height) view.style.setProperty('height', height, heightPriority)
      else view.style.removeProperty('height')
    }
  }
}
