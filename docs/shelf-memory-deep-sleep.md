# 网页安全深睡：普通页显式重载与只读副本

2026-10-29，main 工作区 `D:/workspace/claude/LyShell`，基线 `83053c4e2bbabdbbfd3bca45aa8fd75ffdd54b58`。没有引入 Rust、切换 worktree、提交、推送或打包发布。

## 支持范围

**普通页允许闲置重载**：网页访问栏“更多”→“允许闲置重载…”。main 显示本地确认框，默认与取消均为“保持运行”；确认只授权当前完整网址，跳到其他网址撤销。菜单“保持此页运行”撤销后，持久许可及睡眠快照一起移除。页面继续使用原 `persist:webbar` Session，登录 cookie 和页面 JavaScript 保留，不禁用正常输入或改写网页请求。

确认框明确说明：恢复会重新访问网址，JS 堆、表单、sessionStorage、实时连接及网页内任务不会恢复。只应授权用户明确知道可以重复阅读的页面；HTTP GET、没有可见表单或暂时安静均不是业务无副作用的证明。

**独立只读副本**：“打开只读副本（可休眠）”保留原页，另开内存分区 `shelf-readonly-v1:<uuid>`，不继承原网页登录状态。main 在创建前安装请求/响应头/权限/下载闸门，只接受 GET 与文档、样式、图片、字体，文档只接受 HTML/纯文本/XHTML；追加 CSP 禁止页面脚本、表单、子框架、媒体、Worker、连接和对象。隔离 preload 禁止编辑、粘贴、拖入、提交，不暴露 contextBridge。

只读模式的 JavaScript **引擎仍开启**以执行隔离 preload，页面脚本由 CSP 禁止，不能描述为 WebPreferences 禁用了 JavaScript。每进程最多登记100个只读分区；恢复复用原分区，不消耗新额度，额度耗尽明确拒绝新副本。

两种模式都要求先收纳、没有真实展示需求、闲置五分钟，再通过原生保护检查。普通未授权、unknown、blocked 继续保活。网址仍受 `shelfWebUrl` 约束，查询参数、片段、凭据、敏感/一次性路径及回环字面地址不接受。终端/PTY/SSH/Telnet/串口、插件、Agent/Harness、POST 引导页不进入该路径；未收纳页面不自动深睡。

## 普通页保护观察

main 只给明确的正常浏览器 Session 安装观察，不取消/改写网页请求，不改变代理、权限或下载策略。每个原生 guest 有独立且有界的保护状态。

- 请求进行中、非 GET、WebSocket、下载、编辑/粘贴/拖入/提交、媒体播放、摄像头/麦克风授权或待确认权限、beforeunload 拒绝、打开过 DevTools/调试器均保活。部分证据在本次完整导航内粘性锁定，移除控件或关闭检查器不能清除。
- main 在隔离世界1005安装被动观察器，不修改 DOM 控件或事件默认行为。编辑控件、contenteditable/designMode、子框架、可观察的 shadow/custom element 不确定性不放行。DOM/批次超限、请求无法归属、执行超时或不支持的 API 返回 unknown。
- Session 有运行中的 Service Worker、加载/崩溃/发声或原生验证失败时保活。没有粘性用户激活也保活，因为 Chromium 对未激活文档可能忽略 beforeunload。恢复滚动不要求激活，但再次深睡要求。
- main 随机文档 nonce 匹配真实 guest、Session、导航与当前 URL。生产 attach 按原生 owner/Session/初始导航配对，不相信复用 renderer 的旧 argv，也不接受网页自报 safe。

首次 HTTP 重定向可能早于 `did-attach-webview`。main 在 `web-contents-created` 记录确切 guest 的原生首航地址，用它核对创建许可；若当前地址已经跳转，记录真实导航并撤销旧网址同意。真实 Electron 复现了修复前的“实例一直等待附着”，修复后该页面正常 live；没有按任意最终 URL 或队列位置猜测身份。

这不是任意网站全部未保存状态的完整检测器。例如普通元素的封闭 shadow root、隐藏在 JS 中的业务状态无法据 DOM 全面证明。能力依赖用户明确同意丢弃已知可重复阅读的页面，不能把本地 fixture 的通过率当成真实站点覆盖率。

## 保存、关闭和恢复

main 刷新有效期2秒的保护证据，创建唯一 `suspendOperationId`，按任务 revision 原子保存 URL、任务/资源身份、格式/时间、原分区、缩放及尽力取得的滚动位置。失败不关闭；落盘后复检需求、实例、导航、保护版本、电源 epoch、Session 与已保存 operation ID。

Electron43.7.11 直接 `webview.close({waitForBeforeUnload:true})` 实测仍会销毁拒绝关闭的 guest，所以通用 `safeCloseSupported=false` 保持不变。普通页改为先请求原生导航到内部 `about:blank`，不放行 `will-prevent-unload`，仅在这个确切 guest 真正提交 blank 后关闭。拒绝保留原堆、草稿、URL、Session 和句柄。只读可丢弃契约允许直接关闭副本。

只有匹配原生 `destroyed` 才提交 sleeping，UI随后移除已销毁元素。超时保留原操作/句柄，不产生第二份许可；迟到销毁继续核对原操作，新需求与关闭竞态不能重复创建。内部 blank 不成为显示/保存/恢复网址。冷恢复重新收纳时先绑定原记录，再核验实际 native URL，防止丢失契约或错认页面。

卸载等待期间若另一条真实导航取代了关闭导航，旧关闭事务立即撤销，新文档恢复 live，迟到回执不能继续关闭它。同文档的 history/锚点导航保留已就绪状态及本次文档的阻断信号，不依赖不会再次发生的 dom-ready，也不因只换地址清除输入或 DevTools 保护。

**保存成功不等于睡眠成功**：beforeunload 拒绝后可能留下恢复元数据，但页面仍 live，快照数量不能当作已销毁数量。

仅明确主区/卡片选择及本次激活的有效展示需求触发恢复；滚动、补图、普通卡片挂载不唤醒。renderer 保持1并发/16待处理/4自动驻留，main 另限制真实创建/导航并发1，实际加载停止才释放原生槽。恢复用原 Session，缩放/滚动绑定新文档 nonce，最多3次、2秒；用户或页面主动滚动优先。

导航、电源/锁屏/唤醒和窗口边界失效旧保护/闲置期限，恢复后重新等待五分钟。没有恢复 JS 堆、表单、sessionStorage、WebSocket、远端任务，没有重放 shell、POST、Agent 任务或审批。

## 验收证据

- [直接 close](shelf-memory-p0/safe-close-probe-results.json)：12种实验各3轮，通用guest关闭不可靠。
- [可撤销导航](shelf-memory-p0/navigation-close-probe-results.json)：15种实验各3轮、45份有效证据，已激活保护页拒绝可取消导航并保留堆/草稿/身份/Session，未激活页面没有这一保证。iframe 实验不意味着生产放行 iframe。其 race-demand 实际是延迟调用另一次 close，不是展示需求；真实需求竞态由 runtime 验收覆盖。部分第一轮磁盘目录可能来自早期 smoke，不宣称均从未使用；每实验进程仍使用新内存分区、随机端口和 no-store。
- [真实 guard](shelf-memory-p0/reloadable-guard-probe-results.json)：3×14=42个实验、270项检查通过，执行实际注入脚本、网络观察和Session API。使用 BrowserWindow.webContents，实际webview由下面runtime/整应用覆盖。激活为合成手势，没有测硬件IME、系统文件选择框、真实媒体自动播放或活跃Service Worker。探针退出码本身不证明每项通过，Codex另逐项核对结果。
- 普通页production runtime完成100轮实际webview销毁/恢复，原Session/cookie、zoom1.25、非零scroll650匹配；保存失败/保存中新需求不销毁；保护页真实拒绝，未知/编辑页保活；关闭中新增需求等待原销毁后恢复。原始记录`tmp/reloadable-runtime-acceptance/results.json`。
- 完整应用GUI通过：页面脚本执行、收纳、生产五分钟路径（测试推进时钟）、真实销毁、冷恢复、原分区/缩放/滚动、撤销后保活；实际菜单+main IPC的取消/允许分支也通过。**本地确认框响应在隔离fixture中模拟**，未自动批准真实操作。Codex检查了实际截图。
- 10:41全量`npx vitest run src --pool=forks --maxWorkers=4 --minWorkers=1`：347文件通过、1跳过，4517项通过、8跳过。默认threads首次进程异常退出`-1073740791`，该次未记通过；首次forks发现旧fake缺少原生方法，修正替身后通过。共享工作区后续Harness改动另做最终复检。日志`tmp/reloadable-full-tests*.log`。
- 类型检查与构建通过，变更TS/TSX ESLint为0错误、51条既有any警告。代码、fixture与输出由Codex亲自审查；原生Harness协助实现/执行，不承担代码审查或图片判断。

最终合并复检：349文件通过、1跳过，4531项通过、8跳过；类型检查、构建、变更TS/TSX ESLint（0错误、51条已有any警告）通过。旧右键菜单测试已按当前任务方块和详情菜单定位更新，保留焦点、归档、移除与实例断言。首航绑定和跳转提交撤销许可均有真实失败→修复证据，随后100轮runtime和完整GUI重新通过，GUI记录包含实际dist摘要。一次GUI因过早点击尚未启用的主区按钮而超时，同时记录到截图API的UnknownVizError；修正fixture等待可点击状态后同构建通过，没有绕过输入保护。失败记录保留。

三轮测量结束后，同一最终源码另以未指定pool、并发4重跑全量，也为4531通过、8跳过（`tmp/reloadable-final-default-pool-recheck.log`）。这不改写早期threads异常退出的历史记录，也不据此断言其根因已定位。

长循环又确认并修复了迟到收纳竞态：内部blank已经提交、destroyed尚未到达时，原URL与native空白不相等，导致capture漏认契约并覆盖已保存快照。只有原生guest、当前关闭operation、对应已保存元数据及原授权URL全部匹配时，main才在该短窗口保留契约；普通空白跳转仍拒绝。新增正反回归，100轮实际webview在每次blank阶段检查该契约；完整应用夹具还延迟最终native close，强制插入真实capture IPC并核对磁盘许可/快照保留。之后再冻结构建重新测量，不复用受影响旧样本。

整应用测量另保留了夹具错误：曾把wrapper当输入闸门、加载前就找最终URL、读取错误的快照字段，均已纠正。裸native修改的缩放会被应用交接时的浏览器设置恢复，测量统一用实际设置1.25。响应式fixture在小窗/主区切换时滚动锚定重排曾偏移70px，像素对照改用固定排版；这不代表真实响应式网页保证逐像素一致。每循环仅一次真实GET导航，before重载活页，after恢复睡眠页；不再让after额外重载一次。

普通页整应用三轮、六个新进程全部通过，102次实际恢复、102次对照重载、876项断言及三次重启读取通过。长循环后3秒采样窗的Windows总私有内存三轮中位数 **1171.24→487.84MiB，减少683.40MiB（58.35%）**。这是固定本地普通脚本阅读页、原Session与显式许可的同构建对照，不是任意网站收益保证。就绪p50/p95为951/1407ms；软件滚轮含投递回退/准备/轮询，不作硬件输入延迟。首帧显式回退次数、峰值、各轮及限制见[普通页完整报告](shelf-memory-p0/reloadable-report.md)。

普通页100轮、GUI截图/结果、导航/guard、六进程逐PID数据、保存快照和排除的旧尝试均已归档，SHA与独立算术检查见[证据清单](shelf-memory-p0/reloadable-raw/manifest.json)。旧长循环中另有一次未定位的保活停留，原始失败保留；当前三轮未重现，不能宣称已据此修复。只读副本历史943.65→556.22MiB（41.1%）**不是普通页收益**。旧构建、失败重试、首帧补认修复、旧测试记录见[旧说明](shelf-memory-p0/deep-sleep-readonly-notes.md)与[只读对照](shelf-memory-p0/deep-sleep-report.md)，旧数值未改写为当前新实测。

## 回退及未验证边界

`LYSHELL_SHELF_RELOADABLE_SLEEP=0`关闭普通页自动深睡；`LYSHELL_SHELF_READONLY_SLEEP=0`独立关闭只读副本自动深睡。`LYSHELL_SHELF_BROWSER_LIFECYCLE=0`拒绝新契约，不能把只读请求静默降级成普通页。已有睡眠记录仍有明确打开入口，开关不重放任务。

尚未据此认证真实网站业务正确性、跨平台可撤销导航、真实终端/Agent混合负载、低内存设备、硬件中文IME、混合DPI/多屏或长时间整机睡眠。状态/电源注入测试和虚拟五分钟不等于真实系统休眠。无法验证的保护条件继续保活。
