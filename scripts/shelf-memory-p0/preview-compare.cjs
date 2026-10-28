#!/usr/bin/env node
/**
 * P5 预览同负载前后对照（隔离 Electron 探针）。
 *
 * 目的：在完全相同的本地页面、真实 <webview> guest、宿主内容尺寸、DPR 与调用顺序下，
 * 对照 HEAD 版 `captureShelfWebFrame`（before）与当前工作区实现（after）的
 * 原生 capturePage 次数、成功/失败、返回尺寸、耗时分布与应用内存采样峰值。
 *
 * 边界：不启动 LyShell、不读取用户配置、不访问外网、不修改生产源码；
 * 仅写 `tmp/shelf-memory-compare/` 与 `docs/shelf-memory-p0/preview-compare-results.json`。
 *
 * 运行（在仓库根目录）：node scripts/shelf-memory-p0/preview-compare.cjs
 * 快速接线自检：PREVIEW_COMPARE_SMOKE=1 node scripts/shelf-memory-p0/preview-compare.cjs
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { execFileSync, spawn } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const tmpRoot = path.join(root, 'tmp/shelf-memory-compare')
const docsDir = path.join(root, 'docs/shelf-memory-p0')
const BEFORE_REL = 'src/renderer/components/Layout/task-shelf-web-frame.ts'
const BEFORE_REF = '34d64dc3eed8bc7c53a03775475808545340d72e'
const AFTER_REL = 'src/renderer/components/Layout/task-shelf-web-frame.ts'
const PARTITION = 'persist:preview-compare'

const SMOKE = process.env.PREVIEW_COMPARE_SMOKE === '1'
const BASE_CONFIG = Object.freeze({
  guests: 10,
  ops: 100,
  hotOps: 50,
  guestWidth: 424,
  guestHeight: 630,
  columns: 5,
  hostWidth: 2200,
  hostHeight: 1300,
  sampleMs: 100,
  cacheWindowMs: 400,
  coldGapMs: 420,
  loadSettleMs: 600,
  settleMs: 700,
  seedBase: 9000,
})
const CONFIG = SMOKE
  ? Object.freeze({ ...BASE_CONFIG, guests: 4, ops: 12, hotOps: 6 })
  : BASE_CONFIG
const RUNS = SMOKE
  ? [{ impl: 'before', round: 1 }, { impl: 'after', round: 1 }]
  // 每轮 before/after 顺序交替：b→a、a→b、b→a，抵消单向漂移。
  : [
      { impl: 'before', round: 1 },
      { impl: 'after', round: 1 },
      { impl: 'after', round: 2 },
      { impl: 'before', round: 2 },
      { impl: 'before', round: 3 },
      { impl: 'after', round: 3 },
    ]
const GLOBAL_DEADLINE_MS = 280000
const ROUND_TIMEOUT_MS = 100000

const nowIso = () => new Date().toISOString()
const round2 = value => Math.round(value * 100) / 100
const toMiB = kib => kib / 1024
const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')
const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const stats = values => {
  const clean = values.filter(value => Number.isFinite(value))
  if (!clean.length) return null
  const sorted = [...clean].sort((a, b) => a - b)
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
  return {
    n: sorted.length,
    min: round2(sorted[0]),
    p50: round2(at(0.5)),
    p95: round2(at(0.95)),
    max: round2(sorted[sorted.length - 1]),
    mean: round2(clean.reduce((sum, value) => sum + value, 0) / clean.length),
  }
}

/* ------------------------------------------------------------------ */
/* 页面与驱动：before/after 使用完全相同的本地页面与调用顺序            */
/* ------------------------------------------------------------------ */

function fixturePage(seed) {
  return [
    '<!doctype html><meta charset="utf-8"><title>fixture</title>',
    '<style>',
    'html,body{margin:0;height:100%;overflow:hidden;background:#0b0d10}',
    '#c{position:absolute;left:0;top:0;width:100%;height:100%;image-rendering:pixelated}',
    '#label{position:absolute;left:6px;bottom:4px;color:#fff;font:11px/1.2 "Segoe UI",sans-serif;',
    'text-shadow:0 1px 2px #000;opacity:.85}',
    '</style>',
    '<canvas id="c"></canvas>',
    '<div id="label">Saved page fixture · 中文 🐚</div>',
    '<script>',
    '(function () {',
    '  var seed = ' + Number(seed) + ' >>> 0;',
    '  var state = seed >>> 0;',
    '  function rnd() {',
    '    state = (state + 0x6D2B79F5) | 0;',
    '    var t = Math.imul(state ^ (state >>> 15), 1 | state);',
    '    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;',
    '    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;',
    '  }',
    '  function paint() {',
    '    var canvas = document.getElementById("c");',
    '    var dpr = window.devicePixelRatio || 1;',
    '    canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));',
    '    canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));',
    '    var ctx = canvas.getContext("2d", { alpha: false });',
    '    var image = ctx.createImageData(canvas.width, canvas.height);',
    '    for (var i = 0; i < image.data.length; i += 4) {',
    '      image.data[i] = rnd() * 255 | 0;',
    '      image.data[i + 1] = rnd() * 255 | 0;',
    '      image.data[i + 2] = rnd() * 255 | 0;',
    '      image.data[i + 3] = 255;',
    '    }',
    '    ctx.putImageData(image, 0, 0);',
    '  }',
    '  paint();',
    '  window.addEventListener("resize", paint);',
    '})();',
    '</script>',
  ].join('\n')
}

function driverScript(impl, round) {
  const cfg = JSON.stringify({
    impl,
    round,
    partition: PARTITION,
    guests: CONFIG.guests,
    ops: CONFIG.ops,
    hotOps: CONFIG.hotOps,
    guestWidth: CONFIG.guestWidth,
    guestHeight: CONFIG.guestHeight,
    coldGapMs: CONFIG.coldGapMs,
    cacheWindowMs: CONFIG.cacheWindowMs,
    loadSettleMs: CONFIG.loadSettleMs,
    settleMs: CONFIG.settleMs,
    seedBase: CONFIG.seedBase,
  })
  return `
(function () {
  var CFG = ${cfg};
  var phase = 'boot';
  var report = {
    impl: CFG.impl, round: CFG.round,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    errors: [], phases: [], guests: [], heap: [], ops: [], captureCalls: [], diagnostics: null, imageHashes: {}
  };
  function setPhase(name) {
    phase = name;
    report.phases.push({ phase: name, at: Math.round(performance.now() * 10) / 10 });
    try { document.title = 'phase:' + name; } catch (error) {}
  }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function heapNow() {
    var memory = window.performance && window.performance.memory;
    if (!memory) return null;
    return { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit };
  }
  function pushHeap(label) {
    report.heap.push({ label: label, at: Math.round(performance.now() * 10) / 10, memory: heapNow() });
  }
  function loadGuest(index) {
    return new Promise(function (resolve, reject) {
      var view = document.createElement('webview');
      view.setAttribute('partition', CFG.partition);
      view.style.width = CFG.guestWidth + 'px';
      view.style.height = CFG.guestHeight + 'px';
      var settled = false;
      view.addEventListener('did-finish-load', function () {
        if (settled) return;
        settled = true;
        resolve(view);
      });
      view.addEventListener('did-fail-load', function (event) {
        if (settled) return;
        settled = true;
        reject(new Error('did-fail-load ' + event.errorCode + ' ' + (event.errorDescription || '')));
      });
      view.setAttribute('src', '/page/' + index + '?seed=' + (CFG.seedBase + index));
      document.getElementById('grid').appendChild(view);
    });
  }
  window.__runPromise = (async function () {
    try {
      setPhase('host-ready');
      var waitStart = performance.now();
      while (!window.ShelfImpl) {
        if (performance.now() - waitStart > 5000) throw new Error('ShelfImpl bundle missing');
        await sleep(20);
      }
      setPhase('guests-loading');
      var pages = [];
      for (var i = 0; i < CFG.guests; i += 1) pages.push(await loadGuest(i));
      setPhase('guests-loaded');
      async function probe(view) {
        try {
          view.__viewport = await view.executeJavaScript(
            '({w:window.innerWidth,h:window.innerHeight,cw:document.documentElement.clientWidth,ch:document.documentElement.clientHeight,dpr:window.devicePixelRatio})');
        } catch (probeError) {
          view.__viewport = { error: String((probeError && probeError.message) || probeError) };
        }
        return view.__viewport;
      }
      for (var pv = 0; pv < pages.length; pv += 1) pages[pv].__viewportPre = await probe(pages[pv]);
      // 尺寸归一：先做一次 1px 级 resize 抖动，观察 guest 视口是否跟随元素；再把元素盒子
      // 固定到 guest 实际视口尺寸，使“可见区域”就是“被捕获区域”（before/after 完全一致）。
      for (var pn = 0; pn < pages.length; pn += 1) {
        var pvView = pages[pn];
        var pvRect = pvView.getBoundingClientRect();
        pvView.style.height = Math.max(40, Math.round(pvRect.height) - 2) + 'px';
        await sleep(120);
        pvView.style.height = Math.round(pvRect.height) + 'px';
        await sleep(180);
        pvView.__viewportPostResize = await probe(pvView);
        var target = pvView.__viewportPostResize;
        if (Number.isFinite(target.w) && Number.isFinite(target.h)) {
          pvView.style.width = target.w + 'px';
          pvView.style.height = target.h + 'px';
          await sleep(120);
        }
        pvView.__viewportFinal = await probe(pvView);
      }
      report.guests = pages.map(function (view, index) {
        var rect = view.getBoundingClientRect();
        var id = null;
        try { id = view.getWebContentsId(); } catch (error) {}
        return {
          index: index,
          webContentsId: id,
          rect: {
            left: Math.round(rect.left), top: Math.round(rect.top),
            width: Math.round(rect.width), height: Math.round(rect.height)
          },
          viewport: view.__viewportFinal,
          viewportPreResize: view.__viewportPre,
          viewportPostResize: view.__viewportPostResize,
          resizePropagated: Boolean(view.__viewportPre && view.__viewportPostResize &&
            (view.__viewportPre.w !== view.__viewportPostResize.w || view.__viewportPre.h !== view.__viewportPostResize.h)),
          fullyVisible: rect.left >= 0 && rect.top >= 0 &&
            rect.left + rect.width <= window.innerWidth && rect.top + rect.height <= window.innerHeight
        };
      });
      pushHeap('guests-loaded');
      await sleep(CFG.loadSettleMs);
      setPhase('instrument');
      for (var g = 0; g < pages.length; g += 1) {
        (function (index, view) {
          var original = view.capturePage.bind(view);
          var wrapped = async function () {
            var args = Array.prototype.slice.call(arguments);
            var record = {
              index: report.captureCalls.length, guest: index,
              at: Math.round(performance.now() * 10) / 10, phase: phase, status: 'pending'
            };
            report.captureCalls.push(record);
            try {
              var image = await original.apply(null, args);
              record.status = 'ok';
              record.ms = Math.round((performance.now() - record.at) * 10) / 10;
              try {
                var size = image.getSize();
                record.width = size.width;
                record.height = size.height;
                record.empty = image.isEmpty();
              } catch (measureError) {
                record.measureError = String((measureError && measureError.message) || measureError);
              }
              return image;
            } catch (error) {
              record.status = 'error';
              record.ms = Math.round((performance.now() - record.at) * 10) / 10;
              record.errorName = (error && error.name) || 'Error';
              record.errorMessage = String((error && error.message) || error).slice(0, 200);
              throw error;
            }
          };
          Object.defineProperty(view, 'capturePage', { value: wrapped, configurable: true, writable: true });
        })(g, pages[g]);
      }
      setPhase('ops-warm');
      await sleep(200);
      report.plan = {
        ops: CFG.ops, hot: CFG.hotOps, cold: CFG.ops - CFG.hotOps,
        pages: pages.length, cacheWindowMs: CFG.cacheWindowMs, coldGapMs: CFG.coldGapMs
      };
      var lastCallAt = {};
      var schedule = [];
      for (var h = 0; h < CFG.hotOps; h += 1) schedule.push({ kind: 'hot', page: 0 });
      for (var c = 0; c < CFG.ops - CFG.hotOps; c += 1) schedule.push({ kind: 'cold', page: c % pages.length });
      for (var o = 0; o < schedule.length; o += 1) {
        var step = schedule[o];
        if (o === CFG.hotOps) setPhase('ops-cold');
        var waitedMs = 0;
        if (step.kind === 'cold' && typeof lastCallAt[step.page] === 'number') {
          var gap = performance.now() - lastCallAt[step.page];
          if (gap < CFG.coldGapMs) {
            waitedMs = Math.ceil(CFG.coldGapMs - gap);
            await sleep(waitedMs);
          }
        }
        var startedAt = performance.now();
        var capturesBefore = report.captureCalls.length;
        var previousAt = typeof lastCallAt[step.page] === 'number' ? lastCallAt[step.page] : null;
        lastCallAt[step.page] = startedAt;
        var frame = null;
        var error = null;
        try {
          frame = await window.ShelfImpl.captureShelfWebFrame(pages[step.page]);
        } catch (caught) {
          error = {
            name: (caught && caught.name) || 'Error',
            message: String((caught && caught.message) || caught).slice(0, 200)
          };
        }
        var endedAt = performance.now();
        var captures = report.captureCalls.length - capturesBefore;
        var image = frame && typeof frame.image === 'string' ? frame.image : null;
        report.ops.push({
          index: o,
          kind: step.kind,
          page: step.page,
          ms: Math.round((endedAt - startedAt) * 100) / 100,
          waitedMs: waitedMs,
          gapSinceSamePageMs: previousAt === null ? null : Math.round((startedAt - previousAt) * 100) / 100,
          captures: captures,
          returned: frame ? { width: frame.width, height: frame.height } : null,
          dataUrlChars: image ? image.length : 0,
          ok: Boolean(image),
          cacheHit: captures === 0 && Boolean(image),
          error: error
        });
        // 每页只核对一次完整编码图；放在操作计时外，避免将摘要成本当作截图延迟。
        if (image && !report.imageHashes[step.page]) {
          var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image));
          report.imageHashes[step.page] = Array.from(new Uint8Array(digest)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
        }
      }
      setPhase('ops-done');
      pushHeap('ops-done');
      await sleep(CFG.settleMs);
      setPhase('settled');
      report.diagnostics = typeof window.ShelfImpl.shelfPreviewDiagnostics === 'function'
        ? window.ShelfImpl.shelfPreviewDiagnostics() : null;
      pushHeap('settled');
      report.captureCallTotal = report.captureCalls.length;
      report.finished = true;
      return report;
    } catch (error) {
      report.errors.push(String((error && error.stack) || error));
      return report;
    }
  })();
})();
`
}

function runPage(impl, round) {
  return [
    '<!doctype html><meta charset="utf-8"><title>preview-compare</title>',
    '<style>',
    'html,body{margin:0;background:#111;overflow:hidden}',
    '#grid{display:grid;grid-template-columns:repeat(' + CONFIG.columns + ',' + CONFIG.guestWidth + 'px);',
    'gap:8px;padding:8px}',
    '</style>',
    '<div id="grid"></div>',
    '<script src="/impl.js?impl=' + impl + '"></script>',
    '<script>' + driverScript(impl, round) + '</script>',
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/* 父进程：before 源、esbuild 打包、固定本地服务、交替子进程            */
/* ------------------------------------------------------------------ */

async function runOrchestrator() {
  const startedAt = Date.now()
  const rawDir = path.join(tmpRoot, 'raw')
  const bundlesDir = path.join(tmpRoot, 'bundles')
  const beforeDir = path.join(tmpRoot, 'before')
  const logsDir = path.join(tmpRoot, 'logs')
  const runRawDir = SMOKE ? path.join(tmpRoot, 'smoke/raw') : rawDir
  const gzDir = SMOKE ? path.join(tmpRoot, 'smoke') : path.join(docsDir, 'preview-compare-raw')
  for (const dir of [tmpRoot, runRawDir, bundlesDir, beforeDir, logsDir, docsDir, gzDir]) fs.mkdirSync(dir, { recursive: true })

  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const beforeSource = execFileSync('git', ['show', BEFORE_REF + ':' + BEFORE_REL], { cwd: root, encoding: 'utf8' })
  if (!beforeSource.includes('const frames = new WeakMap') || beforeSource.includes('createShelfWebPreviewRuntime')) {
    throw new Error('HEAD 版本不是预期的 before 实现，停止对照')
  }
  const beforePath = path.join(beforeDir, 'task-shelf-web-frame.ts')
  fs.writeFileSync(beforePath, beforeSource)

  const afterPath = path.join(root, AFTER_REL)
  const afterSource = fs.readFileSync(afterPath)
  if (!afterSource.toString('utf8').includes('export function captureShelfWebFrame')) {
    throw new Error('当前工作区缺少 captureShelfWebFrame，停止对照')
  }

  const esbuild = require('esbuild')
  const buildBundle = (name, entryContents) => {
    const outfile = path.join(bundlesDir, name + '.js')
    esbuild.buildSync({
      stdin: { contents: entryContents, resolveDir: root, loader: 'ts' },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'ShelfImpl',
      outfile,
      logLevel: 'silent',
      write: true,
      sourcemap: false,
      minify: false,
      legalComments: 'none',
    })
    const bytes = fs.readFileSync(outfile)
    return { path: path.relative(root, outfile), bytes: bytes.length, sha256: sha256(bytes) }
  }
  const beforeBundle = buildBundle('before', 'export { captureShelfWebFrame } from "' +
    path.relative(root, beforePath).replace(/\\/g, '/') + '";')
  const afterBundle = buildBundle('after', 'export { captureShelfWebFrame, createShelfWebPreviewRuntime, ' +
    'getShelfWebPreviewRuntime, resetShelfWebPreviewRuntime, shelfPreviewDiagnostics } from "' +
    AFTER_REL + '";')
  console.log('bundles:', JSON.stringify({ before: beforeBundle.bytes, after: afterBundle.bytes, esbuild: esbuild.version }))

  const requestLog = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requestLog.push({ path: url.pathname, at: Date.now() - startedAt })
    const noStore = { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (url.pathname === '/run') {
      const impl = url.searchParams.get('impl')
      const round = Number(url.searchParams.get('round'))
      if (!['before', 'after'].includes(impl) || !Number.isSafeInteger(round)) { res.writeHead(400).end(); return }
      res.writeHead(200, noStore).end(runPage(impl, round))
      return
    }
    if (url.pathname === '/impl.js') {
      const impl = url.searchParams.get('impl')
      const bundle = impl === 'before' ? beforeBundle : impl === 'after' ? afterBundle : null
      if (!bundle) { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/javascript; charset=utf-8' })
      res.end(fs.readFileSync(path.join(root, bundle.path)))
      return
    }
    if (url.pathname.startsWith('/page/')) {
      const index = Number(url.pathname.slice('/page/'.length))
      const seed = Number(url.searchParams.get('seed'))
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(seed)) { res.writeHead(400).end(); return }
      res.writeHead(200, noStore).end(fixturePage(seed))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = 'http://127.0.0.1:' + port

  const rounds = []
  const electronBin = require('electron')
  const childEnv = { ...process.env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.ELECTRON_RENDERER_URL

  try {
    for (const [index, spec] of RUNS.entries()) {
      if (Date.now() - startedAt > GLOBAL_DEADLINE_MS) {
        rounds.push({ ...spec, skipped: 'global-deadline', ok: false })
        continue
      }
      const outFile = path.join(runRawDir, spec.impl + '-round' + spec.round + '.json')
      const logFile = path.join(logsDir, spec.impl + '-round' + spec.round + '.log')
      const log = fs.createWriteStream(logFile)
      const payload = {
        impl: spec.impl, round: spec.round, order: index + 1, port, origin, partition: PARTITION,
        config: CONFIG, outFile, tmpRoot, smoke: SMOKE,
      }
      const child = spawn(electronBin, [__filename, Buffer.from(JSON.stringify(payload)).toString('base64')], {
        cwd: root, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.pipe(log)
      child.stderr.pipe(log)
      const startedChildAt = Date.now()
      let timedOut = false
      const exit = await new Promise(resolve => {
        let settled = false
        const timer = setTimeout(() => {
          timedOut = true
          try { child.kill() } catch { /* 已退出 */ }
        }, ROUND_TIMEOUT_MS)
        child.once('exit', code => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(code)
        })
        child.once('error', () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(-1)
        })
      })
      const durationMs = Date.now() - startedChildAt
      let run = null
      let parseError = null
      if (fs.existsSync(outFile)) {
        try { run = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch (error) { parseError = String(error && error.message) }
      }
      const ok = Boolean(run && run.driver && !run.driver.errors.length && !run.errors.length && !timedOut && exit === 0)
      rounds.push({
        ...spec, order: index + 1, ok, exit, timedOut, durationMs,
        rawFile: path.relative(root, outFile), logFile: path.relative(root, logFile), parseError, run,
      })
      console.log('round', index + 1, spec.impl, spec.round, ok ? 'ok' : 'invalid',
        'exit=' + exit, 'duration=' + durationMs + 'ms')
      log.end()
      // 每轮结束后删除该轮的一次性 profile（userData/appData），保持 tmp 体积可控。
      try {
        for (const entry of fs.readdirSync(tmpRoot)) {
          if (entry.startsWith('profile-' + spec.impl + '-' + spec.round + '-')) {
            const candidate = fs.realpathSync(path.join(tmpRoot, entry))
            const allowedRoot = fs.realpathSync(tmpRoot) + path.sep
            if (!candidate.toLowerCase().startsWith(allowedRoot.toLowerCase())) throw new Error('Profile cleanup target escapes fixture directory')
            fs.rmSync(candidate, { recursive: true, force: true })
          }
        }
      } catch { /* 清理失败不影响结果 */ }
    }
  } finally {
    server.close()
  }

  let summary = buildSummary({ gitHead, beforeSource, afterSource, beforeBundle, afterBundle, rounds, requestLog, startedAt })
  if (SMOKE) {
    fs.writeFileSync(path.join(tmpRoot, 'smoke/summary.json'), JSON.stringify(summary, null, 2))
    console.log('smoke summary -> tmp/shelf-memory-compare/smoke/summary.json')
    return summary
  }

  // 原始明细压缩放 tmp；汇总放 docs。
  for (const round of rounds) {
    if (!round.run) continue
    const raw = fs.readFileSync(path.join(root, round.rawFile))
    const gz = path.join(gzDir, 'preview-compare-' + round.impl + '-round' + round.round + '.json.gz')
    fs.writeFileSync(gz, zlib.gzipSync(raw, { level: 9 }))
    round.gzipFile = path.relative(root, gz)
    round.gzipBytes = fs.statSync(gz).size
    fs.rmSync(path.join(root, round.rawFile))
    round.rawFile = null
  }
  summary = buildSummary({ gitHead, beforeSource, afterSource, beforeBundle, afterBundle, rounds, requestLog, startedAt })
  fs.writeFileSync(path.join(docsDir, 'preview-compare-results.json'), JSON.stringify(summary, null, 2))
  console.log('summary -> docs/shelf-memory-p0/preview-compare-results.json')
  printBrief(summary)
  return summary
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

function compactDiagnostics(diagnostics) {
  if (!diagnostics) return null
  const mib = value => (Number.isFinite(value) ? round2(value / 1048576) : null)
  const scheduler = diagnostics.scheduler || {}
  const cache = diagnostics.cache || {}
  return {
    sources: diagnostics.sources,
    visibleSources: diagnostics.visibleSources,
    scheduler: {
      running: scheduler.running, queued: scheduler.queued, pending: scheduler.pending,
      circuitOpen: scheduler.circuitOpen, watchdogTrips: scheduler.watchdogTrips,
      captures: scheduler.captures, submitted: scheduler.submitted, merged: scheduler.merged,
      captured: scheduler.captured, failed: scheduler.failed, rejected: scheduler.rejected,
      cancelled: scheduler.cancelled,
      temporaryPeakMiB: mib(scheduler.temporaryPeakBytes),
    },
    cache: {
      entries: cache.entries, retired: cache.retired, leases: cache.leases,
      encodedMiB: mib(cache.encodedBytes), decodedMiB: mib(cache.decodedBytes),
      peakEncodedMiB: mib(cache.peakEncodedBytes), peakDecodedMiB: mib(cache.peakDecodedBytes),
      hits: cache.hits, misses: cache.misses, offers: cache.offers, evictions: cache.evictions,
      rejectedAdmission: cache.rejectedAdmission, rejectedEntries: cache.rejectedEntries,
      invalidations: cache.invalidations,
    },
  }
}

function summarizeMemory(samples) {
  if (!samples.length) return null
  const totals = samples.map(sample => toMiB(sample.totalPrivateKiB))
  const peak = Math.max(...totals)
  const peakSample = samples[totals.indexOf(peak)]
  const finalSample = samples[samples.length - 1]
  const phases = [...new Set(samples.map(sample => sample.phase))].map(phase => {
    const values = samples.filter(sample => sample.phase === phase).map(sample => toMiB(sample.totalPrivateKiB))
    return { phase, n: values.length, medianMiB: round2(median(values)), maxMiB: round2(Math.max(...values)) }
  })
  return {
    sampleCount: samples.length,
    finalMiB: round2(toMiB(finalSample.totalPrivateKiB)),
    finalPhase: finalSample.phase,
    peakMiB: round2(peak),
    peakPhase: peakSample.phase,
    medianMiB: round2(median(totals)),
    workingSetPeakMiB: round2(Math.max(...samples.map(sample => toMiB(sample.totalWorkSetKiB)))),
    privateMissingSamples: samples.filter(sample => sample.privateMissing > 0).length,
    phases,
  }
}

function summarizeHeap(heapEntries) {
  if (!heapEntries || !heapEntries.length) return null
  const mapped = heapEntries.map(entry => ({
    label: entry.label,
    usedMiB: entry.memory ? round2(entry.memory.usedJSHeapSize / 1048576) : null,
    totalMiB: entry.memory ? round2(entry.memory.totalJSHeapSize / 1048576) : null,
  }))
  const withValues = mapped.filter(entry => Number.isFinite(entry.usedMiB))
  return {
    checkpoints: mapped,
    finalUsedMiB: withValues.length ? withValues[withValues.length - 1].usedMiB : null,
    peakUsedMiB: withValues.length ? Math.max(...withValues.map(entry => entry.usedMiB)) : null,
  }
}

function summarizeRun(round) {
  const run = round.run
  const driver = (run && run.driver) || {}
  const ops = driver.ops || []
  const captureCalls = driver.captureCalls || []
  const classes = { capture: 0, cache: 0, skipped: 0, error: 0 }
  const latency = { all: [], capture: [], cache: [] }
  const sizes = new Map()
  const cacheGaps = []
  const errorKinds = new Map()
  for (const op of ops) {
    const cls = op.error ? 'error' : op.captures > 0 ? 'capture' : op.ok ? 'cache' : 'skipped'
    classes[cls] += 1
    latency.all.push(op.ms)
    if (cls === 'capture' || cls === 'error') latency.capture.push(op.ms)
    if (cls === 'cache') {
      latency.cache.push(op.ms)
      if (Number.isFinite(op.gapSinceSamePageMs)) cacheGaps.push(op.gapSinceSamePageMs)
    }
    if (op.returned) {
      const key = op.returned.width + 'x' + op.returned.height
      sizes.set(key, (sizes.get(key) || 0) + 1)
    }
    if (op.error) {
      const key = (op.error.name || 'Error') + ': ' + (op.error.message || '')
      errorKinds.set(key, (errorKinds.get(key) || 0) + 1)
    }
  }
  const captureErrors = new Map()
  let captureOk = 0
  let captureEmpty = 0
  const captureDurations = []
  for (const call of captureCalls) {
    if (Number.isFinite(call.ms)) captureDurations.push(call.ms)
    if (call.status === 'ok') {
      captureOk += 1
      if (call.empty) captureEmpty += 1
    } else if (call.status === 'error') {
      const key = (call.errorName || 'Error') + ': ' + (call.errorMessage || '')
      captureErrors.set(key, (captureErrors.get(key) || 0) + 1)
    }
  }
  return {
    impl: round.impl,
    round: round.round,
    order: round.order,
    valid: round.ok,
    exit: round.exit,
    timedOut: Boolean(round.timedOut),
    durationMs: round.durationMs,
    rawFile: round.rawFile || null,
    gzipFile: round.gzipFile || null,
    logFile: round.logFile || null,
    errors: [
      ...(run && run.errors ? run.errors : []),
      ...(driver.errors || []),
      ...(round.parseError ? ['parse: ' + round.parseError] : []),
    ],
    environment: {
      versions: run && run.versions
        ? { electron: run.versions.electron, chrome: run.versions.chrome, node: run.versions.node, v8: run.versions.v8 }
        : null,
      platform: run && run.platform,
      display: run && run.display,
      dpr: driver.devicePixelRatio,
      viewport: driver.viewport,
      hostContentSize: run && run.hostContentSize,
      hostBounds: run && run.hostBounds,
      hostVisible: run && run.hostVisible,
      guestSize: { width: CONFIG.guestWidth, height: CONFIG.guestHeight },
      guests: (driver.guests || []).length,
      guestsFullyVisible: (driver.guests || []).filter(guest => guest.fullyVisible).length,
      guestElements: (driver.guests || []).map(guest => ({
        index: guest.index, rect: guest.rect, viewport: guest.viewport,
        viewportPreResize: guest.viewportPreResize, resizePropagated: guest.resizePropagated,
      })),
      guestViewport: (driver.guests || []).length
        ? (driver.guests[0].viewport || null)
        : null,
      hostWebContentsId: run && run.hostWebContentsId,
    },
    plan: driver.plan || null,
    ops: {
      total: ops.length,
      success: ops.filter(op => op.ok).length,
      failure: ops.filter(op => !op.ok).length,
      thrown: ops.filter(op => Boolean(op.error)).length,
      ...classes,
      captureCallsUsed: ops.reduce((sum, op) => sum + op.captures, 0),
      strayCaptureCalls: (driver.captureCallTotal || 0) - ops.reduce((sum, op) => sum + op.captures, 0),
      returnedSizes: [...sizes.entries()].map(([size, count]) => ({ size, count })),
      imageChars: stats(ops.map(op => op.dataUrlChars).filter(chars => chars > 0)),
      latencyMs: {
        all: stats(latency.all),
        capture: stats(latency.capture),
        cache: stats(latency.cache),
      },
      cacheHitGapMs: {
        count: cacheGaps.length,
        within400: cacheGaps.filter(gap => gap < CONFIG.cacheWindowMs).length,
        min: cacheGaps.length ? round2(Math.min(...cacheGaps)) : null,
        max: cacheGaps.length ? round2(Math.max(...cacheGaps)) : null,
      },
      errorKinds: [...errorKinds.entries()].map(([kind, count]) => ({ kind, count })),
    },
    capture: {
      calls: captureCalls.length,
      ok: captureOk,
      empty: captureEmpty,
      failed: captureCalls.filter(call => call.status === 'error').length,
      nativeMs: stats(captureDurations),
      errorKinds: [...captureErrors.entries()].map(([kind, count]) => ({ kind, count })),
    },
    memory: summarizeMemory((run && run.samples) || []),
    jsHeap: summarizeHeap(driver.heap),
    diagnostics: compactDiagnostics(driver.diagnostics),
    imageHashes: driver.imageHashes || {},
    isolation: {
      proxy: (run && run.proxy) || null,
      blockedRequests: (run && run.blockedRequests) || [],
      partition: PARTITION,
      profileRemovedOnExit: round.exit === 0,
    },
    phases: (driver.phases || []).map(phase => ({ phase: phase.phase, atMs: phase.at })),
  }
}

function buildSummary(input) {
  const runs = input.rounds.map(summarizeRun)
  const valid = runs.filter(run => run.valid)
  const impls = ['before', 'after']
  const perImpl = {}
  for (const impl of impls) {
    const own = runs.filter(run => run.impl === impl)
    const validOwn = valid.filter(run => run.impl === impl)
    const pooledOps = []
    for (const run of validOwn) {
      const driver = (input.rounds.find(round => round.impl === impl && round.round === run.round)?.run?.driver) || {}
      pooledOps.push(...(driver.ops || []))
    }
    const allMs = pooledOps.map(op => op.ms)
    const captureMs = pooledOps.filter(op => !op.error && op.captures > 0).map(op => op.ms)
    const cacheMs = pooledOps.filter(op => !op.error && op.captures === 0 && op.ok).map(op => op.ms)
    const imageChars = pooledOps.map(op => op.dataUrlChars).filter(chars => chars > 0)
    perImpl[impl] = {
      // 逐轮明细已在顶层 runs 中完整保留，这里只放便于对照的紧凑视图，避免汇总文件膨胀。
      rounds: own.map(run => ({
        order: run.order, round: run.round, valid: run.valid,
        finalMemoryMiB: run.memory && run.memory.finalMiB,
        peakMemoryMiB: run.memory && run.memory.peakMiB,
        captureP50Ms: run.ops.latencyMs.capture && run.ops.latencyMs.capture.p50,
        captureCalls: run.capture.calls,
      })),
      validRounds: validOwn.length,
      ops: {
        total: pooledOps.length,
        capture: pooledOps.filter(op => !op.error && op.captures > 0).length,
        cache: pooledOps.filter(op => !op.error && op.captures === 0 && op.ok).length,
        skipped: pooledOps.filter(op => !op.error && op.captures === 0 && !op.ok).length,
        error: pooledOps.filter(op => Boolean(op.error)).length,
        success: pooledOps.filter(op => op.ok).length,
        failure: pooledOps.filter(op => !op.ok).length,
      },
      latencyMs: { all: stats(allMs), capture: stats(captureMs), cache: stats(cacheMs) },
      imageChars: stats(imageChars),
      memoryMiB: {
        finalMedian: median(validOwn.map(run => run.memory && run.memory.finalMiB).filter(Number.isFinite)),
        finalMin: Math.min(...validOwn.map(run => run.memory && run.memory.finalMiB).filter(Number.isFinite)),
        finalMax: Math.max(...validOwn.map(run => run.memory && run.memory.finalMiB).filter(Number.isFinite)),
        peak: Math.max(...validOwn.map(run => run.memory && run.memory.peakMiB).filter(Number.isFinite)),
        medianMedian: median(validOwn.map(run => run.memory && run.memory.medianMiB).filter(Number.isFinite)),
      },
      jsHeapMiB: {
        finalMedian: median(validOwn.map(run => run.jsHeap && run.jsHeap.finalUsedMiB).filter(Number.isFinite)),
        peak: Math.max(...validOwn.map(run => run.jsHeap && run.jsHeap.peakUsedMiB).filter(Number.isFinite)),
      },
      captureCalls: validOwn.reduce((sum, run) => sum + run.capture.calls, 0),
      captureFailed: validOwn.reduce((sum, run) => sum + run.capture.failed, 0),
    }
  }
  const equalWork = perImpl.before.captureCalls === perImpl.after.captureCalls &&
    perImpl.before.ops.success === perImpl.after.ops.success
  const reasons = []
  if (!equalWork) reasons.push('真实捕获数或成功工作量不一致')
  if (valid.some(run => Object.keys(run.imageHashes).length !== run.environment.guests)) reasons.push('缺少逐页输出图摘要')
  if (new Set(valid.map(run => JSON.stringify(run.imageHashes))).size > 1) reasons.push('逐页输出图 SHA-256 不一致')
  if (valid.length !== runs.length) reasons.push('存在无效轮次：' + runs.filter(run => !run.valid).map(run => run.impl + '#' + run.round).join(','))
  if (!runs.length) reasons.push('没有轮次数据')
  if (valid.length && new Set(valid.map(run => run.environment.guests)).size > 1) reasons.push('guest 数量不一致')
  if (valid.length && new Set(valid.map(run => JSON.stringify(run.environment.hostContentSize))).size > 1) reasons.push('宿主内容尺寸不一致')
  if (valid.length && new Set(valid.map(run => run.environment.dpr)).size > 1) reasons.push('DPR 不一致')
  if (valid.length && new Set(valid.map(run => run.ops.total)).size > 1) reasons.push('操作数不一致')
  // 表面可截取性：每轮都必须真实返回图片（空图/异常即视为对照不成立，但仍原样记录）。
  for (const run of valid) {
    const rate = run.ops.total ? run.ops.success / run.ops.total : 0
    if (rate < 0.9) reasons.push(run.impl + '#' + run.round + ' 仅 ' + run.ops.success + '/' + run.ops.total + ' 次返回图片')
    if (run.environment.guests !== run.environment.guestsFullyVisible) {
      reasons.push(run.impl + '#' + run.round + ' 存在未完全可见的 guest')
    }
    if (run.capture.empty > 0) reasons.push(run.impl + '#' + run.round + ' 出现 ' + run.capture.empty + ' 次空图')
  }
  const comparisonValid = reasons.length === 0
  return {
    schema: 1,
    kind: 'isolated-preview-capture-ab',
    generatedAt: nowIso(),
    workspace: root,
    gitHead: input.gitHead,
    smoke: SMOKE,
    intendedUse: 'P5 预览同负载前后对照（单代表性场景）；不替代完整应用或五分钟后稳态',
    before: {
      origin: 'git show ' + BEFORE_REF + ':' + BEFORE_REL,
      sourcePath: path.relative(root, path.join(tmpRoot, 'before/task-shelf-web-frame.ts')),
      sha256: sha256(input.beforeSource),
      bytes: Buffer.byteLength(input.beforeSource),
      bundle: input.beforeBundle,
    },
    after: {
      origin: 'working tree ' + AFTER_REL,
      sourcePath: AFTER_REL,
      sha256: sha256(input.afterSource),
      bytes: input.afterSource.length,
      dirty: true,
      bundle: input.afterBundle,
    },
    bundleTool: { esbuild: require('esbuild').version },
    config: CONFIG,
    runOrder: runs.map(run => ({ order: run.order, impl: run.impl, round: run.round, valid: run.valid })),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0] && os.cpus()[0].model,
      totalMemoryBytes: os.totalmem(),
      electron: runs.find(run => run.environment.versions)?.environment.versions?.electron || null,
    },
    serverRequests: input.requestLog.length,
    runs,
    aggregate: {
      comparisonValid,
      invalidReasons: reasons,
      equalWork,
      before: perImpl.before,
      after: perImpl.after,
      delta: {
        finalMemoryMiB: round2((perImpl.after.memoryMiB.finalMedian || 0) - (perImpl.before.memoryMiB.finalMedian || 0)),
        peakMemoryMiB: round2((perImpl.after.memoryMiB.peak || 0) - (perImpl.before.memoryMiB.peak || 0)),
        jsHeapFinalMiB: round2((perImpl.after.jsHeapMiB.finalMedian || 0) - (perImpl.before.jsHeapMiB.finalMedian || 0)),
        captureP50Ms: round2((perImpl.after.latencyMs.capture?.p50 || 0) - (perImpl.before.latencyMs.capture?.p50 || 0)),
        captureP95Ms: round2((perImpl.after.latencyMs.capture?.p95 || 0) - (perImpl.before.latencyMs.capture?.p95 || 0)),
      },
      claims: {
        benefitClaimed: false,
        note: equalWork
          ? '前后工作量与成功图数一致；内存与耗时差异仍受采样与噪声限制，未声称收益。'
          : '前后工作量/成功图数不同，禁止把差异直接解释为收益。',
      },
      dataPaths: {
        summary: 'docs/shelf-memory-p0/preview-compare-results.json',
        rawGzip: runs.filter(run => run.gzipFile).map(run => run.gzipFile),
        logs: runs.map(run => run.logFile).filter(Boolean),
        report: 'docs/shelf-memory-p0/preview-compare-report.md',
      },
    },
  }
}

function printBrief(summary) {
  const rows = summary.runs.map(run => ({
    order: run.order,
    impl: run.impl,
    round: run.round,
    valid: run.valid,
    ops: run.ops.total,
    captures: run.capture.calls,
    ok: run.ops.success,
    fail: run.ops.failure,
    p50: run.ops.latencyMs.all?.p50,
    p95: run.ops.latencyMs.all?.p95,
    finalMiB: run.memory?.finalMiB,
    peakMiB: run.memory?.peakMiB,
    heapMiB: run.jsHeap?.finalUsedMiB,
  }))
  console.log(JSON.stringify({ comparisonValid: summary.aggregate.comparisonValid, reasons: summary.aggregate.invalidReasons, rows }, null, 2))
}

/* ------------------------------------------------------------------ */
/* Electron 子进程                                                     */
/* ------------------------------------------------------------------ */

function runElectronChild() {
  const { app, BrowserWindow, session, screen, webContents } = require('electron')
  const payload = JSON.parse(Buffer.from(process.argv[process.argv.length - 1], 'base64').toString('utf8'))
  const config = payload.config
  const startedAtMs = Date.now()
  let phase = 'startup'
  let window = null
  let sampler = null
  let finished = false
  let report = null

  const profileRoot = fs.mkdtempSync(path.join(payload.tmpRoot, 'profile-' + payload.impl + '-' + payload.round + '-'))
  const appData = path.join(profileRoot, 'appData')
  const userData = path.join(profileRoot, 'userData')
  fs.mkdirSync(appData, { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('appData', appData)
  app.setPath('userData', userData)

  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('enable-precise-memory-info')

  report = {
    schema: 1,
    impl: payload.impl,
    round: payload.round,
    order: payload.order,
    startedAt: Date.now(),
    config,
    versions: process.versions,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0] && os.cpus()[0].model,
    totalMemory: os.totalmem(),
    profileRoot: path.relative(path.join(payload.tmpRoot, '../..'), profileRoot),
    display: null,
    hostContentSize: null,
    hostBounds: null,
    hostVisible: null,
    dpr: null,
    hostWebContentsId: null,
    guestIds: [],
    proxy: null,
    blockedRequests: [],
    errors: [],
    phaseTimeline: [],
    samples: [],
    driver: null,
  }

  function sample(forcePhase) {
    const metrics = app.getAppMetrics()
    const byPid = new Map()
    for (const metric of metrics) byPid.set(metric.pid, metric)
    let totalPrivateKiB = 0
    let totalWorkSetKiB = 0
    let privateMissing = 0
    const processes = []
    for (const metric of byPid.values()) {
      const memory = metric.memory || {}
      const privateKiB = Number.isFinite(memory.privateBytes) ? memory.privateBytes : null
      if (privateKiB === null) privateMissing += 1
      else totalPrivateKiB += privateKiB
      totalWorkSetKiB += memory.workingSetSize || 0
      processes.push({
        pid: metric.pid,
        type: metric.type,
        name: metric.name || metric.serviceName || null,
        privateKiB,
        workSetKiB: memory.workingSetSize || 0,
        peakWorkSetKiB: memory.peakWorkingSetSize || 0,
      })
    }
    const usage = process.memoryUsage()
    report.samples.push({
      at: Date.now() - startedAtMs,
      phase: forcePhase || phase,
      processes,
      totalPrivateKiB,
      totalWorkSetKiB,
      privateMissing,
      main: { heapUsed: usage.heapUsed, external: usage.external, rss: usage.rss, arrayBuffers: usage.arrayBuffers },
    })
  }

  function finish(code) {
    if (finished) return
    finished = true
    clearInterval(sampler)
    clearTimeout(watchdog)
    try { sample('final') } catch { /* 采样失败不阻塞落盘 */ }
    try {
      if (window && !window.isDestroyed()) {
        report.hostVisible = window.isVisible()
        report.hostContentSize = window.getContentSize()
        report.hostBounds = window.getBounds()
        report.guestIds = webContents.getAllWebContents().filter(item => item.getType() === 'webview').map(item => item.id)
      }
      fs.writeFileSync(payload.outFile, JSON.stringify(report))
    } catch (error) {
      console.error('write report failed', error)
    }
    try { if (window && !window.isDestroyed()) window.destroy() } catch { /* ignore */ }
    app.exit(code)
  }

  const watchdog = setTimeout(() => {
    report.errors.push('child watchdog timeout after ' + (Date.now() - startedAtMs) + 'ms')
    finish(1)
  }, 85000)

  app.whenReady().then(async () => {
    const display = screen.getPrimaryDisplay()
    report.display = { id: display.id, label: display.label, scaleFactor: display.scaleFactor, size: display.size, workAreaSize: display.workAreaSize }
    const partitionSession = session.fromPartition(payload.partition)
    await partitionSession.setProxy({ mode: 'direct' })
    report.proxy = 'direct'
    partitionSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partitionSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      let hostname = ''
      try { hostname = new URL(details.url).hostname } catch { /* 非法 URL 记为阻断 */ }
      const allowed = hostname === '127.0.0.1' || hostname === 'localhost'
      if (!allowed && report.blockedRequests.length < 20) report.blockedRequests.push(details.url.slice(0, 120))
      callback({ cancel: !allowed })
    })

    window = new BrowserWindow({
      show: false,
      useContentSize: true,
      width: config.hostWidth,
      height: config.hostHeight,
      backgroundColor: '#111111',
      title: 'preview-compare',
      webPreferences: {
        webviewTag: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    report.hostWebContentsId = window.webContents.id
    window.webContents.setBackgroundThrottling(false)
    window.webContents.on('will-attach-webview', (event, preferences, params) => {
      if (!String(params.src || '').startsWith(payload.origin + '/page/')) return event.preventDefault()
      preferences.nodeIntegration = false
      preferences.contextIsolation = true
      preferences.sandbox = true
      delete preferences.preload
    })
    window.webContents.on('page-title-updated', (event, title) => {
      if (typeof title === 'string' && title.startsWith('phase:')) {
        event.preventDefault()
        phase = title.slice('phase:'.length)
        report.phaseTimeline.push({ phase, at: Date.now() - startedAtMs })
      }
    })

    sampler = setInterval(() => { try { sample() } catch { /* 忽略单次采样失败 */ } }, config.sampleMs)
    sample('startup')

    try {
      await window.loadURL(payload.origin + '/run?impl=' + payload.impl + '&round=' + payload.round)
      window.showInactive()
      report.hostVisible = window.isVisible()
      report.hostContentSize = window.getContentSize()
      report.dpr = await window.webContents.executeJavaScript('window.devicePixelRatio')
      const driver = await window.webContents.executeJavaScript('window.__runPromise')
      report.driver = driver
      sample('driver-done')
      phase = 'settled-final'
      await new Promise(resolve => setTimeout(resolve, 400))
      sample('settled-final')
      finish(0)
    } catch (error) {
      report.errors.push(String((error && error.stack) || error))
      finish(1)
    }
  }).catch(error => {
    report.errors.push(String((error && error.stack) || error))
    finish(1)
  })

  app.on('window-all-closed', () => { /* 保持到显式落盘 */ })
}

if (!process.versions.electron) {
  runOrchestrator().then(() => { /* 主流程已打印 */ }).catch(error => {
    console.error(error && error.stack || error)
    process.exitCode = 1
  })
} else {
  runElectronChild()
}
