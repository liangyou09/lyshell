import { describe, expect, it } from 'vitest'
import {
  DSH_OFFICIAL_HOLIDAY_YEARS,
  dshOfficialHolidayDays,
  dshOfficialHolidayYears,
  isDshHolidayCalendarYearCovered
} from './calendar'

describe('dshOfficialHolidayDays', () => {
  const days = dshOfficialHolidayDays()

  it('2026 年七个放假区间全覆盖，条数与区间一致', () => {
    expect(days).toHaveLength(3 + 9 + 3 + 5 + 3 + 3 + 7)
    expect(days).toContain('2026-01-01')
    expect(days).toContain('2026-10-07')
  })

  it('区间按闭区间展开：国庆 7 天含首尾，节后一天不在表里', () => {
    expect(days).toContain('2026-10-01')
    expect(days).toContain('2026-10-07')
    expect(days).not.toContain('2026-09-30')
    expect(days).not.toContain('2026-10-08')
  })

  it('春节含调休连休的两端（02-15 到 02-23，共 9 天）', () => {
    expect(days).toContain('2026-02-15')
    expect(days).toContain('2026-02-23')
    expect(days).not.toContain('2026-02-24')
    expect(days.filter((day) => day.startsWith('2026-02'))).toHaveLength(9)
  })

  it('升序且不重复', () => {
    expect([...days].sort()).toEqual(days)
    expect(new Set(days).size).toBe(days.length)
  })

  it('日历数据带来源年份，逐年可核对', () => {
    expect(DSH_OFFICIAL_HOLIDAY_YEARS.map((entry) => entry.year)).toEqual([2026])
    for (const entry of DSH_OFFICIAL_HOLIDAY_YEARS) {
      expect(entry.source).toMatch(/^https:\/\//)
      expect(entry.ranges.length).toBeGreaterThan(0)
    }
  })
})

describe('dshOfficialHolidayYears / isDshHolidayCalendarYearCovered', () => {
  it('只有内置过的年份才算覆盖', () => {
    expect(dshOfficialHolidayYears()).toEqual([2026])
    expect(isDshHolidayCalendarYearCovered(2026)).toBe(true)
    expect(isDshHolidayCalendarYearCovered(2027)).toBe(false)
    expect(isDshHolidayCalendarYearCovered(2025)).toBe(false)
  })
})
