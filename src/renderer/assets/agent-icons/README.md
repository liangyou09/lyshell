# Agent 内置品牌图标

`AgentsPanel` 按 agent 的 `command` 首 token 匹配内置品牌图标(agent 无需自带 `icon` 字段)。
本目录存放图标资产,并记录制作/新增图标的流程。

渲染逻辑在 `src/renderer/components/Layout/AgentsPanel.tsx` 的
`BUNDLED_ICON_BY_COMMAND` / `bundledIconFor` / `BundledIconView` / `AgentSlotIcon`。

---

## 渲染机制

两个模式(`BundledIconEntry.mode`):

| 模式 | 做法 | 适用 | 主题行为 |
|---|---|---|---|
| `img` | `<img>` 直接显示原色品牌标 | 自带配色的品牌(如 Anthropic 赭石) | 图标自带颜色,需在明暗主题下都可见 |
| `mask` | CSS `mask-image` 取资产 alpha 作剪影,按 `--text-rack` 主题文字色着色 | 单色标识(如 OpenAI 花朵) | 明暗主题自适应(跟随主题文字色) |

- **匹配**:`command` 首 token(剥引号、小写)查 `BUNDLED_ICON_BY_COMMAND`。如 `codex`、`codex --args`、`"codex"` 都命中 `codex`。无匹配回退 emoji / 机器人头。
- **尺寸**:槽位 24px,图标 18px(`object-contain` / `maskSize:contain`)。源图统一 64×64(2x 超采样,18px 显示锐利)。
- **取资产 URL**:用 Vite `new URL('../../assets/agent-icons/x.png', import.meta.url).href`(bundler 模式下 `import png` + `declare module '*.png'` 对实际文件不生效,`new URL` 免声明最稳)。

---

## 现有图标

| 文件 | command | 模式 | 矢量源 | 说明 |
|---|---|---|---|---|
| `claude.png` | `claude` | `img` | Claude 官方 VS Code 扩展 `resources/claude-logo.svg`(fill `#D97757`) | Anthropic 太阳花,赭石品牌色 |
| `codex.png` | `codex` | `mask` | OpenAI 官方 VS Code 扩展 `resources/blossom-white.svg`(fill `white`) | OpenAI 花朵,白供 mask 取 alpha |

均为 64×64 RGBA PNG,透明背景。制作流程:矢量 SVG → resvg 栅格化 128px(超采样)→ PIL LANCZOS 降到 64px。

> 注意:Claude 扩展里的 `claude-logo.png` 是个**实心圆**(和 `claude-logo.svg` 不是一回事),不能直接用;真正的太阳花在 `.svg`。codex 的 `blossom.dark.png` 是白花朵+黑底的 RGB 图(无 alpha),也不如直接用 `blossom-white.svg` 矢量源干净。

---

## 为什么不用 exe 抠图

之前试过运行时 `app.getFileIcon` 从 exe 抠图标,不可靠:

- `claude.exe` 是 ~263MB 原生 exe,`getFileIcon` 返回空;
- `codex.exe` 是 Rust 二进制,**无图标资源**,`ExtractAssociatedIcon` 回退成 Windows 通用窗口图标(灰框);
- exe 抠出的 32px 图做透明背景时,亮度阈值会在边缘留杂边(花边)。

故改用打包内置矢量图标——一次制作,稳定可复现,任意尺寸清晰。

---

## 新增品牌图标

### 1. 选源 + 定模式

找品牌图标的**矢量 SVG**(官方扩展/仓库最佳,避免栅格降采样损失)。按品牌特性选模式:

- 自带配色(有专属品牌色)→ `mode: 'img'`
- 单色剪影 → `mode: 'mask'`(资产 RGB 不重要,只用 alpha 通道)

### 2. 栅格化 SVG → 128px PNG(resvg)

系统通常没 cairo,用 `@resvg/resvg-js`(Rust SVG 渲染器,预编译二进制,无系统依赖)。临时装即可,用完删:

```bash
mkdir -p /tmp/svgrender && cd /tmp/svgrender
npm init -y >/dev/null && npm install @resvg/resvg-js
# render.js 见本文件末尾
node render.js "<源.svg>" "<name>-128.png" 128
```

### 3. 降采样到 64px(PIL)

```bash
python -c "
from PIL import Image
Image.open(r'<name>-128.png').convert('RGBA').resize((64,64), Image.LANCZOS).save(r'<name>.png')
"
```

### 4. 放资产 + 登记代码

- 把 `<name>.png` 放到本目录(`src/renderer/assets/agent-icons/`)。
- 在 `AgentsPanel.tsx` 顶部加 import:
  ```tsx
  const xIcon = new URL('../../assets/agent-icons/<name>.png', import.meta.url).href
  ```
- 在 `BUNDLED_ICON_BY_COMMAND` 加一行:
  ```tsx
  x: { src: xIcon, mode: 'img' },   // 或 'mask'
  ```

无 IPC、无 preload、无 store 改动——纯前端资产 + 一行映射。

---

## render.js(resvg 栅格化脚本)

```js
// 用法: node render.js <输入.svg> <输出.png> <尺寸>
const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const [, , svgPath, outPath, size] = process.argv;
const svg = fs.readFileSync(svgPath);
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: parseInt(size) } });
fs.writeFileSync(outPath, resvg.render().asPng());
console.log('rendered', outPath);
```

---

## 校验图标(不读图,用 Python 分析像素)

约定:不直接看 PNG 图像,用脚本分析 alpha 形状 / 覆盖率 / 主色是否正确。

```python
from PIL import Image
im = Image.open('x.png').convert('RGBA')
px = im.load()
opaque = 0; colors = {}
for y in range(im.size[1]):
    for x in range(im.size[0]):
        p = px[x, y]
        if p[3] > 100:
            opaque += 1
            k = (p[0]//32*32, p[1]//32*32, p[2]//32*32)
            colors[k] = colors.get(k, 0) + 1
total = im.size[0] * im.size[1]
print(f'opaque={opaque}/{total}({100*opaque//total}%)')
print('top colors:', sorted(colors.items(), key=lambda kv: -kv[1])[:4])

# alpha 形状 ASCII 预览(确认是预期的 logo 轮廓)
a = im.split()[3]
chars = ' .:-=+*#%@'
for y in range(0, im.size[1], 2):
    print(''.join(chars[min(len(chars)-1, int((a.getpixel((x,y))/255)*len(chars)))]
                   for x in range(0, im.size[0], 2)))
```

正常结果:透明背景(四角空)、主色单一或为品牌色、覆盖率 30%–50%(太低显小,太高显闷)。
