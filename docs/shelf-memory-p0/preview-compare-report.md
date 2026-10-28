# P5 最终预览前后对照

日期：2026-10-28。Codex 完成缓存引用和几何校验修正后重跑六轮，after 源码 SHA-256 为 `d048d60be1a61c746dee820e1c92b49d565d48d3885399dcd07110cec3759be2`，与当前源码一致。before 固定为 `34d64dc3eed8bc7c53a03775475808545340d72e` 的同一模块，后续提交不会改变基线。

## 方法与有效性

六个独立 Electron 43.7.11 进程，顺序 b1/a1/a2/b2/b3/a3；相同10个本地高熵canvas页面、2200×1300宿主、424×630 guest、DPR 1、直连的独立 partition。全部元素和真实 guest 视口吻合并可见。每轮100次操作，前50次同页连续调用，后50次在10页轮转且同页间隔至少420ms。

每实现300次预览操作、153次真实capture、147次400ms窗口命中；300成功、0失败。每页完整DataURL的SHA-256在操作计时外计算一次，10页摘要在六轮完全相同。comparisonValid=true、equalWork=true、invalidReasons=[]。

按PID去重计入Browser/renderer/guest/GPU/utility的私有内存，100ms采样。JS heap独立，不叠加；峰值仅为采样观测值。

## 数据

| 实现 | 轮 | 成功/操作 | native调用 | 最终私有内存MiB | 采样峰值MiB | 捕获p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| before | 1 | 100/100 | 51 | 639.09 | 639.09 | 57.2 |
| after | 1 | 100/100 | 51 | 603.98 | 629.08 | 61.6 |
| after | 2 | 100/100 | 51 | 607.01 | 635.02 | 58.1 |
| before | 2 | 100/100 | 51 | 635.32 | 635.98 | 58.2 |
| before | 3 | 100/100 | 51 | 636.04 | 636.04 | 60.2 |
| after | 3 | 100/100 | 51 | 609.8 | 633.54 | 57.7 |

| 汇总 | before | after |
| --- | --- | --- |
| 最终私有内存（三轮中位数）MiB | 636.04 | 607.01 |
| 私有内存观测峰值MiB | 639.09 | 635.02 |
| 捕获p50 ms（153样本） | 47.6 | 49.3 |
| 捕获p95 ms（153样本） | 58 | 58.5 |
| JS heap最终中位数MiB | 26.15 | 9.33 |

最终私有内存中位数减少 29.03MiB，after三轮范围 603.98–609.8MiB；峰值差异仅 4.07MiB。轮间噪声和样本量限制下，不宣称显著或普遍的性能收益。没有采用Rust。

## 复现与边界

运行 `node scripts/shelf-memory-p0/preview-compare.cjs`，再运行 `node scripts/shelf-memory-p0/summarize-preview-compare.cjs`。完整结果见 [JSON](preview-compare-results.json)，六轮原始明细在 [preview-compare-raw](preview-compare-raw/)。

最初fixture的display:block令guest高度成为150；正式测量前删除该测试CSS并核对最终视口。调整仅发生在独立fixture，前后版本相同处理。没有操作生产guest。未覆盖持续PTY、真实站点、混合DPI、OS输入延迟和采样器零开销。兼容入口返回缩放后尺寸、失败返回空帧；这些契约变化已分别测试。
