const { spawnSync } = require('node:child_process')
const path = require('node:path')

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'git failed')
  return result.stdout
}

// CI 传入 PR base/push before；本地默认检查 HEAD 之后的已跟踪与未跟踪源码。
const base = process.env.LYSHELL_LINT_BASE || 'HEAD'
const tracked = /^0+$/.test(base) ? git(['ls-files', '-z'])
  : git(['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--'])
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'])
const files = [...new Set(`${tracked}\0${untracked}`.split('\0'))]
  .filter(file => /^src\/.*\.tsx?$/.test(file))
if (!files.length) {
  console.log('[lint] No changed TypeScript source files')
} else {
  const eslint = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js')
  const result = spawnSync(process.execPath, [eslint, ...files], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
}
