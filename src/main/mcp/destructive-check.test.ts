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

  describe('整体行为', () => {
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
