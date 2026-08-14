/**
 * eastasianwidth 包无自带类型声明，这里手动补齐。
 * 仅声明终端宽度表用到的 API（Unicode 15.1 East Asian Width）。
 */
declare module 'eastasianwidth' {
  export type EastAsianWidthType = 'F' | 'H' | 'W' | 'Na' | 'A' | 'N'

  /** 单个字符的 East Asian Width 分类（F=全角 W=宽 H=半角 Na=窄 A=歧义 N=中性） */
  export function eastAsianWidth(character: string): EastAsianWidthType

  /** 字符串按 EAW 计算的总宽度 */
  export function characterLength(text: string): number

  export function length(text: string): number

  export function slice(text: string, start?: number, end?: number): string
}
