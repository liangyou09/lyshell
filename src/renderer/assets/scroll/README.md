# 中国书画画轴美术

来源：AIPet 当前工作区 `resources/ui/scroll/scroll-rollers-jade-v1.png`，原始透明 PNG 完整复制，未裁切、重采样或改写。来源图集说明与生成提示保存在 `AIPet-source.md`。

## 资产与主题

- `scroll-rollers-jade-v1.png`：玉雕轴头、金色轴肩、圆柱轴身，含展开与收卷两个状态。
- `paper-light.svg`：暖白宣纸、淡纤维纹理、窄金灰裱绢；推荐墨色 `#493d31`。
- `paper-dark.svg`：深墨纸面、暗金裱绢；推荐文字色 `#eee3cb`。
- `xuan-paper-light-v1.png`、`xuan-paper-dark-v1.png`：ImageGen 生成的纯宣纸纤维纹理，无轴体、无裱边；用于实际纸面与输入框。`XuanPaper` 可独立复用纯纸画心。输入框已去除两侧画轴与系绳，整张宣纸铺满原输入热区；文字区域增加同色淡层以控制纹理对比，聚焦时显示细描边。
- `scroll-tie-silk-gold-v1.png`：ImageGen 生成的透明金色编织丝绳，含蝴蝶结、短绑绳和两条弯曲绳尾；浅色用原色，深色略降亮度与饱和度。通过 `ScrollTie` 接入玉石分组轴和双轴，保留原有收卷显现、开卷淡出动作。小型筛选轴保留原线绘绳结。
- `brush-jade-wood-v1.png`：ImageGen 生成的透明文房毛笔，木质圆杆、玉环金箍、渐变笔毫。`BrushArtwork` 用 SVG 取帧，保留两端比例、仅伸缩中段笔杆；已接入会话栏的本地 Shell 启动按钮，保留名称、点击启动和执笔高亮。原图未裁改，明暗主题通过样式调整光照。
- 轴头明暗两套使用同一原始图集：浅色保持原色，深色在 CSS 渲染时用 `brightness(.58) saturate(.7) sepia(.12)` 处理，保留玉雕与轴肩细节，不复制或修改位图。

## 接入

`src/renderer/styles/scroll-artwork.css` 已由 `main.tsx` 引入。现有 `.rod-caps` 在 `data-scroll-material="jade"` 下使用图集；仅保留玉雕材质，设置中已移除材质选择；旧材质存档自动迁移并保存为玉石。主题切换通过 `data-theme-mode="light|dark"` 自动更换纸张与轴体明暗，包含自定义主题的明暗判定。

CSS `border-image-slice` 在原图上选择状态：展开 `350 185 740 185`，收卷 `735 185 349 185`；左右各 185 源像素保留轴肩，只有中段轴身横向拉伸。标准单轴装配高 16px，双轴展开装配高 18px、收卷装配高 12px；小窗每根轴展开热区高 20px、收卷热区高 14px，常开墙保留 24px 热区。玉石双轴收卷总高 30px，纸面边界按 `185 / 164 × 轴高` 内缩，不能覆盖轴头；纸面向轴心方向延伸以避免接纸断开，收卷仍保留短连纸。

可复用组件位于 `src/renderer/components/Layout/ScrollArtwork.tsx`：

```tsx
import { ScrollRoller, ScrollPaper, SingleScroll } from '@/components/Layout/ScrollArtwork'

<ScrollRoller />                 // 独立展开轴
<ScrollRoller rolled />          // 独立收卷轴
<ScrollPaper>内容</ScrollPaper>  // 独立纸张
<SingleScroll open={open} onToggle={() => setOpen(!open)} label="展开或收起内容">
  内容
</SingleScroll>
```

组件遵循所在容器的主题模式。独立轴可通过 `--scroll-art-height` 调整高度，纸张 SVG 可独立使用；SVG 使用 `preserveAspectRatio="none"` 适配任意纸幅。

## 交互适配

LyShell 的分组、常开画轴墙、文件管理器、网页小窗和查找小窗继续使用原有事件处理，包括轴体点击/键盘开合、拖动调整高度、常开画轴墙的全部分组开合、查找小窗拖动。画轴美术不含装饰文字；现有分组名、计数、操作按钮保留以便识别功能。浏览/筛选/命令操作的开合行为不被额外改写。

AIPet 的“发送后保持展开”以输入示例呈现在预览中；这里没有引入宠物聊天或修改 LyShell 的会话业务。

## 预览与验证

运行 `npm run build`、`npm run preview:scroll`，打开 `http://127.0.0.1:4174/scroll-art-preview.html`。同页并排比较浅深色的双轴、单轴垂卷、独立展开/收卷轴和独立纸张；可点击、键盘开合及输入文字。预览页随 renderer 构建输出，CSS 限定到预览类名，不改变应用页面样式。

静态截图位于 `docs/previews/scroll-art/`：`light-dark-open.png`、`light-dark-rolled.png`、`narrow.png`。

可选自动视觉检查：安装 Playwright 并准备 Chromium 后运行 `node scripts/scroll-art-check.cjs`。可用环境变量 `LYSHELL_PLAYWRIGHT` 指定 Playwright 包、`LYSHELL_CHROMIUM` 指定浏览器路径。检查明暗主题、开合、键盘、inert、示例发送保持展开、窄布局和加载错误。检查只覆盖真实组件预览，不启动 SSH/PTY 或 Electron 会话。
