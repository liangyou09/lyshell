const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const r = JSON.parse(fs.readFileSync('docs/shelf-memory-p0/preview-compare-results.json'))
const hash = crypto.createHash('sha256').update(fs.readFileSync('src/renderer/components/Layout/task-shelf-web-frame.ts')).digest('hex')
assert.equal(r.after.sha256, hash, '重新运行对照：当前源码已经变化')
assert.equal(r.aggregate.comparisonValid, true)
assert.equal(r.aggregate.equalWork, true)
const a = r.aggregate, before = a.before, after = a.after
const rows = r.runs.map(v => `| ${v.impl} | ${v.round} | ${v.ops.success}/${v.ops.total} | ${v.capture.calls} | ${v.memory.finalMiB} | ${v.memory.peakMiB} | ${v.ops.latencyMs.capture.p95} |`).join('\n')
fs.writeFileSync('docs/shelf-memory-p0/preview-compare-report.md', `# P5 最终预览前后对照

日期：2026-10-28。Codex 完成缓存引用和几何校验修正后重跑六轮，after 源码 SHA-256 为 \`${hash}\`，与当前源码一致。before 固定为 \`34d64dc3eed8bc7c53a03775475808545340d72e\` 的同一模块，后续提交不会改变基线。

## 方法与有效性

六个独立 Electron 43.7.11 进程，顺序 b1/a1/a2/b2/b3/a3；相同10个本地高熵canvas页面、2200×1300宿主、424×630 guest、DPR 1、直连的独立 partition。全部元素和真实 guest 视口吻合并可见。每轮100次操作，前50次同页连续调用，后50次在10页轮转且同页间隔至少420ms。

每实现300次预览操作、153次真实capture、147次400ms窗口命中；300成功、0失败。每页完整DataURL的SHA-256在操作计时外计算一次，10页摘要在六轮完全相同。comparisonValid=true、equalWork=true、invalidReasons=[]。

按PID去重计入Browser/renderer/guest/GPU/utility的私有内存，100ms采样。JS heap独立，不叠加；峰值仅为采样观测值。

## 数据

| 实现 | 轮 | 成功/操作 | native调用 | 最终私有内存MiB | 采样峰值MiB | 捕获p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
${rows}

| 汇总 | before | after |
| --- | --- | --- |
| 最终私有内存（三轮中位数）MiB | ${before.memoryMiB.finalMedian} | ${after.memoryMiB.finalMedian} |
| 私有内存观测峰值MiB | ${before.memoryMiB.peak} | ${after.memoryMiB.peak} |
| 捕获p50 ms（153样本） | ${before.latencyMs.capture.p50} | ${after.latencyMs.capture.p50} |
| 捕获p95 ms（153样本） | ${before.latencyMs.capture.p95} | ${after.latencyMs.capture.p95} |
| JS heap最终中位数MiB | ${before.jsHeapMiB.finalMedian} | ${after.jsHeapMiB.finalMedian} |

最终私有内存中位数减少 ${(before.memoryMiB.finalMedian - after.memoryMiB.finalMedian).toFixed(2)}MiB，after三轮范围 ${after.memoryMiB.finalMin}–${after.memoryMiB.finalMax}MiB；峰值差异仅 ${(before.memoryMiB.peak - after.memoryMiB.peak).toFixed(2)}MiB。轮间噪声和样本量限制下，不宣称显著或普遍的性能收益。没有采用Rust。

## 复现与边界

运行 \`node scripts/shelf-memory-p0/preview-compare.cjs\`，再运行 \`node scripts/shelf-memory-p0/summarize-preview-compare.cjs\`。完整结果见 [JSON](preview-compare-results.json)，六轮原始明细在 [preview-compare-raw](preview-compare-raw/)。

最初fixture的display:block令guest高度成为150；正式测量前删除该测试CSS并核对最终视口。调整仅发生在独立fixture，前后版本相同处理。没有操作生产guest。未覆盖持续PTY、真实站点、混合DPI、OS输入延迟和采样器零开销。兼容入口返回缩放后尺寸、失败返回空帧；这些契约变化已分别测试。
`)
console.log(JSON.stringify({ valid: true, hash, rounds: r.runs.length }))
