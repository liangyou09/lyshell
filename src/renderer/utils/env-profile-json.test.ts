import { describe, it, expect } from 'vitest'
import { parseEnvProfileJson } from './env-profile-json'

/**
 * 纯函数测试：只覆盖「粘贴的 JSON → 组配置」这一段判定，不碰 UI、IPC、存储。
 * 用例按 acceptance 分块：复制配置回放、草稿、忽略身份字段、坏 JSON、类型/结构、
 * 模型列表、附加变量安全键与上限。失败断言一律只认错误码（不含 JSON 内容）。
 */

/** 复刻 EnvProfilePanel「复制当前配置」的 JSON 形态（保留 undefined 键的写法差异由 stringify 决定）。 */
const copyConfig = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: '生产密钥',
    note: '中转站',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-123',
    env: { NO_PROXY: '127.0.0.1', CODEX_HOME: '/data/codex' },
    models: ['glm-5.2', 'deepseek-chat'],
    ...overrides
  })

const invalidConfig = { success: false, error: 'invalidConfig' }
const invalidJson = { success: false, error: 'invalidJson' }

describe('parseEnvProfileJson', () => {
  it('复制配置原样回放：六个字段全部落成配置，文本不被改写', () => {
    expect(parseEnvProfileJson(copyConfig())).toEqual({
      success: true,
      profile: {
        name: '生产密钥',
        note: '中转站',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test-123',
        env: { NO_PROXY: '127.0.0.1', CODEX_HOME: '/data/codex' },
        models: ['glm-5.2', 'deepseek-chat']
      }
    })
  })

  it('不写未提供字段：只给 name 时 note/baseUrl/apiKey/models 都不存在', () => {
    const result = parseEnvProfileJson('{"name":"草稿"}')
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.profile.name).toBe('草稿')
    expect(result.profile.env).toEqual({})
    expect('note' in result.profile).toBe(false)
    expect('baseUrl' in result.profile).toBe(false)
    expect('apiKey' in result.profile).toBe(false)
    expect('models' in result.profile).toBe(false)
  })

  it('部分草稿：空串字段、空 env、空模型列表都算合法草稿', () => {
    expect(parseEnvProfileJson('{"name":"","note":"","baseUrl":"","apiKey":"","env":{},"models":[]}')).toEqual({
      success: true,
      profile: { name: '', note: '', baseUrl: '', apiKey: '', env: {}, models: [] }
    })
  })

  it('缺 name 回落空串，缺 env 回落空对象（仅有 baseUrl 也合法）', () => {
    expect(parseEnvProfileJson('{"baseUrl":"http://localhost:8080"}')).toEqual({
      success: true,
      profile: { name: '', baseUrl: 'http://localhost:8080', env: {} }
    })
  })

  it('忽略本地身份字段与未知字段，不把它们带进配置', () => {
    const result = parseEnvProfileJson(
      '{"id":"local-1","order":7,"activation":true,"activeProfileId":"x","foo":{"bar":1},"name":"A","env":{"K":"v"}}'
    )
    expect(result).toEqual({ success: true, profile: { name: 'A', env: { K: 'v' } } })
    if (!result.success) throw new Error('expected success')
    expect('id' in result.profile).toBe(false)
    expect('order' in result.profile).toBe(false)
    expect('activation' in result.profile).toBe(false)
  })

  it('文本保持原样：不 trim、不去重、不改写变量值', () => {
    const result = parseEnvProfileJson(
      '{"name":"  A  ","note":"  注  ","baseUrl":" https://x.test ","apiKey":" sk ","env":{"  K  ":"  v  "},"models":[" m ","m"]}'
    )
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.profile.name).toBe('  A  ')
    expect(result.profile.note).toBe('  注  ')
    expect(result.profile.baseUrl).toBe(' https://x.test ')
    expect(result.profile.apiKey).toBe(' sk ')
    expect(Object.entries(result.profile.env)).toEqual([['  K  ', '  v  ']])
    expect(result.profile.models).toEqual([' m ', 'm'])
  })

  it('没有任何可识别字段的对象不算配置（含空对象、只有 id/order 的对象）', () => {
    expect(parseEnvProfileJson('{}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"id":"local-1","order":0,"activation":false}')).toEqual(invalidConfig)
  })

  it('坏 JSON 一律返回 invalidJson', () => {
    expect(parseEnvProfileJson('')).toEqual(invalidJson)
    expect(parseEnvProfileJson('   ')).toEqual(invalidJson)
    expect(parseEnvProfileJson('{')).toEqual(invalidJson)
    expect(parseEnvProfileJson('{"name":"a",}')).toEqual(invalidJson)
    expect(parseEnvProfileJson('{"name":"a"} trailing')).toEqual(invalidJson)
    expect(parseEnvProfileJson('name: a')).toEqual(invalidJson)
  })

  it('根不是普通对象：null / 数组 / 字符串 / 数字 / 布尔均为 invalidConfig', () => {
    expect(parseEnvProfileJson('null')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('[]')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('[{"name":"a"}]')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('"name"')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('42')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('true')).toEqual(invalidConfig)
  })

  it('字段类型严格：字符串字段不收 null / 数组 / 数字 / 布尔 / 对象', () => {
    expect(parseEnvProfileJson('{"name":null}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":123}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":true}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":["a"]}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","note":null}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","note":["n"]}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","baseUrl":123}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","baseUrl":false}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","apiKey":{}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","apiKey":0}')).toEqual(invalidConfig)
  })

  it('env 不是对象即拒：null / 数组 / 字符串 / 数字', () => {
    expect(parseEnvProfileJson('{"name":"a","env":null}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":[]}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":"K=v"}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":1}')).toEqual(invalidConfig)
  })

  it('env 值必须是字符串：数字 / 布尔 / null / 数组 / 对象不得被转成字符串', () => {
    expect(parseEnvProfileJson('{"name":"a","env":{"K":1}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"K":true}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"K":null}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"K":["v"]}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"K":{"v":"v"}}}')).toEqual(invalidConfig)
  })

  it('env 键非法即拒：空键、纯空白、含 NUL', () => {
    expect(parseEnvProfileJson('{"name":"a","env":{"":"v"}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"   ":"v"}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"K\\u0000X":"v"}}')).toEqual(invalidConfig)
  })

  it('env 值含 NUL 即拒', () => {
    expect(parseEnvProfileJson('{"name":"a","env":{"K":"v\\u0000w"}}')).toEqual(invalidConfig)
  })

  it('env 拒绝 __proto__ / constructor / prototype，且不污染对象原型', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', ' __proto__ ', ' constructor ', ' prototype ']) {
      const json = JSON.stringify({ env: Object.fromEntries([[key, 'value']]) })
      expect(parseEnvProfileJson(json)).toEqual(invalidConfig)
    }
    expect(parseEnvProfileJson('{"name":"a","env":{"__proto__":{"polluted":"1"}}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"constructor":{"x":1}}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","env":{"prototype":{"x":1}}}')).toEqual(invalidConfig)
    expect(Object.prototype).not.toHaveProperty('polluted')
    expect(Object.prototype).not.toHaveProperty('x')
  })

  it('models 类型/内容严格：非数组、非字符串项即拒，空串项按草稿保留', () => {
    expect(parseEnvProfileJson('{"name":"a","models":"m"}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","models":null}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","models":{}}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","models":[1]}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","models":["ok",true]}')).toEqual(invalidConfig)
    expect(parseEnvProfileJson('{"name":"a","models":[""]}')).toEqual({
      success: true,
      profile: { name: 'a', env: {}, models: [''] }
    })
  })

  it('上限与主进程 IPC 一致：边界值放行，越界一项即拒', () => {
    const exact = JSON.stringify({
      name: 'n'.repeat(120),
      note: 'n'.repeat(2000),
      baseUrl: 'u'.repeat(2048),
      apiKey: 'k'.repeat(32768),
      env: { ['E'.repeat(1024)]: 'v'.repeat(32768) },
      models: Array.from({ length: 64 }, () => 'm'.repeat(256))
    })
    expect(parseEnvProfileJson(exact).success).toBe(true)

    expect(parseEnvProfileJson(JSON.stringify({ name: 'n'.repeat(121) }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', note: 'n'.repeat(2001) }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', baseUrl: 'u'.repeat(2049) }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', apiKey: 'k'.repeat(32769) }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', env: { ['E'.repeat(1025)]: 'v' } }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', env: { K: 'v'.repeat(32769) } }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', models: Array.from({ length: 65 }, () => 'm') }))).toEqual(invalidConfig)
    expect(parseEnvProfileJson(JSON.stringify({ name: 'a', models: ['m'.repeat(257)] }))).toEqual(invalidConfig)
  })

  it('env 条目上限 256：恰好 256 条放行，257 条即拒', () => {
    const build = (count: number): string => JSON.stringify({
      name: 'a',
      env: Object.fromEntries(Array.from({ length: count }, (_, i) => [`K${i}`, 'v']))
    })
    expect(parseEnvProfileJson(build(256)).success).toBe(true)
    expect(parseEnvProfileJson(build(257))).toEqual(invalidConfig)
  })

  it('失败结果只含错误码，不带出 JSON 内容或密钥', () => {
    const result = parseEnvProfileJson('{"name":123,"apiKey":"sk-super-secret","env":{"SECRET":"sk-other"}}')
    expect(result).toEqual(invalidConfig)
    expect(JSON.stringify(result)).not.toContain('sk-super-secret')
    expect(JSON.stringify(result)).not.toContain('sk-other')
    expect(JSON.stringify(parseEnvProfileJson('not json sk-leak'))).not.toContain('sk-leak')
  })
})
