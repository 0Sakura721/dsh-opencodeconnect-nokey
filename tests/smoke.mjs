/**
 * 端到端冒烟测试：不依赖 DSH，直接把 shim 跑起来打一次。
 *
 * 验证三件事：
 *   1. CLI 定位 + 隔离 HOME 可用
 *   2. shim 的 /v1/models 与 /v1/chat/completions 返回 OpenAI 兼容结构
 *   3. 流式块序列合法（role → content… → finish_reason → usage → [DONE]）
 *
 * 用法：node tests/smoke.mjs [modelId]
 */
import os from 'node:os'
import path from 'node:path'
import { locateCli, isolatedHome } from '../lib/cli-bridge.js'
import { createShim } from '../lib/shim.js'

const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const log = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a)
}

const cliPath = locateCli('')
if (!cliPath) {
  console.error('没找到 opencode-cli')
  process.exit(1)
}
console.log('CLI =', cliPath)

const home = isolatedHome(path.join(os.homedir(), '.opencodeconnect-test'))
const shim = createShim({ cliPath, home, log, timeoutMs: 180000, catalog: () => undefined })
await shim.start()
const base = shim.baseUrl()
const token = shim.token()
console.log('shim =', base)

// 1) /v1/models
const modelsRes = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` } })
console.log('models status =', modelsRes.status)
const modelsJson = await modelsRes.json()
console.log('models count =', modelsJson.data.length)
console.log('models =', modelsJson.data.map((m) => m.id).join(', '))

// 2) 非流式
const t0 = Date.now()
const plainRes = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: `opencode/${model}`,
    messages: [{ role: 'user', content: '计算 91*47，只回数字' }]
  })
})
const plain = await plainRes.json()
console.log('plain status =', plainRes.status, 'ms =', Date.now() - t0)
console.log('plain text =', JSON.stringify(plain.choices?.[0]?.message?.content))
console.log('plain usage =', JSON.stringify(plain.usage))
if (plain.choices?.[0]?.message?.content !== '4277') {
  console.error('!! 期望 4277，实际不同')
  process.exitCode = 1
}

// 3) 流式
const t1 = Date.now()
const streamRes = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: `opencode/${model}`,
    messages: [{ role: 'user', content: '回复四个字：流式正常' }],
    stream: true
  })
})
console.log('stream status =', streamRes.status, 'ms =', Date.now() - t1)
const raw = await streamRes.text()
const events = raw.split('\n\n').filter((s) => s.trim().startsWith('data:'))
console.log('sse events =', events.length)
let content = ''
let sawDone = false
let sawFinish = false
let sawUsage = false
for (const ev of events) {
  const data = ev.replace(/^data: */, '').trim()
  if (data === '[DONE]') { sawDone = true; continue }
  let o
  try { o = JSON.parse(data) } catch { console.error('!! 坏 JSON:', data.slice(0, 120)); process.exitCode = 1; continue }
  if (o.choices?.[0]?.delta?.content) content += o.choices[0].delta.content
  if (o.choices?.[0]?.finish_reason) sawFinish = true
  if (o.usage) sawUsage = true
}
console.log('stream content =', JSON.stringify(content))
console.log('sawFinish =', sawFinish, 'sawUsage =', sawUsage, 'sawDone =', sawDone)
if (!sawFinish || !sawDone) { console.error('!! SSE 序列不完整'); process.exitCode = 1 }

shim.dispose()
console.log(process.exitCode ? 'FAIL' : 'PASS')
