/**
 * 高峰 / 空闲时段的判定 —— 价目表里的两档单价靠它落到每一条事件上。
 *
 * 官方规则（DeepSeek 价目页）：北京时间周一至周五 09:00-12:00、14:00-18:00 为**高峰时段**，
 * 其余时段（含**周末**与**中国法定节假日**全天）为**空闲时段**，空闲价 = 高峰价的一半。
 *
 * 三个现实问题：
 * - 法定节假日每年由国务院公布，不能写死在代码里当永久事实：官方假日放在 `calendar.ts`
 *   （带年份与来源），价目表里的 `holidays` 与之取并集 —— 用户补自己的假日不会被拒绝，
 *   内置表也不会因为用户文件里有一行 `holidays` 就被清空。
 * - **周末全天空闲**，调休补班日（`workdays`）并不改变这一点：官方折扣是按「周末/节假日」
 *   给的，补班上班的周六也不按高峰价计费。`workdays` 仅为兼容旧价目表而保留解析。
 * - 北京时间是固定 UTC+8，没有夏令时，所以直接按偏移量算，不依赖运行机器的时区设置。
 */
import { dshOfficialHolidayDays } from './calendar'

/** 北京时间相对 UTC 的固定偏移（中国无夏令时）。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 高峰时段（北京时间，当日分钟数，左闭右开）。 */
export const DSH_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60]
]

export interface DshBeijingClock {
  /** `YYYY-MM-DD`（北京时间），与 `holidays` / `workdays` 里的写法一致 */
  dayKey: string
  /** 1 = 周一 … 7 = 周日 */
  weekday: number
  /** 当日分钟数（0-1439） */
  minute: number
}

/** 把时间戳换算成北京时间的「几号、周几、几点几分」。 */
export function beijingClock(time: number): DshBeijingClock {
  const date = new Date(time + BEIJING_OFFSET_MS)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return {
    dayKey: `${date.getUTCFullYear()}-${month}-${day}`,
    weekday: date.getUTCDay() || 7,
    minute: date.getUTCHours() * 60 + date.getUTCMinutes()
  }
}

export interface DshTariffCalendar {
  /** 法定节假日：全天按空闲价。调用方负责把内置官方日历合进来。 */
  holidays?: readonly string[]
  /** @deprecated 调休补班日不影响判定：周末始终全天空闲。保留字段只为兼容旧价目表。 */
  workdays?: readonly string[]
}

/**
 * 组装判定用的日历：内置官方节假日（`calendar.ts`，按年维护）+ 价目表里用户补的假日。
 * 取并集而不是覆盖 —— 用户文件里写一行 `holidays` 不该把官方放假安排整份抹掉，
 * 否则国庆当天会突然按高峰价计费。
 */
export function resolveDshCalendar(extraHolidays?: readonly string[]): DshTariffCalendar {
  const holidays = new Set(dshOfficialHolidayDays())
  for (const day of extraHolidays ?? []) holidays.add(day)
  return { holidays: [...holidays].sort() }
}

/**
 * 造一个「这个时刻是不是高峰」的判定函数。折叠每条事件时都要调，
 * 所以先把节假日放进 `Set`，别在循环里反复 `includes`。
 */
export function createDshPeakClassifier(calendar: DshTariffCalendar = {}): (time: number) => boolean {
  const holidays = new Set(calendar.holidays ?? [])
  return (time: number): boolean => {
    const clock = beijingClock(time)
    if (holidays.has(clock.dayKey)) return false
    // 周末整天是空闲时段；调休补班日也照此处理，不看 workdays
    if (clock.weekday > 5) return false
    return DSH_PEAK_WINDOWS.some(([start, end]) => clock.minute >= start && clock.minute < end)
  }
}
