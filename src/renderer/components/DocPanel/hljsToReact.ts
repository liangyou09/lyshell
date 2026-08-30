/**
 * highlight.js 按需注册 + 高亮 HTML → React 节点转换器。
 *
 * 只引 lib/core 与手动注册的常用语言（控制包体），alias（sh/html 等）由
 * 语言定义自带。转换走 DOMParser 递归重建 React 元素 —— 保持仓库
 * 零 dangerouslySetInnerHTML 不变量。
 */
import React from 'react'
import hljs from 'highlight.js/lib/core'
import type { LanguageFn } from 'highlight.js'

import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGUAGES: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  css,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml
}

for (const [name, lang] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, lang)
}

/** 语言名归一化：小写；未知语言返回 null（调用方回退纯文本） */
export function normalizeLang(raw: string | undefined): string | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  return hljs.getLanguage(lower) ? lower : null
}

/** DOM 节点列表 → React 子节点数组（文本节点直出，元素节点递归重建） */
function domToReact(nodes: NodeList, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  nodes.forEach((n, i) => {
    const key = `${keyPrefix}-${i}`
    if (n.nodeType === 3) {
      out.push(n.textContent)
    } else if (n.nodeType === 1) {
      const el = n as HTMLElement
      const cls = el.getAttribute('class') || undefined
      out.push(React.createElement(
        el.tagName.toLowerCase(),
        { key, className: cls },
        domToReact(el.childNodes, key)
      ))
    }
  })
  return out
}

/**
 * 高亮代码 → React 节点。未知语言或高亮异常时回退纯文本（ok=false）。
 */
export function hljsToReact(code: string, lang: string | null): { nodes: React.ReactNode[]; ok: boolean } {
  if (!lang) return { nodes: [code], ok: false }
  try {
    const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true })
    const doc = new DOMParser().parseFromString(value, 'text/html')
    return { nodes: domToReact(doc.body.childNodes, 'hl'), ok: true }
  } catch {
    return { nodes: [code], ok: false }
  }
}
