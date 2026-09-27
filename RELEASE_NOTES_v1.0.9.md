# LyShell v1.0.9

**Release date: 2026-09-27**

## ✨ Features

- **Workspace directory groups**: Agents, Claude, Codex, and dsh workspaces are grouped by working directory. Each group and all groups can be folded; groups with the same directory name show a distinguishing parent fragment and a visible number.
- **Web visit groups**: recent visits are grouped by domain, with an entry to open a visit in the mini browser.

## 🔄 Changed

- **Cleaner rack lists**: Env and Plugins now use flat paper lists without noninteractive decorative rods. Workspace paths appear once in group headers instead of on every card.
- **Easier scroll controls**: clickable wall rods have a 24 px hit area while keeping their 5 px visual thickness.
- **Mini browser lifecycle**: switching rack tabs keeps the mini browser page alive; closing it releases its resources.

## 🐛 Bug Fixes

- Improved web navigation and loading-state handling, and fixed duplicate dsh Web launches and process cleanup.
