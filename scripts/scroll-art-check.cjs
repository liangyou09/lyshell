// 可选视觉检查：使用开发环境的 Playwright；不引入应用运行时依赖。
const { chromium } = require(process.env.LYSHELL_PLAYWRIGHT || 'playwright')
const path = require('path')
const fs = require('fs')

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.LYSHELL_CHROMIUM || chromium.executablePath() })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 980 }, deviceScaleFactor: 1 })
    const failures = []
    page.on('pageerror', error => failures.push(error.message))
    page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`) })
    await page.goto('http://127.0.0.1:4174/scroll-art-preview.html')
    await page.locator('.scroll-art-roller').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    const output = path.resolve('docs/previews/scroll-art')
    fs.mkdirSync(output, { recursive: true })
    for (const mode of ['light', 'dark']) {
      await page.locator(`[data-theme-mode="${mode}"] .art-search-samples`).screenshot({ path: path.join(output, `input-paper-${mode}.png`) })
    }
    await page.screenshot({ path: path.join(output, 'light-dark-open.png'), fullPage: true })
    for (const theme of await page.locator('.art-theme').all()) {
      await theme.getByRole('button', { name: '发送', exact: true }).click()
      if (await theme.getByRole('button', { name: '上轴开合' }).getAttribute('aria-expanded') !== 'true') throw new Error('发送后画轴应保持展开')
      await theme.getByRole('button', { name: '上轴开合' }).click()
      await theme.getByRole('button', { name: '单画轴开合' }).click()
      if (await theme.locator('.scroll-dual-paper').getAttribute('inert') === null) throw new Error('收卷纸面必须 inert')
    }
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(output, 'light-dark-rolled.png'), fullPage: true })
    await page.getByRole('button', { name: '上轴开合' }).first().focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    if (await page.getByRole('button', { name: '上轴开合' }).first().getAttribute('aria-expanded') !== 'true') throw new Error('键盘开卷失败')
    await page.setViewportSize({ width: 420, height: 1000 })
    await page.screenshot({ path: path.join(output, 'narrow.png'), fullPage: true })
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('窄布局横向溢出')
    if (failures.length) throw new Error(failures.join('\n'))
    console.log('画轴视觉检查通过：明暗主题、开合、键盘、inert、发送保持展开、窄布局；截图位于 ' + output)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
