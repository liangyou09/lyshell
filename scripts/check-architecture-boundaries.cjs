#!/usr/bin/env node
'use strict'
// AST 门禁：type-only 边不参与运行时环；动态 import 单列并参与环判定，不能靠改语法隐藏循环。
const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')
const ts = require('typescript')
const slash = value => value.replace(/\\/g, '/')
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
function sourceFiles(root) {
  const files = []
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.[^.]+$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(file)
    }
  }
  visit(path.join(root, 'src'))
  return files.sort()
}
function runtimeClause(clause) {
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  return !bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0 || bindings.elements.some(item => !item.isTypeOnly)
}
function references(source) {
  const result = []
  const add = (node, specifier, dynamic = false) => result.push({ specifier, dynamic, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
  const visit = node => {
    if (ts.isImportDeclaration(node) && runtimeClause(node.importClause) && ts.isStringLiteral(node.moduleSpecifier)) add(node, node.moduleSpecifier.text)
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly)) add(node, node.moduleSpecifier.text)
    }
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) add(node, node.moduleReference.expression.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      add(node, arg && ts.isStringLiteralLike(arg) ? arg.text : null, true)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteralLike(arg)) add(node, arg.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}
function components(graph) {
  let next = 0
  const active = new Set(), stack = [], index = new Map(), low = new Map(), cycles = []
  const visit = key => {
    index.set(key, next); low.set(key, next++)
    stack.push(key); active.add(key)
    for (const target of graph.get(key) || []) {
      if (!index.has(target)) { visit(target); low.set(key, Math.min(low.get(key), low.get(target))) }
      else if (active.has(target)) low.set(key, Math.min(low.get(key), index.get(target)))
    }
    if (low.get(key) === index.get(key)) {
      const group = []
      let target
      do { target = stack.pop(); active.delete(target); group.push(target) } while (target !== key)
      if (group.length > 1 || graph.get(key)?.has(key)) cycles.push(group.sort())
    }
  }
  for (const key of graph.keys()) if (!index.has(key)) visit(key)
  return cycles.sort((a, b) => a[0].localeCompare(b[0]))
}
function check(root) {
  root = path.resolve(root)
  const options = {
    moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext,
    baseUrl: root, paths: { '@/*': ['src/renderer/*'], '@main/*': ['src/main/*'], '@shared/*': ['src/shared/*'], '@preload/*': ['src/preload/*'] }
  }
  const graph = new Map(), staticGraph = new Map(), violations = [], dynamicImports = []
  const files = sourceFiles(root), known = new Set(files.map(file => slash(path.resolve(file))))
  for (const file of files) {
    const relative = slash(path.relative(root, file)), edges = new Set(), staticEdges = new Set()
    graph.set(relative, edges); staticGraph.set(relative, staticEdges)
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const reference of references(source)) {
      const { specifier, dynamic, line } = reference
      let target
      if (specifier) {
        const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName
        if (resolved && known.has(slash(path.resolve(resolved)))) target = slash(path.relative(root, resolved))
      }
      if (dynamic) dynamicImports.push({ file: relative, line, specifier, target: target || null })
      if (target) { edges.add(target); if (!dynamic) staticEdges.add(target) }
      const fail = reason => violations.push({ file: relative, line, specifier, target, reason })
      if (relative.startsWith('src/shared/') && target && /^src\/(main|renderer)\//.test(target)) fail('shared must not depend on main/renderer')
      if (relative.startsWith('src/renderer/')) {
        if (target?.startsWith('src/main/')) fail('renderer must not depend on main')
        if (specifier && (specifier === 'electron' || builtins.has(specifier.replace(/^node:/, '')))) fail('renderer must not import Node/Electron capabilities')
      }
      if (/^src\/main\/(?:commands|services|application)\//.test(relative) || /^src\/main\/.*(?:-service|\/service)\.ts$/.test(relative)) {
        if (target && (/^src\/renderer\//.test(target) || ['src/main/ipc/handlers.ts', 'src/main/mcp/http-server.ts'].includes(target))) fail('application service must not depend on transport registration')
      }
      if (relative === 'src/main/storage/secret-store.ts' && target === 'src/main/storage/repository.ts') fail('secret store must not depend on repository')
    }
  }
  return { files: files.length, violations, cycles: components(graph), staticCycles: components(staticGraph), dynamicImports }
}
if (require.main === module) {
  const report = check(process.argv.slice(2).find(argument => !argument.startsWith('--')) || process.cwd())
  const verbose = process.argv.includes('--json')
  if (verbose) console.log(JSON.stringify(report, null, 2))
  else {
    console.log('Architecture boundaries: ' + report.files + ' source files, ' + report.violations.length + ' violations, ' + report.cycles.length + ' runtime cycles (' + report.staticCycles.length + ' static), ' + report.dynamicImports.length + ' dynamic imports')
    for (const item of report.violations) console.error(item.file + ':' + item.line + ' ' + item.reason + ': ' + item.specifier)
    for (const cycle of report.cycles) console.error('Runtime cycle: ' + cycle.join(' -> '))
    for (const item of report.dynamicImports) console.log('Dynamic import: ' + item.file + ':' + item.line + ' -> ' + (item.specifier || '<computed>'))
  }
  if (report.violations.length || report.cycles.length) process.exitCode = 1
}
module.exports = { check, references, components }
