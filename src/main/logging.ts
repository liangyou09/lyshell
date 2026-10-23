import { app } from 'electron'
import { closeSync, mkdirSync, openSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import log from 'electron-log'

// 在其它业务模块加载前配置，避免启动期间的日志先写入默认目录。
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

if (app.isPackaged && process.platform === 'win32') {
  // electron-builder 的便携 EXE 会解压到临时目录，execPath 指向解压后的程序。
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const applicationDir = portableDir && isAbsolute(portableDir)
    ? portableDir
    : dirname(app.getPath('exe'))
  const logsDir = join(applicationDir, 'logs')

  try {
    mkdirSync(logsDir, { recursive: true })
    // 提前确认日志文件可写；安装到 Program Files 等只读位置时保留默认日志。
    closeSync(openSync(join(logsDir, log.transports.file.fileName), 'a'))
    app.setAppLogsPath(logsDir)
    log.transports.file.resolvePathFn = ({ fileName = 'main.log' }) => join(logsDir, fileName)
  } catch (error) {
    log.warn(`无法写入日志目录 ${logsDir}，使用默认日志目录`, error)
  }
}
