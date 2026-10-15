// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import postcss from 'postcss'
import { ScrollTie } from './ScrollFold'

afterEach(cleanup)

describe('ScrollTie', () => {
  it('多个绳结各自引用自己的纹理，重渲染后引用保持稳定', () => {
    const ties = <><ScrollTie group /><ScrollTie /></>
    const { container, rerender } = render(ties)
    const ids = Array.from(container.querySelectorAll('pattern'), pattern => pattern.id)
    expect(new Set(ids).size).toBe(2)
    container.querySelectorAll('svg').forEach((svg, index) => {
      expect(svg.querySelector('.scroll-tie-wrap path[stroke^="url"]')?.getAttribute('stroke'))
        .toBe(`url(#${ids[index]})`)
    })
    rerender(<><ScrollTie group={false} /><ScrollTie group /></>)
    expect(Array.from(container.querySelectorAll('pattern'), pattern => pattern.id)).toEqual(ids)
  })

  it('双轴缩绳规则只命中上下辊，不影响墙内嵌套或独立的单轴分组', () => {
    const { container } = render(<div data-scroll-material="jade">
      <div className="scroll-dual scroll-dual-wall">
        <div className="scroll-dual-rod"><span className="scroll-dual-tie"><ScrollTie /></span></div>
        <div className="scroll-dual-paper">
          <div className="scroll-head rolled"><ScrollTie group /></div>
        </div>
        <div className="scroll-dual-rod scroll-dual-rod-b"><span className="scroll-dual-tie"><ScrollTie /></span></div>
      </div>
      <div className="scroll-head rolled"><ScrollTie group /></div>
    </div>)
    const selectors: string[] = []
    const artworkCss = readFileSync(resolve(__dirname, '../../styles/scroll-artwork.css'), 'utf8')
    postcss.parse(artworkCss).walkRules(rule => {
      if (rule.selector.includes('.scroll-tie-wrap')) {
        rule.walkDecls('transform', declaration => {
          if (declaration.value.includes('scaleY')) selectors.push(rule.selector)
        })
      }
    })
    expect(selectors.length).toBeGreaterThan(0)
    const shortened = Array.from(container.querySelectorAll('.scroll-tie-wrap'))
      .filter(wrap => selectors.some(selector => wrap.matches(selector)))
    expect(shortened).toEqual(Array.from(container.querySelectorAll('.scroll-dual-rod .scroll-tie-wrap')))
    expect(shortened).toHaveLength(2)
  })
})
