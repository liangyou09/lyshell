# OpenSSH 10.6p1 替换 10.5.20.39 —— 执行流水账

- 依据方案：`docs/openssh-10.6-cutover-20.39.md`（v4）
- 执行日期：2026-10-23（主机时间 CST）
- 操作通道：LyShell 会话 `10.5.20.39 Copy`（id `1792720830680`，`10.5.20.39:2222`，root）
- 原则：每完成一步记录「做了什么 / 输出证据 / 判据是否通过 / 结论」

---

## 0. 开工前置确认（对应 §5.1 部分基线）

开工时刻（主机 `date`）：`Fri Oct 23 11:02:07 AM CST 2026`

| 项 | 实测值 | 与方案 §2 一致 |
|---|---|---|
| hostname | `bigdata-master` | ✅ |
| kernel | `5.10.0-182.0.0.95.oe2203sp3.x86_64` | ✅ |
| whoami | `root` | ✅ |
| `/usr/sbin/sshd -V` | `OpenSSH_9.8p1, OpenSSL 1.1.1q  5 Jul 2022` | ✅ §2.1 |
| sshd MainPID | `1293214`（active/running） | ✅ §2.1 |
| 监听 | `0.0.0.0:22` pid=1293214；`0.0.0.0:2222` pid=376266；v6 同 | ✅ |
| 2233 / 2244 | 无监听（干净，无上次残留） | ✅ |
| `/usr/sbin/sshd` | 603680 B, Aug 22 2024, 0755 root:root | ✅ §2.1 |
| `/usr/local/libexec/sshd-session` | 1831936 B, Aug 22 2024, 0755 root:root | ✅ §2.2/§2.3 |
| `/usr/libexec/openssh/sftp-server` | 146032 B, Dec 28 2023 | ✅ §2.3 |
| `/` 可用空间 | 7.9G（85% used） | ✅ §7 |

`/root/fhy/` 现有内容：`baseline.md5`、`publish-10.6.sh`(2579B, 0700)、`rollback-min.sh`(3786B, 0700)、`sshd-2222.{pid,log}`、`openssh-10.6/`（旧前缀产物，2222 在用，**不可动**）、`openssh-10.6p1.tar.gz`(2355244B)、`openssh-10.6p1/`（属主 dolphinscheduler，待 §4.1 重新解包到 build-usr）。

`/root/openssh-backup-20261023-100913/` 现有：`bin/ etc-ssh/ libexec/ md5.txt pam/ restore.sh rpm/ sbin/ systemd/`，**尚无 `libexec-local/`**（§4.7.1 待建）。

**结论：基线画面与方案 §2 完全吻合，可以开始阶段一。**

---

## §4.1 解包 + chown

执行（11:02）：

```bash
rm -rf /root/fhy/build-usr && mkdir -p /root/fhy/build-usr
tar xzf /root/fhy/openssh-10.6p1.tar.gz -C /root/fhy/build-usr
chown -R root:root /root/fhy/build-usr
```

输出证据：

- `TAREXIT=0`，`CHOWNEXIT=0`
- `/root/fhy/build-usr` → `drwxr-xr-x 3 root root`；`/root/fhy/build-usr/openssh-10.6p1` → `drwxr-xr-x 7 root root 12288 Oct 6 16:45`
- `version.h`：`#define SSH_VERSION "OpenSSH_10.6"` ✅
- `find /root/fhy/build-usr ! -user root | wc -l` → **0** ✅（源码包内 uid 1000=dolphinscheduler 的污染已清除）

**判定：通过。** 注意 `/root/fhy/openssh-10.6/`（旧前缀，2222 在用）与 `/root/fhy/openssh-10.6p1/`（旧前缀源码）均未被触碰。

---

## §4.2 configure

执行（11:03，输出重定向到 `/root/fhy/build-usr/cfg.log` 而非屏幕，便于留存）：

```bash
cd /root/fhy/build-usr/openssh-10.6p1 && ./configure \
  --prefix=/usr --sysconfdir=/etc/ssh --libexecdir=/usr/libexec/openssh \
  --with-pid-dir=/run --with-pam --with-privsep-path=/var/empty \
  > /root/fhy/build-usr/cfg.log 2>&1
```

输出证据：`CFGEXIT=0`；`cfg.log` 共 700 行。

关键行（`grep -nE` 实测）：

- `checking OpenSSL header version... 1010180f (OpenSSL 1.1.1wa  16 Nov 2023)`
- `checking OpenSSL library version... 1010180f (OpenSSL 1.1.1wa  16 Nov 2023)`
- `checking whether OpenSSL's headers match the library... yes`
- `checking for zlib... yes` / `checking for zlib.h... yes`
- `PAM is enabled.`（cfg.log:696）

configure 摘要（`sed -n '/OpenSSH has been configured/,$p'`）实测：

```
User binaries: /usr/bin
System binaries: /usr/sbin
Configuration files: /etc/ssh
Askpass program: /usr/libexec/openssh/ssh-askpass     <-- 证明 --libexecdir 生效
PID file: /run
Privilege separation chroot path: /var/empty
PAM support: yes
Privsep sandbox style: seccomp_filter
+for channels: -lcrypto  -lz
+for sshd: -lcrypt  -lpam -ldl
```

**判定：通过**（`CFGEXIT=0`、`PAM is enabled`、OpenSSL 1.1.1wa、zlib ok 四项判据全中）。

> 小插曲（不影响结果）：configure 运行期间我误发了一条 `true`，它滞留在 tty 输入缓冲，configure 退出后被 shell 当作一条普通命令执行（`LYSHELL$ true`），无副作用。后续长命令改为「重定向到日志 + tail_until 轮询」，不再往运行中的 PTY 送输入。

---

## §4.3 编译与暂存安装

### 4.3.1 `make -j8`（11:03）

```bash
cd /root/fhy/build-usr/openssh-10.6p1
(make -j8 > /root/fhy/build-usr/build.log 2>&1; echo "MKEXIT=$?" > /root/fhy/build-usr/build.exit)
```

输出证据：

- `MKEXIT=0`（`cat /root/fhy/build-usr/build.exit`）
- `build.log` 共 **673** 行
- 真实编译行计数 `grep -c ' -c ' build.log` → **240**（证明是真编译，不是复用旧 `.o`）；
  首行样例含 `-D_PATH_SSHD_SESSION=\"/usr/libexec/openssh/sshd-session\" -D_PATH_SSHD_AUTH=\"/usr/libexec/openssh/sshd-auth\"` ✅ 正是 §4.4 第 2 条判据所需的编译期路径
- 警告统计：`grep -icE 'warning:|error:'` → **7 条，全部是 `-Wformat-truncation` 类**，无 error：
  - `Makefile:769: warning: ignoring prerequisites on suffix rule definition`
  - `log.c:395:39` / `log.c:408:44` / `log.c:464:60`（`': '`、`'%ld'` 可能被截断）
  - `fmt_scaled.c:293:52`、`misc.c:788:26`、`ssh-keygen.c:341:34`
  - 结论：均属编译器对 `snprintf` 缓冲区上限的保守提示，OpenSSH 上游常见，**非错误**
- 时间戳链（`ls -l --time-style=full-iso`）：`config.h 11:03:07` → `sshd.o 11:03:38` → `libssh.a 11:03:41` → `sshd 11:03:41`
- 产物计数：`*.o` **157** 个；`sshd` 3637624 B、`ssh` 5069984 B（未 strip 的链接产物）

链接命令行逐条确认（build.log 尾部原文）：

- `cc -o sshd ... -lssh -lopenbsd-compat -lcrypt -lpam -ldl -lcrypto -lz`
- `cc -o sshd-session ... -lcrypt -lpam -ldl -lcrypto -lz`
- `cc -o sshd-auth ... -lcrypt -lpam -ldl -lcrypto -lz`
- `cc -o sftp-server ... -lssh -lopenbsd-compat`（无 PAM/crypt，符合 §4.4 第 4 条"依赖集合不必相同"）

**判定：通过（MKEXIT=0，仅 format-truncation 警告）。**

### 4.3.2 `make install DESTDIR=/root/fhy/stage-usr`（11:04）

```bash
(make install DESTDIR=/root/fhy/stage-usr > /root/fhy/build-usr/inst.log 2>&1; \
 echo "INSEXIT=$?" > /root/fhy/build-usr/inst.exit)
```

输出证据：

- `INSEXIT=0`；`inst.log` 共 **43** 行
- 安装清单（inst.log:6–41）：`usr/bin/{ssh,scp,ssh-add,ssh-agent,ssh-keygen,ssh-keyscan,sftp}`、
  `usr/sbin/sshd`、`usr/libexec/openssh/{sshd-session,sshd-auth,ssh-keysign(4711),ssh-pkcs11-helper,ssh-sk-helper,sftp-server}`、
  man1/man5/man8 共 15 个 man page
- inst.log:12 `mkdir -p -m 0755 /root/fhy/stage-usr/var/empty`
- inst.log:42 `mkdir -p /root/fhy/stage-usr/etc/ssh`，实测该目录已生成 `moduli` / `ssh_config` / `sshd_config`（`install-sysconf` 生效，与方案 §4.3 的更正一致）
- **`DESTDIR` 生效、未碰 `/etc/ssh`**：`host-key` 规则因 `DESTDIR` 非空被跳过（`Makefile.in:493-496`），无 `ssh-keygen -A` 行

#### 安装期 `-t` 的真实诊断（方案要求逐条解释，不许笼统写"可忽略"）

inst.log 最后一行（43 行）为：

```
/root/fhy/stage-usr/usr/sbin/sshd -t -f /root/fhy/stage-usr/etc/ssh/sshd_config
```

**该行之后没有任何 stderr/stdout**。复核确认这不是"被 `-` 前缀吞掉的失败"，而是**真的静默通过**：

```bash
$S/usr/sbin/sshd -t -f $S/etc/ssh/sshd_config ; echo "T_STAGE_EXIT=$?"   # -> T_STAGE_EXIT=0
$S/usr/sbin/sshd -t -f /etc/ssh/sshd_config   ; echo "T_SYS_EXIT=$?"     # -> T_SYS_EXIT=0
```

两条配置的 md5（**两者内容不同，后续运行验证必须用系统那份**）：

| 配置 | md5 |
|---|---|
| `/root/fhy/stage-usr/etc/ssh/sshd_config`（安装产物·上游默认） | `d5d8b09cec5931748cd11e0ad5e967d0` |
| `/etc/ssh/sshd_config`（真实系统配置） | `519207bc1a32fc5cafcdddeaff87e884` |

说明：暂存区那份是上游默认模板，其 `HostKey` 等仍是绝对路径 `/etc/ssh/ssh_host_*`，这些文件真实存在，所以 `-t` 没有任何"缺少主机密钥"类报错 —— 方案 §4.3 预留的两种可能（环境原因 / 配置语法）**都没有发生**。

`grep -nE 'sshd -t|SSHD-TEST|no hostkeys|Unable to load|Bad configuration|missing' inst.log` 只命中第 43 行的命令回显本身（`GREP_EXIT=0`），无诊断文本。

#### 真实 `/etc/ssh` 未被改动（方案 §4.3 三条复核）

```bash
md5sum -c /root/fhy/baseline.md5      # 4 行全 OK，MD5CHECK_EXIT=0
ls -l /etc/ssh/ | grep -i mldsa       # 无输出，MLDSA_GREP_EXIT=1
ls -lt /etc/ssh/ | head -5            # 最新为 sshd_config Nov 18 2024，无本次时间戳新文件
```

实测输出：

```
/etc/ssh/sshd_config: OK
/etc/ssh/ssh_config: OK
/usr/sbin/sshd: OK
/usr/bin/ssh: OK
MD5CHECK_EXIT=0

=== /etc/ssh newest 5 ===
-rw-r--r--  1 root root       3370 Nov 18  2024 sshd_config
-r--------  1 root root        162 Nov  6  2024 ssh_host_dsa_key.pub
-rw-------  1 root root        492 Nov  6  2024 ssh_host_dsa_key
-rw-------  1 root ssh_keys   2578 Nov  6  2024 ssh_host_rsa_key
```

**判定：通过。** 暂存区结构 `find $S -maxdepth 4 -type d`：

```
$S / $S/etc/ssh / $S/usr/{bin,sbin,libexec/openssh,share/man/{man1,man5,man8}} / $S/var/empty
```

四件关键产物（均 11:04，未 strip 前的大小）：

| 文件 | 实测大小 | 方案参考值 |
|---|---|---|
| `usr/sbin/sshd` | 596752 | ≈596752 ✅ |
| `usr/libexec/openssh/sshd-session` | 1052208 | ≈1052208 ✅ |
| `usr/libexec/openssh/sshd-auth` | 1014864 | ≈1014864 ✅ |
| `usr/libexec/openssh/sftp-server` | 162088 | ≈162088 ✅ |
| `usr/bin/ssh` | 965424 | — |

> 注意：`install -s` 会 strip，所以暂存区大小 = 方案给出的参考大小；`build-usr` 里未 strip 的 `sshd` 是 3637624 B。

---

## §4.4 产物与依赖核对

执行（`S=/root/fhy/stage-usr`）：

```bash
$S/usr/sbin/sshd -V
$S/usr/bin/ssh -V
# 四件产物 ldd 循环（把方案里的 `exit 1` 改成 FAIL 标记，避免判失败时把 2222 会话一起带走）
strings $S/usr/sbin/sshd | grep -E '^/usr/libexec/openssh/(sshd-session|sshd-auth)$'
```

### 判据 1：版本

```
OpenSSH_10.6p1, OpenSSL 1.1.1wa  16 Nov 2023      # sshd -V
OpenSSH_10.6p1, OpenSSL 1.1.1wa  16 Nov 2023      # ssh -V
```

✅ 与方案第 1 条完全一致（`10.6p1` + `OpenSSL 1.1.1wa`）。

### 判据 2：`strings` 命中系统 helper 路径

```
/usr/libexec/openssh/sshd-session
/usr/libexec/openssh/sshd-auth
```

`STRINGS_HIT=0`。✅ 命中**系统路径**而非 `/root/fhy/...` —— 满足"可以直接替换到系统路径"的判据（与 §4.3.1 编译期 `-D_PATH_SSHD_SESSION/-D_PATH_SSHD_AUTH` 互相印证）。

### 判据 3：四件产物 `ldd` 无 `not found`、libcrypto 走 `/usr/lib64/`

`LDD_FAIL=0`。原文摘录：

| 产物 | 依赖（实测） |
|---|---|
| `usr/sbin/sshd` | libcrypt.so.1、libpam.so.0、**libcrypto.so.1.1 → /usr/lib64/libcrypto.so.1.1**、libz.so.1、libc.so.6、libaudit.so.1、libcap-ng.so.0 |
| `usr/libexec/openssh/sshd-session` | libcrypt.so.1、libpam.so.0、**libcrypto.so.1.1 → /usr/lib64/**、libz.so.1、libc.so.6、libaudit.so.1、libcap-ng.so.0 |
| `usr/libexec/openssh/sshd-auth` | 同 sshd-session |
| `usr/libexec/openssh/sftp-server` | 仅 libc.so.6 + ld-linux（不需要 PAM/crypt/crypto） |

✅ libcrypto 走 `/usr/lib64/libcrypto.so.1.1`，**不是**旧二进制那条 `/usr/lib64/ssh1.1.1/libcrypto.so.1.1`（对照 §2.4 记录：9.8 的 `/usr/local/libexec/sshd-session` 链的是 `ssh1.1.1/` 那份）。无 `not found`。

### 判据 4：依赖集合不必彼此相同

`sshd`/`sshd-session`/`sshd-auth` 带 PAM/audit/cap-ng，`sftp-server` 只要 libc —— 与方案 v3 修正后的第 4 条一致，不算异常。

### 判据 5：无 `ldd` 执行失败

`LDD_FAIL=0`（循环里每个 `ldd` 都成功、每份输出都可解释）。

**判定：通过。四件产物可进入 §4.5。**

---

## §4.5 配置检查（门槛，不是"能启动"的证据）

执行：

```bash
S=/root/fhy/stage-usr
$S/usr/sbin/sshd -t -f /etc/ssh/sshd_config ; echo "TESTEXIT=$?"
$S/usr/sbin/sshd -T -f /etc/ssh/sshd_config | grep -Ei '^(port|usepam|permitrootlogin|subsystem|hostkeyalgorithms|kexalgorithms|sshdsessionpath|sshdauthpath)'
```

实测输出：

```
TESTEXIT=0
Port 22
UsePAM yes
PermitRootLogin yes
KexAlgorithms curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group14-sha1
HostKeyAlgorithms ssh-rsa,ecdsa-sha2-nistp256,ssh-ed25519
SshdSessionPath /usr/libexec/openssh/sshd-session
SshdAuthPath /usr/libexec/openssh/sshd-auth
Subsystem sftp internal-sftp
TEXIT=0
```

逐条对判据：

| 期望 | 实测 | 结果 |
|---|---|---|
| `TESTEXIT=0` | 0 | ✅ |
| `Subsystem sftp internal-sftp` 保留 | 命中 | ✅ |
| `UsePAM yes` 保留 | 命中 | ✅ |
| `SshdSessionPath` = `/usr/libexec/openssh/sshd-session` | 一致 | ✅ |
| `SshdAuthPath` = `/usr/libexec/openssh/sshd-auth` | 一致 | ✅ |

两条 `Sshd*Path` 是**编译期默认值**（本步未加任何 `-o`），与 §4.4 的 `strings` 结论一致；本步不出现暂存路径，符合方案 N4 的更正。

> 明确：本步通过**不代表** §4.6 能启动 —— 真正启动 10.6 的 listener 时，默认 helper 路径指向系统 `/usr/libexec/openssh/`，那里若还是 9.8 的 helper 会版本错配。这正是 §4.6 必须显式传 `-o SshdSessionPath/-o SshdAuthPath` 的原因。

---

## §4.6 2233 端口全链路验证（覆盖 helper 路径）

### 4.6.1 启动暂存产物的 listener（11:06）

```bash
S=/root/fhy/stage-usr
rm -f /root/fhy/sshd-2233.pid /root/fhy/sshd-2233.log
$S/usr/sbin/sshd -f /etc/ssh/sshd_config -p 2233 \
  -o PidFile=/root/fhy/sshd-2233.pid \
  -o SshdSessionPath=$S/usr/libexec/openssh/sshd-session \
  -o SshdAuthPath=$S/usr/libexec/openssh/sshd-auth \
  -E /root/fhy/sshd-2233.log
echo "STARTEXIT=$?"
```

实测：

```
STARTEXIT=0
--- pidfile: 1667624
--- listen:
LISTEN 0  128  0.0.0.0:2233  0.0.0.0:*  users:(("sshd",pid=1667624,fd=7))
LISTEN 0  128     [::]:2233     [::]:*  users:(("sshd",pid=1667624,fd=8))
--- log:
Server listening on 0.0.0.0 port 2233.
Server listening on :: port 2233.
```

✅ `STARTEXIT=0`、监听 `0.0.0.0:2233` + `[::]:2233`、日志**无** `does not exist or is not executable` / `unable to`。
（日志里 `Server listening` 两行本身即证明 `sshd` 启动期对 `SshdSessionPath`/`SshdAuthPath` 的 `stat()` 检查已通过 —— `sshd.c:1812-1822` 若失败会 `fatal()` 直接退出。）

### 4.6.2 验证项 1：协议入口（自动）

```bash
timeout 5 bash -c 'exec 3<>/dev/tcp/10.5.20.39/2233; head -c 40 <&3'
```

实测输出：`SSH-2.0-OpenSSH_10.6` ✅

- 与方案预期一致（协议 banner 为 `10.6`，不带 `p1`；`p1` 只出现在 `-V` 的发行说明里）
- 该探测在日志留下 `Connection closed by 10.5.20.39 port 39438 [preauth]` —— 是探测主动断开的正常痕迹，不是错误

### 4.6.3 验证项 2/3/4/5：人工登录 + 自动核验 ✅（11:08–11:10）

**人工部分（用户操作）**：LyShell 新建 `10.5.20.39:2233` 会话（会话 id `1792724870358`，"10.5.20.39 2233"），root 口令登录成功；文件管理器列目录、上传、下载各一次。

**验证项 4：helper 归属（自动，`/proc/<pid>/exe` 证据）**

```
===== port 2233 listener=1667624
  1687332 sshd-session: root [postauth]   -> /root/fhy/stage-usr/usr/libexec/openssh/sshd-session
    1687437 sshd-session: root@pts/8      -> /root/fhy/stage-usr/usr/libexec/openssh/sshd-session
  1687502 sshd-session: root [postauth]   -> /root/fhy/stage-usr/usr/libexec/openssh/sshd-session
    1687642 sshd-session: root@notty      -> /root/fhy/stage-usr/usr/libexec/openssh/sshd-session
  1695565 sshd-session: root [postauth]   -> /root/fhy/stage-usr/usr/libexec/openssh/sshd-session
```

✅ 所有子进程 `exe` 都指向 **`/root/fhy/stage-usr/usr/libexec/openssh/sshd-session`** —— 这正是方案要求的"测的是暂存产物"证据（配合 §4.6.1 的 `-o SshdSessionPath/-o SshdAuthPath` 与 §4.4 的 `strings`）。

全机统计：`pgrep -f sshd-session` 中 **16 个**进程的 `exe` 落在 `/root/fhy/stage-usr/` 下。

**验证项 3：SFTP 客户端进程（自动）**

```
root 1687643 1687642  sshd-session: root@internal-sftp
root 1696473 1696280  sshd-session: root@internal-sftp
root 1699295 1699243  sshd-session: root@internal-sftp
root 1703137 1703110  sshd-session: root@internal-sftp
```

且三者 `readlink -f /proc/<pid>/exe` 均为 `/root/fhy/stage-usr/usr/libexec/openssh/sshd-session`（`root@internal-sftp` 是进程标题，不是另一个二进制；10.6 的 internal-sftp 已并入 sshd-session）。

✅ 出现 4 个 `@internal-sftp` 子进程 = SFTP 子系统确实被调用过（列目录/上传/下载留下的会话）。

**验证项 5：认证日志（自动）**

```
Accepted password for root from 172.18.34.204 port 63441 ssh2
Accepted password for root from 172.18.34.204 port 63461 ssh2
Accepted password for root from 172.18.34.204 port 57795 ssh2
Accepted password for root from 172.18.34.204 port 49339 ssh2
Accepted password for root from 172.18.34.204 port 52858 ssh2
Accepted password for root from 172.18.34.204 port 63090 ssh2
Accepted password for root from 172.18.34.204 port 62236 ssh2
Accepted password for root from 172.18.34.204 port 51254 ssh2
Accepted password for root from 172.18.34.204 port 60267 ssh2
Accepted password for root from 172.18.34.204 port 53546 ssh2
```

`grep -c Accepted` → **10**，`grep -c Failed` → 0。✅ 口令认证（PAM）在 10.6 产物上工作正常。

**附带发现（10.6 新行为，记录备查）**：日志里 `grep -c WARNING` → **10**，每一条都是
`WARNING: connection from 172.18.34.204 port 53546 is not using a post-quantum key exchange algorithm: "curve25519-sha256@libssh.org"`
—— 10.6 新引入的"非 PQ 密钥交换"提示（推荐 `mlkem768x25519-sha256` 等 PQ 算法）。本机 `/etc/ssh/sshd_config` 未配已知主机/KEX 白名单，客户端 LyShell(ssh2) 走的是传统 KEX，故每条连接都提示一次。**这不是错误，也不影响连通性**；阶段二切到 10.6 后生产连接也会出现同样提示，属预期噪音。

**判定：§4.6 全部通过**（`STARTEXIT=0` + banner `SSH-2.0-OpenSSH_10.6` + 真账号口令登录 + SFTP 三操作 + helper 归属证据 + Accepted 日志）。

收尾（等 §4.7.2 的 2244 验完一并做，避免反复起停）：

```bash
kill "$(cat /root/fhy/sshd-2233.pid)"; sleep 1; ss -tlnp | grep -c 2233   # 期望 0
```

---

## §4.7 旧链路回滚能力预演

### 4.7.1 补备份旧 helper + 核对备份主程序（11:07）✅

```bash
B=/root/openssh-backup-20261023-100913
OLD_HELPER=/usr/local/libexec/sshd-session
install -d -m 0700 "$B/libexec-local"
cp -p "$OLD_HELPER" "$B/libexec-local/sshd-session"
cmp -s "$OLD_HELPER" "$B/libexec-local/sshd-session"
```

（把方案里的 `exit 1` 改成打印 FATAL + 标记，避免判失败时连带掉线 2222 会话。）

实测：

```
MKDIR_EXIT=0
CP_EXIT=0
CMP_EXIT=0
/usr/local/libexec/sshd-session                         root:root 755 1831936
/root/openssh-backup-20261023-100913/libexec-local/sshd-session root:root 755 1831936
42ced75d21a585f1df63ebda33dc66fd  /usr/local/libexec/sshd-session
42ced75d21a585f1df63ebda33dc66fd  /root/openssh-backup-20261023-100913/libexec-local/sshd-session
```

✅ 目录 `0700`、`cp -p` 保留 755/root:root/1831936、`cmp` 一致、md5 双份相同 → 旧 helper 已有独立副本（N3 要求的"显式文件路径"到位）。

备份主程序一致性：

```
CMP_SSHD_EXIT=0
dea201a93146e1bbdb63e373407d4fb1  /root/openssh-backup-20261023-100913/sbin/sshd
dea201a93146e1bbdb63e373407d4fb1  /usr/sbin/sshd
```

✅ `cmp` 一致且 md5 与方案 §11 的 `dea201a93146e1bbdb63e373407d4fb1` 相符 → 备份就是现网正在跑的 9.8，不是过期备份。

### 4.7.2 用备份产物在 2244 自证（listener 已起，11:07）

```bash
B=/root/openssh-backup-20261023-100913
"$B/sbin/sshd" -f /etc/ssh/sshd_config -p 2244 \
  -o PidFile=/root/fhy/sshd-2244.pid \
  -o SshdSessionPath="$B/libexec-local/sshd-session" \
  -E /root/fhy/sshd-2244.log
```

实测：

```
START2244=0
--- pid: 1686143
--- listen:
LISTEN 0 128  0.0.0.0:2244  0.0.0.0:*  users:(("sshd",pid=1686143,fd=8))
LISTEN 0 128     [::]:2244     [::]:*  users:(("sshd",pid=1686143,fd=9))
--- proc:
1686143 sshd: /root/openssh-backup-20261023-100913/sbin/sshd -f /etc/ssh/sshd_config -p 2244 \
        -o PidFile=/root/fhy/sshd-2244.pid \
        -o SshdSessionPath=/root/openssh-backup-20261023-100913/libexec-local/sshd-session \
        -E /root/fhy/sshd-2244.log [listener] 0 of 10-100 startups
--- log:
Server listening on 0.0.0.0 port 2244.
Server listening on :: port 2244.
--- banner: SSH-2.0-OpenSSH_9.8
```

✅ 起的是**备份目录里的 9.8 主程序**（`pgrep -af` 的 argv[0] 即备份路径），helper 指向**备份副本** `$B/libexec-local/sshd-session`，banner `SSH-2.0-OpenSSH_9.8`。

#### 4.7.2.a 第一次口令尝试：认证成功但连接立刻被关闭（11:12）

用户首次尝试连 2244 后报「连不上」。当时 listener 为 **1686143**，`/root/fhy/sshd-2244.log` 全文如下（该文件随后被我误删，内容在此逐行留存）：

```
Server listening on 0.0.0.0 port 2244.
Server listening on :: port 2244.
Connection closed by 10.5.20.39 port 40520
Connection closed by 172.18.34.204 port 63884
authenticated1 0
authenticated2 1
authenticated4 1
mm_answer_authpassword: sending result 1
Accepted password for root from 172.18.34.204 port 50782 ssh2
Connection closed by 172.18.34.204 port 50782
```

判定要点：

- `Accepted password for root from 172.18.34.204 port 50782 ssh2` 说明**口令认证已经通过**，紧随其后的 `Connection closed by ... 50782` 是**连接被关闭**，不是认证失败。
- 全程**没有** `fatal:`、没有 `Failed`、没有 `does not exist or is not executable`，服务端没有报错退出。
- `pgrep -P 1686143` 当时**没有任何子进程**残留，符合「连接关闭后 helper 进程退出」。
- 那些 `authenticated1/2/4`、`mm_answer_authpassword` 是 OpenSSH monitor 的 `debug3` 级输出，本不该出现在默认 `LogLevel INFO` 的日志里（异常点，记此备案，不影响功能判定）。
- 排除项：`firewalld` = `inactive`；`iptables -S INPUT` 首行 `-P INPUT ACCEPT`（另有 calico/kube/docker 链，但 2233 同机可连，说明不是防火墙端口问题）；`dmesg` 尾部只有容器内 `mysqld` 被 cgroup OOM kill（`oom-kill:constraint=CONSTRAINT_MEMCG ... task=mysqld,pid=1757833`），与本问题无关；`/var/log/messages` 无 sshd segfault。

#### 4.7.2.b 我的操作失误与纠正（11:14）

- 失误：诊断时执行了 `pkill -f 'sshd .*2244'`，把 **listener 1686143 自己**也匹配杀掉；同时 `rm -f /root/fhy/sshd-2244.log` 把上表日志删掉了（内容已在 4.7.2.a 完整留存）。用户当时若仍有 2244 会话，会被一并断开。
- 纠正：立即按方案原命令重启 2244（新 listener **1781954**），配置与本节开头完全一致（备份主程序 + 备份 helper）。

#### 4.7.2.c 服务端自证（publickey + sftp，11:15–11:17）✅

为避免动真实的 `authorized_keys`，先备份再临时追加一把一次性测试公钥，取证后立即还原：

```bash
cp -p /root/.ssh/authorized_keys /root/fhy/authorized_keys.bak   # 原 md5 1a564f2aae54e6dd3e53018745a5358a，5 行
ssh-keygen -q -t ed25519 -N '' -f /root/fhy/testkey
cat /root/fhy/testkey.pub >> /root/.ssh/authorized_keys            # 5 行 -> 6 行
```

- 本机 ssh 客户端第一次跑就失败：`/etc/crypto-policies/back-ends/openssh.config: line 3: Bad configuration option: gssapikexalgorithms` → `terminating, 3 bad configuration options`（由 `ssh_config` 第 56 行 `Include` 引入，9.8 客户端不认这些新选项）。加 `-F /dev/null` 绕过。**这与 2244 服务端无关**，是主机本地 ssh 客户端配置问题，记录备查。
- `ssh -F /dev/null -p 2244 -i /root/fhy/testkey ... root@10.5.20.39 'echo HELLO_OK; ...'` → `Authenticated to 10.5.20.39 ([10.5.20.39]:2244) using "publickey".` + `HELLO_OK`。
- `sftp -P 2244 -i /root/fhy/testkey ... root@10.5.20.39` 执行 `ls -l /root/fhy` 成功（列出 `stage-usr`、`sshd-2233.pid` 等），`SFTP_RC=0`。

#### 4.7.2.d 进程取证：helper 确实是备份副本（11:17）✅

以 `-N` 长连接 + `ssh -s ... sftp` 子系统各挂一个会话后取证（listener **1781954**）：

```
1782209 | sshd-session: root [priv]              | /root/openssh-backup-20261023-100913/libexec-local/sshd-session
1782213 | sshd-session: root                     | /root/openssh-backup-20261023-100913/libexec-local/sshd-session
1788401 | sshd-session: root [priv]              | /root/openssh-backup-20261023-100913/libexec-local/sshd-session
1788429 | sshd-session: root@notty               | /root/openssh-backup-20261023-100913/libexec-local/sshd-session
1788435 | sshd-session: root@internal-sftp       | /root/openssh-backup-20261023-100913/libexec-local/sshd-session
```

其中 **1788401/1788429/1788435 这一组来自用户 LyShell 的口令登录**（`root@notty` 终端 + `root@internal-sftp` 文件管理器），`readlink -f /proc/<pid>/exe` **全部** = `/root/openssh-backup-20261023-100913/libexec-local/sshd-session`，既不是 `/usr/local/libexec/sshd-session`，也不是暂存区那一份。

#### 4.7.2.e 日志计数与还原（11:18）

```
Accepted publickey for root from 10.5.20.39 port 60124 ... ED25519 SHA256:ck+gfG5h9suIurWLDaVthurrnyXPsz13MjhQgOIOKJE
authenticated1 0 / authenticated2 1 / authenticated4 1 / mm_answer_authpassword: sending result 1
Accepted password for root from 172.18.34.204 port 60995 ssh2
Accepted publickey for root from 10.5.20.39 port 35690 ... ED25519 ...
accepted=3 failed=0
```

还原与清理：

```bash
cp -p /root/fhy/authorized_keys.bak /root/.ssh/authorized_keys   # root 的 cp 是别名 cp -i，会提示覆盖，需回答 y
# 结果：md5 1a564f2aae54e6dd3e53018745a5358a（与备份前一致）、5 行、cmp 一致
rm -f /root/fhy/testkey /root/fhy/testkey.pub /root/fhy/test_authkeys   # testkey_left=0
```

#### 4.7.2.f 结论与遗留观察

- ✅ 备份主程序 + 备份 helper 这条**回滚链路本身是通的**：publickey 登录、口令登录、终端会话、`internal-sftp` 子系统全部成功，且进程 exe 证明用的是备份副本。
- ⚠️ 遗留观察：两次口令登录都出现「`Accepted password` 之后 `Connection closed by 172.18.34.204`」。服务端无 fatal、无 Failed，而同一 listener 上 publickey + sftp 自测完全正常，因此判断是**客户端侧主动断开**（用户回复「连上了」也印证会话曾经建立）。这与 2244 服务端无关，但需在阶段二前确认用户侧 LyShell 会话是否稳定，避免把客户端问题误判成替换失败。
- 用户确认（11:19）：2244 会话稳定，之前那次断开是他自己关闭的。→ §4.7.2 **通过**。

## §4.7.3 收尾：停掉 2233 / 2244 两个测试 listener（11:20）✅

```bash
kill "$(cat /root/fhy/sshd-2244.pid)"; kill "$(cat /root/fhy/sshd-2233.pid)"
```

| 检查项 | 命令 | 结果 |
|---|---|---|
| 停之前 | `ss -tlnp \| grep -E ':(2233\|2244) '` | `2233` → pid=1667624；`2244` → pid=1781954（v4/v6 各一条） |
| kill 返回值 | — | `KILL2244=0`、`KILL2233=0` |
| 端口已释放 | `ss -tlnp \| grep -c ':2244 '` / `':2233 '` | **cnt2244=0、cnt2233=0** ✅ |
| 无残留进程 | `pgrep -af 'sshd.*2233\|sshd.*2244'` | **无输出** ✅ |
| 无残留 listener | `[ -d /proc/1781954 ]`、`[ -d /proc/1667624 ]` | 两者都不存在 ✅ |
| 生产端口未受影响 | `ss -tlnp \| grep -E ':(22\|2222) '` | `22` → pid=1293214、`2222` → pid=376266，v4/v6 都在 ✅ |
| 生产 MainPID 未变 | `systemctl show sshd -p MainPID --value` | `1293214`（与开工基线一致）✅ |

LyShell 界面侧测试会话也一并关闭（`lyshell_close_session`）：

- `1792725128432`（"10.5.20.39 2244"）→ `status: disconnected` ✅
- `1792724870358`（"10.5.20.39 2233"）→ `status: disconnected` ✅

> 目的（方案 N5）：避免遗留一个 9.8 listener 和脏 PID 混进阶段二的「旧会话基线」。现在只剩 2222 旁路会话 `1792720830680` 与生产 22/2222 两条链路。

## §4.7.4 备份归档与异地副本（11:21）✅

```bash
cd /root
rm -f /root/openssh-backup-20261023-100913.tar.gz
tar czf /root/openssh-backup-20261023-100913.tar.gz openssh-backup-20261023-100913   # TAREXIT=0
chmod 600 /root/openssh-backup-20261023-100913.tar.gz
tar -tzf ... | grep libexec-local
```

| 项 | 结果 |
|---|---|
| 包内已含增量备份 | `openssh-backup-20261023-100913/libexec-local/` + `.../libexec-local/sshd-session` ✅ |
| 权限 | `root:root 600` ✅ |
| 大小 | **4163713 B**（重打包前 2103699 B） |
| md5 | **`0de6afe80a0212f81305da0e28d6cf1b`**（旧值 `f26f0ae4153e42bfc6c848036d6aac45` 已失效） |
| 条目数 | 51 条（其中文件 42 个 = `find -type f \| wc -l` 的 42）✅ |
| 完整性回归 | 解包到 `/root/fhy/tarverify` → `tar xzf` XEXIT=0；`diff -r` 备份目录 vs 解包目录 → **DIFFEXIT=0、差异 0 行** ✅ |

异地副本（本机覆盖）：

```
D:\workspace\download\lyshell\10.5.20.39 Copy\openssh-backup-20.39.tar.gz
-rw-r--r-- 69534 197609 4163713 Oct 23 11:17
md5 0de6afe80a0212f81305da0e28d6cf1b   （与服务器端一致）
tar -tzf 校验：含 libexec-local/ 与 libexec-local/sshd-session
```

方案文档 §11 两行已同步更新（旧版备份包 4163713 B / `0de6afe80a0212f81305da0e28d6cf1b`；本机异地副本同样标注为已重新下载覆盖且 md5 一致）。

**§4 阶段一全部完成**（§4.1–§4.7）。下一步是 §5 阶段二，属于「动系统文件」环节，按方案 §10 需用户明确批准后才可开始。

---

# §5 阶段二：替换系统文件

## §5.1 前置门禁（11:22，全部只读，未改动任何系统文件）

| # | 门禁 | 命令 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | §4 全部通过、§4.7 回滚预演通过（含备份副本登录） | — | §4.1–§4.7 全部 ✅，2244 用备份主程序+备份 helper 完成口令登录 + `internal-sftp` | ✅ |
| 2 | 旧 helper 已进备份且 `cmp` 通过 | `cmp -s /usr/local/libexec/sshd-session "$B/libexec-local/sshd-session"` | `G2_HELPER_CMP_OK=1` | ✅ |
| 3 | 备份 sshd 与现网一致 | `cmp -s "$B/sbin/sshd" /usr/sbin/sshd` | `G3_SSHD_CMP_OK=1`（两侧 md5 均 `dea201a93146e1bbdb63e373407d4fb1`） | ✅ |
| 4 | 2244 实例已停、端口已释放、测试会话已关 | `ss -tlnp \| grep -c ':2244 '` | `0`；listener 1781954 已消失；LyShell 会话 `1792725128432`/`1792724870358` 均 `disconnected` | ✅ |
| 5 | 备份 tar 已重打包、异地副本已更新、§11 md5 一致 | `md5sum` + 本机 `md5sum` | 两端均 `0de6afe80a0212f81305da0e28d6cf1b`、4163713 B；方案 §11 两行已更新 | ✅ |
| 6 | `rollback-min.sh` 已落地、`chmod 700`、`bash -n` 通过 | `ls -l` + `bash -n` | `-rwx------ 1 root root 3786 Oct 23 10:53`；`G6_SYNTAX=0` | ✅ |
| 7 | 操作通道是 2222，且**刚刚新建过连接** | `timeout 6 bash -c 'exec 3<>/dev/tcp/10.5.20.39/2222; head -c 40 <&3'` | 返回 `SSH-2.0-OpenSSH_10.6` —— 2222 能接受**新**连接（不只是旧会话还活着） | ✅ |
| 8 | 记录基线 | 见下 | `MainPID=1293214`、`sshd-session` 进程 **41** 个、`ss -tn state established '( sport = :22 )'` 计数 **10** | ✅ 已记录 |
| 9 | 记录一个固定旧会话用于存活验收 | 见下 | `pts/1` → `sshd-session` pid **3830207**、`starttime=407133852`、`ELAPSED 3-17:23:57`（2026-10-19 17:55 登录，来自 192.168.58.142） | ✅ 已记录 |
| 10 | `/etc/sysconfig/sshd` 无 `OPTIONS`、无 systemd drop-in | `grep -c OPTIONS /etc/sysconfig/sshd`、`ls -d /etc/systemd/system/sshd.service.d` | `0`（0 处）、drop-in 目录不存在；unit 为 `EnvironmentFile=/etc/sysconfig/sshd` + `ExecStart=/usr/sbin/sshd -D $OPTIONS` | ✅ |

补充基线（阶段二验收要用）：

- 旁路通道自身：本机 tty `/dev/pts/5`，父进程 `736953` = `sshd-session: root@pts/5`，其 exe 在 `/root/fhy/openssh-10.6/`（即 2222 的 10.6 旧前缀实例），**与将要替换的 `/usr/sbin/sshd`、`/usr/libexec/openssh/*` 无任何共享文件** —— 替换过程不会碰到它。
- 生产两端口：`22` → pid 1293214；`2222` → pid 376266。
- `who` 前 5 行（旧会话样本）：`pts/0 10:12 (192.168.58.9)`、`pts/1 10-19 17:55 (192.168.58.142)`、`pts/2 10-19 20:33`、`pts/3 10:12`、`pts/4 10:13`。

> 结论：§5.1 的 10 条门禁**全部满足**。§5 阶段二可以开始，但按方案 §10，执行前需要用户明确批准。

## §5.2 决策确认（11:24，用户批准）

| 决策 | 选择 | 影响 |
|---|---|---|
| 阶段二是否执行 | **批准** | 开始 §5.3 |
| 客户端 `/usr/bin/ssh`、`/usr/bin/scp`、`ssh-keysign` | 按 D1 **不动**，保持 9.8 | `md5sum -c baseline.md5` 中 `/usr/bin/ssh` 应继续 OK |
| `/usr/libexec/openssh/sftp-server` | **一并替换**（用户选择，非 D2） | `rpm -V` 脏文件 5 → 6，新增 `S.5....T. /usr/libexec/openssh/sftp-server`，属 §2.7 已声明预期 |

## §5.3 发布（11:24，`publish-10.6.sh`）

执行：

```bash
md5sum /root/fhy/publish-10.6.sh      # f310cbe6274c7497cc53eeb04234379c
ls -l /root/fhy/publish-10.6.sh       # -rwx------ 1 root root 2579 Oct 23 10:46
bash /root/fhy/publish-10.6.sh 2>&1 | tee /root/fhy/publish-run.log
```

输出（全文）：

```
OpenSSH_10.6p1, OpenSSL 1.1.1wa  16 Nov 2023      ← 发布后新的 /usr/sbin/sshd -V
PRE-T=0                                           ← 发布前 sshd -t 通过
OpenSSH_10.6p1, OpenSSL 1.1.1wa  16 Nov 2023
POST-T=0                                          ← 发布后 sshd -t 通过
-rwxr-xr-x 1 root root 1014864 Oct 23 11:19 /usr/libexec/openssh/sshd-auth
-rwxr-xr-x 1 root root 1052208 Oct 23 11:19 /usr/libexec/openssh/sshd-session
-rwxr-xr-x 1 root root  596752 Oct 23 11:19 /usr/sbin/sshd
PUBEXIT=0
```

| 项 | 发布前 | 发布后 |
|---|---|---|
| `/usr/sbin/sshd` | `603680` Aug 22 2024（9.8） | **`596752`** Oct 23 11:19，md5 `19556e1d03ec82620668c6de424c9b5d` |
| `/usr/libexec/openssh/sshd-session` | 不存在（旧 helper 在 `/usr/local/libexec/`） | **`1052208`**，md5 `8909e0b4a0a61df3a1c58ad172da3df1` |
| `/usr/libexec/openssh/sshd-auth` | 不存在 | **`1014864`**，md5 `37eb4f87ebe992e2965b6f11f5e22a27` |
| `/usr/libexec/openssh/sftp-server` | `146032` Dec 28 2023 | **`162088`**，md5 `7196fe74d64df9b88ecabe4b552cdf55` |

顺序符合方案要求：**先装 helper（`sshd-session`/`sshd-auth`）、最后 rename 主程序 `sshd`**，`PRE-T`/`POST-T` 均为 0。

**§5.3 判定：通过（PUBEXIT=0）。**

## §5.4 生效：reload（11:25）

```bash
OLD_MAIN=$(systemctl show sshd -p MainPID --value)   # 1293214
systemctl reload sshd; echo "RELOAD_EXIT=$?"          # RELOAD_EXIT=0
sleep 3
```

| 判据 | 预期（方案 §5.4） | 实测 | 判定 |
|---|---|---|---|
| `MainPID` | **不变** | `R_MAIN=1293214`（= OLD_MAIN） | ✅ |
| ActiveState/SubState | active/running | `active/running` | ✅ |
| `/proc/<MainPID>/exe` | `/usr/sbin/sshd` | `readlink -f` → `/usr/sbin/sshd` | ✅ |
| `/proc/<MainPID>/exe` 校验和 | = 新二进制 | `md5sum /proc/1293214/exe` = **`19556e1d03ec82620668c6de424c9b5d`** = 新 `/usr/sbin/sshd` | ✅ |
| 监听 | 短暂中断后恢复 | `LISTEN 0 128 0.0.0.0:22` + `[::]:22` 均在 | ✅ |
| 日志 | `Received SIGHUP; restarting` | `Oct 23 11:20:05 bigdata-master sshd[1293214]: Received SIGHUP; restarting.` | ✅ |
| 已认证会话 | 子进程继续服务 | reload 后 `est22=10`（与基线一致）；10 个子进程 exe 全为 `/usr/local/libexec/sshd-session` | ✅ |

> 说明：`MainPID` 未变而 `/proc/<pid>/exe` 已是新二进制，正是方案 R3 描述的 `execv` 自替换行为 —— 监听进程现在是 10.6 代码，**旧会话的子进程仍是 9.8 helper**（`/usr/local/libexec/sshd-session` 未被删除，故旧会话不受影响）。

**§5.4 判定：通过。**

## §5.5 生效后验收（进行中）

| # | 检查 | 实测 | 判定 |
|---|---|---|---|
| 1 | 监听恢复 | `0.0.0.0:22` + `[::]:22` 都在听 | ✅ |
| 2 | 运行映像 | `md5sum /proc/1293214/exe` = `19556e1d03ec82620668c6de424c9b5d` = 新 `/usr/sbin/sshd` | ✅ |
| 3 | 协议入口 | `ssh -F /dev/null -v -o BatchMode=yes -p 22 root@10.5.20.39 true` → `debug1: Remote protocol version 2.0, remote software version OpenSSH_10.6` | ✅ |
| 4 | 真实登录（22） | 11:23:01/11:23:02 两次 `Accepted password for root from 172.18.34.204`（journal），对应 `pts/8` 终端会话 + 一个 `notty` 会话 | ✅ |
| 5 | SFTP 上传/下载 | 该 `notty` 会话下派生 `1889973 sshd-session: root@internal-sftp`（exe=新 helper），说明 `Subsystem sftp internal-sftp` 链路可用 | ✅ |
| 6 | 新连接用新 helper | 新连接子进程 **`1889830`/`1889868`（PPID=1293214）**，`readlink -f /proc/<pid>/exe` = **`/usr/libexec/openssh/sshd-session`**；其下游 `1889867 root@pts/8`、`1889953 root@notty`、`1889973 root@internal-sftp` 也全是该新路径 | ✅ |
| 7 | 旧会话仍可用 | 用户在其切换前就已打开的 22 会话内执行 `echo OLD-SESSION-ALIVE`，**回显 `OLD-SESSION-ALIVE`** ✅；进程侧同时满足：`3830207`（pts/1）`starttime=407133852` 与基线一致、`ELAPSED 3-17:28:44`，10 个旧子进程 exe 仍为 `/usr/local/libexec/sshd-session` | ✅ |
| 8 | 认证链路 | `journalctl -u sshd --since 11:20` 有 `Accepted password` + `pam_unix(sshd:session): session opened`；`grep -aiE 'does not exist\|fatal\|error\|fail'` 自 11:20 起 **0 条**；`/var/log/secure` 同步有 pam 记录 | ✅ |
| 9 | 配置生效值 | `/usr/sbin/sshd -T` → `Port 22`、`UsePAM yes`、`Subsystem sftp internal-sftp` | ✅ |
| 10 | 校验和变化范围 | `md5sum -c /root/fhy/baseline.md5` → `sshd_config: OK`、`ssh_config: OK`、`/usr/sbin/sshd: FAILED`（预期）、`/usr/bin/ssh: OK` | ✅ |

第 10 项附带 `rpm -V openssh-server openssh-clients`（6 行，比基线多 1 行，符合 §2.7 预期）：

```
SM5....T.  c /etc/ssh/sshd_config
S.5....T.    /usr/lib/systemd/system/sshd.service
S.5....T.    /usr/libexec/openssh/sftp-server     ← 本次新增（预期）
S.5....T.    /usr/sbin/sshd
S.5....T.    /usr/bin/scp
S.5....T.    /usr/bin/ssh
```

reload 前 10 个旧会话仍是 listener 的直接子进程，exe 全部指向旧 helper：

```
886621 /usr/local/libexec/sshd-session     985738 /usr/local/libexec/sshd-session
899517 /usr/local/libexec/sshd-session     1171897 /usr/local/libexec/sshd-session
985543 /usr/local/libexec/sshd-session     1792290 /usr/local/libexec/sshd-session
1979750 /usr/local/libexec/sshd-session    3607678 /usr/local/libexec/sshd-session
3608545 /usr/local/libexec/sshd-session    3830164 /usr/local/libexec/sshd-session
```

## §5.6 替换后基线（11:27 已生成）

`/root/fhy/baseline-after-10.6.md5`：

```
519207bc1a32fc5cafcdddeaff87e884  /etc/ssh/sshd_config
7c4eea6cb2fe4f55d51cc03d0a327306  /etc/ssh/ssh_config
19556e1d03ec82620668c6de424c9b5d  /usr/sbin/sshd
9ca84bf447eaa1ed5c1ef3e1f706c344  /usr/bin/ssh
8909e0b4a0a61df3a1c58ad172da3df1  /usr/libexec/openssh/sshd-session
37eb4f87ebe992e2965b6f11f5e22a27  /usr/libexec/openssh/sshd-auth
7196fe74d64df9b88ecabe4b552cdf55  /usr/libexec/openssh/sftp-server
42ced75d21a585f1df63ebda33dc66fd  /usr/local/libexec/sshd-session
--- rpm -V openssh-server openssh-clients
（上述 6 行）
```

> 附注：`/usr/bin/ssh` 实测 md5 为 `9ca84bf447eaa1ed5c1ef3e1f706c344`（方案 §11 早期记录写成 `...3e6f706c344`，有 2 位笔误；以本文件实测为准）。

## §5.7 验收窗口与切换后状态（11:32 复核）

| 项 | 要求（方案 §5.7） | 实测 |
|---|---|---|
| 10 分钟窗口内满足第 1/3/4/5 项 | reload 后 10 分钟内 | reload `11:20:05` → 监听恢复 + banner `OpenSSH_10.6` + 真实登录 `11:23:01` + `root@internal-sftp` 派生，**全部在 3 分钟内** ✅ |
| 监听 60s 内未恢复 → 回滚 | 未触发 | 监听未中断可见异常 ✅ |
| banner 非 10.6 / `does not exist or is not executable` → 回滚 | 未触发 | banner = `SSH-2.0-OpenSSH_10.6`；自 11:20 起 journal 中 `does not exist`/`fatal`/`error`/`fail` **0 条** ✅ |
| 真实登录连续 2 次失败 → 回滚 | 未触发 | 11:23 两次登录均 `Accepted password` ✅ |
| SFTP 不可用 → 回滚 | 未触发 | 新 helper 下 `root@internal-sftp`（1889973）正常派生 ✅ |

切换后即时状态（11:32）：

```
/usr/sbin/sshd -V  → OpenSSH_10.6p1, OpenSSL 1.1.1wa  16 Nov 2023
MainPID            → 1293214（与切换前一致，ActiveState=active）
listener 子进程     → 12 个（10 个旧 + 2 个新）
est22              → 12
/tmp/... 无残留     → 发布脚本用到的临时文件已由脚本自行清理（`trap`），/usr 下无 `.tmp` 残留
```

## 阶段二结论

**§5 全部通过**：§5.1 门禁 10/10 → §5.3 发布 `PUBEXIT=0`（PRE-T/POST-T 均 0）→ §5.4 reload `MainPID` 不变、exe 已是新二进制 → §5.5 十项验收 10/10 → §5.6 替换后基线已生成。

系统现状：

| 文件 | 版本/校验 |
|---|---|
| `/usr/sbin/sshd` | 10.6p1，596752 B，`19556e1d03ec82620668c6de424c9b5d` |
| `/usr/libexec/openssh/sshd-session` | 1052208 B，`8909e0b4a0a61df3a1c58ad172da3df1`（新连接全部走它） |
| `/usr/libexec/openssh/sshd-auth` | 1014864 B，`37eb4f87ebe992e2965b6f11f5e22a27` |
| `/usr/libexec/openssh/sftp-server` | 162088 B，`7196fe74d64df9b88ecabe4b552cdf55` |
| `/usr/local/libexec/sshd-session` | 旧 9.8 helper 保留（1831936 B，`42ced75d21a585f1df63ebda33dc66fd`），仅旧会话在用，**不要删**（回滚要用） |
| `/usr/bin/ssh`、`/usr/bin/scp` | 9.8 未动（D1） |

回滚资源仍在位：`/root/openssh-backup-20261023-100913/`（含 `libexec-local/`）、备份 tar 4163713 B / `0de6afe80a0212f81305da0e28d6cf1b`、`/root/fhy/rollback-min.sh`（`02a27123ec984098cff8ec2ee019f6bc`，700，`bash -n` 通过）。

## 后续待办（按 §10 清单，非本轮）

1. **24h 观察**：`journalctl -u sshd` + `/var/log/secure`，重点看 `Accepted`/`fatal`/`pam_` 异常，以及 10.6 新增的 PQ KEX `WARNING` 数量（属预期噪音，非错误）。
2. **D4：2222 去留**：观察期后再决定是否关闭 2222 旁路实例（当前 pid 376266，`/root/fhy/openssh-10.6/`，与系统文件无共享）。
3. **§9.1 本机 CLI 损坏**（升级前即坏，本次不解决）：`/etc/crypto-policies/back-ends/openssh.config` 第 3 行 `gssapikexalgorithms` 等 4 处 bad option 会让本机 `ssh/scp/sftp` 直接退出 255；临时绕过 `-F /dev/null`。
4. **§9.2**：RPM 元数据仍是 9.8，`rpm -V` 脏文件 6 个（含本次新增 `sftp-server`），已在 `baseline-after-10.6.md5` 记录，供安全扫描白名单使用。

## 切换后健康快照（11:35）

```
systemctl is-active sshd            → active
systemctl show sshd -p NRestarts    → 0            （reload 未触发重启，与 §5.4 结论互相印证）
监听                                → 0.0.0.0:22  pid 1293214   [::]:22  pid 1293214
                                      0.0.0.0:2222 pid 376266    [::]:2222 pid 376266
磁盘 /                              → 7.5G 可用（86%）
/root/fhy/build-usr                 → 80M（编译树，保留待观察期后再清理）
/root/fhy/stage-usr                 → 8.2M（暂存产物，保留供回滚/比对）
journalctl -u sshd 最近 3 条        → 1 条 PQ KEX WARNING + 1 条正常关闭 + 1 条 pam session closed，无 fatal
```

**流水账到此为止；剩余两项（24h 观察、2222 去留 D4）在观察期结束后追加。**

---

# 附录 A：版本核验脚本 `/root/fhy/check-sshd-version.sh`

切换后为了随时回答「现在跑的到底是不是 10.6」，落地了一个只读脚本（700，`bash -n` 通过），用四重独立证据判定：

```bash
bash /root/fhy/check-sshd-version.sh
```

11:40 实跑输出：

```
MainPID          : 1293214 (active, NRestarts=0)
1 磁盘二进制版本  : OpenSSH_10.6p1, OpenSSL 1.1.1wa  16 Nov 2023
2 进程映像=磁盘   : 一致 (19556e1d03ec82620668c6de424c9b5d)
   inode 相同     : 相同 (2054:44763203)
   残留旧 inode   : 无（进程用的是当前文件）
3 协议 banner     : SSH-2.0-OpenSSH_10.6
4 子进程 helper   : 新路径 4 个 / 其它路径 10 个

结论: PASS —— 运行中的服务就是 OpenSSH_10.6（listener 与新连接 helper 都是）
```

四重证据各自的含义与「只看一项会误判」的原因：

| # | 检查 | 证明什么 | 单独看会漏什么 |
|---|---|---|---|
| 1 | `/usr/sbin/sshd -V` | 磁盘上的文件是 10.6 | 文件换了但没 reload 时，进程仍跑旧 inode |
| 2 | `/proc/<MainPID>/exe` 的 md5 / `stat -L` inode 与磁盘文件相同、`/proc/<pid>/maps` 无 `(deleted)` | **内存里执行的字节就是那个 10.6 文件** | 只证明 listener，不证明 privsep 子进程 |
| 3 | 新连接 banner `SSH-2.0-OpenSSH_10.6` | 服务端在自己的协议握手里自报 10.6 | 经过代理/端口转发时会看到代理的版本 |
| 4 | 新连接子进程 exe = `/usr/libexec/openssh/sshd-session` | 认证后的 privsep 会话进程也换成了 10.6 helper | 旧会话（10 个）仍指 `/usr/local/libexec/sshd-session`，属预期 |

附带旁证：`NRestarts=0` + `MainPID` 与切换前一致（1293214），说明不是靠重启掩盖；`journalctl -u sshd` 里 `post-quantum` 提示 6 条，是 10.x 才有的新行为（9.8 无此输出）。
