import { describe, it, expect } from 'vitest'
import { scanDestructiveCommand, DESTRUCTIVE_PATTERNS } from './destructive-check'

/** 命中即返回 true，便于反例批量断言 */
function isDestructive(text: string): boolean {
  return scanDestructiveCommand(text).length > 0
}

/** 取命中 pattern 名集合 */
function matchedNames(text: string): string[] {
  return scanDestructiveCommand(text).map(m => m.name)
}

describe('scanDestructiveCommand', () => {
  describe('rm-rf-root', () => {
    it('命中裸根删除', () => {
      expect(matchedNames('rm -rf /')).toContain('rm-rf-root')
      expect(matchedNames('rm -rf / ')).toContain('rm-rf-root')
      expect(matchedNames('rm -rf /; echo done')).toContain('rm-rf-root')
      expect(matchedNames('cd /tmp && rm -rf /')).toContain('rm-rf-root')
    })
    it('命中家目录 / 根 glob', () => {
      expect(matchedNames('rm -rf ~')).toContain('rm-rf-root')
      expect(matchedNames('rm -rf /*')).toContain('rm-rf-root')
      expect(matchedNames('rm -rf ~/*')).toContain('rm-rf-root')
    })
    it('命中 -fr / -rfv 等变体', () => {
      expect(matchedNames('rm -fr /')).toContain('rm-rf-root')
      expect(matchedNames('rm -rfv /')).toContain('rm-rf-root')
      expect(matchedNames('rm  -rf  /')).toContain('rm-rf-root') // 多空格
    })
    it('放行具体子路径的正常清理', () => {
      expect(isDestructive('rm -rf /tmp/lyshell-test')).toBe(false)
      expect(isDestructive('rm -rf ./node_modules')).toBe(false)
      expect(isDestructive('rm -rf /home/user/build')).toBe(false)
      expect(isDestructive('rm -rf ~/projects/foo')).toBe(false)
    })
    it('放行不带 -rf 的 rm', () => {
      expect(isDestructive('rm /some/file')).toBe(false)
      expect(isDestructive('rm -f /tmp/x')).toBe(false)
    })
  })

  describe('dd-to-block-device', () => {
    it('命中 dd 写块设备', () => {
      expect(matchedNames('dd if=/dev/zero of=/dev/sda bs=1M')).toContain('dd-to-block-device')
      expect(matchedNames('dd of=/dev/nvme0n1')).toContain('dd-to-block-device')
    })
    it('放行 dd 写普通文件', () => {
      expect(isDestructive('dd if=/dev/zero of=/tmp/blank.img bs=1M count=10')).toBe(false)
    })
  })

  describe('mkfs', () => {
    it('命中 mkfs 及其变体', () => {
      expect(matchedNames('mkfs.ext4 /dev/sda1')).toContain('mkfs')
      expect(matchedNames('mkfs -t xfs /dev/sdb')).toContain('mkfs')
      expect(matchedNames('mkfs')).toContain('mkfs')
    })
  })

  describe('write-to-block-device', () => {
    it('命中重定向到块设备', () => {
      expect(matchedNames('cat img.raw > /dev/sda')).toContain('write-to-block-device')
      expect(matchedNames('foo 2>/dev/sdb')).toContain('write-to-block-device')
    })
    it('放行 /dev/null', () => {
      expect(isDestructive('echo hi > /dev/null')).toBe(false)
      expect(isDestructive('cmd 2>/dev/null')).toBe(false)
    })
  })

  describe('fork-bomb', () => {
    it('命中经典 fork bomb', () => {
      expect(matchedNames(':(){ :|:& };')).toContain('fork-bomb')
    })
    it('放行普通函数定义', () => {
      expect(isDestructive('f(){ echo hi; }')).toBe(false)
    })
  })

  describe('shutdown-reboot', () => {
    it('命中关机重启命令', () => {
      expect(matchedNames('shutdown -h now')).toContain('shutdown-reboot')
      expect(matchedNames('reboot')).toContain('shutdown-reboot')
      expect(matchedNames('sudo halt')).toContain('shutdown-reboot')
      expect(matchedNames('init 0')).toContain('shutdown-reboot')
      expect(matchedNames('init 6')).toContain('shutdown-reboot')
      expect(matchedNames('systemctl reboot')).toContain('shutdown-reboot')
    })
    it('放行含 reboot/halt 子串的变量名与普通 runlevel', () => {
      expect(isDestructive('reboot_count=0')).toBe(false)
      expect(isDestructive('echo halted')).toBe(false)
      expect(isDestructive('init 3')).toBe(false)
    })
  })

  describe('chmod-root', () => {
    it('命中 chmod 根目录', () => {
      expect(matchedNames('chmod -R 777 /')).toContain('chmod-root')
      expect(matchedNames('chmod 777 /')).toContain('chmod-root')
    })
    it('放行具体路径', () => {
      expect(isDestructive('chmod 755 /usr/bin/foo')).toBe(false)
      expect(isDestructive('chmod -R 755 ./src')).toBe(false)
    })
  })

  describe('只读排查的文字参数放行', () => {
    it('复现用例：crontab 检查里的 grep reboot 不误报', () => {
      // 原始误报：把 grep 的搜索词当成了重启命令
      const cmd = "crontab -l 2>/dev/null | grep -iE 'compose|docker|reboot' || echo 'root crontab 无相关'"
      expect(isDestructive(cmd)).toBe(false)
    })
    it('grep / rg 搜索重启相关文字不误报', () => {
      expect(isDestructive("grep -rn 'reboot' src/")).toBe(false)
      expect(isDestructive('grep -rn reboot /var/log/messages')).toBe(false)
      expect(isDestructive("rg -n 'shutdown|halt|poweroff' docs/")).toBe(false)
      expect(isDestructive("grep 'init 0' notes.txt")).toBe(false)
    })
    it('echo / printf 输出重启提示文字不误报', () => {
      expect(isDestructive("echo '系统需要 reboot 才能生效'")).toBe(false)
      expect(isDestructive("echo reboot")).toBe(false)
      expect(isDestructive("printf '%s\\n' reboot")).toBe(false)
    })
    it('grep / echo 里的 mkfs 字样不误报', () => {
      expect(isDestructive("grep -rn 'mkfs.ext4' docs/")).toBe(false)
      expect(isDestructive("echo 'mkfs.ext4 /dev/sda1'")).toBe(false)
      expect(isDestructive('grep -n mkfs /etc/fstab')).toBe(false)
    })
    it('sudo 前缀下的只读排查同样放行', () => {
      expect(isDestructive("sudo grep -rn 'reboot' /var/log")).toBe(false)
      expect(isDestructive('sudo -u root grep reboot /var/log/messages')).toBe(false)
    })
  })

  describe('文字参数放行不放过真实执行', () => {
    it('直接 / sudo / systemctl 重启仍命中', () => {
      expect(matchedNames('reboot')).toContain('shutdown-reboot')
      expect(matchedNames('sudo reboot')).toContain('shutdown-reboot')
      expect(matchedNames('systemctl reboot')).toContain('shutdown-reboot')
    })
    it('分号 / && / 管道之后的真实 reboot 仍命中', () => {
      expect(matchedNames('echo hi; reboot')).toContain('shutdown-reboot')
      expect(matchedNames("grep -rn 'reboot' src/ && reboot")).toContain('shutdown-reboot')
      expect(matchedNames('echo hi | reboot')).toContain('shutdown-reboot')
    })
    it('sh/batch -c 与 eval 里的 reboot 仍命中', () => {
      expect(matchedNames("sh -c 'reboot'")).toContain('shutdown-reboot')
      expect(matchedNames('bash -c "reboot"')).toContain('shutdown-reboot')
      expect(matchedNames("eval 'reboot'")).toContain('shutdown-reboot')
    })
    it('命令替换 / 反引号里的 reboot 仍命中', () => {
      expect(matchedNames('echo "$(reboot)"')).toContain('shutdown-reboot')
      expect(matchedNames('echo `reboot`')).toContain('shutdown-reboot')
    })
    it('管道末端是解释器时 grep 参数不放行', () => {
      // echo reboot | sh 真的会执行 reboot
      expect(matchedNames('echo reboot | sh')).toContain('shutdown-reboot')
    })
    it('echo reboot > /dev/sda 仍命中写块设备（重定向目标不放行）', () => {
      expect(matchedNames('echo reboot > /dev/sda')).toContain('write-to-block-device')
    })
    it('未知命令的参数仍保守命中', () => {
      expect(matchedNames('foo reboot')).toContain('shutdown-reboot')
      expect(matchedNames("custom-tool 'reboot'")).toContain('shutdown-reboot')
      expect(matchedNames("awk '/reboot/' /var/log/syslog")).toContain('shutdown-reboot')
    })
    it('rm / dd / 重定向 / fork / chmod 的结构命中不受文字放行影响', () => {
      // 结构性规则完全不参与文字放行，引号内也照旧按原文命中
      expect(matchedNames("echo 'rm -rf / ; whoami'")).toContain('rm-rf-root')
      expect(matchedNames("echo 'dd if=/dev/zero of=/dev/sda'")).toContain('dd-to-block-device')
      expect(matchedNames("echo 'chmod -R 777 / ; whoami'")).toContain('chmod-root')
      expect(matchedNames("echo ':(){ :|:& };'")).toContain('fork-bomb')
      expect(matchedNames("grep -rn '> /dev/sda' docs/")).toContain('write-to-block-device')
    })
    it('真实 mkfs 仍命中', () => {
      expect(matchedNames('mkfs.ext4 /dev/sda1')).toContain('mkfs')
      expect(matchedNames('mkfs -t xfs /dev/sdb')).toContain('mkfs')
    })
  })

  describe('整体行为', () => {
    it('rg 执行外部程序的选项不能作为普通搜索参数放行', () => {
      for (const text of ['rg --pre reboot pattern file', 'rg --pre=mkfs.ext4 pattern file', "rg '--pre' 'reboot' pattern file", 'rg --hostname-bin reboot pattern file']) {
        expect(isDestructive(text)).toBe(true)
      }
      expect(isDestructive('rg --pre-glob reboot pattern file')).toBe(false)
    })
    it('接近输入上限的大量文字参数仍能找到末尾真正执行的命令', () => {
      const literals = 'echo ' + 'reboot '.repeat(100000)
      expect(isDestructive(literals)).toBe(false)
      expect(matchedNames(literals + '; reboot')).toContain('shutdown-reboot')
    })
    it('未知管道下游和多行替换保留保守检测', () => {
      for (const text of ['echo reboot | busybox sh', 'echo reboot | custom-runner', 'eval $(\necho reboot\n)', 'eval `\necho reboot\n`', 'printf -v cmd reboot; $cmd', 'echo reboot > /tmp/script; sh /tmp/script']) {
        expect(matchedNames(text)).toContain('shutdown-reboot')
      }
      expect(isDestructive('grep reboot /var/log/syslog | head -20')).toBe(false)
    })
    it('注释引号不隐藏下一行执行，未知路径和进程替换保持检测', () => {
      for (const text of ["echo hi # '\nreboot\n'", 'echo =(reboot)', 'echo (reboot)', '/tmp/grep reboot']) {
        expect(matchedNames(text)).toContain('shutdown-reboot')
      }
      expect(isDestructive('/usr/bin/grep reboot /var/log/messages')).toBe(false)
    })
    it('安全命令零命中', () => {
      expect(isDestructive('echo hello')).toBe(false)
      expect(isDestructive('ls -la /tmp')).toBe(false)
      expect(isDestructive('npm install')).toBe(false)
      expect(isDestructive('git status')).toBe(false)
      expect(isDestructive('kubectl get pods')).toBe(false)
      expect(isDestructive('df -h')).toBe(false)
      expect(isDestructive('')).toBe(false)
    })
    it('多行文本中能定位破坏性命令', () => {
      const script = 'cd /opt/app\nnpm run build\nrm -rf /\n'
      expect(matchedNames(script)).toContain('rm-rf-root')
    })
    it('一条命令可命中多个 pattern', () => {
      // 同时含 mkfs 与 dd 块设备
      const cmd = 'mkfs.ext4 /dev/sda1 && dd if=/dev/zero of=/dev/sdb'
      const names = matchedNames(cmd)
      expect(names).toContain('mkfs')
      expect(names).toContain('dd-to-block-device')
    })
    it('返回的 snippet 不超过上限且包含命中片段', () => {
      const matches = scanDestructiveCommand('rm -rf /')
      expect(matches).toHaveLength(1)
      expect(matches[0].snippet).toContain('rm')
    })
  })

  it('DESTRUCTIVE_PATTERNS 非空且 name 唯一', () => {
    const names = DESTRUCTIVE_PATTERNS.map(p => p.name)
    expect(names.length).toBeGreaterThan(0)
    expect(new Set(names).size).toBe(names.length)
  })
})
