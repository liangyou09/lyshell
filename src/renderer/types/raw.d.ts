/**
 * Vite `?raw` 静态导入的模块形态声明 —— 内置文档手册等随包内容以原文文本引入。
 *
 * 通配符 declare module 只在「无顶层 import/export 的纯脚本 d.ts」里生效（模块文件里
 * 会退化成 augmentation），故独立成文件而不是并进 types/global.d.ts。项目未引用
 * vite/client 类型（该声明本可覆盖），这里是等价的手工声明。
 */
declare module '*?raw' {
  const content: string
  export default content
}
