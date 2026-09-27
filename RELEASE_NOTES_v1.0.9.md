# LyShell v1.0.9 发行说明 / Release Notes

**发布日期 / Release date: 2026-09-27**

## ✨ 新增 / Features

- **工作目录分组**：Agents、Claude、Codex 和 dsh 工作区按工作目录分组，支持单组及整栏折叠。同名目录显示可区分的父目录片段和序号。*Agents, Claude, Codex, and dsh workspaces are grouped by working directory, with per-group and all-group folding. Same-named directories show a distinguishing parent fragment and number.*
- **网页访问分组**：最近访问按域名分组，并可从历史记录打开迷你浏览器。*Recent web visits are grouped by domain, with an entry to open a visit in the mini browser.*

## 🔄 变更 / Changed

- **机柜列表更简洁**：变量组和插件改用平铺纸面列表，移除无操作的装饰辊；工作目录集中显示在分组标题，不再逐张卡片重复。*Env and Plugins use flat paper lists without noninteractive decorative rods. Workspace paths appear once in group headers instead of on every card.*
- **画轴更易点击**：可点击画轴的热区扩大到 24 px，视觉轴体仍保持 5 px。*Clickable wall rods have a 24 px hit area while keeping their 5 px visual thickness.*
- **迷你浏览器状态保留**：切换机柜页签时保留页面状态，关闭页面时释放资源。*Switching rack tabs keeps the mini browser page alive; closing it releases its resources.*

## 🐛 修复 / Bug Fixes

- **网页与启动稳定性**：改进网页导航和加载状态处理，修复 dsh Web 重复启动及关闭后进程未及时回收的问题。*Improved web navigation and loading-state handling, and fixed duplicate dsh Web launches and process cleanup after closing.*
