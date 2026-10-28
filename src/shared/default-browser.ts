/**
 * 默认浏览器注册状态。
 *
 * 由主进程根据 Windows 注册表核算；renderer 只做展示，不参与判定，
 * 也不能通过入参影响返回值。
 */
export interface DefaultBrowserStatus {
  /** 仅 Windows 为 true。 */
  supported: boolean
  /** 当前可执行文件已在 HKCU 完成 HTTP/HTTPS 协议注册。 */
  registered: boolean
  /** HTTP 与 HTTPS 的 UserChoice 都指向本产品，且注册项属于当前安装路径。 */
  isDefault: boolean
  /** 是否允许发起注册（Windows 且已打包）。 */
  canRegister: boolean
}

/**
 * 注册名。必须同时用作：
 * - HKCU\Software\RegisteredApplications 下的值名
 * - HKCU\Software\Clients\StartMenuInternet 下的子键名
 * - ms-settings:defaultapps?registeredAppUser=... 的参数值
 */
export const DEFAULT_BROWSER_APP_NAME = 'LyShell'

/** 应用专用 ProgID；只用于 HTTP/HTTPS，不接管本地 .html 文件。 */
export const DEFAULT_BROWSER_PROG_ID = 'LyShellURL'

/** 应用描述，出现在 Windows 设置“默认应用”列表中。 */
export const DEFAULT_BROWSER_DESCRIPTION = 'LyShell 智能终端（内置网页浏览器）'

/**
 * 打开“默认应用”设置页并定位到本产品。
 *
 * registeredAppUser 的取值必须与 RegisteredApplications 下的值名一致；
 * 该 URI 只负责打开设置页，最终选择始终由用户在 Windows 设置中完成。
 */
export const DEFAULT_BROWSER_SETTINGS_URI =
  `ms-settings:defaultapps?registeredAppUser=${DEFAULT_BROWSER_APP_NAME}`
