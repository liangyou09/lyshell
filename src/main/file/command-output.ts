/** 命令结果与增量输出共用硬上限；超限失败，不把部分结果伪装成成功。 */
export const MAX_COMMAND_OUTPUT_CHARS = 1024 * 1024

export function appendCommandOutput(output: string, chunk: string): string {
  if (chunk.length > MAX_COMMAND_OUTPUT_CHARS - output.length) {
    throw new Error(`Command output limit exceeded (max ${MAX_COMMAND_OUTPUT_CHARS} chars)`)
  }
  return output + chunk
}
