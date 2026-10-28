import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./installer.nsh', import.meta.url), 'utf8')

// String.raw 保留 NSIS 的 $\" 转义，避免测试自己把反斜杠吃掉。
const QUOTED_EXE = String.raw`$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"`
const PROGRAM_COMMAND = String.raw`'$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" --open-url $\"%1$\"'`
const CLIENT_COMMAND = String.raw`'$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"'`
const ICON_VALUE = String.raw`$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0`

function macro(name: string): string {
  const start = source.indexOf(`!macro ${name}`)
  const end = source.indexOf('!macroend', start)
  expect(start, `缺少宏 ${name}`).toBeGreaterThanOrEqual(0)
  expect(end, `宏 ${name} 未结束`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/** 只保留会写注册表的行，避免把注释里的说明当成实际契约。 */
function regWrites(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(WriteRegStr|WriteRegDWORD|DeleteRegKey|DeleteRegValue)\b/.test(line))
}

describe('安装器默认浏览器接线', () => {
  const install = macro('LyShellRegisterDefaultBrowser')
  const uninstall = macro('LyShellUnregisterDefaultBrowser')

  it('安装时由 customInstall 注册，卸载时由 customUnInstall 清理', () => {
    expect(macro('customInstall')).toContain('!insertmacro LyShellRegisterDefaultBrowser')
    expect(macro('customUnInstall')).toContain('!insertmacro LyShellUnregisterDefaultBrowser')
  })

  it('以当前用户身份登记 Capabilities、RegisteredApplications 和 ProgID', () => {
    const writes = regWrites(install)
    expect(writes).toContain(
      'WriteRegStr HKCU "Software\\RegisteredApplications" "${LYSHELL_BROWSER_APP}" "${LYSHELL_BROWSER_CAPABILITIES}"'
    )
    expect(writes).toContain(
      'WriteRegStr HKCU "Software\\Classes\\${LYSHELL_BROWSER_PROGID}" "URL Protocol" ""'
    )
    expect(writes).toContain(
      'WriteRegStr HKCU "${LYSHELL_BROWSER_CAPABILITIES}\\URLAssociations" "http" "${LYSHELL_BROWSER_PROGID}"'
    )
    expect(writes).toContain(
      'WriteRegStr HKCU "${LYSHELL_BROWSER_CAPABILITIES}\\URLAssociations" "https" "${LYSHELL_BROWSER_PROGID}"'
    )
    expect(source).toContain('!define LYSHELL_BROWSER_CAPABILITIES "${LYSHELL_BROWSER_CLIENT}\\Capabilities"')
    expect(install).toContain('"ApplicationName"')
    expect(install).toContain('"ApplicationDescription"')
    expect(install).toContain('"ApplicationIcon"')
  })

  it('图标写入 DefaultIcon 子键的默认值，而不是父键上名为 DefaultIcon 的值', () => {
    const writes = regWrites(install)
    const iconDefaults = writes.filter(
      (line) => /\\DefaultIcon" ""/.test(line) && line.includes('$INSTDIR')
    )
    expect(iconDefaults).toHaveLength(2)
    expect(
      iconDefaults.some((line) => line.includes('${LYSHELL_BROWSER_PROGID}\\DefaultIcon'))
    ).toBe(true)
    expect(
      iconDefaults.some((line) => line.includes('${LYSHELL_BROWSER_CLIENT}\\DefaultIcon'))
    ).toBe(true)
    expect(iconDefaults.every((line) => line.endsWith(`'${ICON_VALUE}'`))).toBe(true)
    // 父键上的命名值不会被系统读取，出现即视为回归。
    expect(writes.some((line) => /"[^"]*"\s+"DefaultIcon"\s/.test(line))).toBe(false)
  })

  it('只写 HKCU、只注册 HTTP/HTTPS，不接管本地 html 文件', () => {
    const writes = regWrites(install)
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every((line) => line.startsWith('WriteRegStr HKCU '))).toBe(true)
    expect(writes.some((line) => /\bHKLM\b|\bSHELL_CONTEXT\b/.test(line))).toBe(false)
    expect(writes.some((line) => /\.html|FileAssociations/i.test(line))).toBe(false)
    expect(writes.some((line) => /UserChoice/i.test(line))).toBe(false)
  })

  it('打开命令使用引号包裹的安装路径和专用 --open-url 参数', () => {
    const writes = regWrites(install)
    const programCommand = writes.find(
      (line) => line.includes('${LYSHELL_BROWSER_PROGID}\\shell\\open\\command')
    )
    const clientCommand = writes.find(
      (line) => line.includes('${LYSHELL_BROWSER_CLIENT}\\shell\\open\\command')
    )

    expect(programCommand).toBe(
      `WriteRegStr HKCU "Software\\Classes\\\${LYSHELL_BROWSER_PROGID}\\shell\\open\\command" "" ${PROGRAM_COMMAND}`
    )
    expect(clientCommand).toBe(
      `WriteRegStr HKCU "\${LYSHELL_BROWSER_CLIENT}\\shell\\open\\command" "" ${CLIENT_COMMAND}`
    )
    expect(programCommand).toContain('--open-url')
    expect(programCommand).toContain(QUOTED_EXE)
    expect(install).not.toContain('electron.exe')
    expect(install).toContain('SHChangeNotify')
  })

  it('卸载前核对注册命令属于当前安装目录，避免误删其它路径的便携版注册', () => {
    const commandCheck = uninstall.indexOf(
      'ReadRegStr $0 HKCU "Software\\Classes\\${LYSHELL_BROWSER_PROGID}\\shell\\open\\command"'
    )
    const clientCheck = uninstall.indexOf(
      'ReadRegStr $0 HKCU "${LYSHELL_BROWSER_CLIENT}\\shell\\open\\command"'
    )
    const deleteProgId = uninstall.indexOf(
      'DeleteRegKey HKCU "Software\\Classes\\${LYSHELL_BROWSER_PROGID}"'
    )
    const deleteClient = uninstall.indexOf('DeleteRegKey HKCU "${LYSHELL_BROWSER_CLIENT}"')
    const deleteRegistered = uninstall.indexOf(
      'DeleteRegValue HKCU "Software\\RegisteredApplications" "${LYSHELL_BROWSER_APP}"'
    )

    expect(commandCheck).toBeGreaterThanOrEqual(0)
    expect(clientCheck).toBeGreaterThan(commandCheck)
    expect(deleteProgId).toBeGreaterThan(clientCheck)
    expect(deleteClient).toBeGreaterThan(deleteProgId)
    expect(deleteRegistered).toBeGreaterThan(deleteClient)

    const guards = uninstall.match(/StrCmp \$0 '.*' 0 browserRegistrationDone/g) ?? []
    expect(guards).toHaveLength(2)
    expect(guards[0]).toContain('--open-url')
    expect(guards[1]).toContain('$INSTDIR')
    expect(guards[1]).not.toContain('--open-url')
    expect(uninstall).toContain(
      'StrCmp $0 "${LYSHELL_BROWSER_CAPABILITIES}" 0 +2'
    )
  })
})
