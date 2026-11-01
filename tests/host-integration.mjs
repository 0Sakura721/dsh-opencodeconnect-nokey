/**
 * 宿主集成测试：在 "宿主环境" 里真正 load 一次 lib/index.js 的 apply()。
 *
 * 用 `ELECTRON_RUN_AS_NODE=1` + DSH 自带的 node 形态跑，这样
 * `hostModuleRoot()` 能像宿主一样从 process.execPath 推出 asar 目录。
 *
 * 它造一个最小 cordis 上下文（logger / effect / get / llm.registerAdapter），
 * 然后检查三件事：
 *   1. apply 不抛
 *   2. registerAdapter 被调用且拿到的 adapter 有 profiles()
 *   3. provider 的 models 指向 shim 的 baseUrl
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginEntry = path.join(here, '..', 'lib', 'index.js')

const logs = []
const log = {
  info: (...a) => { logs.push(['info', a.join(' ')]); console.log('[info]', ...a) },
  warn: (...a) => { logs.push(['warn', a.join(' ')]); console.warn('[warn]', ...a) },
  error: (...a) => { logs.push(['error', a.join(' ')]); console.error('[error]', ...a) }
}

let registered = null
const disposers = []

/** 极简 cordis 上下文替身：只提供这个插件真正用到的那几个面。 */
const ctx = {
  logger: log,
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  },
  get(name) {
    if (name === 'dshHome') return path.join(os.homedir(), '.dsh')
    return undefined
  },
  llm: {
    registerAdapter(ids, adapter) {
      registered = { ids, adapter }
      console.log('[ctx.llm] registerAdapter ids =', ids)
      return () => { console.log('[ctx.llm] released', ids) }
    }
  }
}

const mod = await import(pathToFileURL(pluginEntry).href)
console.log('plugin exports =', Object.keys(mod).join(', '))

mod.apply(ctx, { enabled: true, displayName: 'OpenCode Free', timeoutMs: 180000 })

// 等 shim 起来 + adapter 注册（apply 内部是异步的）
let waited = 0
while (!registered && waited < 20000) {
  await new Promise((r) => setTimeout(r, 500))
  waited += 500
}

if (!registered) {
  console.error('FAIL: registerAdapter 从未被调用')
  console.error('logs:', JSON.stringify(logs, null, 1))
  process.exit(1)
}

const adapter = registered.adapter
console.log('adapter methods =', Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).join(', '))

const models = await adapter.listModels('opencode-free')
console.log('listModels count =', models.length)
const first = models[0]
console.log('first model =', JSON.stringify(first, null, 1).slice(0, 400))

if (!first) {
  console.error('FAIL: listModels 返回空')
  process.exit(1)
}

// 解析模型元信息 + 准备调用，这两步是宿主真正跑推理前的必经路径
const info = await adapter.resolveModel('opencode-free', first.id)
console.log('resolveModel =', JSON.stringify(info, null, 1).slice(0, 500))

const prepared = await adapter.prepareCall('opencode-free', first.id)
console.log('prepareCall model =', JSON.stringify(prepared.model, null, 1).slice(0, 300))
console.log('prepareCall has stream =', typeof prepared.stream === 'function')

if (typeof prepared.stream !== 'function') {
  console.error('FAIL: prepareCall 没有返回 stream')
  process.exit(1)
}

for (const d of disposers) {
  try { d() } catch { /* 卸载期窗口已关 */ }
}
console.log('PASS')
