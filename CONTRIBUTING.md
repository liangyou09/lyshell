# Contributing

> Thanks for considering contributing to LyShell! This repository is the **open-source home of LyShell** — it hosts the full application source code, documentation, and example plugins, released under the [MIT License](LICENSE).
>
> 感谢你考虑为 LyShell 贡献。这个仓库是 LyShell 的**开源仓库**，承载完整的应用源码、文档与示例插件，基于 [MIT 许可证](LICENSE) 发布。

## What you can contribute here · 你能在这里贡献什么

- **源码 / Source code** — 修复 bug、改进 `src/` 下的主进程 / 渲染进程代码。*Fix bugs and improve the main / renderer code under `src/`.*
- **文档 / Docs** — 修正/补全 `README.md`（英文）与 `README.zh.md`（中文），以及 FAQ、使用指南等内容。*Fix or complete the English and Chinese READMEs, FAQ, and usage guides.*
- **示例插件 / Example plugins** — 在 `examples/` 下新增或改进最小可跑的插件 demo。*Add or improve minimal plugin demos under `examples/`.*
- **截图资源 / Screenshots** — 更新 `docs/assets/` 下的界面截图。*Update screenshots under `docs/assets/`.*

## Documentation conventions · 文档风格约定

- 面向**最终用户**：不出现源码路径、构建命令或开发者内部术语。*End-user oriented: no source paths, build commands, or internal jargon.*
- 双语同步：对 `README.md` 的改动须同步到 `README.zh.md`；`examples/README.md` 同样保持中英双语。*Keep both languages in sync — `README.md` ↔ `README.zh.md`, and `examples/README.md` stays bilingual too.*
- 截图：优先用 `docs/assets/` 下的 `.jpg`，宽度统一 `90%`（浮窗截图用 `70%`）。*Use `.jpg` under `docs/assets/`, width `90%` (float-window screenshots use `70%`).*

## Opening a PR · 提交一个 PR

1. Fork 本仓库并创建分支。*Fork the repo and create a branch.*
2. 保持改动聚焦、可读，中文与英文文档同步更新。*Keep changes focused; sync both languages.*
3. 提交时说明改动目的（`fix:` / `feat:` / `docs:` 前缀）。*Use `fix:` / `feat:` / `docs:` prefixes.*
4. 打开 Pull Request，描述改动内容与动机。*Open a PR describing the change and motivation.*

## Reporting issues · 报告问题

Bug 与功能建议请通过 GitHub Issues 提交，尽量附上：复现步骤、预期与实际行为、系统版本（Windows 10/11）。*File bugs and feature requests via GitHub Issues with steps to reproduce, expected vs. actual behavior, and OS version.*
