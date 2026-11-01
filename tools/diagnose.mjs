/**
 * 诊断工具：回答"插件到底有没有被 DSH 加载并注册成功"。
 *
 * 这个脚本是为一个真实的排查经历写的。当时的现象是：
 *
 *   「插件」页面显示 dsh-opencodeconnect-nokey **已安装、开关打开**，
 *   但模型选择器里搜不到 OpenCode Free，DSH 也没有任何相关日志。
 *
 * 结论是**不能相信插件页面的状态** —— 它只反映 profile 里声明了什么，
 * 不反映 loader 有没有真的把那一行跑起来。必须看三个事实：
 *
 *   1. 轨迹文件里有没有 `module-load` / `registered`
 *   2. 有没有插件自己的 shim 端口
 *   3. 模型选择器里能不能搜到
 *
 * 用法：
 *   node tools/diagnose.mjs
 *   node tools/diagnose.mjs --profile web
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const profileArg = (() => {
  const i = args.indexOf('--profile')
  return i !== -1 ? args[i + 1] : 'desktop'
})()

const PKG_NAME = 'dsh-opencodeconnect-nokey'
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileArg)
const traceFile = path.join(dshHome, 'opencodeconnect', 'startup.log')

const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => console.log('  ✗ ' + m)
const info = (m) => console.log('    ' + m)

let problems = 0

function section(title) {
  console.log('')
  console.log('─'.repeat(64))
  console.log(title)
  console.log('─'.repeat(64))
}

// ─── 1. 安装三要素 ───────────────────────────────────────────────
section('1. 安装三要素')

const libDir = path.join(profileDir, 'node_modules', PKG_NAME, 'lib')
if (fs.existsSync(path.join(libDir, 'index.js')) && fs.existsSync(path.join(libDir, 'shim.js'))) {
  ok(`插件文件到位 (${libDir})`)
} else {
  bad('插件文件缺失，请重新跑 install.mjs')
  problems++
}

const profilePatch = path.join(profileDir, 'cordis.patch.yml')

/**
 * 数一条 patch 文件里挂载某 id 的真正次数。
 *
 * 只看**非注释行**：本项目的 cordis.patch.yml 注释里会引用示例行
 * （"不要写 `- id: opencodeconnect-nokey`"），把注释也算进来会误报 ——
 * 这个误报在我自己排查时真出现过一次。
 */
function countMounts(file) {
  if (!fs.existsSync(file)) return -1
  const code = fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
  return (code.match(/id:\s*opencodeconnect-nokey/g) || []).length
}

let mountCount = 0
if (fs.existsSync(profilePatch)) {
  mountCount = countMounts(profilePatch)
  if (mountCount === 1) ok('profile patch 里有 1 条挂载行')
  else if (mountCount === 0) { bad('profile patch 里没有挂载行'); problems++ }
  else { bad(`profile patch 里有 ${mountCount} 条挂载行（应为 1，重复会导致 loader 跳过）`); problems++ }
} else {
  bad('profile 的 cordis.patch.yml 不存在')
  problems++
}

const pluginPatch = path.join(profileDir, 'node_modules', PKG_NAME, 'cordis.patch.yml')
if (fs.existsSync(pluginPatch)) {
  const selfMount = countMounts(pluginPatch)
  if (selfMount === 0) ok('插件自带 patch 为空（无自引用）')
  else { bad(`插件自带 patch 挂载了自己 ${selfMount} 次 —— loader 会静默跳过，改成 []`); problems++ }
}

const profilePkg = path.join(profileDir, 'package.json')
if (fs.existsSync(profilePkg)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(profilePkg, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles ?? []
    if (bundles.includes(PKG_NAME)) ok('bundles 里已声明')
    else { bad('bundles 里没有它（不会被打包进加载树）'); problems++ }
  } catch (e) {
    bad('profile package.json 无法解析: ' + e.message)
    problems++
  }
}

// ─── 2. 加载轨迹 ─────────────────────────────────────────────────
section('2. 加载轨迹（判断 loader 有没有真的跑起来）')

if (!fs.existsSync(traceFile)) {
  bad(`轨迹文件不存在: ${traceFile}`)
  info('说明本轮 DSH 启动后，插件模块**连 import 都没有发生**。')
  info('常见原因：profile 挂载行没生效 / bundles 没生效 / 改完没重启 DSH。')
  problems++
} else {
  const lines = fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
  const tail = lines.slice(-25)
  const stages = new Set()
  for (const l of tail) {
    const m = l.match(/\[([^\]]+)\]/)
    if (m) stages.add(m[1])
  }
  console.log('  最近 25 条:')
  for (const l of tail) console.log('   | ' + l)

  if (stages.has('registered')) ok('轨迹里出现 registered —— provider 注册成功')
  else if (stages.has('apply')) {
    bad('有 apply 但没到 registered —— 中途某步失败，看上面最后一条')
    problems++
  } else if (stages.has('module-load')) {
    bad('模块被 import 了，但 loader 没调用 apply()（inject 服务缺失或签名不符）')
    problems++
  } else {
    bad('轨迹里连 module-load 都没有')
    problems++
  }
  if (stages.has('host-modules-FAIL') || stages.has('register-FAIL') || stages.has('shim-FAIL')) {
    info('↑ 轨迹里出现了 *_FAIL 阶段，那就是根因')
  }
}

// ─── 3. shim 端口 ────────────────────────────────────────────────
section('3. 运行时端口（插件必须有自己的 shim 端口）')

let listening = []
try {
  // 只读查询，不做任何修改；失败就如实说不支持
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.LocalAddress -eq '127.0.0.1' } | " +
    "Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"
  ], { encoding: 'utf8', timeout: 20000 })
  listening = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite)
} catch {
  console.log('  (无法查询端口，跳过)')
}

if (listening.length) {
  console.log('  当前 127.0.0.1 监听端口: ' + listening.join(', '))
  const ranges = []
  for (let p = 0; p < listening.length; p++) {
    let end = p
    while (end + 1 < listening.length && listening[end + 1] === listening[end] + 1) end++
    if (end - p >= 2) ranges.push(`${listening[p]}-${listening[end]}`)
    p = end
  }
  info('连号端口段（这些是 DSH 主程序自己的，插件 shim 通常不在其中）:')
  for (const r of ranges) console.log('    ' + r)

  if (fs.existsSync(traceFile)) {
    const m = fs.readFileSync(traceFile, 'utf8').match(/[shim-up]\s*port=(\d+)/g)
    if (m) {
      const ports = m.map((s) => Number(s.match(/port=(\d+)/)[1]))
      const alive = ports.filter((p) => listening.includes(p))
      if (alive.length) ok(`轨迹里的 shim 端口仍在监听: ${alive.join(', ')}`)
      else {
        bad(`轨迹里的 shim 端口 ${ports.join(', ')} 已经不在监听（插件被卸载或进程重启过）`)
        info('如果刚重启过，这是正常的；发一条消息再看。')
      }
    }
  }
} else {
  console.log('  (未发现 127.0.0.1 监听端口)')
}

// ─── 4. 结论 ─────────────────────────────────────────────────────
section('结论')
if (problems === 0) {
  console.log('  配置层面全部正确。')
  console.log('  若模型选择器里仍搜不到 OpenCode Free，请：')
  console.log('    1) 确认改完后**重启过 DSH**')
  console.log('    2) 重启后在模型选择器里搜 "opencode"')
} else {
  console.log(`  发现 ${problems} 个问题，按上面的 ✗ 逐条修。`)
  console.log('  修完重跑本脚本确认，再重启 DSH。')
}
