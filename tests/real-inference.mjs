/**
 * 真实推理测试：走宿主 adapter 的完整 stream 路径，拿到模型输出。
 *
 * 这一步和 DSH 里点"发送"是同一条代码路径：
 *   adapter.prepareCall(provider, model) -> stream(options)
 *
 * 验证目标是**内容正确**（91*47=4277），而不是"没报错"。
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
      return () => {}
    }
  }
}

const mod = await import(pathToFileURL(pluginEntry).href)
mod.apply(ctx, { displayName: 'OpenCode Free', timeoutMs: 180000 })

let waited = 0
while (!registered && waited < 20000) {
  await new Promise((r) => setTimeout(r, 500))
  waited += 500
}
if (!registered) {
  console.error('FAIL: registerAdapter 未被调用')
  process.exit(1)
}

const adapter = registered.adapter
const prepared = await adapter.prepareCall('opencode-free', 'deepseek-v4.1-flash-free')
console.log('prepared model =', prepared.model.id, '| context =', prepared.model.context?.contextWindow)

// 构造一次真实的调用：宿主传给 pi-ai 的是 messages 数组
const ac = new AbortController()
const timeout = setTimeout(() => ac.abort(), 180000)

let text = ''
let chunks = 0
const t0 = Date.now()
const stream = prepared.stream({
  provider: 'opencode-free',
  model: 'deepseek-v4.1-flash-free',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '计算 91*47，只回数字，不要别的内容' }] }
  ],
  tools: [],
  signal: ac.signal
})

for await (const chunk of stream) {
  chunks++
  // pi-ai 的事件流：assistant 的文本增量
  if (typeof chunk === 'object' && chunk !== null) {
    if (chunk.type === 'text-delta' || chunk.type === 'text') {
      text += chunk.delta ?? chunk.text ?? ''
    } else if (chunk.type === 'error') {
      console.error('stream error chunk =', JSON.stringify(chunk).slice(0, 400))
    }
  }
}
clearTimeout(timeout)

console.log('elapsed ms =', Date.now() - t0)
console.log('chunks =', chunks)
console.log('text =', JSON.stringify(text.trim()))

const clean = text.trim()
if (clean.includes('4277')) {
  console.log('PASS: 91*47 = 4277 正确')
} else {
  console.error('FAIL: 期望输出包含 4277，实际 =', JSON.stringify(clean.slice(0, 200)))
  process.exitCode = 1
}

for (const d of disposers) {
  try { d() } catch { /* 卸载期窗口已关 */ }
}
