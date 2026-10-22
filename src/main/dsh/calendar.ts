/**
 * 官方计费日历：法定节假日 + 「周末永远空闲」。
 *
 * 官方规则（DeepSeek 开放平台的 off-peak 折扣）：
 * - 高峰 = 北京时间的工作日 09:00-12:00、14:00-18:00；
 * - 周末整天算空闲；
 * - 法定节假日整天算空闲。
 *
 * 这里只放**有来源的**节假日数据，并且按年保存：国务院每年才公布下一年的放假安排，
 * 把它们写成不带年份的永久事实，隔年就会悄悄算错。没覆盖到的年份由调用方
 * （`usage-service.ts` → `pricing.calendarWarningYears`）如实告诉用户。
 */

export interface DshOfficialHolidayYear {
  year: number
  /** 数据来源：用户/审查者能顺着它核对到具体公告 */
  source: string
  /** 放假区间，闭区间 `[首日, 末日]`，`MM-DD` */
  ranges: ReadonlyArray<readonly [string, string]>
}

/**
 * 2026 年放假安排（国务院办公厅 2026 年部分节假日安排，2025-11 发布）。
 * 只收「放假」的日期：调休补班日不影响本判定 —— 官方折扣里周末是全天空闲的，
 * 补班上班的周六也不该按高峰价计费。
 */
export const DSH_OFFICIAL_HOLIDAY_YEARS: readonly DshOfficialHolidayYear[] = [
  {
    year: 2026,
    source: 'https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm',
    ranges: [
      ['01-01', '01-03'], // 元旦
      ['02-15', '02-23'], // 春节
      ['04-04', '04-06'], // 清明节
      ['05-01', '05-05'], // 劳动节
      ['06-19', '06-21'], // 端午节
      ['09-25', '09-27'], // 中秋节
      ['10-01', '10-07'] // 国庆节
    ]
  }
]

const DAY_MS = 86_400_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 用 UTC 做日期推进：纯日历算术，没有时区/夏令时偏移，也不会被本地时区改写日期。 */
function expandRange(year: number, from: string, to: string): string[] {
  const [fromMonth, fromDay] = from.split('-').map(Number)
  const [toMonth, toDay] = to.split('-').map(Number)
  const start = Date.UTC(year, fromMonth - 1, fromDay)
  const end = Date.UTC(year, toMonth - 1, toDay)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  const days: string[] = []
  for (let time = start; time <= end; time += DAY_MS) {
    const date = new Date(time)
    days.push(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`)
  }
  return days
}

let cachedDays: readonly string[] | null = null

/** 内置日历覆盖的全部节假日（`YYYY-MM-DD`，升序去重）。 */
export function dshOfficialHolidayDays(): readonly string[] {
  if (cachedDays) return cachedDays
  const days = new Set<string>()
  for (const year of DSH_OFFICIAL_HOLIDAY_YEARS) {
    for (const [from, to] of year.ranges) {
      for (const day of expandRange(year.year, from, to)) days.add(day)
    }
  }
  cachedDays = [...days].sort()
  return cachedDays
}

/** 内置日历覆盖到的年份（升序）。 */
export function dshOfficialHolidayYears(): number[] {
  return DSH_OFFICIAL_HOLIDAY_YEARS.map((entry) => entry.year).sort((a, b) => a - b)
}

/** 某一年是否有官方节假日数据；没有就要在界面上提示「节假日按工作日判定，可能高估」。 */
export function isDshHolidayCalendarYearCovered(year: number): boolean {
  return DSH_OFFICIAL_HOLIDAY_YEARS.some((entry) => entry.year === year)
}
