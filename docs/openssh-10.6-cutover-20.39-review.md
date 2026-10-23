# 10.5.20.39 OpenSSH 10.6p1 替换方案审查意见

- 审查日期：2026-10-23
- 被审文档：[openssh-10.6-cutover-20.39.md](./openssh-10.6-cutover-20.39.md)
- 最新审查对象：原方案 v4。
- 最新结论：**v3 最后指出的管道误判问题已在 v4 修正，N7 可在文档与代码块层面闭环。目前未发现尚未修正的明显严重错误；实际切换仍按既定门禁验收。**
- 本次仅审查并形成报告，未修改原方案，未连接目标主机，未执行编译、替换、reload 或回滚。

## v4 核对（2026-10-23，当前有效结论）

已确认 §6.1 的判断改为 `strings "$B/sbin/sshd" | grep -xF -- "$OLD_HELPER" >/dev/null`。回滚代码块内已没有使用 `grep -q` 的管道，监听检查也同步去掉了 `-q`。

从文档提取回滚代码块、按 LF 换行计算的 MD5 为 `02a27123ec984098cff8ec2ee019f6bc`，与 §11 更新后的记录一致。文档另有主机侧旧写法 40 次返回 141、新写法 5 次返回 0 的测试记录；这些是作者提供的现场结果，本次未独立登录目标主机核验磁盘脚本或重跑测试。

**此前最后指出的问题已修正；本轮未发现新的明显严重错误。** 原方案未修改，本次只更新审查结论。

---

## v3 复审（2026-10-23，仅检查严重错误，历史记录）

本轮检查范围为切换失败、回滚失效和操作通道丢失；不继续扩展一般文案或非阻断项。原方案未修改，未执行目标主机命令。

已确认 v3 的发布前显式失败判断、逐文件 `cmp`、helper 先发布、备份目录创建、备份产物预演、2244 收尾以及回滚前依赖检查均已落实。旧版依赖与新版默认路径相互分离，2222 仍使用独立的旧前缀产物；文档中的这些主要路径没有新发现的严重矛盾。

**仍需修正一行：§6.1，原方案 630–632 行。**

当前写法：

```bash
if ! strings "$B/sbin/sshd" | grep -qxF "$OLD_HELPER"; then
  die "备份主程序的默认 helper 路径不含 $OLD_HELPER，链路不匹配"
fi
```

脚本启用了 `pipefail`。`grep -q` 在匹配后可立即退出，上游 `strings` 如果还在写入就可能收到 SIGPIPE；于是即使路径匹配成功，整个管道仍可能非零，进入 `die`，在真正恢复主程序之前拒绝回滚。

这是可能影响应急恢复的失败判断问题，不是缺少匹配路径。改为完整消费输入即可：

```bash
if ! strings "$B/sbin/sshd" | grep -xF "$OLD_HELPER" >/dev/null; then
  die "备份主程序的默认 helper 路径不含 $OLD_HELPER，链路不匹配"
fi
```

本机没有 `strings` 命令，因此未执行原始 `strings` 管道。验证方式是从同一旧备份二进制提取可打印文本，用分块输出程序作为上游复现提前关闭管道：三次中一次得到上游状态 `141`、`grep` 状态 `0`，证明“匹配成功但 pipefail 判失败”的条件可发生；这不是目标主机故障率的测量。

**结论：修正这一行并同步磁盘上的 `rollback-min.sh`、文档及其校验值后，从文档和脚本逻辑层面未发现其他新的明显严重错误。** 生产执行仍以方案已经列出的备份、备用端口登录/SFTP、2222 新登录和切换后真实验收为条件；本次没有验证它们在目标主机上已通过。

---

## 0. v2 复审（2026-10-23，历史记录）

本节对应原方案 v2 的行号。后续 §1–§5 保留首轮对 v1 的审查记录，其旧结论不能直接当作 v2 的现状。

复审仍由 Codex 直接完成，未委派。文档新增的现场实测记录作为作者提供的证据使用，本次没有重新连接目标主机验证。以下脚本语义问题已通过本机 Git Bash 的最小复现验证；没有执行文档中的生产命令。

### 0.1 首轮问题闭环情况

| 首轮编号 | v2 状态 | 复审结论 |
|---|---|---|
| R1 暂存 helper 路径 | 主要修正 | §4.6 两个 `-o` 正确；但 §4.5 的预期仍与未加覆盖的命令矛盾，见 N4。 |
| R2 旧 helper 与备份 | 尚未闭环 | 已明确真实路径与依赖；补备份命令会在目标目录不存在时失败，预演也未使用备份产物，见 N3。 |
| R3 reload 原理与 PID | 原理已修正 | 监听中断、正常 PID 不变、映像校验的描述正确；旧会话仍需实际执行命令，不能只检查 PID。 |
| R4 故障恢复 | 主要修正 | 已删除 42 秒恢复承诺，增加存活/退出分支与超时；实际回滚脚本仍有 N2 的失败处理问题。 |
| R5 回滚可靠性 | 尚未闭环 | `restore.sh` 描述已修正；新增脚本并不能保证“任一步失败立即中止”，且没有恢复声明中的全部四个文件，见 N2、N6。 |
| R6 验收 | 部分修正 | `-F /dev/null` 和旧客户端校验和预期已正确；PID 集合检查仍不能证明原会话功能正常。 |

### 0.2 N1：发布前检查失败仍会执行 rename（P1）

**位置：原方案 §5.3，351、361–368、372 行。**

`set -euo pipefail` 不会让 `cmd && echo` 左侧的 `cmd` 失败后自动退出。文档当前命令：

```bash
/usr/sbin/.sshd.10.6.new -t -f /etc/ssh/sshd_config && echo "PRE-T=0"
md5sum /usr/sbin/.sshd.10.6.new $S/sbin/sshd
mv -f /usr/sbin/.sshd.10.6.new /usr/sbin/sshd
```

当 `-t` 因配置、密钥或运行环境检查失败时，脚本仍会继续计算校验和并发布。POST-T 也存在相同问题。仅打印两个文件的 `md5sum` 不执行相等性判断，两份内容不同也可返回 0。整段粘贴执行时，没有在人工比较校验和之前暂停的机制。

本机最小复现：

```bash
bash -c 'set -euo pipefail; false && echo PRE-T=0; echo PUBLISH_REACHED'
```

实际输出 `PUBLISH_REACHED`，退出码为 0。依据：[GNU Bash 的 set/errexit 说明](https://www.gnu.org/s/bash/manual/bash.html#The-Set-Builtin)。

**要求修正：**把关键门禁写成显式失败分支，且校验所有待发布文件，不仅主程序。例如：

```bash
if ! /usr/sbin/.sshd.10.6.new -t -f /etc/ssh/sshd_config; then
  echo "FATAL: PRE-T failed" >&2
  exit 1
fi
if ! cmp -s /usr/sbin/.sshd.10.6.new "$S/sbin/sshd"; then
  echo "FATAL: staged sshd mismatch" >&2
  exit 1
fi
```

helpers 和可选 `sftp-server` 同样比较通过后才能发布。执行初始的三个 `test -x` 也应写成逐条检查或带 `|| exit 1` 的整体判断。建议先发布完整的新 helper，再最后发布主程序，缩短意外重启遇到不完整新链路的窗口。

### 0.3 N2：回滚先改系统再验依赖，且检查失败可被漏过（P1）

**位置：原方案 §6.1，450–458、480–486 行。**

当前脚本先把旧 `sshd` 发布到 `/usr/sbin/sshd`，随后才确认旧 helper 与依赖。若此时检查发现旧 helper 不可用，脚本退出后磁盘上的主程序已经回到不可工作的旧链路，运行态则可能仍是新进程；后续自动重启会进一步受到影响。回滚前置条件应在发布任何文件前验证。

依赖检查本身还存在失败放行：

```bash
ldd "$OLD_HELPER" | grep -q 'not found' && { echo FATAL; exit 1; }
```

这只处理“输出命中 not found”的情况。如果 `ldd` 自身执行失败，且没有输出该文本，管道非零状态位于 `&&` 左侧，不会被 `set -e` 自动中止。`pipefail` 改变管道状态，但不能取消这一例外。本机用返回 1 的替身 `ldd` 复现，脚本仍执行到后续步骤。`grep -q` 提前关闭管道也可能令上游收到 SIGPIPE，不能把整个非零状态统一解释为“没有缺库”。

同一脚本的配置检查仍是 `sshd -T ... && echo CONFIG-Ok`，失败后会继续最后一个 `echo`；`md5sum /proc/$P/exe || true` 也允许运行映像读取失败被忽略。因此 486 行“任一步失败立即中止”的结论不成立。

**要求修正：**

1. 发布前验证备份主程序、匹配 helper、校验和、权限、动态依赖和当前配置；需要从备份恢复旧 helper 时，先准备好完整链路。
2. 分开判断 `ldd` 执行结果和缺库文本，不把检查命令错误当作通过。例如：

   ```bash
   if ! deps=$(ldd "$OLD_HELPER" 2>&1); then
     printf 'FATAL: ldd failed\n%s\n' "$deps" >&2
     exit 1
   fi
   if grep -F 'not found' <<<"$deps" >/dev/null; then
     printf 'FATAL: missing dependency\n%s\n' "$deps" >&2
     exit 1
   fi
   ```

3. 配置检查失败、运行映像读取失败或与备份不匹配时显式报错退出。脚本检查通过与最终人工登录/SFTP 验收继续分开。

### 0.4 N3：补备份命令缺目录创建，预演也未验证备份（P1）

**位置：原方案 §4.7，308–317 行。**

现有备份清单没有 `libexec-local/`，v2 在复制前也没有创建它：

```bash
cp -a /usr/local/libexec/sshd-session /root/openssh-backup-20261023-100913/libexec-local/
```

目标带尾斜杠时必须已有目录。本机使用临时文件和不存在的目录复现，`cp` 返回非零并提示 `Not a directory`。该代码块没有显式失败处理，后续 `md5sum` 和 2244 启动仍可能继续；2244 又使用现网主程序与现网 helper，所以即使备份失败，登录测试仍可成功。

这只能证明现网旧链路可用，不能证明用于恢复的备份完整、匹配。当前回滚脚本也没有从补备份的位置恢复 helper，遇到旧 helper 缺失只会中止。

**要求修正：**

- 用 `install -d -m 0700` 明确创建备份子目录，再复制到显式文件路径；不要无检查地覆盖已验证备份。
- 比较备份副本与源文件内容，记录属主、权限及校验和；阶段二的门禁检查实际副本，不能只检查源文件。
- 2244 用备份的主程序启动，并通过 `SshdSessionPath` 指向备份 helper，验证真登录与 SFTP。
- 回滚流程明确备份 helper 的恢复方式；补备份后更新归档和异地副本及其校验值，或明确记录增量备份的独立位置。

### 0.5 N4：§4.5 的 helper 路径预期仍与命令矛盾（P2）

**位置：原方案 §4.5，254–258 行。**

这里运行的 `-T` 没有 `SshdSessionPath` / `SshdAuthPath` 覆盖，而新构建的默认值应为 `/usr/libexec/openssh/`。原文却期待输出 `/root/fhy/stage-usr/usr/libexec/openssh/`，会把正确的标准路径产物误判为失败。

**要求修正：**§4.5 验收默认路径 `/usr/libexec/openssh/`；只有 §4.6 显式加测试覆盖后才期待暂存路径。两个检查的目的应保持区分。

### 0.6 N5：2244 旧版验证实例缺少收尾步骤（P2）

**位置：原方案 §4.7，312–317 行，以及 §10 清单。**

2233 有停止与端口释放检查，2244 没有。照稿执行会在切换完成后额外保留一个 9.8 监听器，不在 D4 的“保留 2222 新版旁路”安排内。该测试实例使用现网配置和可访问端口，不能默认为已关闭。

**要求修正：**2244 验收后确认 PID 与实际程序，停止该 listener 并确认端口释放；关闭测试会话，避免后续 PID 基线混入测试实例。将收尾列入阶段二前置门禁。

### 0.7 N6：最小回滚宣称覆盖四个文件，实际只恢复一个（P2）

**位置：原方案 §6.1，439–484 行。**

本轮发布脚本总会替换外部 `sftp-server`，但最小回滚脚本只恢复 `/usr/sbin/sshd`，没有恢复备份的 `sftp-server`；两个新增 helper 也保留。保留新 helper 以供相关连接继续使用可以接受，但“仅动本次 4 个文件”不是实际行为。

**要求修正：**明确选择：

- 仅做旧服务链路恢复：准确说明只恢复旧 listener，保留新 helper 和外部 `sftp-server`；或
- 撤销本次已有文件的替换：同时恢复备份 `sftp-server`，并说明新增 helper 的延后清理安排。

现网 `internal-sftp` 不调用外部程序，因此此问题不等同于回滚后必然无法传文件，但文件级回滚范围必须准确。

### 0.8 其他应一并修正的说明

- **§4.3，216 行：**普通 `make install DESTDIR=...` 包含 `install-sysconf`，会创建暂存配置。不能断言 `<stage>/etc/ssh/sshd_config` 不存在，并把安装期所有 `-t` 报错笼统视为可忽略。应检查实际诊断；例如未生成主机密钥与配置文件缺失是不同原因。依据：[10.6p1 Makefile.in 的 install、install-sysconf 和 check-config](https://github.com/openssh/openssh-portable/blob/V_10_6_P1/Makefile.in)。
- **§4.4，233、249 行：**`awk '{print $1" -> "$3}'` 会把 `libX => not found` 截成 `libX -> not`，丢失要求人工检查的完整文本。保留原始 `ldd` 输出并显式判错。不同可执行程序的依赖集合也不必完全一致，重点是与各自预期相符、库路径正确且无缺失。
- **§2.7、§7：**“客户端不换，所以 rpm -V 不新增脏文件”不成立。初始五项清单不含外部 `sftp-server`，本轮若替换这个受 RPM 管理的文件，其校验异常可新增。应按实际替换清单复核。
- **§5.5 第 7 项：**`kill -0` 只能证明对应 PID 可见，不能证明是同一启动实例或该会话还能交互；自然退出也会造成误报。保留固定旧会话并在其中执行命令，PID/启动时间/连接标识只作辅助证据。

### 0.9 v2 结论

**v2 的路径覆盖、reload 原理、42 秒等待含义和客户端校验预期已经明显改进；目前仍应修正 N1–N3 后再提交执行。** N4–N6 及上述验收说明应一并调整，避免流程出现互相矛盾的成功标准或留下旧版测试监听器。

本次最小复现验证了失败检查放行、缺失备份目录导致复制失败、不同文件的普通 `md5sum` 仍返回 0。未进行目标主机的替换或恢复测试，因此不宣称现场备份和回滚链路已经通过。

---

以下为首轮 v1 审查记录，保留用于追踪修订来源。

## 1. 审查依据与边界

本次直接核对了：

1. 被审文档全文及其中的执行命令。
2. OpenSSH Portable `V_10_6_P1` 的 `sshd.c`、`sshd-session.c`、`servconf.c`、`servconf.h`、`Makefile.in` 等上游源码，以及 `V_9_8_P1` 的 reload 实现。
3. OpenSSH 官方配置手册与 systemd 官方服务手册。
4. 本机备份包 `D:\workspace\download\lyshell\10.5.20.39 Copy\openssh-backup-20.39.tar.gz` 的文件清单、备份 `sshd` 的可打印字符串、`restore.sh`、`sshd.service` 和 `sshd_config`。

本机备份包 MD5 为 `f26f0ae4153e42bfc6c848036d6aac45`，与方案记录一致。仅提取审查所需内容，未提取主机私钥。

目标主机当前的 helper 文件、动态库解析、systemd drop-in、`/etc/sysconfig/sshd`、运行中进程和真实登录结果仍需现场复核。上游源码结论不能代替该主机的运行验证。

代码与方案审查按仓库要求由 Codex 直接完成，未委派给工作助手。

## 2. 问题清单

| 编号 | 等级 | 位置 | 问题 |
|---|---|---|---|
| R1 | P1 | §4.6，原文 189–205 行 | 暂存区启动命令没有覆盖 helper 路径，无法完成宣称的暂存全链路验证 |
| R2 | P1 | §6.1，原文 324–334 行；备份清单 | 9.8 已依赖 `sshd-session`，备份缺少旧二进制默认引用的 helper |
| R3 | P1 | §5.4，原文 284–286 行 | reload 会关闭监听 socket；正常 re-exec 保持 PID，现有生效判据错误 |
| R4 | P1 | §1、§6.3、§7，原文 21、350–353、362 行 | 42 秒不是恢复上限，主进程退出后不能只靠 reload 回滚 |
| R5 | P2 | §6.2，原文 338–346 行；实际 `restore.sh` | “完全回滚含 PAM”与脚本不符，且脚本可在关键失败后返回成功 |
| R6 | P2 | §5.5，原文 295–302 行 | 版本检查受已知坏客户端配置阻断，校验和与连接存活判据也有误 |

P1 表示应在执行阶段二前修正；P2 表示会影响回滚可靠性或验收准确性，应随执行稿一起修正。

### R1：暂存测试不会自动使用暂存区的 helper（P1）

**证据与影响**

方案用 `--libexecdir=/usr/libexec/openssh` 编译，却直接从 `/root/fhy/stage-usr/usr/sbin/sshd` 启动 2233 实例。`DESTDIR` 只改变安装落点，不改变程序运行时的默认路径。

因此，该命令默认仍会寻找：

```text
/usr/libexec/openssh/sshd-session
/usr/libexec/openssh/sshd-auth
```

它不会因主程序在暂存区就自动改找 `/root/fhy/stage-usr/usr/libexec/openssh/`。若系统目标位置没有 helper，10.6 会在启动检查时退出；若已有 helper，则可能测试到系统上的另一份产物。原文期望在 `ps` 中自然出现暂存 helper 路径不成立。

另外，`sshd -t` 的成功退出位于正常启动的 helper 存在性检查之前，因此 §4.5 通过不能证明 §4.6 能启动。

依据：[10.6p1 sshd.c](https://github.com/openssh/openssh-portable/blob/V_10_6_P1/sshd.c)、[10.6p1 Makefile.in](https://github.com/openssh/openssh-portable/blob/V_10_6_P1/Makefile.in)。

**修改建议**

2233 测试显式指定两个测试路径，系统配置文件无需为此改动：

```bash
/root/fhy/stage-usr/usr/sbin/sshd \
  -f /etc/ssh/sshd_config \
  -p 2233 \
  -o PidFile=/root/fhy/sshd-2233.pid \
  -o SshdSessionPath=/root/fhy/stage-usr/usr/libexec/openssh/sshd-session \
  -o SshdAuthPath=/root/fhy/stage-usr/usr/libexec/openssh/sshd-auth \
  -E /root/fhy/sshd-2233.log
```

`SshdSessionPath` 和 `SshdAuthPath` 是上游提供的测试用途选项，10.6p1 源码中均有定义。依据：[10.6p1 servconf.h](https://github.com/openssh/openssh-portable/blob/V_10_6_P1/servconf.h)、[官方选项说明](https://man.openbsd.org/sshd_config#SshdAuthPath)。

验收应包括真登录和 SFTP，并结合测试监听器的子进程关系、`/proc/<pid>/exe` 确认使用暂存文件。进程标题可能被改写，不能只依赖 `ps | grep` 显示完整路径。

此测试证明暂存产物能完成业务链路；正式安装后仍需验证不带测试路径覆盖的默认链路。

### R2：旧版 helper 未纳入备份，回滚前提不完整（P1）

**证据与影响**

原文称“9.8 的 sshd 是单进程模型，不依赖 sshd-session”，此说法错误。9.8 已拆出 `sshd-session`，10.0 再进一步拆出 `sshd-auth`。依据：[OpenSSH 官方发布说明](https://www.openssh.org/releasenotes.html)。

本机备份 `sbin/sshd` 的可打印字符串中包含：

```text
OpenSSH_9.8p1
/usr/local/libexec/sshd-session
/usr/lib64/ssh1.1.1/
libcrypto.so.1.1
```

其中 `/usr/local/libexec/sshd-session` 是旧二进制内嵌的默认 helper 路径。备份的 `sshd_config` 未覆盖此路径；仍需现场检查 `$OPTIONS` 等启动参数是否覆盖默认值。

但备份包清单没有 `sshd-session`，`restore.sh` 也没有恢复 `/usr/local/libexec/sshd-session`。

**这不意味着只回退主程序必然失败**：如果旧 helper 仍在原路径且未被改动，快速回退可能正常工作。本方案的新 helper 目标路径与上述旧默认路径不同，也没有证据表明本次会直接覆盖旧 helper。问题是现有备份无法独立恢复完整的旧服务链路，不能据此宣称回滚完备。

**修改建议**

- 切换前确认旧 listener 实际使用的 helper 路径，记录文件版本、校验和、属主权限，并把对应文件纳入备份和恢复清单。
- 对旧 helper、旧主程序和新三个服务端程序分别核对动态依赖，记录实际解析到的库路径；不能仅凭主程序 `-V` 证明所有组件依赖正确。
- 在备用端口验证“备份的旧主程序 + 匹配的旧 helper”的登录和 SFTP，再把它作为回滚验收依据。
- 保留旧 helper；新 helper 也可先保留，待相关新旧连接和认证过程结束后再单独清理。

### R3：reload 不是监听 socket 无缝继承，PID 判据相反（P1）

**证据与影响**

9.8 和 10.6 的 `sighup_restart()` 都包含关闭监听 socket 后再 `execv()` 的逻辑。正常监听循环处理 SIGHUP 时也会进入停止接收新连接的阶段。

因此：

- “监听 socket 不中断”不成立，新连接可能遇到短暂拒绝或重试。
- `execv()` 替换进程映像，正常执行成功保持 PID；现网 `ExecStart` 带 `-D`，不应期待正常 reload 改变 `MainPID`。
- PID 改变可能意味着旧主进程退出、systemd 重新启动，应调查原因，不能将其作为成功标志。
- 已认证会话通常由独立子进程继续服务，但这与新连接的监听连续性是两个不同问题。SIGHUP 的处理也不由 `KillMode` 决定；`KillMode` 主要约束 systemd 的停止与杀进程行为。

依据：[9.8p1 sshd.c](https://github.com/openssh/openssh-portable/blob/V_9_8_P1/sshd.c)、[10.6p1 sshd.c](https://github.com/openssh/openssh-portable/blob/V_10_6_P1/sshd.c)。

**修改建议**

将影响描述改为：“计划保留已认证会话；reload 期间新连接可能存在短暂窗口，不承诺零中断。”

生效验收改为结合以下证据：

1. 记录 reload 前后 `MainPID` 和 `/proc/<MainPID>/exe` 对应文件的身份或校验和，确认运行映像已切换。
2. 轮询确认 22 的 IPv4/IPv6 监听恢复。
3. 独立建立新连接，核对远端版本并完成真实认证、SFTP。
4. 在事先保持的旧会话内继续执行命令，确认原会话仍可用。

`systemctl reload` 返回成功仅表示 `/bin/kill` 成功发送信号。固定 `sleep 2`、一条旧日志或 `ActiveState=active` 都不足以单独证明新版本已就绪。systemd 官方手册明确指出，这种发信号式 reload 是异步操作：[ExecReload 说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#ExecReload=)。

### R4：42 秒不是故障恢复上限，失去主进程时 reload 无法救援（P1）

**证据与影响**

`RestartSec=42s` 表示自动重启前的等待时间，不表示 42 秒后服务必定恢复。自动重启仍执行磁盘上的新二进制；缺失 helper、动态库错误或配置错误若未修复，重启后仍会失败。部分认证链路故障还可能只导致每连接子进程失败，listener 保持运行，根本不触发自动重启。

此外，重启受启动频率限制约束，实际值需要现场读取，不能只根据 unit 的这几行推导。依据：[systemd Restart/RestartSec 说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Restart=)。

原文 §6.3 在“22 完全起不来”时先尝试 §6.1，而 §6.1 只恢复文件再 reload。若主进程已经退出、unit 处于 failed/inactive，reload 没有可重执行的目标，不能完成恢复。

**修改建议**

- 删除“最坏最长 42s”的承诺，明确恢复时长取决于故障修复或回滚成功。
- 回滚先恢复经验证的旧主程序及其依赖，再按权威运行状态分支处理：主进程仍存活时可 reload；服务已停止时应 start；启动限流时，排除故障后按需 reset-failed 再 start。
- 设置明确的切换验收超时和人工回滚触发条件；无论自动重启是否发生，最终均以监听、真实新登录和 SFTP 成功为准。
- 在阶段二前重新建立一次 2222 登录，验证旁路可以接受新连接，而不只确认已有会话尚未断开。

### R5：“完全回滚”与实际脚本行为不一致（P2）

**证据与影响**

实际备份 `restore.sh` 的核心行为是：

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

存在三项与方案保障不一致的情况：

1. **不恢复 PAM 配置。** 包内虽有 `pam/`，脚本没有复制它，更不会回退已升级的 PAM RPM；§6.2 标题“含配置、unit、PAM”不准确。
2. **关键失败可被忽略。** `set -u` 只检查未定义变量，不会让复制、启动或监听检查失败立即成为脚本失败。末尾版本命令成功时，前面启动失败仍可能得到脚本退出码 0。
3. **恢复范围比此次变更宽。** 它覆盖全部备份客户端文件和 `/etc/ssh/` 内容，包括主机密钥；这不是仅撤销本次四个服务端文件的最小回滚。

**修改建议**

优先编写仅针对本次变更文件的回滚流程。保留全量恢复工具时，应准确描述其范围，逐项处理关键命令失败，并把真实登录与 SFTP 作为人工验收项。不要用脚本退出码或 `sshd -V` 代替服务恢复判据。

若确实需要恢复 PAM，应另行明确恢复哪些配置及是否涉及软件包版本；不应为匹配标题而扩大本次变更。

### R6：生效后验收包含确定的错误预期（P2）

**证据与影响**

- §5.5 第 2 项用本机 `ssh` 检查远端版本，但 §9.1 已说明系统客户端配置会报错退出；按现有命令可能在连接前就失败。而普通 `ssh` 未加调试参数也不会按预期打印协议版本行。
- §5.5 第 9 项称两个二进制校验“必然 FAILED”，但本轮明确不替换 `/usr/bin/ssh`，所以其校验应继续为 `OK`。只有被替换的 `/usr/sbin/sshd` 应相对旧基线变化。
- `ss` 总连接数和 `who` 总人数不能证明原会话存活：自然退出和新登录都可能掩盖断连；未排除表头也会影响计数。
- 全局 `ps | grep sshd-session` 可能匹配旧 22 会话、2222 或其他测试实例，不能证明新 22 连接使用了指定 helper。

**修改建议**

版本探测可使用 `ssh -F /dev/null -v`，绕过已知坏的系统客户端配置，并从标准错误的调试日志读取远端协议版本；这一步与真实登录验收分开。`-F` 的行为见 [ssh 官方手册](https://man.openbsd.org/ssh.1#F)。

也可使用独立客户端或方案已有的 TCP banner 探测。无论使用哪种探测，banner 成功只代表协议入口可达，仍需认证和 SFTP 验证。

旧会话验收使用事先固定的会话及连接标识；进程验收应关联新连接、父子关系和 `/proc/<pid>/exe`。修正校验预期：配置与旧客户端不变，服务端主程序发生预期变化，新 helper 单独生成基线。

## 3. 对原文六个审查重点的回答

| 原文问题 | 审查结论 |
|---|---|
| §3 标准路径重编是否成立 | `--libexecdir=/usr/libexec/openssh` 可以设置相应默认路径。但“写死且无法覆盖”过于绝对，10.6 提供测试路径覆盖选项。原前缀 helper 若仍存在，仅复制主程序也不必然立即失败；生产部署仍应采用受控、完整的路径布局。 |
| §4.3 DESTDIR 是否跳过主机密钥生成 | **成立。** 10.6p1 `Makefile.in` 的 `host-key` 目标只在 `DESTDIR` 为空时调用 `./ssh-keygen -A`。原文写成 `ssh-keygen -A -f /etc/ssh` 不是该上游目标的实际命令。 |
| §5.4 HUP 是否 re-exec、保留老连接 | **re-exec 成立；监听不中断与 PID 改变不成立。** 已认证会话通常继续运行，仍应现场验证。 |
| 替换清单是否还需要 moduli、keygen 服务等 | 就现有 `internal-sftp` 和固定组 KEX 配置，没有证据说明必须同步替换这些文件。更关键的遗漏是旧 helper 的依赖与备份盘点。需核对完整 unit、drop-in、启动参数和动态库。 |
| 只回退旧 sshd 是否足够 | **有条件成立。** 旧 helper 和依赖必须仍可用；旧版不是单二进制服务模型。当前备份不能证明完整恢复能力。 |
| 42 秒与 reload 有何隐患 | 发信号式 reload 是异步操作；正常 reload 不需要等待 RestartSec。42 秒只约束触发自动重启后的等待，不能保障恢复，更不能覆盖 listener 存活但登录链路失败的场景。 |

关于编译参数：没有证据表明必须无条件加 `--with-ssl-dir`、`--with-zlib` 或 `--with-selinux`。应根据实际依赖位置与功能需求决定。尤其 OpenSSL 位于自定义目录时，必须核对 configure 结果及主程序、两个 helper 在正常服务环境中的实际动态库解析；只看上一轮编译成功或版本文本不足以证明一致。

## 4. 执行稿应补充的门禁

以下是修订要求，不代表本次已经执行通过：

- [ ] 现场确认当前 unit、drop-in、`$OPTIONS` 和旧 helper 的实际路径。
- [ ] 备份匹配的旧 `sshd-session`，验证旧主程序与旧 helper 的备用端口登录及 SFTP。
- [ ] 为 §4.6 加入两个测试路径覆盖，证明测试的是同一套暂存产物。
- [ ] 核对三个新服务端程序的动态依赖、属主权限及校验和。
- [ ] 将“零停机”和“最长 42 秒”改为与实现一致的影响描述。
- [ ] 以运行映像、监听恢复、新登录、SFTP 和固定旧会话共同验收，不要求正常 reload 改变 PID。
- [ ] 将回滚分为主进程仍存活与服务已退出两种路径，并显式处理关键步骤失败。
- [ ] 修正全量恢复脚本说明，明确它不恢复 PAM，且会覆盖此次未改动的文件。
- [ ] 修正坏客户端配置、校验和预期和连接计数带来的验收错误。
- [ ] 阶段二前确认 2222 可以重新登录，保留该实例及其独立产物，直至观察完成。

建议同时把正式安装改为“先准备并校验所有文件，再通过同目录临时文件及 rename 发布”，降低目标文件短暂缺失和中途复制失败的风险。多个文件的 rename 仍不构成一个整体事务，应配套失败处理；当前旧 helper 默认路径与新路径分离的条件也应先现场确认。

## 5. 最终意见

采用标准路径构建、DESTDIR 暂存、保留旁路会话、先验证再切换的方向可以保留。但当前稿的暂存测试命令、旧版依赖认识、reload 成功判据和故障恢复承诺存在实质问题。

**建议先完成 R1–R6 的文档及脚本修订，再以真实备用端口测试和回滚验证作为进入阶段二的条件。** 本报告没有验证目标主机当前状态，也不构成生产切换已经通过的结论。
