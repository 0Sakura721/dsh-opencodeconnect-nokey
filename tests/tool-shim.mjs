/**
 * shim 层的工具调用测试 —— **用假 CLI，不消耗免费额度**。
 *
 * 免费额度会周期性耗尽（实测 retryAfterMs 十几小时），那时任何依赖真实推理的
 * 测试都跑不了。但 shim 的职责是"翻译"，跟上游额度无关，所以这里注入一个
 * 假 CLI 直接把模型输出喂进来，验证：
 *
 *   - tools 定义被渲染进 prompt
 *   - 模型输出 <tool_call> 时转成标准 tool_calls（非流式）
 *   - 流式下 tool_calls 分两段下发（id/name 一次，arguments 一次）
 *   - 模型给普通文本时不误报成调用
 *
 * 假 CLI 的做法：写一个 Node 脚本替身，按 `--format json` 的 NDJSON 格式吐事件。
 * 环境变量 FAKE_CLI_OUTPUT 指定要输出的文本。
 *
 * 跑法：node tests/tool-shim.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createShim } from '../lib/shim.js'
import { mergeModelCatalog } from '../lib/cli-bridge.js'

const CATALOG = [
  {
    id: 'deepseek-v4.1-flash-free',
    name: 'DeepSeek V4.1 Flash Free',
    context: 200000,
    maxOutput: 32000,
    vision: true,
    variants: ['low', 'high', 'max']
  }
]

/**
 * 造一个假 CLI 替身（CJS）。
 *
 * 注意这里**不用模板字符串里嵌 `\n`**：那层转义要穿过「测试文件 → 生成的文件」
 * 两次，很容易变成字面换行把脚本写坏（实测 SyntaxError: Invalid or unexpected token）。
 * 改用 `JSON.stringify` 生成行、用 `NL` 常量拼，只转义一次。
 */
function makeFakeCliCjs(dir) {
  const p = path.join(dir, 'fake-cli.cjs')
  const NL = 'newline'
  const lines = [
    "const fs = require('node:fs')",
    `const NL = String.fromCharCode(10)`,
    "const out = process.env.FAKE_CLI_OUTPUT ?? ''",
    "const chunks = []",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (d) => chunks.push(d))",
    "process.stdin.on('end', () => {",
    "  let prompt = chunks.join('')",
    "  if (!prompt) prompt = process.argv.slice(2).join(' ')",
    "  try { fs.writeFileSync(process.env.FAKE_CLI_PROMPT_OUT, prompt, 'utf8') } catch {}",
    "})",
    "process.stdout.write(JSON.stringify({ type: 'step_start', part: {} }) + NL)",
    "process.stdout.write(JSON.stringify({ type: 'text', part: { text: out } }) + NL)",
    "process.stdout.write(JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 10, output: 5, reasoning: 0 } } }) + NL)",
    ''
  ]
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  return p
}

let failed = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { console.error('  ✗ ' + m); failed++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-toolshim-'))
const fakeCli = makeFakeCliCjs(tmp)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-toolshim-home-'))

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  }
]

/** 起一个 shim，把 cliPath 指向假 CLI。 */
async function withShim(output, fn) {
  const promptFile = path.join(tmp, `prompt-${Math.random().toString(36).slice(2)}.txt`)
  const shim = createShim({
    cliPath: fakeCli,
    home,
    log: { warn: () => {}, info: () => {}, error: console.error },
    timeoutMs: 30000,
    catalog: () => CATALOG
  })
  await shim.start()
  // 假 CLI 通过环境变量拿输出内容；runCliOnce 会把 process.env 传下去
  process.env.FAKE_CLI_OUTPUT = output
  process.env.FAKE_CLI_PROMPT_OUT = promptFile
  try {
    await fn({ shim, promptFile })
  } finally {
    shim.dispose()
  }
}

const post = (shim, body) => fetch(`${shim.baseUrl()}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

console.log('═'.repeat(66))
console.log('非流式：模型输出 tool_call 标记')
console.log('═'.repeat(66))

await withShim(
  '<tool_call>{"name":"read_file","arguments":{"path":"C:/temp/a.txt"}}</tool_call>',
  async ({ shim, promptFile }) => {
    const r = await post(shim, {
      model: 'opencode/deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: '读一下 C:/temp/a.txt' }],
      tools: TOOLS
    })
    if (r.status !== 200) { bad('状态码 ' + r.status); return }
    const j = await r.json()
    const msg = j.choices?.[0]?.message
    const finish = j.choices?.[0]?.finish_reason

    if (finish === 'tool_calls') ok('finish_reason = tool_calls')
    else bad(`finish_reason 期望 tool_calls，实际 ${finish}`)

    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length === 1) ok('产出了 1 个 tool_calls')
    else bad('tool_calls 缺失或数量不对: ' + JSON.stringify(msg?.tool_calls))

    const tc = msg?.tool_calls?.[0]
    if (tc?.function?.name === 'read_file') ok('函数名正确')
    else bad('函数名不对: ' + tc?.function?.name)

    if (typeof tc?.function?.arguments === 'string') ok('arguments 是 JSON 字符串')
    else bad('arguments 不是字符串')

    try {
      const a = JSON.parse(tc.function.arguments)
      if (a.path === 'C:/temp/a.txt') ok('arguments 内容正确')
      else bad('arguments 内容不对: ' + JSON.stringify(a))
    } catch (e) {
      bad('arguments 无法解析: ' + tc.function.arguments)
    }

    // 调工具时 content 应为 null（不是把整个标记当正文回给 DSH）
    if (msg?.content === null || msg?.content === '') ok('content 为 null（标记没泄漏到正文）')
    else console.log('    content =', JSON.stringify(msg?.content))

    // tools 定义必须真的进了 prompt
    if (fs.existsSync(promptFile)) {
      const sent = fs.readFileSync(promptFile, 'utf8')
      if (sent.includes('read_file')) ok('tools 定义已渲染进发给 CLI 的 prompt')
      else bad('prompt 里没有 read_file —— tools 没渲染')
      if (sent.includes('NEVER try to run the function yourself')) ok('prompt 含"不要自己执行"的约束')
    } else {
      bad('假 CLI 没写出 prompt 旁路文件')
    }
  }
)

console.log('')
console.log('═'.repeat(66))
console.log('流式：tool_calls 分两段下发')
console.log('═'.repeat(66))

await withShim(
  '<tool_call>{"name":"read_file","arguments":{"path":"D:/x.txt"}}</tool_call>',
  async ({ shim }) => {
    const r = await post(shim, {
      model: 'opencode/deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: '读 D:/x.txt' }],
      tools: TOOLS,
      stream: true
    })
    if (r.status !== 200) { bad('状态码 ' + r.status); return }
    const raw = await r.text()
    const events = raw.split('\n\n').filter((s) => s.trim().startsWith('data:')).map((s) => s.replace(/^data:\s*/, '').trim())
    if (!events.some((e) => e === '[DONE]')) bad('缺 [DONE]')

    let sawName = false
    let sawArgs = false
    let sawFinish = false
    for (const e of events) {
      if (e === '[DONE]') continue
      let o
      try { o = JSON.parse(e) } catch { continue }
      const d = o.choices?.[0]?.delta
      if (d?.tool_calls?.[0]?.function?.name === 'read_file' && d.tool_calls[0].id) sawName = true
      if (d?.tool_calls?.[0]?.function?.arguments) sawArgs = true
      if (o.choices?.[0]?.finish_reason === 'tool_calls') sawFinish = true
    }
    if (sawName) ok('第一段：id + function.name 已下发')
    else bad('没有下发 tool_calls 的 id/name')
    if (sawArgs) ok('第二段：function.arguments 已下发')
    else bad('没有下发 arguments')
    if (sawFinish) ok('finish_reason = tool_calls')
    else bad('流式结束没有 tool_calls 的 finish_reason')
  }
)

console.log('')
console.log('═'.repeat(66))
console.log('模型给普通文本（不该误报成调用）')
console.log('═'.repeat(66))

await withShim('这个文件不需要工具，内容是 42。', async ({ shim }) => {
  const r = await post(shim, {
    model: 'opencode/deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: '随便聊聊' }],
    tools: TOOLS
  })
  const j = await r.json()
  const msg = j.choices?.[0]?.message
  const finish = j.choices?.[0]?.finish_reason
  if (!msg?.tool_calls && finish === 'stop') ok('纯文本回答：没有 tool_calls，finish=stop')
  else bad(`误报了调用: finish=${finish} tool_calls=${JSON.stringify(msg?.tool_calls)}`)
  if (msg?.content?.includes('42')) ok('正文内容原样返回')
  else bad('正文丢了: ' + JSON.stringify(msg?.content))
})

console.log('')
console.log('═'.repeat(66))
console.log('不传 tools（普通对话不受影响）')
console.log('═'.repeat(66))

await withShim('4277', async ({ shim, promptFile }) => {
  const r = await post(shim, {
    model: 'opencode/deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: '计算 91*47，只回数字' }]
  })
  const j = await r.json()
  if (j.choices?.[0]?.message?.content === '4277') ok('无 tools 时正常返回文本')
  else bad('无 tools 时输出不对: ' + JSON.stringify(j.choices?.[0]?.message?.content))
  if (fs.existsSync(promptFile)) {
    const sent = fs.readFileSync(promptFile, 'utf8')
    if (!sent.includes('<functions>')) ok('无 tools 时 prompt 里没有工具段（不污染）')
    else bad('无 tools 时仍塞了工具段')
  }
})

fs.rmSync(tmp, { recursive: true, force: true })
fs.rmSync(home, { recursive: true, force: true })

console.log('')
console.log('═'.repeat(66))
if (failed) {
  console.error(`FAIL: ${failed} 项失败`)
  process.exit(1)
}
console.log('PASS: shim 工具调用路径全部正常（用假 CLI，零额度消耗）')
