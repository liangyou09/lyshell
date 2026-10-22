# DeepSeek 用量面板

Mode: Operate. 扩展既有DeepSeek启动页，保留鲸鱼与既有主题，不套用Codex/Claude项目索引设计。

Primary target: src/renderer/components/Layout/DshUsagePanel.tsx
Related targets: src/renderer/components/Layout/DshLaunchTab.tsx, src/renderer/components/Layout/DshMarketPanel.css

## Direction contract

THESIS: 在终端侧栏快速确认用量与费用，按需查看逐日趋势和峰谷明细。

OWN-WORLD: 沿用bg-base/bg-rack/text-rack/amber/rule-soft，不引入新字体、图标库、照片或装饰图。

STORY: 四范围切换 → 费用与总token → 缓存与活动 → 每日费用（周期）→ 峰谷/计费说明。

FIRST VIEWPORT: 会话/今日/过去7天/30天四个按钮；预估费用与总token；四桶用量。用户先指定400px，后明确要求调高至默认未展开无滚动条：常规550px、250px以内600px、210px以内780px；同宽度下切换及展开均不推挤鲸鱼。展开后内部滚动，矮窗口整体仍可滚动。

FORM: 紧凑账页，5px容器/3px选中项；中文费用28px、总量23px，窄栏25px/21px；中文标签11px，重点数据12px。用户追加要求英文增大一档：英文标签与明细12px、费用/总量30px/24px，窄栏28px/23px；图表2px圆角为数据几何。半透明阴影、卡片堆叠与展示字体不用于统计内容。

BEHAVIOR: 周期含今天，以本地自然日分组；计价按北京时间。逐日图点选及方向键操作；未知金额保留破折号，部分金额显示下限。峰谷明细默认折叠、按桶和时段精确算费。

FINISH: 用户仓库明确要求视觉检查和代码审查由Codex本人执行，不交给其他代理。原生LyShell助手仅实现后端及执行测试。视觉证据在.impeccable/review/dsh-usage-*，详细行为见docs/dsh-usage.md。保留全局DESIGN.md及design.json，不自动修复其他设计上下文漂移。
