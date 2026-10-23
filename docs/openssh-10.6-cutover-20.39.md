# 10.5.20.39 OpenSSH 9.8p1 → 10.6p1 替换方案（v4，已按三轮审查修订）

- 目标主机：`10.5.20.39`（bigdata-master），openEuler 22.03 LTS-SP3，kernel 5.10.0-182.0.0.95.oe2203sp3.x86_64，glibc 2.34，SELinux Disabled
- 变更性质：源码编译后**原地替换**系统 OpenSSH 服务端，不升级 RPM
- 当前记录：据[执行日志](./openssh-10.6-cutover-20.39-exec-log.md)，2026-10-23 已完成系统服务端替换与切换验收；24h 观察与 2222 去留仍待处理。下文“现状基线”为切换前记录，后续状态见 §10、§11 与执行日志，勿重复执行发布步骤。
- 修订依据：[openssh-10.6-cutover-20.39-review.md](./openssh-10.6-cutover-20.39-review.md) —— 首轮 R1–R6（并入 v2）、二轮 N1–N6 + §0.8（并入 v3）、三轮"v3 复审"一处 P1（并入 v4）

## 0. 修订记录

### 0.1 三轮审查（v3 → v4），对应 review「v3 复审」

| 编号 | 位置 | 问题 | v4 处理 |
|---|---|---|---|
| N7 | §6.1 第 1 步 | 脚本带 `pipefail`，`strings ... \| grep -qxF` 中 `grep -q` 匹配后立即退出，上游 `strings` 可能收到 SIGPIPE（状态 141）；即使路径匹配成功，整个管道仍可能非零 → 进入 `die`，在真正恢复主程序之前拒绝回滚 | 去掉 `-q`、加 `--`，改为 `strings ... \| grep -xF -- "$OLD_HELPER" >/dev/null`（完整消费输入，匹配即写出后正常退出）；同文件 §6.1 第 5 步的 `ss -tln \| grep -qE` 也去掉 `-q`，避免同一类假失败 |

> **主机侧实测（2026-10-23，10.5.20.39，`set -o pipefail`）**：`/usr/bin/strings` 存在。旧写法 `strings "$B/sbin/sshd" | grep -qxF -- /usr/local/libexec/sshd-session` 连跑 **40 次全部返回 141（SIGPIPE）**——即 v3 的回滚脚本在这台机器上会在 `[1/7]` 100% 中止，永远走不到恢复主程序那一步，不是概率问题。新写法 `grep -xF -- ... >/dev/null` 连跑 5 次全 0。`ss -tln | grep -qE` 的同类改法在本机 30 次**未**复现失败（新旧写法均 0/30），保留改法只为不再沿用错误范式，不声称有实测收益。

### 0.2 二轮审查（v2 → v3），对应 review §0 的 N1–N6

| 编号 | v2 存在的问题 | v3 处理 |
|---|---|---|
| N1 | §5.3 门禁写成 `cmd && echo`，`set -e` 不会因此中止；`-t` 失败后仍会执行 rename；只打印两个 md5 从不比较；且先发布主程序 | §5.3 重写：所有门禁改 `if ! ...; then exit 1`；四个待发布文件逐一 `cmp -s` 与暂存源比对；改为**先发 helper 与 sftp-server，最后发主程序**，把"意外重启撞上不完整新链路"的窗口压到最小 |
| N2 | §6.1 先把旧 `sshd` 发到系统再验依赖；`ldd ... \| grep -q && exit`、`sshd -T && echo` 会放行检查失败；`md5sum /proc/$P/exe \|\| true` 静默忽略 | §6.1 重写：发布前一次完成"备份校验和 / 权限 / 自身配置检查 / 新旧依赖"四类前置校验；`ldd` 先判执行是否成功、再判输出有无 `not found`；所有门禁显式 `die`；运行映像读取失败视为失败 |
| N3 | §4.7 的补备份没建目录（`cp` 到不存在的 `libexec-local/` 必失败），且 2244 预演用的是现网文件而非备份产物；归档/异地副本未更新 | §4.7 重写：`install -d -m 0700` 建目录、复制到显式文件路径、`cmp` 校验副本与源一致；2244 改用**备份的主程序 + 备份的 helper**；补备份后重打包并更新 §11 校验值（若选择不重打包，则单独登记增量备份位置与 md5） |
| N4 | §4.5 的 `-T` 没有 `-o` 覆盖，却期待输出暂存路径，会把正确的默认路径产物判成失败 | §4.5 预期改回编译期默认 `/usr/libexec/openssh/`；暂存路径只出现在 §4.6（那里显式加了 `-o`） |
| N5 | 2244 验证实例没有收尾，切换后会多留一个 9.8 listener | §4.7 增加"停止 + 端口释放 + 进程复核 + 关闭测试会话"，并写入 §5.1 门禁与 §10 清单 |
| N6 | §6.1 标题称"仅动本次 4 个文件"，实际只恢复 `/usr/sbin/sshd` | §6.1 改为如实表述"只恢复旧 listener"，逐条说明 helper 与 `sftp-server` 的真实状态，并给出"要连 `sftp-server` 一起回退"的命令 |

review §0.8 的其他说明同步修正：

| 项 | 处理位置 |
|---|---|
| `make install` 含 `install-sysconf`，暂存区**会**有配置，不能把安装期 `-t` 报错一概当作可忽略 | §4.3 |
| `awk '{print $1" -> "$3}'` 会截断 `libX => not found`；且不同程序依赖集合本就不必一致 | §4.4 |
| 替换受 RPM 管理的 `sftp-server` 会新增一个 `rpm -V` 脏文件（5 → 6），"不新增脏文件"不成立 | §2.7、§5.5 第 10 项、§7 |
| `kill -0` 只能证明 PID 可见，不能证明旧会话可交互 | §5.5 第 7 项 |

### 0.3 首轮审查（v1 → v2，R1–R6）

| 编号 | 原稿问题 | v2 处理 |
|---|---|---|
| R1 | 暂存区 sshd 用的是编译期默认路径 `/usr/libexec/openssh/`，2233 测试并未测到暂存产物 | §4.6 加 `-o SshdSessionPath=` / `-o SshdAuthPath=`（**已实测这两个选项在 10.6p1 上被接受**），改用 `/proc/<pid>/exe` 验证而非 `ps` 文本 |
| R2 | 误称"9.8 单进程、不依赖 helper"，备份缺旧 helper | 现场实测 9.8 **已是** split-privsep；§2.3 记录 `/usr/local/libexec/sshd-session`（1831936 B）并把补备份列为阶段二门禁；§6.1 回滚依赖重写 |
| R3 | 称 reload 监听不断、且以 PID 变化为成功判据 | §5.4/§5.5 改为：reload 会短暂关闭并重建监听，正常 re-exec **PID 不变**；验收改 `/proc/<MainPID>/exe` 身份 + 监听恢复 + 新登录 + 旧会话存活 |
| R4 | 承诺"最坏 42s 恢复"、`§6.3` 在主进程已退出时仍试 reload | §1/§6/§7 删除 42s 承诺；§6 按"主进程存活 / 已退出 / 启动限流"三分支 |
| R5 | "完全回滚含 PAM"与实际 `restore.sh` 不符，脚本可忽略关键失败 | §6.2 如实描述 `restore.sh` 真实行为（不恢复 PAM、`set -u` 不中断、覆盖面更宽）；§6.1 新增最小回滚脚本 `rollback-min.sh`（`set -euo pipefail` + 显式校验） |
| R6 | 版本探测被坏客户端配置阻断、校验和预期写错、会话存活用总数判断 | §5.5 全部重写：`ssh -F /dev/null -v` 读 banner；校验和预期改为"只有 `/usr/sbin/sshd` 变"；会话存活按 pid 集合比对 |
| 门禁 | —— | §10 增补"准备→发布"、2222 新登录、旧 helper 备份、动态依赖核对 等条目 |

---

## 1. 变更摘要

| 项 | 内容 |
|---|---|
| 替换版本 | OpenSSH 9.8p1（2024-08-22 手工编译）→ 10.6p1 |
| 服务端必换文件 | 3 个：`/usr/sbin/sshd` + 新增 `/usr/libexec/openssh/sshd-session`、`/usr/libexec/openssh/sshd-auth` |
| 服务端可选文件 | 1 个：`/usr/libexec/openssh/sftp-server`（当前走 `internal-sftp`，不调用它） |
| 配置文件 | **零修改**（已用 10.6 的 `-t` / `-T` 验证） |
| 主机密钥 | **不动**（客户端指纹不变） |
| 对已有会话 | **计划保留**：已认证会话由独立子进程持有，re-exec 不影响 |
| 对新连接 | **不承诺零中断**：reload 会短暂关闭并重建监听，窗口内新连接可能被拒绝或需重试 |
| 故障恢复 | **无时间上限承诺**：自动重启仍会执行同一个损坏的二进制；恢复取决于修复或回滚是否成功 |
| 旁路通道 | 2222 端口常驻 10.6 实例（本次全程从该会话操作，且阶段二前须验证它能**接受新连接**） |
| 回滚 | 旧 helper 原地未动 → 快速回滚可行；旧 helper 必须先进备份，否则回滚前提不成立 |

---

## 2. 现状基线（全部现场实测）

### 2.1 运行态

| 项 | 值 |
|---|---|
| 监听进程 | `/usr/sbin/sshd`，PID 1293214，`-D` |
| 版本 | `OpenSSH_9.8p1, OpenSSL 1.1.1q 5 Jul 2022` |
| 监听 | `0.0.0.0:22` + `[::]:22` |
| 已建立连接 | 12 条；`who` 在线 16–18 人 |
| 进程标题 | `/proc/1293214/cmdline` = `sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups`（**标题被改写，不能靠 `ps` 参数判断实际程序**） |
| 旁路实例 | PID 376266，`/root/fhy/openssh-10.6/sbin/sshd -f /etc/ssh/sshd_config -p 2222 -o PidFile=/root/fhy/sshd-2222.pid -E /root/fhy/sshd-2222.log` |

### 2.2 9.8 已经是 split-privsep（v1 的重要更正）

现场进程树（`ps -ef` + `/proc/<pid>/exe`）：

```
1293214  /usr/sbin/sshd -D [listener]                      (22 listener)
 └─ 886621  sshd-session: root [priv]      exe -> /usr/local/libexec/sshd-session
     └─ 890539  sshd-session: root@pts/0,pts/3   exe -> /usr/local/libexec/sshd-session
         └─ 890631  sshd-session: root@internal-sftp
376266  /root/fhy/openssh-10.6/sbin/sshd -p 2222          (2222 listener)
 └─ 736897  sshd-session: root [postauth]  exe -> /root/fhy/openssh-10.6/libexec/sshd-session
```

结论：
- **9.8 就把 `sshd-session` 拆出去了**（10.0 才进一步拆出 `sshd-auth`）。`/usr/sbin/sshd -T` 实测输出 `sshdsessionpath /usr/local/libexec/sshd-session`，`sshd` 的 `strings` 里也内嵌该路径。
- 22 端口当前真实使用的 helper 是 **`/usr/local/libexec/sshd-session`（1831936 B，Aug 22 2024）**，不是 `/usr/libexec/openssh/` 下那个（`/usr/libexec/openssh/` 里根本没有 `sshd-session`）。
- 9.8 无 `sshd-auth` 文件，`sshd -T` 也无 authpath 行 —— 与"10.0 引入 sshd-auth"一致。

### 2.3 备份完整性缺口（R2）

| 文件 | 现状 | 是否已备份 |
|---|---|---|
| `/usr/sbin/sshd` | 603680 B，9.8p1 | ✅ |
| `/usr/local/libexec/sshd-session` | 1831936 B，Aug 22 2024，**22 端口正在用** | ❌ **缺失** → 由 §4.7.1 补齐 |
| `/usr/libexec/openssh/sftp-server` | 146032 B | ✅ |
| `/usr/libexec/openssh/ssh-keysign` 等 | 见 §11 | ✅ |

阶段二门禁：把旧 helper 复制进 `libexec-local/`、`cmp` 校验副本、记录属主/权限/校验和，并（重打包后）更新异地副本（见 §4.7、§5.1、§11）。**只打印 md5 不等于备份可用** —— v2 里 `cp` 的目标目录当时并不存在，那条命令会直接失败，N3 已修。

### 2.4 动态依赖差异（新发现，v1 未记录）

| 二进制 | 实际解析 |
|---|---|
| 旧 `/usr/sbin/sshd`（9.8p1） | `libcrypt`、`libpam`、`libdl`、`libutil`、`libresolv`、`libnsl`、**`libmysqlclient.so.16`**、**`libxml2.so.2`**、`libpthread`、**`libcrypto.so.1.1 => /usr/lib64/ssh1.1.1/`**、`libz` |
| 旧 `/usr/local/libexec/sshd-session` | 同上（含 `libmysqlclient` / `libxml2` / 私有 OpenSSL 目录） |
| 新 `/root/fhy/openssh-10.6/sbin/sshd` | `libcrypt`、`libpam`、**`libcrypto.so.1.1 => /usr/lib64/`**、`libz`、`libc`、`libaudit`、`libcap-ng` |
| 新 `.../libexec/sshd-session` | 与上同（无 mysql/xml 污染） |

两点含义：
1. 旧二进制链到了 `libmysqlclient.so.16`、`libxml2` 和私有 OpenSSL 目录 `/usr/lib64/ssh1.1.1`，说明当年编译时 `LDFLAGS`/`--with-ssl-dir` 被污染；这些库现在都存在（`ldd` 全部解析成功），但**回滚时必须重新 `ldd` 确认**。
2. 新二进制干净，用系统 OpenSSL 1.1.1wa。10.6 的 `sshd` 与两个 helper 依赖一致，未引入额外库。

### 2.5 systemd unit 全文（v1 摘录不全，v2 补全）

```ini
# /usr/lib/systemd/system/sshd.service
[Unit]
Description=OpenSSH server daemon
Documentation=man:sshd(8) man:sshd_config(5)
After=network.target sshd-keygen.service
Wants=sshd-keygen.service

[Service]
EnvironmentFile=/etc/sysconfig/sshd
ExecStart=/usr/sbin/sshd -D $OPTIONS
ExecReload=/bin/kill -HUP $MAINPID
KillMode=process
Restart=on-failure
RestartSec=42s

[Install]
WantedBy=multi-user.target
```

- `/etc/systemd/system/sshd.service.d/` **不存在**；`systemctl cat` 未显示任何 drop-in。
- `/etc/sysconfig/sshd` **只有注释，没有 `OPTIONS=`** → `$OPTIONS` 为空，`ExecStart` 实际等价 `/usr/sbin/sshd -D`。
- `KillMode=process`：systemd 停止时只杀主进程，每连接子进程不在 kill 集合内。它约束的是 `stop`/`restart`，**与 SIGHUP 处理无关**（v1 表述已更正）。

### 2.6 关键配置（`/etc/ssh/sshd_config`）

| 行 | 内容 |
|---|---|
| 13 | `Port 22` |
| 33 | `PermitRootLogin yes` |
| 83 | `UsePAM yes` |
| 111 | `Subsystem sftp internal-sftp` |
| 119 | `HostKeyAlgorithms ssh-rsa,ecdsa-sha2-nistp256,ecdsa-sha2-nistp256,ssh-ed25519`（含重复项） |
| 120 | `KexAlgorithms curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group14-sha1` |

### 2.7 文件校验基线（`/root/fhy/baseline.md5`）

```
519207bc1a32fc5cafcdddeaff87e884  /etc/ssh/sshd_config
7c4eea6cb2fe4f55d51cc03d0a327306  /etc/ssh/ssh_config
dea201a93146e1bbdb63e373407d4fb1  /usr/sbin/sshd
9ca84bf447eaa1ed5c1ef3e1f706c344  /usr/bin/ssh
```

`rpm -V openssh-server openssh-clients` 现状已有 5 个脏文件（`sshd_config`、`sshd.service`、`/usr/sbin/sshd`、`/usr/bin/scp`、`/usr/bin/ssh`），属 2024 年手工编译遗留。

**本方案会改变这个数字**（v2 此处判断有误）：客户端保持 9.8、`/usr/bin/ssh`、`/usr/bin/scp` 不变；但 `/usr/libexec/openssh/sftp-server` 归 `openssh-server` 所有，若按 §5.2 一并替换（默认建议换），切换后 `rpm -V openssh-server` 会多出一条 `S.5....T. /usr/libexec/openssh/sftp-server`，脏文件数 5 → 6。这是**预期内的新增**，必须写进 §5.6 的切换后基线；若不换 `sftp-server`，则维持 5 个。

---

## 3. helper 布局为什么决定方案（R1/R2 修订后的表述）

事实（已在 10.6p1 源码与二进制上核实）：

1. `sshd` 在 **main() 准备监听器时**就 `stat()` 两个 helper，不存在或不可执行立即 `fatal("%s does not exist or is not executable")`（`sshd.c:1814` 为 session 路径、`sshd.c:1820` 为 auth 路径，均已对照 10.6p1 源码行号核实）。也就是说缺 helper 是**启动即失败**，不是"连上来才失败"。
2. `-t`（配置检查）不覆盖这段逻辑 —— `-t` 通过**不能证明**服务能起来（v1 的 §4.5→§4.6 推论已作废）。
3. helper 路径是编译期默认值，可被配置项覆盖：10.6p1 支持 `SshdSessionPath` / `SshdAuthPath`，实测
   `sshd -t -o SshdSessionPath=/tmp/x`、`-o SshdAuthPath=/tmp/x`（含大小写混写）均返回 0，
   `sshd -T` 输出 `SshdSessionPath ...` / `SshdAuthPath ...`。
4. `DESTDIR` 只改安装落点，**不改运行时默认路径**。因此"把暂存目录里的 sshd 直接跑起来"仍会去找 `/usr/libexec/openssh/`。

所以：
- 生产布局用 `--prefix=/usr --libexecdir=/usr/libexec/openssh` 重编，helper 落到标准路径；
- 阶段一的 2233 测试用 `-o` 显式指向暂存产物，才真正测到"这一套文件"；
- 旧 helper 在 `/usr/local/libexec/`，与新路径不重叠 → **替换不会覆盖旧 helper**，这是快速回滚能成立的前提（但仍必须补备份，见 §2.3）。

---

## 4. 阶段一：重编标准路径产物（不触碰系统）

### 4.1 解包

```bash
rm -rf /root/fhy/build-usr
mkdir -p /root/fhy/build-usr
tar xzf /root/fhy/openssh-10.6p1.tar.gz -C /root/fhy/build-usr
chown -R root:root /root/fhy/build-usr     # 源码包内 uid/gid 为上游 1000，本机 1000=dolphinscheduler
cd /root/fhy/build-usr/openssh-10.6p1
```

### 4.2 configure

```bash
./configure \
  --prefix=/usr \
  --sysconfdir=/etc/ssh \
  --libexecdir=/usr/libexec/openssh \
  --with-pid-dir=/run \
  --with-pam \
  --with-privsep-path=/var/empty \
  2>&1 | tee /root/fhy/build-usr/cfg.log
echo "CFGEXIT=${PIPESTATUS[0]}"
```

预期 `CFGEXIT=0`，日志含 `PAM is enabled`、OpenSSL 1.1.1wa、`zlib ok`。

> 不加 `--with-ssl-dir`：系统默认即 `/usr/lib64`，§2.4 已证新产物干净。若后续 `ldd` 显示链到 `/usr/lib64/ssh1.1.1` 之外的异常库，再单独讨论。

### 4.3 编译与暂存安装

```bash
make -j8 2>&1 | tee /root/fhy/build-usr/build.log
echo "MKEXIT=${PIPESTATUS[0]}"

rm -rf /root/fhy/stage-usr
make install DESTDIR=/root/fhy/stage-usr 2>&1 | tee /root/fhy/build-usr/inst.log
echo "INSEXIT=${PIPESTATUS[0]}"
```

预期 `MKEXIT=0`（仅 format-truncation 类警告），`INSEXIT=0`。

**`DESTDIR` 的作用已核实**（`Makefile.in:493-496`）：

```make
host-key: ssh-keygen$(EXEEXT)
	@if [ -z "$(DESTDIR)" ] ; then \
		./ssh-keygen -A ; \
	fi
```

`DESTDIR` 非空即跳过主机密钥生成，因此本次不会碰 `/etc/ssh`。

另外 `Makefile.in:430` 的安装期自检是 `-$(DESTDIR)$(sbindir)/sshd -t -f $(DESTDIR)$(sysconfdir)/sshd_config`，行首的 `-` 表示该步失败不致命。

**不要预设它会失败**（v2 的判断不成立）：普通 `make install` 会执行 `install-sysconf`，因此暂存区里**会存在** `/root/fhy/stage-usr/etc/ssh/sshd_config`（安装产物的默认配置，不是对真实 `/etc/ssh` 的修改）。既然配置文件存在，这条 `-t` 可能直接通过，也可能因暂存区没有主机密钥等其它原因失败。要求读出真实诊断并逐条解释：

```bash
ls -l /root/fhy/stage-usr/etc/ssh/            # 确认暂存配置确实被创建（预期存在）
grep -nE 'sshd -t|SSHD-TEST|no hostkeys|Unable to load|Bad configuration|missing' \
  /root/fhy/build-usr/inst.log               # 读出安装期 -t 的真实报错文本
```

- 报错是"暂存区缺少主机密钥"这类环境原因 → 可忽略，但要在记录里写明是哪一条，不要笼统写"可忽略"。
- 报错是配置语法/编译问题 → **停止**，先查清楚再继续。

同时立即复核真实 `/etc/ssh` 未被改动：

```bash
md5sum -c /root/fhy/baseline.md5          # 4 行全 OK
ls -l /etc/ssh/ | grep -i mldsa           # 期望无输出
ls -lt /etc/ssh/ | head -5                # 期望无本次时间戳的新文件
```

> 运行验证一律用 `-f /etc/ssh/sshd_config`（真实配置），**不要**用暂存区那份默认配置 —— 两者内容完全不同。

### 4.4 产物与依赖核对（R2 要求的"不能只看 -V"）

```bash
set -uo pipefail
S=/root/fhy/stage-usr
ls -l $S/usr/sbin/sshd $S/usr/libexec/openssh/sshd-session \
      $S/usr/libexec/openssh/sshd-auth $S/usr/libexec/openssh/sftp-server
$S/usr/sbin/sshd -V
$S/usr/bin/ssh -V

# ldd：保留原始输出，先判"命令是否执行成功"，再判"是否有 not found"
for f in $S/usr/sbin/sshd $S/usr/libexec/openssh/sshd-session \
         $S/usr/libexec/openssh/sshd-auth $S/usr/libexec/openssh/sftp-server; do
  echo "== $f"
  if ! deps=$(ldd "$f" 2>&1); then
    printf 'FATAL: ldd 执行失败: %s\n%s\n' "$f" "$deps" >&2
    exit 1
  fi
  printf '%s\n' "$deps"
  if grep -F 'not found' <<<"$deps" >/dev/null; then
    printf 'FATAL: %s 存在未解析依赖\n' "$f" >&2
    exit 1
  fi
done

strings $S/usr/sbin/sshd | grep -E '^/usr/libexec/openssh/(sshd-session|sshd-auth)$'
```

预期：

| 文件 | 参考大小 |
|---|---|
| `usr/sbin/sshd` | ≈ 596752 |
| `usr/libexec/openssh/sshd-session` | ≈ 1052208 |
| `usr/libexec/openssh/sshd-auth` | ≈ 1014864 |
| `usr/libexec/openssh/sftp-server` | ≈ 162088 |

判据（v3 修正，不再做 `awk` 截断，也不要求依赖集合"彼此一致"）：

1. 版本：`OpenSSH_10.6p1, OpenSSL 1.1.1wa 16 Nov 2023`
2. `strings` 命中 `/usr/libexec/openssh/sshd-session` 与 `.../sshd-auth`（**不是** `/root/fhy/...`）—— 这是"可以直接替换到系统路径"的判据
3. 四个程序 `ldd` 均无 `not found`，且 `libcrypto.so.1.1` 解析到 `/usr/lib64/`（**不是**旧二进制那条 `/usr/lib64/ssh1.1.1/`）
4. 四个程序的依赖集合**不必彼此相同**（`sshd` 链 PAM/audit/cap-ng，`sftp-server` 不需要），只要求"各自与 §2.4 记录的新二进制同类依赖相符、库路径正确、无缺失"
5. 任何一条 `ldd` 执行失败或输出无法解释 → 停止，不要进入 §4.5

### 4.5 配置检查（仅作门槛，不当作能启动的证据）

```bash
$S/usr/sbin/sshd -t -f /etc/ssh/sshd_config; echo "TESTEXIT=$?"
$S/usr/sbin/sshd -T -f /etc/ssh/sshd_config | grep -Ei '^(port|usepam|permitrootlogin|subsystem|hostkeyalgorithms|kexalgorithms|sshdsessionpath|sshdauthpath)'
```

预期 `TESTEXIT=0`，`Subsystem sftp internal-sftp`、`UsePAM yes` 保留。

两条 `Sshd*Path` 的预期值：**`/usr/libexec/openssh/sshd-session` 与 `/usr/libexec/openssh/sshd-auth`**（编译期默认值，因为本步没有加任何 `-o` 覆盖）。

> v2 此处期待暂存路径 `/root/fhy/stage-usr/...`，与本步命令自相矛盾，会把正确的产物判成失败 —— 已按 N4 修正。暂存路径只在 §4.6 出现，那里显式传了 `-o SshdSessionPath` / `-o SshdAuthPath`。

> 明确：本步通过**不代表** §4.6 能启动（见 §3 第 1、2 条）。

### 4.6 2233 端口全链路验证（覆盖 helper 路径）

```bash
S=/root/fhy/stage-usr
$S/usr/sbin/sshd \
  -f /etc/ssh/sshd_config \
  -p 2233 \
  -o PidFile=/root/fhy/sshd-2233.pid \
  -o SshdSessionPath=$S/usr/libexec/openssh/sshd-session \
  -o SshdAuthPath=$S/usr/libexec/openssh/sshd-auth \
  -E /root/fhy/sshd-2233.log
echo "STARTEXIT=$?"
ss -tlnp | grep 2233
```

预期 `STARTEXIT=0`、监听 `0.0.0.0:2233`；日志无 `does not exist or is not executable` / `unable to`。

验证项：

1. **协议入口**（自动）：`timeout 5 bash -c 'exec 3<>/dev/tcp/10.5.20.39/2233; head -c 40 <&3'` → `SSH-2.0-OpenSSH_10.6`
2. **真账号登录**（人工，LyShell 新建 `10.5.20.39:2233` 会话）：口令登录成功
3. **SFTP**（人工）：该会话文件管理器列目录 + 上传 + 下载各一
4. **helper 归属**（自动，替代 `ps | grep`）：登录后立刻
   ```bash
   L=$(cat /root/fhy/sshd-2233.pid)
   for p in $(pgrep -P "$L"; pgrep -P "$(pgrep -P "$L" | head -1)"); do
     echo "$p $(readlink -f /proc/$p/exe)"
   done
   ```
   预期出现 `.../stage-usr/usr/libexec/openssh/sshd-session` —— **这才是"测的是暂存产物"的证据**（§4.6 的 `-o` 与 §4.4 的 `strings` 共同保证）
5. **认证日志**（自动）：`grep -E 'Accepted|Failed' /root/fhy/sshd-2233.log`

收尾：

```bash
kill "$(cat /root/fhy/sshd-2233.pid)"
sleep 1; ss -tlnp | grep -c 2233     # 期望 0
```

> 任一项失败 → **停止**，不进阶段二。此时系统零改动，删 `/root/fhy/build-usr`、`/root/fhy/stage-usr` 即可。
> 本步证明"暂存产物能跑通业务链路"；正式安装后仍需按 §5.5 验证**不带 `-o` 覆盖**的默认链路。

### 4.7 旧链路回滚能力预演（R2 + N3/N5 门禁，阶段二前必须做）

目的：把"能回滚"从假设变成已验证 —— 用**备份里的主程序 + 备份里的 helper** 真正登录一次。

#### 4.7.1 补备份旧 helper（N3：必须先建目录、复制到显式文件路径）

```bash
set -euo pipefail
B=/root/openssh-backup-20261023-100913
OLD_HELPER=/usr/local/libexec/sshd-session

install -d -m 0700 "$B/libexec-local"
[ -f "$OLD_HELPER" ] || { echo "FATAL: 旧 helper 不存在 $OLD_HELPER" >&2; exit 1; }
cp -p "$OLD_HELPER" "$B/libexec-local/sshd-session"

cmp -s "$OLD_HELPER" "$B/libexec-local/sshd-session" \
  || { echo "FATAL: helper 副本与源不一致" >&2; exit 1; }
stat -c '%n %U:%G %a %s' "$OLD_HELPER" "$B/libexec-local/sshd-session"
md5sum "$OLD_HELPER" "$B/libexec-local/sshd-session"
```

同时确认备份里的主程序就是现网正在跑的 9.8（不一致说明备份过期，先重做备份而非继续）：

```bash
cmp -s "$B/sbin/sshd" /usr/sbin/sshd && echo "BACKUP-SSHD-SAME" \
  || { echo "FATAL: 备份与现网不一致，先重做备份再继续" >&2; exit 1; }
md5sum "$B/sbin/sshd"      # 应为 dea201a93146e1bbdb63e373407d4fb1
```

#### 4.7.2 用备份产物在 2244 自证（N3：不能用现网文件顶替）

```bash
B=/root/openssh-backup-20261023-100913
"$B/sbin/sshd" -f /etc/ssh/sshd_config -p 2244 \
  -o PidFile=/root/fhy/sshd-2244.pid \
  -o SshdSessionPath="$B/libexec-local/sshd-session" \
  -E /root/fhy/sshd-2244.log
echo "START2244=$?"
ss -tlnp | grep 2244
pgrep -af 'sshd.*2244'
```

> 9.8 的 helper 路径同样是编译期默认值，必须用 `-o SshdSessionPath=` 指到**备份副本**；否则测到的是现网 `/usr/local/libexec/sshd-session`，回滚能力仍未被证实。

验收（必须真账号走一遍）：

1. LyShell 新建 `10.5.20.39:2244` 会话，口令登录成功
2. 该会话文件管理器列目录 + 上传 + 下载各一次
3. 证明子进程用的是备份副本：
   ```bash
   L=$(cat /root/fhy/sshd-2244.pid)
   for p in $(pgrep -P "$L"); do echo "$p $(readlink -f /proc/$p/exe)"; done
   ```
   预期出现 `$B/libexec-local/sshd-session`（**不是** `/usr/local/libexec/sshd-session`）
4. `grep -E 'Accepted|Failed' /root/fhy/sshd-2244.log`

#### 4.7.3 收尾（N5：不做会遗留一个 9.8 listener）

```bash
kill "$(cat /root/fhy/sshd-2244.pid)"; sleep 1
ss -tlnp | grep -c 2244        # 期望 0
pgrep -af 'sshd.*2244'         # 期望无输出
```

并在 LyShell 界面里**关闭 2244 测试会话**，避免它的子进程 PID 混进阶段二的"旧会话基线"。

#### 4.7.4 备份归档与异地副本（N3）

```bash
cd /root
tar czf /root/openssh-backup-20261023-100913.tar.gz openssh-backup-20261023-100913
chmod 600 /root/openssh-backup-20261023-100913.tar.gz
tar -tzf /root/openssh-backup-20261023-100913.tar.gz | grep libexec-local
md5sum /root/openssh-backup-20261023-100913.tar.gz
```

然后重新下载到本机覆盖 `D:\workspace\download\lyshell\10.5.20.39 Copy\openssh-backup-20.39.tar.gz`，并更新 §11 的包大小与 md5（重打包后原值 `f26f0ae4153e42bfc6c848036d6aac45` 必然失效）。

若选择**不重打包**：必须在 §11 单独登记增量备份 `/root/openssh-backup-20261023-100913/libexec-local/sshd-session` 的路径、大小与 md5，并注明它不在 tar 包内。

---

## 5. 阶段二：替换系统文件

### 5.1 前置门禁（全部满足才开工）

- [ ] §4 全部通过；§4.7 旧链路回滚预演通过（含用**备份副本**登录成功）
- [ ] 旧 helper 已进备份，且 `cmp -s /usr/local/libexec/sshd-session "$B/libexec-local/sshd-session"` 通过
- [ ] `cmp -s "$B/sbin/sshd" /usr/sbin/sshd` 通过（备份与现网一致，回滚才有意义）
- [ ] 2244 测试实例**已停止、端口已释放**，2244 测试会话已关闭（N5，避免遗留 9.8 listener 与脏 PID 基线）
- [ ] 备份 tar 已重打包、异地副本已更新，§11 的 md5 与实际一致
- [ ] `/root/fhy/rollback-min.sh` 已落地、`chmod 700`、且已在本机 `bash -n` 语法通过
- [ ] 操作通道是 2222 会话，且**刚刚新建过一次连接**（证明旁路能接受新连接，不只是旧会话还活着）
- [ ] 记录基线：`systemctl show sshd -p MainPID --value`、`pgrep -a sshd-session` 全量 pid、`ss -tn state established '( sport = :22 )'` 不含表头的桶数量
- [ ] 记录一个**固定旧会话**用于存活验收：`who` 里的 `pts/N`、其 `sshd-session` pid、`awk '{print $22}' /proc/<pid>/stat` 的 starttime
- [ ] 确认 `/etc/sysconfig/sshd` 仍无 `OPTIONS`、无 systemd drop-in

### 5.2 替换清单

服务端（必须有）：

| # | 目标 | 来源 | 权限 |
|---|---|---|---|
| 1 | `/usr/sbin/sshd` | `stage/usr/sbin/sshd` | `0755 root:root` |
| 2 | `/usr/libexec/openssh/sshd-session` | `stage/usr/libexec/openssh/sshd-session` | `0755 root:root`（新增） |
| 3 | `/usr/libexec/openssh/sshd-auth` | `stage/usr/libexec/openssh/sshd-auth` | `0755 root:root`（新增） |

服务端（可选，建议）：`/usr/libexec/openssh/sftp-server`（`0755 root:root`）。注意它是 RPM 管理文件，替换后会新增一条 `rpm -V` 脏记录（§2.7）；当前配置走 `internal-sftp`，不换也不影响功能。

**本轮不动客户端**（决策 D1）：`/usr/bin/*`、`/usr/libexec/openssh/ssh-keysign` 等保持 9.8，因此 `/usr/bin/ssh` 的校验和**应继续为 OK**（v1 §5.5 第 9 项写错，已改）。
`/usr/bin/ssh-copy-id` 保留（10.6 未装该文件，纯 shell 脚本，版本无关）。

### 5.3 发布方式：先全部备好并逐字节比对，再"先 helper 后主程序"逐个 rename

```bash
set -euo pipefail
S=/root/fhy/stage-usr/usr

# 0) 待发布文件齐全（逐条显式失败，不依赖 set -e 去终止 && 链）
for f in "$S/sbin/sshd" \
         "$S/libexec/openssh/sshd-session" \
         "$S/libexec/openssh/sshd-auth" \
         "$S/libexec/openssh/sftp-server"; do
  if [ ! -f "$f" ] || [ ! -x "$f" ]; then
    echo "FATAL: 缺失或不可执行: $f" >&2; exit 1
  fi
done

# 1) 全部落到同目录隐藏临时文件（此时系统仍未变）
install -m 0755 -o root -g root "$S/sbin/sshd"                    /usr/sbin/.sshd.10.6.new
install -m 0755 -o root -g root "$S/libexec/openssh/sshd-session" /usr/libexec/openssh/.sshd-session.10.6.new
install -m 0755 -o root -g root "$S/libexec/openssh/sshd-auth"    /usr/libexec/openssh/.sshd-auth.10.6.new
install -m 0755 -o root -g root "$S/libexec/openssh/sftp-server"  /usr/libexec/openssh/.sftp-server.10.6.new

# 2) 每个临时文件都与暂存源逐字节比对（不是"打印两个 md5 让人肉眼看"）
cmp -s /usr/sbin/.sshd.10.6.new                    "$S/sbin/sshd" \
  || { echo "FATAL: sshd 副本不一致" >&2; exit 1; }
cmp -s /usr/libexec/openssh/.sshd-session.10.6.new "$S/libexec/openssh/sshd-session" \
  || { echo "FATAL: sshd-session 副本不一致" >&2; exit 1; }
cmp -s /usr/libexec/openssh/.sshd-auth.10.6.new    "$S/libexec/openssh/sshd-auth" \
  || { echo "FATAL: sshd-auth 副本不一致" >&2; exit 1; }
cmp -s /usr/libexec/openssh/.sftp-server.10.6.new  "$S/libexec/openssh/sftp-server" \
  || { echo "FATAL: sftp-server 副本不一致" >&2; exit 1; }

# 3) 临时文件自检（失败必须中止）
if ! /usr/sbin/.sshd.10.6.new -V; then
  echo "FATAL: 临时 sshd -V 失败" >&2; exit 1
fi
if ! /usr/sbin/.sshd.10.6.new -t -f /etc/ssh/sshd_config; then
  echo "FATAL: PRE-T 失败（临时 sshd 不接受现有配置）" >&2; exit 1
fi
echo "PRE-T=0"

# 4) 先发布 helper 与 sftp-server，最后发布主程序
mv -f /usr/libexec/openssh/.sshd-session.10.6.new /usr/libexec/openssh/sshd-session
mv -f /usr/libexec/openssh/.sshd-auth.10.6.new    /usr/libexec/openssh/sshd-auth
mv -f /usr/libexec/openssh/.sftp-server.10.6.new  /usr/libexec/openssh/sftp-server
mv -f /usr/sbin/.sshd.10.6.new                    /usr/sbin/sshd

# 5) 复核（同样显式失败）
if ! /usr/sbin/sshd -V; then echo "FATAL: POST -V 失败" >&2; exit 1; fi
if ! /usr/sbin/sshd -t -f /etc/ssh/sshd_config; then
  echo "FATAL: POST-T 失败 → 立即按 §6.1 回滚" >&2; exit 1
fi
echo "POST-T=0"
ls -l /usr/sbin/sshd /usr/libexec/openssh/sshd-session /usr/libexec/openssh/sshd-auth
```

> rename 是**逐文件原子**，不是整体事务；中途失败时系统可能处于"部分已换"状态，按 §6 处理。
>
> **顺序为什么是 helper 先、sshd 后**：旧 sshd 的 helper 在 `/usr/local/libexec/`，与新路径不重叠，所以"新 helper 已就位 + 旧主程序"是可工作的组合；反过来"新主程序 + 缺 helper"是启动即 `fatal`。虽然两次 rename 之间只有微秒级，但把不可避免的窗口指向可工作的那一边没有额外成本。
>
> 若按 D2 决定**不换** `sftp-server`：删掉第 0 步清单里的那一项、第 2 步对应的 `cmp`、第 1 步对应的 `install`、第 4 步对应的 `mv`（共 4 处），其余不变。

### 5.4 生效：reload（同步修正 R3/R4）

```bash
systemctl show sshd -p MainPID --value        # 记下 OLD_MAIN
systemctl reload sshd; echo "RELOAD_EXIT=$?"
sleep 3
systemctl show sshd -p ActiveState -p SubState -p MainPID --value
readlink -f /proc/$(systemctl show sshd -p MainPID --value)/exe
md5sum /usr/sbin/sshd
grep -a -E 'Received SIGHUP|restarting' /var/log/secure | tail -3
```

正确预期（与 v1 相反）：

| 判据 | 预期 |
|---|---|
| `MainPID` | **不变**（`execv` 替换进程映像，PID 保留） |
| `/proc/<MainPID>/exe` | `/usr/sbin/sshd`，且 `md5sum /proc/<MainPID>/exe` 等于新二进制 |
| 监听 | **会短暂中断后恢复**；`reload` 返回 0 只表示信号已送达，属异步 |
| 日志 | `Received SIGHUP; restarting` |
| 已认证会话 | 子进程继续服务，旧会话可用 |

若 `MainPID` 变了 → 说明主进程退出、systemd 重启，**这是异常**，按 §6.3 排查，不要当成功。

### 5.5 生效后验收（R3/R6 重写）

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 监听恢复 | `for i in $(seq 1 20); do ss -tln \| grep ':22 ' >/dev/null && break; sleep 1; done; ss -tln \| grep ':22 '` | v4/v6 都在听 |
| 2 | 运行映像 | `P=$(systemctl show sshd -p MainPID --value); md5sum /proc/$P/exe` | 与新 `/usr/sbin/sshd` 校验和相同 |
| 3 | 协议入口 | `ssh -F /dev/null -v -o BatchMode=yes -o ConnectTimeout=5 -p 22 root@10.5.20.39 true 2>&1 \| grep -i 'remote software version'` | `OpenSSH_10.6`。**必须带 `-F /dev/null`**，否则被 §9.1 的坏配置阻断；此步只证协议可达 |
| 4 | 真实登录 | LyShell 新建 22 会话 + 口令登录 | 成功 |
| 5 | SFTP | 该会话文件管理器上传/下载 | 成功 |
| 6 | 新连接用新 helper | 新连接建立后：`P=$(systemctl show sshd -p MainPID --value); for c in $(pgrep -P $P); do readlink -f /proc/$c/exe; done` | 出现 `/usr/libexec/openssh/sshd-session`（不是 `sshd-auth` 之外的旧路径） |
| 7 | 旧会话仍**可用** | 在 §5.1 选定并记录的固定旧会话里执行 `echo OLD-SESSION-ALIVE` 并读回输出；同时核对它的 `sshd-session` pid 仍存在、`awk '{print $22}' /proc/<pid>/stat` 的 starttime 与基线一致 | 命令有回显 = 会话可交互。`kill -0` 只证明 pid 可见，不能单独作为证据；`who`/`ss` 的总数变化也不等于该会话断开 |
| 8 | 认证链路 | `tail -60 /var/log/secure`；`journalctl -u sshd -n 50` | 有 `Accepted`；无 `pam_`/`does not exist` 错误 |
| 9 | 配置生效值 | `/usr/sbin/sshd -T \| grep -E '^(port\|subsystem\|usepam)'` | `port 22`、`subsystem sftp internal-sftp`、`usepam yes` |
| 10 | 校验和变化范围 | `md5sum -c /root/fhy/baseline.md5` | `sshd_config` **OK**、`ssh_config` **OK**、`/usr/sbin/sshd` **FAILED（预期）**、`/usr/bin/ssh` **OK（本轮未换客户端）** |

第 10 项补充：若 §5.2 的 `sftp-server` 也换了，它**不在** `baseline.md5` 的四项里，需要另行比对 —— 见 §5.6。同一次检查里请顺带记录 `rpm -V openssh-server openssh-clients`：预期由 5 条脏文件变成 6 条（新增 `/usr/libexec/openssh/sftp-server`），这是 §2.7 已声明的预期变化。

### 5.6 替换后基线

```bash
{
  for f in /etc/ssh/sshd_config /etc/ssh/ssh_config /usr/sbin/sshd /usr/bin/ssh \
           /usr/libexec/openssh/sshd-session /usr/libexec/openssh/sshd-auth \
           /usr/libexec/openssh/sftp-server /usr/local/libexec/sshd-session; do
    [ -e "$f" ] && md5sum "$f"
  done
} > /root/fhy/baseline-after-10.6.md5
{
  echo "--- rpm -V openssh-server openssh-clients"
  rpm -V openssh-server openssh-clients 2>&1 || true
} >> /root/fhy/baseline-after-10.6.md5
cat /root/fhy/baseline-after-10.6.md5
```

预期该文件里 `/usr/libexec/openssh/sftp-server` 是新 md5，`rpm -V` 段出现 `sftp-server` 一行（若按 D2 替换）。

### 5.7 切换超时与人工回滚触发条件（R4）

- 切换验收窗口：`reload` 后 **10 分钟**内必须满足 §5.5 第 1、3、4、5 项。
- 触发人工回滚的条件（任一）：监听 60s 内未恢复；banner 不是 10.6 且日志报 `does not exist or is not executable`；真实登录连续 2 次失败；SFTP 不可用。
- 不设"最长 42s 自动恢复"承诺：`RestartSec` 只管自动重启的等待，且重启仍执行同一份文件；认证链路故障（listener 活着、每连接子进程失败）根本不会触发自动重启。

---

## 6. 回滚

### 6.1 最小回滚脚本 `rollback-min.sh`（只恢复旧 listener）

先落地为 `/root/fhy/rollback-min.sh`（`chmod 700`，`bash -n` 校验语法），内容：

```bash
#!/usr/bin/env bash
# 只把 /usr/sbin/sshd 换回备份里的 9.8；不动 /usr/local/libexec/sshd-session，
# 不回滚 /usr/libexec/openssh/{sshd-session,sshd-auth,sftp-server}。范围说明见方案 §6.1。
set -euo pipefail
B=/root/openssh-backup-20261023-100913
OLD_HELPER=/usr/local/libexec/sshd-session
EXPECT_MD5_SSHD=dea201a93146e1bbdb63e373407d4fb1
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

echo "[1/7] 发布前校验：备份、权限、依赖、配置（此时系统仍是新版本，未改动）"
[ -f "$B/sbin/sshd" ] || die "备份主程序缺失: $B/sbin/sshd"
got=$(md5sum <"$B/sbin/sshd" | cut -d' ' -f1)
[ "$got" = "$EXPECT_MD5_SSHD" ] || die "备份主程序校验和不是 9.8 基线: $got"
stat -c '  备份主程序 %n %U:%G %a %s' "$B/sbin/sshd"

# 备份主程序编译期期望的 helper 路径，必须与本脚本恢复的那份一致（"匹配 helper"）
# 不用 grep -q：它在匹配后立刻退出，上游 strings 可能收到 SIGPIPE，pipefail 下会把
# "匹配成功"判成整个管道失败，从而在真正回滚前就中止。这里完整消费输入。
if ! strings "$B/sbin/sshd" | grep -xF -- "$OLD_HELPER" >/dev/null; then
  die "备份主程序的默认 helper 路径不含 $OLD_HELPER，链路不匹配"
fi

# 旧 helper 缺失时，先从备份副本恢复（N2：回滚链路必须能自洽恢复）
if [ ! -x "$OLD_HELPER" ]; then
  if [ -x "$B/libexec-local/sshd-session" ]; then
    install -d -m 0755 -o root -g root /usr/local/libexec
    install -m 0755 -o root -g root "$B/libexec-local/sshd-session" "$OLD_HELPER"
    echo "  已从备份恢复旧 helper: $OLD_HELPER"
  else
    die "旧 helper 缺失且无备份副本: $OLD_HELPER"
  fi
fi

if ! deps=$(ldd "$OLD_HELPER" 2>&1); then
  printf '%s\n' "$deps" >&2; die "ldd 旧 helper 执行失败"
fi
if grep -F 'not found' <<<"$deps" >/dev/null; then
  printf '%s\n' "$deps" >&2; die "旧 helper 存在未解析依赖"
fi

if ! deps=$(ldd "$B/sbin/sshd" 2>&1); then
  printf '%s\n' "$deps" >&2; die "ldd 备份主程序执行失败"
fi
if grep -F 'not found' <<<"$deps" >/dev/null; then
  printf '%s\n' "$deps" >&2; die "备份主程序存在未解析依赖"
fi

if ! "$B/sbin/sshd" -t -f /etc/ssh/sshd_config; then
  die "备份主程序不接受当前配置文件"
fi
echo "  旧链路自检通过"

echo "[2/7] 准备回滚临时文件并做 T 检查"
install -m 0755 -o root -g root "$B/sbin/sshd" /usr/sbin/.sshd.rollback
cmp -s "$B/sbin/sshd" /usr/sbin/.sshd.rollback || die "回滚临时文件与备份不一致"
if ! /usr/sbin/.sshd.rollback -t -f /etc/ssh/sshd_config; then
  die "回滚临时文件 PRE-T 失败"
fi

echo "[3/7] 发布旧主程序"
mv -f /usr/sbin/.sshd.rollback /usr/sbin/sshd
/usr/sbin/sshd -V || die "发布后 -V 失败"

echo "[4/7] 生效：主进程存活则 reload，否则 start"
MAIN=$(systemctl show sshd -p MainPID --value)
if [ "${MAIN:-0}" != "0" ] && kill -0 "$MAIN" 2>/dev/null; then
  systemctl reload sshd
else
  systemctl reset-failed sshd 2>/dev/null || true
  systemctl start sshd
fi

echo "[5/7] 等待 22 监听恢复（最多 60s）"
ok=0
for i in $(seq 1 60); do
  if ss -tln | grep -E '(:22 |:22$)' >/dev/null; then ok=1; break; fi
  sleep 1
done
[ "$ok" = 1 ] || die "22 未恢复监听"

echo "[6/7] 运行态核验"
systemctl is-active sshd || die "sshd 不是 active"
P=$(systemctl show sshd -p MainPID --value)
[ "${P:-0}" != "0" ] || die "MainPID=0，主进程未运行"
if ! img=$(md5sum "/proc/$P/exe" 2>&1); then
  printf '%s\n' "$img" >&2; die "无法读取 /proc/$P/exe"
fi
printf '%s\n' "$img"
if ! /usr/sbin/sshd -T -f /etc/ssh/sshd_config >/dev/null; then
  die "配置解析失败"
fi
echo "CONFIG-Ok"

echo "[7/7] 仍需人工：新建 22 连接 + 口令登录 + 文件管理器上传/下载"
```

为什么这样写（对应 N2）：

1. **先校验、后动手**：v2 先把旧 `sshd` 铺到系统再验依赖，一旦发现回滚链路不可用，磁盘上已经是旧主程序、运行态可能还是新进程，等于把"半回滚"写死了。现在所有前置校验都在 `[1/7]` 完成，失败时系统**一个字节都没动**。
2. **门禁不能写成 `cmd && {...}`**：bash 的 `errexit` 对 `&&` 列表中非末尾命令的失败不生效，`ldd ... | grep -q 'not found' && exit 1` 这种写法在 `ldd` 自身失败时会静默放行。全部改成 `if ! ...; then die ...; fi`。
3. **`ldd` 分两步判**：先判"命令是否执行成功"，再判"输出里有没有 `not found`"；`grep -q` 提前退出可能让上游吃 SIGPIPE，不能把整体非零一律当作"没缺库"。
4. **不静默忽略**：v2 的 `md5sum /proc/$P/exe || true` 已删除 —— 读不到运行映像就是失败。
5. 脚本退出 0 **不代表** 22 已可登录：第 7 步仍是人工验收。
6. **helper 可自愈**：若 `/usr/local/libexec/sshd-session` 已丢失，脚本在 `[1/7]` 就会用 `libexec-local/` 里的备份副本恢复它（`install -d` + `install -m 0755`）；连备份副本都没有则直接 `die`，不会带着残缺链路去 reload。
7. **不用 `grep -q`（N7）**：`pipefail` 下，`strings ... | grep -qxF` 里 `grep -q` 匹配即退出，上游 `strings` 可能吃到 SIGPIPE（141），管道整体非零 → 明明路径匹配了却走 `die`，在真正回滚之前就自我中止。改成 `grep -xF ... >/dev/null` 完整消费输入；第 5 步等 22 监听同理。

**回滚范围（N6，必须如实告知）**：本脚本只把 `/usr/sbin/sshd` 换回 9.8。

| 文件 | 回滚后状态 |
|---|---|
| `/usr/sbin/sshd` | 9.8（已恢复） |
| `/usr/local/libexec/sshd-session` | 未动（旧链路依赖它，所以能工作） |
| `/usr/libexec/openssh/sshd-session`、`sshd-auth` | 保留 10.6 产物（新 sshd 已不在用，无害；如需清理等 24h 观察后单独做） |
| `/usr/libexec/openssh/sftp-server` | 保留 10.6 产物。现网 `Subsystem sftp internal-sftp` 不调用它，因此不影响传文件 |

若要把 `sftp-server` 也退回去：

```bash
install -m 0755 -o root -g root \
  /root/openssh-backup-20261023-100913/libexec/sftp-server \
  /usr/libexec/openssh/sftp-server
```

（会让 `rpm -V` 的 sftp-server 行同时回到 OK。）

### 6.2 全量回滚工具 `restore.sh` 的真实行为（R5，不再称"含 PAM"）

`/root/openssh-backup-20261023-100913/restore.sh` 实际做的是：

```bash
set -u
systemctl stop sshd
cp -a $D/sbin/sshd /usr/sbin/sshd
cp -a $D/bin/. /usr/bin/
cp -a $D/libexec/. /usr/libexec/openssh/
cp -a $D/etc-ssh/. /etc/ssh/
cp -a $D/systemd/sshd.service /usr/lib/systemd/system/sshd.service
systemctl daemon-reload
systemctl start sshd
sleep 1
ss -tlnp | grep ':22 '
sshd -V 2>&1 || /usr/sbin/sshd -V
```

必须知道的三点：

1. **不恢复 PAM**：包里有 `pam/`，脚本不复制它，也不回退 pam RPM。
2. **关键失败可被忽略**：`set -u` 只查未定义变量；复制/启动/监听失败不会中止脚本，末尾 `sshd -V` 成功时退出码可能仍是 0。
3. **恢复范围比本次变更宽**：会覆盖全部备份客户端文件与整个 `/etc/ssh/`（含主机密钥），不是最小回滚。

因此：优先用 §6.1；只有在"最小回滚失败"时，才用 `restore.sh` 做**全量重置**，并把它视为"回到 9.8 + 原配置"的重建动作，事后重新核对主机密钥指纹。

### 6.3 故障分支

| 现象 | 判断 | 处理 |
|---|---|---|
| reload 后 22 无监听，`journalctl -u sshd` 报 `... does not exist or is not executable` | helper 路径/权限错 | 检查 §5.3 是否漏装；`ls -l /usr/libexec/openssh/sshd-{session,auth}`；修好后 `systemctl start sshd` |
| unit 变 `failed`，`MainPID=0` | 主进程已退出 | **不要**再 `reload`（无目标）；`systemctl reset-failed sshd && systemctl start sshd`；仍失败 → §6.1 |
| `start` 报 start-limit | 触发频率限制 | `systemctl reset-failed sshd` 后再 start |
| listener 活着但新连接认证全失败 | 每连接子进程（`sshd-auth`/`sshd-session`）问题，不触发自动重启 | 立即 §6.1 回滚，再查 `journalctl`/`/var/log/secure` |
| 2222 也断了 | 旁路失效 | 从机器控制台/physical 或已存在的 22 旧会话处理；准备走 `restore.sh` |

---

## 7. 风险清单（v3 修订）

| 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|
| 新 sshd 起不来 | 22 新连接中断，恢复时间取决于处理速度（**无 42s 上限**） | 低（§4.4/§4.6/§4.7 三重验证） | 替换前用同一套产物在 2233 跑通真登录+SFTP；准备 §6.1 脚本 |
| helper 路径错/权限错 | 启动即 `fatal`，22 全断 | 低 | `strings` 验证默认路径；`install -m 0755` 明确权限；§5.5 第 6 项 |
| `-t` 通过但启动失败 | 误判"已就绪" | 中（`-t` 不检查 helper） | 以 §5.5 第 1/2/3/4/5 项为准，不以 `-t` 为准 |
| reload 期间新连接被拒 | 少量新连接失败需重试 | 中（监听会短暂关闭） | 选低峰；不承诺零中断；客户端有重试 |
| 在线 16–18 人断连 | 业务投诉 | 低（会话子进程独立存活，`KillMode=process`） | 只 reload 不 restart；替换前后比对 `sshd-session` pid 集合 |
| 2222 被连带杀掉 | 失去旁路 | 低 | 不做 `pkill sshd`/`killall sshd`/`systemctl kill`/改 `KillMode`；阶段二前验证 2222 可新登录 |
| 旧 helper 依赖缺失（`libmysqlclient.so.16` 等） | 回滚失败 | 低（当前 `ldd` 全解析） | §4.7 预演 + §6.1 脚本内 `ldd` 校验 |
| `rpm -V` 脏状态 | 扫描器报篡改 | 必然（现状 5 个脏文件；若换 `sftp-server` 则 6 个） | 见 §2.7、§9.2；变更写在 §5.6 基线里 |
| 发布中途失败（部分已换） | 新旧混合状态 | 低（rename 前已全部 `cmp` 校验） | §5.3 先 helper 后主程序；任何 `PRE/POST-T` 失败立即 §6.1 |
| 磁盘 | `/` 剩 8.0G | 低 | 新增约 2.1MB；`/root/fhy` 暂存约 100MB |

---

## 8. 决策项

- **D1 客户端是否同步升级**：本轮**不动客户端**（保持 `/usr/bin/ssh` 9.8，校验和预期保持 OK）。若日后要换，注意 `ssh-keysign` 权限（现网 `-r-xr-sr-x root:ssh_keys` setgid vs 新构建 `-rws--x--x root:root` setuid，二选一不要混）。
- **D2 `sftp-server` 是否替换**：配置走 `internal-sftp`，不调用它；建议换以保持版本一致。
- **D3 是否优化 `sshd_config`**：`KexAlgorithms` 加 `mlkem768x25519-sha256`、`HostKeyAlgorithms` 去重。**本方案不改配置**，单独立项。
- **D4 2222 实例保留**：建议观察 24h 后再关，期间作旁路。
- **D5 2222 是否独立 unit**：当前与 `sshd.service` 同 cgroup；可 `systemd-run` 收编，避免被 `systemctl kill` 连带。

---

## 9. 遗留问题（本次不解决）

### 9.1 本机 CLI `ssh/scp/sftp` 当前不可用（升级前即坏）

`/etc/ssh/ssh_config:56` 引入 `/etc/crypto-policies/back-ends/openssh.config`，其 `CASignatureAlgorithms` 含 `ssh-dss` 等 3 项，9.8 与 10.6 客户端均报 `Bad key types ... terminating, 3 bad configuration options`。影响本机所有调 CLI `ssh/scp/sftp` 的脚本（Ansible、rsync over ssh、集群脚本）；LyShell 用内置 ssh2 不受影响。修复：`update-crypto-policies --set DEFAULT` 重新生成，**独立立项**。因此本方案所有版本探测都带 `-F /dev/null` 或走 TCP banner。

### 9.2 RPM 元数据与实际版本不一致

RPM 库仍是 `openssh-8.8p1-37.oe2203sp3`，二进制被手工编译覆盖。基于 `rpm -q`/`rpm -V` 的扫描器会报 8.8p1 与"文件被修改"。本变更沿用同一模式；变更后 `/usr/sbin/sshd` 版本变成 10.6，但 RPM 仍显示 8.8p1。另外 `sftp-server` 也是 RPM 管理文件，替换它会让 `rpm -V openssh-server` 的脏文件从 5 条变 6 条（§2.7）——这是本方案**引入的新增**，不是遗留。

### 9.3 旧二进制依赖污染（记录，供回滚与后续清理参考）

旧 `sshd`/`sshd-session` 链到 `libmysqlclient.so.16`、`libxml2.so.2` 和私有 OpenSSL 目录 `/usr/lib64/ssh1.1.1`，疑为 2024 年编译时环境变量污染。新产物已不再依赖这些库。若日后清理 `/usr/lib64/ssh1.1.1` 或 mysql/xml 库，**旧 helper 将无法加载**，回滚能力随之丧失——要么保留这些库，要么在清理前把回滚方案改为重装 RPM。

### 9.4 pam 运行时库被动升级

安装 `pam-devel-1.5.2-13` 时运行时 `pam` 由 `1.5.2-6` 升到 `1.5.2-13`（同 SP3 内小版本）。已完成，非本方案内容，仅备案。

---

## 10. 执行清单

**阶段一（零风险）** —— 2026-10-23 11:02–11:18 全部完成

- [x] 4.1 解包 + `chown -R root:root`
- [x] 4.2 configure → `CFGEXIT=0`，含 `PAM is enabled`
- [x] 4.3 `make -j8` → `MKEXIT=0`；`make install DESTDIR=` → `INSEXIT=0`
- [x] 4.3 读 `inst.log` 里安装期 `-t` 的真实诊断并逐条解释（不许笼统写"可忽略"）
- [x] 4.3 `md5sum -c /root/fhy/baseline.md5` 全 OK；`/etc/ssh` 无新文件
- [x] 4.4 四个程序 `ldd` 原始输出保留、无 not found、`libcrypto` 指向 `/usr/lib64/`；`strings` 命中 `/usr/libexec/openssh/sshd-{session,auth}`
- [x] 4.5 `-t`/`-T` 通过（仅门槛；`Sshd*Path` 预期为 `/usr/libexec/openssh/`）
- [x] 4.6 2233 起实例（带两个 `-o` 覆盖），banner `SSH-2.0-OpenSSH_10.6`
- [x] 4.6 2233 真账号登录 + 文件管理器上传下载
- [x] 4.6 `pgrep -P` + `/proc/<pid>/exe` 证明用的是暂存 helper
- [x] 4.6 关停 2233，端口释放
- [x] 4.7 `install -d` 建 `libexec-local` + 补备份旧 helper + `cmp` 校验副本
- [x] 4.7 `cmp -s "$B/sbin/sshd" /usr/sbin/sshd` 通过（备份未过期）
- [x] 4.7 2244 用**备份主程序 + 备份 helper** 跑通登录 + SFTP，`/proc/<pid>/exe` 指向备份副本
- [x] 4.7 关停 2244、端口释放、`pgrep` 无残留、关闭测试会话
- [x] 4.7 重打包备份 tar（或登记增量备份位置）+ 更新异地副本与 §11 校验值

**阶段二（动系统，需批准）** —— 2026-10-23 11:22–11:32 全部完成（用户已批准，`sftp-server` 一并替换）

- [x] 5.1 门禁全绿（含"2222 能新登录"、2244 已收尾、备份副本校验通过、`rollback-min.sh` 已就位并通过 `bash -n`）
- [x] 记录基线：MainPID、`pgrep -a sshd-session` pid 集合、22 established 数量、固定旧会话的 pts/pid/starttime
- [x] 5.3 四个临时文件就位 + 逐一 `cmp` 一致 + PRE-T 通过
- [x] 5.3 按"helper → sftp-server → 主程序"顺序 rename
- [x] 5.3 POST-T 通过（失败立即 §6.1）
- [x] 5.4 reload，`MainPID` 未变，`/proc/<MainPID>/exe` 校验和=新二进制
- [x] 5.5 第 1–10 项
- [x] 5.6 生成 `baseline-after-10.6.md5`
- [ ] 24h 观察：`journalctl -u sshd`、`/var/log/secure`
- [ ] 观察后决定 2222 去留（D4）

> 逐步执行证据（每一步的命令、原始输出、判据）见同目录 `openssh-10.6-cutover-20.39-exec-log.md`。

---

## 11. 附录：路径与校验值

| 名称 | 路径 / 值 |
|---|---|
| 旧版备份目录 | `/root/openssh-backup-20261023-100913/` |
| 旧版备份包 | `/root/openssh-backup-20261023-100913.tar.gz`（**4163713 B，md5 `0de6afe80a0212f81305da0e28d6cf1b`**，2026-10-23 11:17 按 §4.7.4 重打包，已含 `libexec-local/sshd-session`；旧值 2103699 B / `f26f0ae4153e42bfc6c848036d6aac45` 已失效） |
| 本机异地副本 | `D:\workspace\download\lyshell\10.5.20.39 Copy\openssh-backup-20.39.tar.gz`（2026-10-23 11:17 已重新下载覆盖：4163713 B，md5 `0de6afe80a0212f81305da0e28d6cf1b`，与本机包一致） |
| 旧 helper（22 旧会话在用） | `/usr/local/libexec/sshd-session`，1831936 B，Aug 22 2024，md5 **`42ced75d21a585f1df63ebda33dc66fd`**（§4.7.1 实测；**勿删，回滚需要**） |
| 旧 helper 备份副本 | `/root/openssh-backup-20261023-100913/libexec-local/sshd-session`（§4.7.1 生成，`cmp` 校验通过；已重打包进 tar） |
| 新 helper（切换后） | `/usr/libexec/openssh/sshd-session` md5 `8909e0b4a0a61df3a1c58ad172da3df1`；`sshd-auth` md5 `37eb4f87ebe992e2965b6f11f5e22a27`；`sftp-server` md5 `7196fe74d64df9b88ecabe4b552cdf55` |
| 新 sshd（切换后） | `/usr/sbin/sshd` 596752 B，md5 `19556e1d03ec82620668c6de424c9b5d` |
| 切换后基线 | `/root/fhy/baseline-after-10.6.md5`（8 个文件 md5 + `rpm -V` 6 行） |
| 旧版基线 | `/root/fhy/baseline.md5` |
| 新源码（旧前缀） | `/root/fhy/openssh-10.6p1/` |
| 旧前缀产物 | `/root/fhy/openssh-10.6/`（2222 实例在用，**不可移动**） |
| 新前缀暂存 | `/root/fhy/stage-usr/`（阶段一生成） |
| 最小回滚脚本 | `/root/fhy/rollback-min.sh`（§6.1），md5 `02a27123ec984098cff8ec2ee019f6bc`，`bash -n` 通过 |
| 发布脚本 | `/root/fhy/publish-10.6.sh`（§5.3），md5 `f310cbe6274c7497cc53eeb04234379c`，`bash -n` 通过 |
| 2222 / 2233 / 2244 日志 | `/root/fhy/sshd-{2222,2233,2244}.log` |
| 主机密钥指纹 ED25519 | `SHA256:C6IlOIYCcObsFonqaUo4bNMP5ZJTJn/gKNwOVsHys10` |
| 主机密钥指纹 RSA | `SHA256:0gfBWLLV0tA3I+aG4UcP9Wepr3oCwrONL2PoRL1l0jY` |
| 旧 sshd md5 | `dea201a93146e1bbdb63e373407d4fb1` |
| 旧 ssh md5 | `9ca84bf447eaa1ed5c1ef3e1f706c344` |
| 旧 sshd_config md5 | `519207bc1a32fc5cafcdddeaff87e884` |

> §5.3 与 §6.1 的 code block 与上表两个 `.sh` 文件**逐字节一致**（`diff` 已验，`bash -n` 均为 0）。今后修改脚本必须同步两处；执行时以磁盘上的 `.sh` 为准。

---

## 12. 三轮审查闭环表（R1–R6 + N1–N7）

| 编号 | v2 位置 | 处置 |
|---|---|---|
| R1 | §3 第 1–4 条、§4.6 | 使用 `-o SshdSessionPath/-o SshdAuthPath`（已实测可用）；验收改 `/proc/<pid>/exe`；明确 `-t` 不证明可启动 |
| R2 | §2.2、§2.3、§2.4、§4.7、§6.1、§9.3 | 更正 9.8 已是 split-privsep；记录 `/usr/local/libexec/sshd-session` 并列为门禁；回滚脚本内 `ldd` 校验；记录旧依赖污染 |
| R3 | §5.4、§5.5 | 明确 reload 会短暂断开监听、正常 re-exec PID 不变；以 `/proc/<MainPID>/exe` + 监听恢复 + 新登录 + SFTP + 旧会话 pid 存活共同验收 |
| R4 | §1、§5.7、§6.3、§7 | 删除 42s 承诺；三分支回滚（存活/已退出/限流）；设 10 分钟验收窗口与人工回滚触发条件 |
| R5 | §6.1、§6.2 | 新增最小回滚脚本（`set -euo pipefail`）；如实描述 `restore.sh`（不恢复 PAM、失败不中止、覆盖含主机密钥） |
| R6 | §5.5 | 版本探测用 `ssh -F /dev/null -v`；校验和预期改为只有 `/usr/sbin/sshd` 变；会话存活改 pid 集合比对；helper 归属改 `/proc/<pid>/exe` |
| §4 门禁 | §5.1、§10 | 全部 9 条落到前置门禁与执行清单；补"先准备再 rename" |
| N1 | §5.3 | 门禁全部改 `if ! ...; then exit 1`；四个文件逐一 `cmp -s`；改为 helper 优先、主程序最后 |
| N2 | §6.1 | 回滚前完成备份校验和/权限/依赖/配置四类校验；`ldd` 两段判断；移除 `\|\| true` 与 `&& echo` |
| N3 | §4.7 | `install -d -m 0700`；复制到显式路径并 `cmp`；2244 改用备份主程序+备份 helper；重打包并更新 §11 |
| N4 | §4.5 | 预期值改回 `/usr/libexec/openssh/`，暂存路径只在 §4.6 出现 |
| N5 | §4.7.3、§5.1、§10 | 2244 增加停止/端口释放/进程复核/关闭会话，并进前置门禁 |
| N6 | §6.1 范围表 | 明确"只恢复旧 listener"，逐文件列出 helper 与 sftp-server 的真实状态，给出单独回退命令 |
| §0.8-a | §4.3 | 承认暂存区会生成配置；要求读 `inst.log` 真实诊断 |
| §0.8-b | §4.4 | 保留原始 `ldd` 输出、显式判错；不再要求依赖集合一致 |
| §0.8-c | §2.7、§5.2、§5.5-10、§5.6、§7、§9.2 | 替换 `sftp-server` 会使 `rpm -V` 脏文件 5 → 6，全部标注为预期 |
| §0.8-d | §5.5 第 7 项 | 旧会话用"在其中执行命令并读回 + starttime"验收，`kill -0` 降级为辅助 |
| N7 | §6.1 第 1、5 步 | `pipefail` 下 `strings \| grep -q` 可因 SIGPIPE 把"匹配成功"判成失败并中止回滚；改 `grep -xF -- ... >/dev/null`，`ss \| grep -q` 同样去 `-q` |
