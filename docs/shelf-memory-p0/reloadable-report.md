# 普通网页显式闲置重载：三轮整应用验收

完成时间：2026-10-29T05:20:11.893Z。Windows / Electron 43.7.11。当前main未提交构建，没有替换正式安装版。

六个新进程的三轮配对全部通过。长循环后3秒采样窗总私有内存的三轮中位数 **1171.24 → 487.84 MiB**，差值 **-683.4 MiB（-58.35%）**。这是普通页面、原persist:webbar Session与页面JS启用的独立实测，不是此前只读副本41.1%的数字。

## 方法与口径

- 同一dist构建及源码，前后交错顺序before/after、after/before、before/after；每进程独立appData/userData/sessionData/DSH_HOME，本地HTTP no-store fixture，代理与后台节流设置两组一致。
- 每进程10个显式授权阅读页、1个已激活beforeunload保护页、1个无授权未知页。页面JS实际执行、Session对象/合成登录cookie、原生附着、输入闸门均核对。已授权不等于一定可睡。
- 每组每轮34次循环，共102次：before重载活页一次，after重新创建并加载睡眠页一次；同样进行内容、缩放1.25、非零滚动、软件滚轮检查及收纳。没有让after额外重载一次。阅读文档使用固定排版；真实响应式网页的逐像素偏移不作保证。
- before仅设置LYSHELL_SHELF_RELOADABLE_SLEEP=0；after启用生产路径。测试推进main时钟走原五分钟阈值，不代表真实等待五分钟、整机休眠或真实网站业务正确性。
- app.getAppMetrics的Windows privateBytes按KiB换算MiB，目标间隔100ms采样，逐PID取一次再求和，包含Browser/Tab/GPU/Utility。独立脚本重新核对每份原始样本的PID去重与算术，没有叠加JS heap/external，也没有用guest数代替内存。
- loaded/final/sleep分别为规定的3秒采样窗；transition单列为收回需求及闲置转换，cycles包括完整操作。100ms观测峰值不是绝对峰值，短采样窗不是长期GC稳态承诺。

| 轮 | 组 | loaded MiB | sleep MiB | 长循环后 MiB | 全阶段观测峰值 MiB | 显式首帧回退次数 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | before | 796.69 | 770.65 | 1165.37 | 1212.68 | 9 |
| 1 | after | 816.85 | 544.11 | 487.84 | 825.43 | 12 |
| 2 | after | 800.53 | 533.38 | 479.95 | 831.207 | 11 |
| 2 | before | 803.7 | 774.82 | 1186.84 | 1230.891 | 12 |
| 3 | before | 795.68 | 767.01 | 1171.24 | 1212.883 | 11 |
| 3 | after | 807.71 | 541.38 | 494.48 | 830.633 | 11 |

全阶段（含启动和转换）采样峰值：before **1230.891 MiB**，after **831.207 MiB**。不能把较低的闲置内存描述为启动峰值降低。

## 恢复与保护检查

- 876项整应用断言，失败0；102次实际睡眠页恢复、102次对照重载，未发POST。
- after每轮原生创建46、销毁44，最终10 sleeping、2 live；保护页真实拒绝卸载，草稿/JS标记/原句柄保留，未知页不关闭。保存的保护页快照不能计为sleeping。
- 三次独立重新启动读取原记录：12项进入Archive、0原生guest，10个阅读页快照及保护页保存记录仍可校验。Session内cookie保留的结论指睡眠/恢复，不承诺会话cookie跨应用退出。
- 另有当前生产runtime的100轮实际webview循环、保存失败/新增需求/关闭中需求竞态；真实HTTP重定向绑定与提交后撤销旧网址许可；实际GUI菜单、收纳、恢复和撤销。确认框响应只在隔离fixture内模拟，未自动批准真实操作。

| 组 | 就绪 p50/p95 ms | 软件滚轮场景 p50/p95 ms |
| --- | --- | --- |
| before | 429.5 / 464 | 1749.5 / 1777 |
| after | 951 / 1407 | 1754 / 1772 |

就绪从本轮UI操作开始计时，包含加载、内容/Session、实际webview输入闸门和必要的显式首帧回退。首帧截图未确认时，只在核对控制页面URL/标题并留截图后点击现有“Show current page”；这不是自动首帧确认成功。main的几何回执可能因显示需求交接失效，验收不把它或wrapper尺寸单独当作输入就绪。

滚轮场景包含未送达的宿主投递、已标注的guest软件事件、重试/准备与25ms轮询开销；直接guest投递成功不等同于真实OS命中测试，更不代表硬件键盘/中文IME延迟。实际投递方式计数保存在JSON中。

内存fixture的文档响应会补发合成cookie，因此cookie可见本身不是独立的登录保留证明；原Session身份由GUI和100轮runtime另行验证，后者服务端不补发该cookie。

## 失败保留与限制

- 早期夹具曾误读顶层sleep字段、把附着当作加载完成、按子串匹配页面、把wrapper当输入闸门、用仅展开的边缘按钮收起并吞掉超时；已修正，旧样本不参与这六个进程的汇总。缩放改用实际浏览器设置1.25，排版固定以隔离浏览器滚动锚定重排。
- 已确认并修复内部blank提交到destroyed之间的迟到capture覆盖许可/快照竞态；只有当前关闭operation与原URL匹配才保留契约，普通空白跳转拒绝。100轮真实blank检查和整应用强制插入capture IPC均通过。
- 保留了一次旧长循环在第19次恢复后页面继续保活、未再次保存/关闭的失败。那次未记录实时保活原因，根因仍未知；独立34次复验及本三轮没有重现，不能据此宣称已修复。没有强制关闭或放宽保护来获得通过。
- 原生Harness协助准备脚本；Codex接管界面定位/输入门槛与最终测量前，按原identity/session/task确认cancelled且无残留测量进程。未把原生取消说成完成，未重投未知旧任务。
- 全量forks回归4531通过、8跳过；类型检查、构建、变更TS/TSX ESLint为0错误（51条已有any警告），diff检查与脚本语法检查通过。默认threads早期曾异常退出-1073740791，该次未记通过；最终未指定pool、并发4的全量复跑也为4531通过、8跳过。
- 仅对用户明确接受重新访问的页面开放；guard不是全部隐藏JS状态、封闭shadow或远端工作的完整检测器。无授权、阻断或未知继续保活。真实网站、硬件IME/混合DPI、真实媒体/上传/整机睡眠与跨平台发布认证仍不在本证据范围。

## 可复查材料

- [完整结果与构建/源码摘要](reloadable-app-results.json)
- [逐PID原始数据、失败尝试与SHA清单](reloadable-raw/manifest.json)
- [当前契约与使用入口](../shelf-memory-deep-sleep.md)
- [历史只读副本实测](deep-sleep-report.md)（旧构建，不混入本次数据）

复验：先构建当前源码，在tmp/reloadable-build-ready.json写入ready:true，再运行node scripts/shelf-memory-p0/reloadable-app.cjs；成功后运行node scripts/shelf-memory-p0/summarize-reloadable.cjs。测量期间不得修改src或构建。归档包含本次实际测量脚本。
