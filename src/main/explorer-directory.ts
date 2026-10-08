import { execFileSync } from 'child_process'
import { join } from 'path'
import koffi from 'koffi'
import log from 'electron-log'
import { validateExplorerDirectory } from './explorer-launch'

interface ExplorerWindow {
  window: number
  tab: number
}

/** 窗口显示前捕获发起启动的 Explorer；只认前台窗口，不猜其它已打开目录。 */
export function captureExplorerWindow(): ExplorerWindow | null {
  if (process.platform !== 'win32') return null
  const user32 = koffi.load('user32.dll')
  const foreground = user32.func('uintptr_t __stdcall GetForegroundWindow()')
  const className = user32.func('int __stdcall GetClassNameW(uintptr_t window, void *name, int length)')
  const findChild = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, const void *className, const void *title)')
  const visible = user32.func('int __stdcall IsWindowVisible(uintptr_t window)')
  const window = Number(foreground())
  if (!window) return null
  const name = Buffer.alloc(512)
  const length = className(window, name, 256)
  if (!['CabinetWClass', 'ExploreWClass'].includes(name.toString('utf16le', 0, length * 2))) return null
  const tabClass = Buffer.from('ShellTabWindowClass\0', 'utf16le')
  let tab = Number(findChild(window, 0, tabClass, null))
  while (tab) {
    if (visible(tab)) return { window, tab }
    tab = Number(findChild(window, tab, tabClass, null))
  }
  return { window, tab: 0 }
}

/** Shell browser 的 IOleWindow.GetWindow 返回页签句柄，区分 Win11 同 HWND 的多个页签。 */
export function explorerDirectoryScript(target: ExplorerWindow): string {
  if (![target.window, target.tab].every(value => Number.isSafeInteger(value) && value >= 0) || target.window === 0) {
    throw new Error('Invalid Explorer window handle')
  }
  return `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface LyShellServiceProvider {
  [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result);
}
[ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface LyShellOleWindow {
  [PreserveSig] int GetWindow(out IntPtr window);
  [PreserveSig] int ContextSensitiveHelp(bool enter);
}
public static class LyShellExplorerTab {
  public static long Handle(object window) {
    Guid browser = new Guid("000214E2-0000-0000-C000-000000000046");
    IntPtr pointer;
    int hr = ((LyShellServiceProvider)window).QueryService(ref browser, ref browser, out pointer);
    if (hr != 0 || pointer == IntPtr.Zero) return 0;
    try {
      IntPtr handle;
      return ((LyShellOleWindow)Marshal.GetObjectForIUnknown(pointer)).GetWindow(out handle) == 0 ? handle.ToInt64() : 0;
    } finally { Marshal.Release(pointer); }
  }
}
'@
$matches=@()
$shell=New-Object -ComObject Shell.Application
foreach($entry in $shell.Windows()) {
  try {
    if([long]$entry.HWND -ne ${target.window}) { continue }
    if(${target.tab} -ne 0 -and [LyShellExplorerTab]::Handle($entry) -ne ${target.tab}) { continue }
    $folder=$entry.Document.Folder.Self.Path
    if($folder -is [string]) { $matches+= $folder }
  } catch {}
}
if($matches.Count -eq 1) { ConvertTo-Json -InputObject $matches[0] -Compress }
`
}

/** App Paths 启动的 cwd 可能是安装目录；直接从前台 Explorer 活动页签取真实目录。 */
export function readActiveExplorerDirectory(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const target = captureExplorerWindow()
    if (!target) return null
    const executable = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const stdout = execFileSync(executable, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(explorerDirectoryScript(target), 'utf16le').toString('base64')
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    if (!stdout.trim()) return null
    return validateExplorerDirectory(JSON.parse(stdout.trim()))
  } catch (error) {
    log.warn('Failed to resolve Explorer address-bar directory:', (error as Error).message)
    return null
  }
}
