/**
 * 对「正在运行的 DSH 里的插件 shim」发一次真实推理请求。
 *
 * 为什么需要它：插件 shim 的 Bearer token 是每次启动随机生成的，外部拿不到。
 * 但我们仍要验证"装到 DSH 里的那份代码"能处理 DSH 体量的 prompt ——
 * 只靠离线测试证明不了这一点（离线用的是同一份代码，但插件可能装的是旧版）。
 *
 * 做法：读插件源码里同样的算法？不行，token 是 randomBytes。
 * 所以这里换个角度：**直接验证 DSH 装机副本的代码版本**，
 * 再用 CLI 层做一次真实大 prompt 推理，两者合起来足够。
 *
 * 用法：
 *   node tools/verify-installed.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoLib = path.join(here, '..', 'lib')

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileArg = (() => {
  const i = process.argv.indexOf('--profile')
  return i !== -1 ? process.argv[i + 1] : 'desktop'
})()
const installedLib = path.join(dshHome, 'profiles', profileArg, 'node_modules', 'dsh-opencodeconnect-nokey', 'lib')

const sha = (f) => {
  try { return createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12) }
  catch { return null }
}

let problems = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { console.log('  ✗ ' + m); problems++ }

console.log('仓库 lib :', repoLib)
console.log('装机 lib :', installedLib)
console.log('')

console.log('── 装机副本是否与仓库一致 ──')
for (const f of fs.readdirSync(repoLib)) {
  if (!f.endsWith('.js')) continue
  const a = sha(path.join(repoLib, f))
  const b = sha(path.join(installedLib, f))
  if (a === null || b === null) { bad(`${f} 缺失`); continue }
  if (a === b) ok(`${f} 一致 (${a})`)
  else bad(`${f} 不一致 — 仓库 ${a} / 装机 ${b}，请重跑 install.mjs`)
}

console.log('')
console.log('── 装机副本是否包含 stdin 修复 ──')
const bridge = path.join(installedLib, 'cli-bridge.js')
if (fs.existsSync(bridge)) {
  const src = fs.readFileSync(bridge, 'utf8')
  if (src.includes('ARGV_PROMPT_LIMIT') && src.includes("stdio: [useStdin ? 'pipe' : 'ignore'")) {
    ok('含 stdin 分流（长 prompt 不再走 argv）')
  } else {
    bad('不含 stdin 修复 —— 会再次 ENAMETOOLONG，重跑 install.mjs')
  }
  if (src.includes('ENAMETOOLONG')) ok('含 ENAMETOOLONG 错误提示')
  else bad('缺少 ENAMETOOLONG 提示文案')
} else {
  bad('cli-bridge.js 不存在')
}

console.log('')
console.log('── 运行时：shim 端口与最新轨迹 ──')
const traceFile = path.join(dshHome, 'opencodeconnect', 'startup.log')
if (fs.existsSync(traceFile)) {
  const lines = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
  // 取最后一轮启动（从最后一个 module-load 开始）
  let start = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('[module-load]')) { start = i; break }
  }
  const round = lines.slice(start)
  console.log(`  最后一轮启动共 ${round.length} 条：`)
  for (const l of round) console.log('   | ' + l)
  const m = round.map((l) => l.match(/[shim-up]\s*port=(\d+)/)).find(Boolean)
  if (m) {
    const port = Number(m[1])
    console.log('')
    console.log(`  探测 shim 端口 ${port} ...`)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 3000)
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: ctrl.signal })
      clearTimeout(t)
      if (res.status === 401) ok(`端口 ${port} 在监听且鉴权生效（401 = 正常）`)
      else if (res.status === 200) ok(`端口 ${port} 在监听（200）`)
      else bad(`端口 ${port} 返回意外状态 ${res.status}`)
    } catch (e) {
      bad(`端口 ${port} 不可达：${e.message}（插件可能已卸载或 DSH 已重启）`)
    }
  }
  if (round.some((l) => l.includes('[directory]'))) ok('已登记进可配置目录（模型选择器能列出）')
  else bad('未登记进可配置目录 —— 选择器里不会有 OpenCode Free')
  if (round.some((l) => l.includes('[register-FAIL]') || l.includes('[host-modules-FAIL]'))) {
    bad('轨迹里出现 FAIL 阶段，见上面输出')
  }
} else {
  bad('没有启动轨迹 — 插件未加载')
}

console.log('')
console.log('── 离线真实推理（验证 CLI 通道本身可用）──')
const { locateCli, isolatedHome, runCliOnce } = await import(pathToFileURL(path.join(installedLib, 'cli-bridge.js')).href)
const cliPath = locateCli('')
if (!cliPath) {
  bad('找不到 opencode-cli')
} else {
  ok('CLI 已定位: ' + path.basename(cliPath))
  const home = isolatedHome(path.join(os.homedir(), '.dsh', 'opencodeconnect'))
  // 用 DSH 体量的 prompt 走 stdin 路径
  const big = 'harness boilerplate line\n'.repeat(4000) + '\nAnswer exactly: VERIFY_OK'
  const t0 = Date.now()
  try {
    const r = await runCliOnce({ cliPath, home, model: 'deepseek-v4.1-flash-free', prompt: big, timeoutMs: 180000 })
    const ms = Date.now() - t0
    if (r.text.includes('VERIFY_OK')) ok(`${big.length} 字符 prompt（stdin）推理正确，${ms}ms`)
    else bad(`推理输出不含 VERIFY_OK：${JSON.stringify(r.text.slice(0, 120))}`)
  } catch (e) {
    bad('推理失败: ' + e.message)
  }
}

console.log('')
console.log('='.repeat(64))
if (problems) {
  console.error(`FAIL: ${problems} 个问题`)
  process.exit(1)
}
console.log('PASS: 装机副本、运行时状态、推理通道全部正常')
