# Launcher 展示字体

`ZCOOLKuaiLe-Launcher.woff2` 用于 DeepSeek Launcher 鲸鱼下方的启动状态语。

- 字体：ZCOOL KuaiLe Regular，Copyright 2018 The ZCOOL KuaiLe Project Authors。
- 原始字体：https://github.com/google/fonts/blob/main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf
- 原始 TTF SHA-256：`812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d`。
- 许可：SIL Open Font License 1.1，原文位于 `../public/licenses/ZCOOLKuaiLe-OFL.txt`，通过 Vite public 目录随应用构建一起分发。
- 本地 WOFF2 由 FontTools 子集化，只保留 `locales/zh.json` 与 `locales/en.json` 中 `dshLaunch` 的 `hint`、`opening`、`running`、`failed` 文案字符。
- 更新这四项文案时，使用原始 TTF、FontTools 的 `subset` 和 Brotli 重新生成 WOFF2；`Subsetter.populate(text=...)` 的参数为上述八条文案拼接，`Options.flavor = 'woff2'`。新增字符在子集更新前使用 CSS 回退字体。

字体随应用打包，运行时不请求在线字体服务；仅启动状态语使用该字体，其余界面沿用现有字体。

## 英文连笔花体

英文状态语单独使用 `GreatVibes-Launcher.woff2`（CSS 名称 `Dsh Launch Script`），由组件的 `lang` 与 `:lang(en)` 选择；中文继续使用上面的 ZCOOL KuaiLe。

- 字体：Great Vibes Regular，Copyright 2015 The Great Vibes Pro Project Authors。
- 原始字体：https://github.com/google/fonts/blob/main/ofl/greatvibes/GreatVibes-Regular.ttf
- 许可：SIL Open Font License 1.1，原文 `../public/licenses/GreatVibes-OFL.txt` 随构建分发。
- 子集只包含 `locales/en.json` 的上述四条状态语，生成方式同上，保留 FontTools 默认 OpenType 排版特性，以支持连笔与连字。
- 英文文案变化时需同步更新这个子集；字号为 28px、行高 36px，变色层使用相同字体和度量。
