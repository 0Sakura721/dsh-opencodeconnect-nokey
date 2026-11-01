/**
 * install.mjs 的回归测试：覆盖三种真实 profile 状态。
 *
 * 这三种输入在实测里都出现过，其中 `[]` 空数组是先踩到的坑：
 * 直接在 `[]` 后面追加 `- insert:` 会得到非法 YAML
 * （"end of the stream or a document separator is expected"），
 * 导致整个 profile 起不来。所以这里逐一把关。
 *
 * 用 DSH 自带的 js-yaml 校验产物（和宿主加载器同一个库）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const installScript = path.join(here, '..', 'install.mjs')

const hostRoot = path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules')
const yaml = await import(pathToFileURL(path.join(hostRoot, 'js-yaml', 'index.js')).href)

/** 造一个最小 profile 目录。 */
function makeProfile(root, patchContent, bundles) {
  const dir = path.join(root, '.dsh', 'profiles', 'desktop')
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles, patchReload: 'live' } }
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchContent)
  return dir
}

function run(profileRoot) {
  return execFileSync(process.execPath, [installScript], {
    env: { ...process.env, DSH_HOME: path.join(profileRoot, '.dsh') },
    encoding: 'utf8'
  })
}

const CASES = [
  {
    name: '空文件（0 字节）',
    patch: '',
    bundles: []
  },
  {
    name: '[] 空数组（DSH 新 profile 默认，最容易踩坑）',
    patch: '[]\n',
    bundles: []
  },
  {
    name: '只有注释和 []',
    patch: '# comment only\n[]\n',
    bundles: []
  },
  {
    name: '已有真实 patch 行（不能破坏原内容）',
    patch: [
      '# existing patch',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    presets: {}',
      ''
    ].join('\n'),
    bundles: ['@deepseek-ai/dsh-base']
  }
]

let failed = 0
for (const c of CASES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-test-'))
  const dir = makeProfile(root, c.patch, c.bundles)

  console.log('='.repeat(60))
  console.log('CASE:', c.name)

  try {
    run(root)
  } catch (err) {
    console.error('  install.mjs 抛错:', err.message.split('\n')[0])
    failed++
    continue
  }

  const patchOut = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')

  // 1. 必须是合法 YAML 且根是数组
  let parsed
  try {
    parsed = yaml.load(patchOut)
  } catch (err) {
    console.error('  ✗ YAML 非法:', err.message.split('\n')[0])
    failed++
    continue
  }
  if (!Array.isArray(parsed)) {
    console.error('  ✗ 根不是数组，实际:', typeof parsed)
    failed++
    continue
  }
  console.log('  ✓ YAML 合法，条目数 =', parsed.length)

  // 2. 插件行必须存在
  const hasPlugin = parsed.some((e) =>
    Array.isArray(e?.insert) && e.insert.some((r) => r?.id === 'opencodeconnect-nokey')
  )
  if (!hasPlugin) {
    console.error('  ✗ 找不到 opencodeconnect-nokey 挂载行')
    failed++
    continue
  }
  console.log('  ✓ 挂载行存在')

  // 3. 原有条目不能被吃掉
  const existingKept = parsed.filter((e) =>
    Array.isArray(e?.insert) && e.insert.some((r) => r?.id !== 'opencodeconnect-nokey')
  ).length
  if (c.name.includes('已有真实')) {
    const originalRow = parsed.some((e) => e?.id === 'permission')
    if (!originalRow) {
      console.error('  ✗ 原有的 permission 行被破坏了')
      failed++
      continue
    }
    console.log('  ✓ 原有 permission 行保留')
  }

  // 4. bundles 必须包含插件
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (!pkg.dsh.profile.bundles.includes('dsh-opencodeconnect-nokey')) {
    console.error('  ✗ bundles 未追加')
    failed++
    continue
  }
  console.log('  ✓ bundles 已追加')

  // 5. 插件文件真的复制到位
  const libDir = path.join(dir, 'node_modules', 'dsh-opencodeconnect-nokey', 'lib')
  if (!fs.existsSync(path.join(libDir, 'index.js'))) {
    console.error('  ✗ lib/index.js 未复制')
    failed++
    continue
  }
  console.log('  ✓ 插件文件已复制')

  // 6. 二次安装要幂等
  try {
    run(root)
  } catch (err) {
    console.error('  ✗ 二次安装失败:', err.message.split('\n')[0])
    failed++
    continue
  }
  const after = yaml.load(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'))
  const count = after.filter((e) =>
    Array.isArray(e?.insert) && e.insert.some((r) => r?.id === 'opencodeconnect-nokey')
  ).length
  if (count !== 1) {
    console.error('  ✗ 二次安装产生了重复挂载行，count =', count)
    failed++
    continue
  }
  console.log('  ✓ 二次安装幂等')

  fs.rmSync(root, { recursive: true, force: true })
}

console.log('='.repeat(60))
if (failed) {
  console.error(`FAIL: ${failed} 个用例失败`)
  process.exit(1)
}
console.log('PASS: 全部用例通过')
