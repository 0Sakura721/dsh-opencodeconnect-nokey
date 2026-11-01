/**
 * 安装脚本：把插件装进 DSH profile，并挂上 patch 层。
 *
 * 为什么需要脚本而不是 `dsh plugin add`：
 *   本机 profile 的 pnpm-lock.yaml 与 registry 的 integrity 对不上
 *   （pnpm 会拒绝写锁文件："The downloaded tarball does not match the integrity
 *   recorded in the lockfile"），`pnpm add` 直接失败。
 *   而插件本身是**零运行时依赖**的（pi-ai / dsh-llm / dsh-llm-pi-ai
 *   全部从宿主 asar 动态导入），所以复制 + 手动写 patch 是完全可行的，
 *   不需要也不应该动用户的 lockfile。
 *
 * 用法：
 *   node install.mjs                 # 默认装到 ~/.dsh/profiles/desktop
 *   node install.mjs --profile web   # 装到别的 profile
 *   node install.mjs --dry-run
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-opencodeconnect-nokey'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const profileArg = (() => {
  const i = args.indexOf('--profile')
  return i !== -1 ? args[i + 1] : 'desktop'
})()

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileArg)
const targetDir = path.join(profileDir, 'node_modules', PKG_NAME)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const profilePkgPath = path.join(profileDir, 'package.json')

function exists(p) {
  try { return fs.statSync(p).isDirectory() || fs.statSync(p).isFile() } catch { return false }
}

function fail(msg) {
  console.error('安装失败：' + msg)
  process.exit(1)
}

if (!exists(profileDir)) {
  fail(`profile 目录不存在：${profileDir}\n请确认 DSH 已用这个 profile 启动过至少一次。`)
}

console.log(`profile    = ${profileDir}`)
console.log(`安装目标   = ${targetDir}`)
console.log(`patch 文件 = ${patchPath}`)
if (dryRun) console.log('[dry-run] 只打印计划，不写盘')

// ---- 1. 复制包文件 ----
const files = ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE']
for (const f of files) {
  const src = path.join(here, f)
  if (!exists(src)) continue
  const dst = path.join(targetDir, f)
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  console.log(`  copy ${f}`)
}

for (const entry of fs.readdirSync(path.join(here, 'lib'))) {
  const src = path.join(here, 'lib', entry)
  if (!fs.statSync(src).isFile()) continue
  const dst = path.join(targetDir, 'lib', entry)
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
  console.log(`  copy lib/${entry}`)
}

// ---- 2. 写 patch 层 ----
let patch = exists(patchPath) ? fs.readFileSync(patchPath, 'utf8') : ''

if (patch.includes('id: opencodeconnect-nokey')) {
  console.log('  patch 行已存在，跳过')
} else {
  /**
   * 空数组 `[]` 是 DSH 新 profile 的默认 patch。
   *
   * 必须把它**替换掉**而不是在后面追加 —— YAML 里 `[]` 已经是一个完整的
   * 流式（flow）空序列，后面再跟 `- insert:` 会得到
   * "end of the stream or a document separator is expected"，
   * 整个 profile 都起不来。这是实测踩到的坑，不是理论风险。
   */
  const stripped = patch.replace(/^\s*\[\s*\]\s*$/m, '').trimEnd()
  const addition = [
    `# ${PKG_NAME} —— 把 OpenCode 内置免费模型接入 DSH（无需 API Key）`,
    '- insert:',
    '    - id: opencodeconnect-nokey',
    `      name: ${PKG_NAME}`,
    '      inject: [llm]',
    '      config:',
    '        enabled: true',
    '        displayName: OpenCode Free',
    '        cliPath: ""',
    '        timeoutMs: 300000'
  ].join('\n')

  const body = stripped === '' ? addition + '\n' : stripped + '\n\n' + addition + '\n'
  if (!dryRun) {
    // 备份一次原文件，改坏了能一眼看出来
    if (exists(patchPath) && !exists(patchPath + '.bak')) {
      fs.copyFileSync(patchPath, patchPath + '.bak')
    }
    fs.writeFileSync(patchPath, body, 'utf8')
  }
  console.log('  patch 行已追加' + (stripped === '' ? '（原文件为空/空数组，已重置为数组根）' : ''))
}

// ---- 3. 确保 package.json 的 bundles 里有它 ----
if (exists(profilePkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && !bundles.includes(PKG_NAME)) {
      bundles.push(PKG_NAME)
      if (!dryRun) fs.writeFileSync(profilePkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
      console.log('  bundles 已追加')
    } else {
      console.log('  bundles 无需改动')
    }
  } catch (err) {
    console.warn('  读取 profile package.json 失败，跳过 bundles 改动：' + err.message)
  }
}

console.log('')
console.log('完成。重启 DSH（DeepSeek Harness）后，')
console.log('模型选择器里会出现 provider「OpenCode Free」，含 8 个内置免费模型。')
console.log('')
console.log('验证：重启后在 DSH 里选 opencode-free/deepseek-v4.1-flash-free 发一句话即可。')
console.log('排查：DSH 日志里搜 "opencodeconnect" ——')
console.log('  正常应看到 "使用 CLI: ..." 与 "provider \\"opencode-free\\" 已注册"')
