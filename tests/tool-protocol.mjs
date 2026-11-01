/**
 * 工具调用协议层的纯函数测试（不消耗免费额度）。
 *
 * 这一层最容易出问题的地方不是"能不能调通"，而是**模型输出不规范时会不会炸**。
 * 模型会给的各种脏输出都在下面的用例里，解析必须宽容：
 *   - 标准标记
 *   - 裸 JSON
 *   - ```json 代码块
 *   - JSON 前后带前言/后记
 *   - arguments 是字符串而不是对象
 *   - 带尾逗号的非法 JSON
 *   - 完全不是调用的普通回答（要能识别成文本，不能误报）
 *
 * 跑法：node tests/tool-protocol.mjs
 */
import {
  renderToolsPrompt,
  parseToolCalls,
  toOpenAiToolCalls,
  CALL_OPEN,
  CALL_CLOSE
} from '../lib/tool-calling.js'

let failed = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { console.error('  ✗ ' + m); failed++ }

console.log('═'.repeat(66))
console.log('渲染 tools 提示词')
console.log('═'.repeat(66))

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, timeout: { type: 'number' } },
        required: ['command']
      }
    }
  }
]

const prompt = renderToolsPrompt(tools)
if (prompt.includes('read_file') && prompt.includes('run_shell')) ok('两个函数名都进了提示词')
else bad('函数名缺失')

if (prompt.includes('"parameters"') || prompt.includes('parameters')) ok('带了 parameters schema')
else bad('没有 parameters schema')

if (prompt.includes(CALL_OPEN) && prompt.includes(CALL_CLOSE)) ok(`包含调用标记 ${CALL_OPEN}…${CALL_CLOSE}`)
else bad('缺少调用标记')

if (prompt.includes('NEVER try to run the function yourself')) ok('明确禁止模型自己执行')
else bad('缺少"不要自己执行"的约束')

if (renderToolsPrompt([]) === '' && renderToolsPrompt(undefined) === '') ok('无工具时返回空串（不污染 prompt）')
else bad('无工具时不该返回内容')

if (renderToolsPrompt([{ type: 'function', function: { name: '' } }]) === '') ok('无效工具定义被忽略')
else bad('空的 function.name 没被过滤')

console.log('')
console.log('═'.repeat(66))
console.log('解析模型输出（含各种脏格式）')
console.log('═'.repeat(66))

/** 一条用例：输入 → 期望的 calls 数量和第一个调用的名字。 */
function expectCase(name, input, expectCalls, expectName, expectArgs) {
  const r = parseToolCalls(input)
  if (r.calls.length !== expectCalls) {
    bad(`${name}: 期望 ${expectCalls} 个调用，实际 ${r.calls.length} —— 输入 ${JSON.stringify(input.slice(0, 80))}`)
    return
  }
  if (expectCalls > 0) {
    if (r.calls[0].name !== expectName) {
      bad(`${name}: 期望 name=${expectName}，实际 ${r.calls[0].name}`)
      return
    }
    if (expectArgs !== undefined && JSON.stringify(r.calls[0].arguments) !== JSON.stringify(expectArgs)) {
      bad(`${name}: arguments 不符 —— ${JSON.stringify(r.calls[0].arguments)}`)
      return
    }
  }
  ok(name)
}

// 1. 标准标记（实测模型真实输出）
expectCase(
  '标准标记 + 实测输出格式',
  '<tool_call>{"name":"read_file","arguments":{"path":"C:/temp/a.txt"}}</tool_call>',
  1, 'read_file', { path: 'C:/temp/a.txt' }
)

// 2. 标记前后带换行/空白
expectCase(
  '标记前后有空白',
  '\n\n<tool_call>{"name":"run_shell","arguments":{"command":"ls"}}</tool_call>\n\n',
  1, 'run_shell', { command: 'ls' }
)

// 3. 裸 JSON
expectCase('裸 JSON', '{"name":"read_file","arguments":{"path":"a.txt"}}', 1, 'read_file', { path: 'a.txt' })

// 4. 代码块
expectCase(
  '```json 代码块',
  '```json\n{"name":"run_shell","arguments":{"command":"pwd"}}\n```',
  1, 'run_shell', { command: 'pwd' }
)

// 5. 前后带前言（模型没听话的情况）
expectCase(
  '前言 + 标记',
  '好的，我来读取。\n<tool_call>{"name":"read_file","arguments":{"path":"b.txt"}}</tool_call>',
  1, 'read_file', { path: 'b.txt' }
)

// 6. arguments 是字符串（OpenAI 风格）
expectCase(
  'arguments 是 JSON 字符串',
  '<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"c.txt\\"}"}</tool_call>',
  1, 'read_file', { path: 'c.txt' }
)

// 7. 带尾逗号的非法 JSON（宽松解析应能救回来）
expectCase(
  '带尾逗号',
  '<tool_call>{"name":"read_file","arguments":{"path":"d.txt",}}</tool_call>',
  1, 'read_file', { path: 'd.txt' }
)

// 8. 普通回答：必须识别成文本，不能误报成调用
expectCase('普通文本回答（不误报）', '这个文件不需要工具就能告诉你答案：42。', 0, undefined)

// 9. 纯散文里带花括号（不能被当成调用）
expectCase(
  '散文里带 JSON 但不是调用',
  '配置长这样：{"foo":1,"bar":2}，你照着填即可。',
  0, undefined
)

// 10. 多段标记
const multi = parseToolCalls(
  '<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>' +
  '<tool_call>{"name":"run_shell","arguments":{"command":"ls"}}</tool_call>'
)
if (multi.calls.length === 2) ok('多段标记解析出 2 个调用')
else bad(`多段标记期望 2 个，实际 ${multi.calls.length}`)

// 11. leftoverText 应该把标记剥掉
const left = parseToolCalls('思考中…<tool_call>{"name":"read_file","arguments":{}}</tool_call>')
if (left.leftoverText === '思考中…') ok('leftoverText 剥掉了标记')
else bad(`leftoverText 不对: ${JSON.stringify(left.leftoverText)}`)

console.log('')
console.log('═'.repeat(66))
console.log('转成 OpenAI tool_calls 结构')
console.log('═'.repeat(66))

const calls = parseToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"e.txt"}}</tool_call>').calls
const oa = toOpenAiToolCalls(calls)
if (oa.length === 1) ok('产出 1 个 tool_call')
if (oa[0]?.id?.startsWith('call_')) ok(`id 格式正确: ${oa[0].id}`)
if (oa[0]?.type === 'function') ok('type=function')
if (typeof oa[0]?.function?.arguments === 'string') ok('arguments 是字符串（OpenAI 协议要求）')
else bad(`arguments 必须是字符串，实际 ${typeof oa[0]?.function?.arguments}`)
if (JSON.parse(oa[0].function.arguments).path === 'e.txt') ok('arguments 字符串可解析回原对象')

// id 必须唯一，否则 DSH 回填 tool 结果会错位
const ids = toOpenAiToolCalls([{ name: 'a', arguments: {} }, { name: 'b', arguments: {} }]).map((c) => c.id)
if (ids[0] !== ids[1]) ok('多个调用的 id 不重复')
else bad('id 重复了')

console.log('')
console.log('═'.repeat(66))
if (failed) {
  console.error(`FAIL: ${failed} 项失败`)
  process.exit(1)
}
console.log('PASS: 工具调用协议层全部正常（不消耗额度）')
