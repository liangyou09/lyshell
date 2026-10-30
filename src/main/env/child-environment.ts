/** 子进程的基础环境白名单。任务所需变量经 overrides 显式注入，不继承宿主凭据。 */
const BASE_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'DISPLAY', 'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'PYTHONIOENCODING',
  'PYTHONUTF8', 'POWERSHELL_UPDATECHECK', 'DSH_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'
])

export function childEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  inheritedKeys: readonly string[] = []
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const allowed = new Set([...BASE_KEYS, ...inheritedKeys.map(key => key.toUpperCase())])
  const put = (name: string, value: string | undefined): void => {
    if (process.platform === 'win32') {
      const existing = Object.keys(result).find(key => key.toUpperCase() === name.toUpperCase())
      if (existing) delete result[existing]
    }
    if (value !== undefined) result[name] = value
  }
  for (const [name, value] of Object.entries(base)) {
    if (allowed.has(name.toUpperCase()) || /^LC_[A-Z_]+$/i.test(name)) put(name, value)
  }
  for (const [name, value] of Object.entries(overrides)) put(name, value)
  return result
}
