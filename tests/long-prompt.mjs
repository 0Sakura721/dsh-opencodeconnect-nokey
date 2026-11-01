/**
 * 长 prompt 回归：验证 stdin 通道能处理 DSH 体量的 system prompt。
 *
 * 这个用例是为了一个真实故障写的：
 *   在 GUI 里用 OpenCode Free 模型发一条消息，返回
 *     502 {"type":"upstream_error","message":"spawn ENAMETOOLONG"}
 *
 * 原因是 DSH 每次请求都带上万字的 system prompt（工具说明、harness 规则等），
 * 而我们最初把整个 prompt 塞进 `opencode-cli` 的 argv。
 * Windows 的 CreateProcess 命令行上限是 32767 字节，超了就 ENAMETOOLONG。
 *
 * 实测数据（本机）：
 *   - 40000 字符走 argv → "Argument list too long"
 *   - 同样内容走 stdin  → CLI 正常返回
 *
 * 所以 cli-bridge 改为：短 prompt 走 argv，长 prompt 走 stdin。
 * 这个测试同时守住这两条路径。
 */
import os from 'node:os'
import path from 'node:path'
import { locateCli, isolatedHome, runCliOnce, ARGV_PROMPT_LIMIT } from '../lib/cli-bridge.js'

const model = 'deepseek-v4.1-flash-free'

const cliPath = locateCli('')
if (!cliPath) {
  console.error('没找到 opencode-cli')
  process.exit(1)
}

const home = isolatedHome(path.join(os.homedir(), '.opencodeconnect-loneprompt-test'))
console.log('CLI =', cliPath)
console.log('ARGV_PROMPT_LIMIT =', ARGV_PROMPT_LIMIT)

let failed = 0

/** 一条用例：跑一次，断言输出包含期望值。 */
async function runCase(name, prompt, expect, expectPath) {
  console.log('')
  console.log('='.repeat(60))
  console.log(`CASE: ${name}`)
  console.log(`  prompt 长度 = ${prompt.length}（预期走 ${prompt.length > ARGV_PROMPT_LIMIT ? 'stdin' : 'argv'}）`)
  const t0 = Date.now()
  try {
    const r = await runCliOnce({ cliPath, home, model, prompt, timeoutMs: 180000 })
    const ms = Date.now() - t0
    console.log(`  耗时 ${ms}ms，输出 = ${JSON.stringify(r.text.slice(0, 60))}`)
    if (!r.text.includes(expect)) {
      console.error(`  ✗ 期望包含 ${JSON.stringify(expect)}`)
      failed++
      return
    }
    console.log('  ✓ 输出正确')
  } catch (err) {
    console.error('  ✗ 抛错:', err.message)
    if (err.stderr) console.error('    stderr:', err.stderr.slice(0, 300))
    failed++
  }
}

// 短 prompt：走 argv，验证原有路径没被改坏
await runCase('短 prompt（argv 路径）', '计算 91*47，只回数字', '4277')

// 超长 prompt：走 stdin，模拟 DSH 的真实请求
const filler = 'The following is harness boilerplate that the model should ignore.\n'
const bigPrompt = filler.repeat(2000) + '\n\nNow answer exactly: LONGPATH_OK'
await runCase('超长 prompt（stdin 路径，模拟 DSH system prompt）', bigPrompt, 'LONGPATH_OK')

console.log('')
console.log('='.repeat(60))
if (failed) {
  console.error(`FAIL: ${failed} 个用例失败`)
  process.exit(1)
}
console.log('PASS: argv 与 stdin 两条路径都正常')
