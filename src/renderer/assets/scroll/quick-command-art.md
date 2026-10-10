# 快捷命令美术

使用内置 ImageGen 生成，源图保留透明通道；组件在渲染时通过 SVG viewBox 取图，只有空白中段随命令名/侧栏宽度伸缩，圆角两端固定。

- `seal-box-lid-ash-v1.png`：当前匣盖使用浅灰米色白蜡木纹，柔和圆角，无铜角或雕花；与白玉签和宣纸协调。
- `command-seal-white-jade-v1.png`：浅色主题的羊脂白玉签，温润米白与细云纹，文字使用深墨。
- `command-seal-grey-jade-v1.png`：深色主题的烟灰玉签，细云纹与浅色柔光边，文字使用浅墨。两种签均无印钮或雕花，最小宽 88px。
- `seal-box-lid-wood-v2.png`、`command-seal-jade-v2.png` 与初版图为历史候选；当前匣盖使用 ash-v1，命令签使用 white-jade-v1。

深色主题在渲染时把灰米木盖压成低饱和烟灰色，匣盘衬绢和窄边跟随侧栏底色，命令签使用独立灰玉素材。浅色主题保留灰米木纹与白玉签。

生成提示词：

1. Production UI bitmap asset for a Chinese scholar's seal storage box lid. One very thin horizontal rectangular wooden panel in orthographic view, isolated on transparent background, fine warm walnut/sandalwood grain, softly beveled rim, restrained antique brass brackets at extreme ends. Quiet blank center for app labels and controls. Tactile painterly product illustration with soft top lighting. No text, handle, contents, table, perspective, scroll rods, ropes, logos or watermark.
2. Production UI sprite for a Chinese scholar's jade command seal. One wide shallow rectangular pale celadon jade block in orthographic front view, transparent background, cloudy mineral veins, beveled edges, fine inset rim and restrained end carvings. Blank central face for command labels. Small centered carved arch knob above the top edge. Tactile painterly product illustration matching jade scrolls and wooden seal box. No letters, characters, red stamp marks, other objects, table, scene, ropes or logos.

v2 重绘提示词：

3. One refined minimalist wooden seal box lid, orthographic face-on, transparent background, 12:1 thin horizontal slat, quiet fine honey walnut grain, single shallow bevel, rounded-square ends, plain center for app text. Contemporary Chinese aesthetic at 32px display height. No metal, carvings, handles, double borders, gilding, text, scroll rods, scene or large shadows.
4. One slim 7:1 polished celadon jade tally/slip, front orthographic view, transparent background, plain pale sage jade face with quiet cloudy mineral texture, rounded-square corners and single subtle outer bevel. Contemporary Chinese desk aesthetic at 26px display height. No knob, handle, carvings, gold, inset border, text, stamps, ropes or other objects.

白玉编辑提示词（内置 ImageGen，以青玉 v2 为编辑目标）：

Use case: precise-object-edit. Edit this production UI jade slip sprite. Change ONLY the material/color from green celadon jade to warm WHITE mutton-fat jade (Chinese 羊脂白玉): luminous creamy ivory white, subtly translucent, very fine quiet cloudlike internal jade texture, soft polished white bevel. Remove every green/sage tint. Preserve exact long rectangular silhouette, rounded-square ends, single subtle outer bevel, dimensions, placement and transparent background/alpha. Keep the center blank for software labels. Maintain restrained contemporary Chinese aesthetic and soft diffuse light. No added carvings, borders, knobs, handles, text, symbols, gold, scene or objects. The object must read as white jade rather than marble, plastic or grey stone.

灰米木匣编辑提示词（内置 ImageGen，以 wood-v2 为编辑目标）：

Use case: precise-object-edit. Edit ONLY the color/material finish of this minimalist wooden seal box lid UI sprite. Replace the honey yellow-orange/brown wood with refined pale GREIGE ASH WOOD: softly grey ivory, low saturation, quiet fine horizontal natural wood grain, like a pale ash wood box with a faint grey-white wash. Color family neutral stone grey with a tiny warm ivory undertone, designed to harmonize with creamy white mutton-fat jade command slips and xuan paper. Eliminate orange, reddish and golden-brown casts. Keep it visibly wood, not marble, not jade, not metal. Preserve exactly the thin long rectangle, subtle outer bevel, rounded square corners, silhouette, dimensions, placement, original soft lighting and genuine transparent alpha outside. Blank center. No added hardware, ornaments, text, handles, frames or objects. Restrained contemporary Chinese aesthetic.

灰玉编辑提示词（内置 ImageGen，以白玉签为编辑目标）：

Use case: precise-object-edit. Edit ONLY the jade material/color of this UI slip from white jade to SMOKY GREY JADE for a dark theme. Neutral cool smoke-grey, mid-dark grey around #58625f in the center, slightly lighter translucent grey bevel, soft quiet cloudlike jade inclusions, waxy polished jade sheen. A warm jade tactile finish, not rough stone or glossy plastic. Keep text area quiet and sufficiently dark for pale overlaid software labels. Preserve EXACT existing long thin rectangle, single rounded bevel, rounded-square ends, dimensions, placement, lighting and transparent background alpha. No green/blue saturation, no gold, no black marble veins, no white slabs. No carvings, knobs, handles, ornaments, frames, text, symbols, additional objects or scenery. One blank grey jade slip only.
