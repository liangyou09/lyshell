import { describe, expect, it } from 'vitest'
import { beijingClock, createDshPeakClassifier, DSH_PEAK_WINDOWS, resolveDshCalendar } from './tariff'

/** 北京时间 = UTC+8：用 UTC 造时间戳，避免测试受运行机器时区影响。 */
function beijing(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

describe('beijingClock', () => {
  it('把时间戳换算成北京时间的日期、周几与分钟数', () => {
    // 2026-10-20 是周二，北京时间 09:05 → UTC 01:05
    const clock = beijingClock(beijing(2026, 10, 20, 9, 5))
    expect(clock).toEqual({ dayKey: '2026-10-20', weekday: 2, minute: 545 })
    // 北京时间 00:30 → UTC 前一天 16:30，日期不能跟着 UTC 走
    expect(beijingClock(beijing(2026, 10, 20, 0, 30))).toEqual({ dayKey: '2026-10-20', weekday: 2, minute: 30 })
    // 周日算 7 而不是 0
    expect(beijingClock(beijing(2026, 10, 25, 12, 0)).weekday).toBe(7)
  })
})

describe('createDshPeakClassifier', () => {
  const isPeak = createDshPeakClassifier()

  it('工作日的高峰窗口是左闭右开：09:00 进、12:00 出、14:00 进、18:00 出', () => {
    expect(isPeak(beijing(2026, 10, 20, 8, 59))).toBe(false)
    expect(isPeak(beijing(2026, 10, 20, 9, 0))).toBe(true)
    expect(isPeak(beijing(2026, 10, 20, 11, 59))).toBe(true)
    expect(isPeak(beijing(2026, 10, 20, 12, 0))).toBe(false)
    expect(isPeak(beijing(2026, 10, 20, 13, 59))).toBe(false)
    expect(isPeak(beijing(2026, 10, 20, 14, 0))).toBe(true)
    expect(isPeak(beijing(2026, 10, 20, 17, 59))).toBe(true)
    expect(isPeak(beijing(2026, 10, 20, 18, 0))).toBe(false)
    expect(isPeak(beijing(2026, 10, 20, 23, 30))).toBe(false)
  })

  it('周末全天是空闲时段', () => {
    expect(isPeak(beijing(2026, 10, 24, 10, 0))).toBe(false)
    expect(isPeak(beijing(2026, 10, 25, 15, 0))).toBe(false)
  })

  it('节假日整天空闲，调休补班日也按周末算空闲', () => {
    const calendar = createDshPeakClassifier({ holidays: ['2026-10-20'], workdays: ['2026-10-24'] })
    expect(calendar(beijing(2026, 10, 20, 10, 0))).toBe(false)
    // 2026-10-24 是周六：补班上班也不算高峰 —— 官方折扣按「周末/节假日」给，不看是否调休
    expect(calendar(beijing(2026, 10, 24, 10, 0))).toBe(false)
    expect(calendar(beijing(2026, 10, 24, 12, 30))).toBe(false)
  })

  it('高峰窗口常量本身是 09:00-12:00 与 14:00-18:00', () => {
    expect(DSH_PEAK_WINDOWS).toEqual([[540, 720], [840, 1080]])
  })
})

describe('resolveDshCalendar', () => {
  const withOfficial = createDshPeakClassifier(resolveDshCalendar())

  it('内置官方节假日（2026）整天空闲：国庆当天不按高峰算', () => {
    // 2026-10-01 是周四（工作日），只有节假日日历能让它进空闲价
    expect(withOfficial(beijing(2026, 10, 1, 10, 0))).toBe(false)
    expect(withOfficial(beijing(2026, 10, 7, 15, 0))).toBe(false)
    // 节后第一个工作日回到高峰
    expect(withOfficial(beijing(2026, 10, 8, 10, 0))).toBe(true)
  })

  it('春节/清明/劳动节/端午/中秋/元旦都在内置日历里', () => {
    expect(withOfficial(beijing(2026, 1, 1, 10, 0))).toBe(false)
    expect(withOfficial(beijing(2026, 2, 17, 10, 0))).toBe(false)
    expect(withOfficial(beijing(2026, 4, 6, 10, 0))).toBe(false)
    expect(withOfficial(beijing(2026, 5, 4, 10, 0))).toBe(false)
    expect(withOfficial(beijing(2026, 6, 19, 10, 0))).toBe(false)
    expect(withOfficial(beijing(2026, 9, 25, 10, 0))).toBe(false)
  })

  it('用户补的假日与官方日历取并集，不会把官方安排抹掉', () => {
    const classifier = createDshPeakClassifier(resolveDshCalendar(['2026-12-24']))
    expect(classifier(beijing(2026, 12, 24, 10, 0))).toBe(false)
    expect(classifier(beijing(2026, 10, 1, 10, 0))).toBe(false)
  })
})
