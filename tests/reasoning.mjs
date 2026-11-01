/**
 * 推理等级（thinking effort）链路测试。
 *
 * 这条链有四段，每段都能单独坏掉，所以逐段验证：
 *
 *   1. 模型描述里带上 `reasoning: true` + `thinkingLevelMap`
 *      → 否则宿主 `reasoningInfo()` 不输出 `reasoning`，界面就没有选择器
 *   2. 宿主 `getSupportedThinkingLevels()` 列出的档位 = 模型自己的 variants
 *   3. shim 接受 `reasoning_effort` 并校验（不支持的档位返回 400 而不是甩给上游）
 *   4. CLI 真正把 variant 送到上游（用 reasoning_tokens 作为客观证据）
 *
 * 用法：
 *   ELECTRON_RUN_AS_NODE=1 <DSH.exe> tests/reasoning.mjs
 *   node tests/reasoning.mjs        # 只跑第 3、4 段（不依赖宿主）
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { locateCli, isolatedHome, runCliOnce } from '../lib/cli-bridge.js'
import { createShim } from '../lib/shim.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { console.error('  ✗ ' + m); failed++ }

const cliPath = locateCli('')
if (!cliPath) {
  console.error('没找到 opencode-cli')
  process.exit(1)
}
const home = isolatedHome(path.join(os.homedir(), '.opencodeconnect-reasoning-test'))

// ─── 第 4 段：CLI 侧 variant 真的改变了推理 token ──────────────────
console.log('═'.repeat(64))
console.log('4. CLI 层：variant 是否真的改变上游行为')
console.log('═'.repeat(64))

const PROMPT = '一个农夫有17只羊，除了9只以外全都死了，还剩几只？只回答数字'
const seen = {}
for (const variant of ['low', 'high', 'max']) {
  try {
    const r = await runCliOnce({
      cliPath, home, model: 'deepseek-v4.1-flash-free', variant, prompt: PROMPT, timeoutMs: 180000
    })
    seen[variant] = r.usage?.reasoning ?? 0
    console.log(`  variant=${variant.padEnd(5)} reasoning_tokens=${seen[variant]}  输出=${JSON.stringify(r.text.trim().slice(0, 20))}`)
  } catch (e) {
    bad(`variant=${variant} 失败: ${e.message}`)
  }
}
const vals = Object.values(seen)
if (vals.length === 3 && new Set(vals).size > 1) ok('不同 variant 产生了不同的 reasoning_tokens')
else bad(`各 variant 的 reasoning_tokens 没拉开差距: ${JSON.stringify(seen)}（可能上游忽略 variant）`)

// 不支持的档位必须被上游明确拒绝，这是 shim 校验存在的理由
console.log('')
console.log('  验证不支持的档位会被上游拒绝（deepseek 没有 off 档）：')
try {
  await runCliOnce({ cliPath, home, model: 'deepseek-v4.1-flash-free', variant: 'off', prompt: 'hi', timeoutMs: 90000 })
  bad('variant=off 居然成功了 —— 上游行为变了，shim 的白名单可能已过时')
} catch (e) {
  if (/Variant unavailable|no-route/i.test(e.message + (e.stderr ?? ''))) {
    ok('上游正确拒绝 off 档（说明 shim 必须按模型 variants 校验）')
  } else {
    bad('off 档失败但原因不是 Variant unavailable: ' + e.message)
  }
}

// ─── 第 3 段：shim 的 reasoning_effort 处理 ──────────────────────
console.log('')
console.log('═'.repeat(64))
console.log('3. shim 层：reasoning_effort 的接受与校验')
console.log('═'.repeat(64))

const CATALOG = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', context: 200000, maxOutput: 32000, vision: true, variants: ['low', 'high', 'max'] },
  { id: 'big-pickle', name: 'Big Pickle', context: 200000, maxOutput: 32000, vision: false, variants: [] }
]
const shim = createShim({
  cliPath,
  home,
  log: { warn: (m) => console.log('    [warn] ' + m), info: () => {}, error: console.error },
  timeoutMs: 180000,
  catalog: () => CATALOG
})
await shim.start()
const base = shim.baseUrl()
const token = shim.token()
const post = (body) => fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

// 3a. 支持档位：正常放行
let r = await post({
  model: 'opencode/deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: '计算 91*47，只回数字' }],
  reasoning_effort: 'high'
})
if (r.status === 200) {
  const j = await r.json()
  ok(`reasoning_effort=high 放行，输出=${JSON.stringify(j.choices[0].message.content)}`)
} else {
  bad(`reasoning_effort=high 被拒: ${r.status} ${(await r.text()).slice(0, 120)}`)
}

// 3b. 不支持的档位：必须 400，且提示可选值
r = await post({
  model: 'opencode/deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'hi' }],
  reasoning_effort: 'off'
})
if (r.status === 400) {
  const j = await r.json()
  const msg = j.error?.message ?? ''
  if (msg.includes('low') && msg.includes('high') && msg.includes('max')) {
    ok('不支持的档位返回 400，并列出可选值')
  } else {
    bad('返回了 400 但提示里没有可选档位: ' + msg)
  }
} else {
  bad(`variant=off 期望 400，实际 ${r.status}`)
}

// 3c. 模型本身不支持调节：静默忽略，不能让请求失败
r = await post({
  model: 'opencode/big-pickle',
  messages: [{ role: 'user', content: '计算 3*7，只回数字' }],
  reasoning_effort: 'max'
})
if (r.status === 200) {
  const j = await r.json()
  ok(`无 variants 的模型忽略 reasoning_effort 且不报错，输出=${JSON.stringify(j.choices[0].message.content)}`)
} else {
  bad(`无 variants 的模型被 reasoning_effort 弄挂了: ${r.status}`)
}

shim.dispose()

// ─── 第 1、2 段：宿主侧（需要 DSH 运行时）────────────────────────
console.log('')
console.log('═'.repeat(64))
console.log('1+2. 宿主层：reasoning 是否出现在模型描述里')
console.log('═'.repeat(64))

const isHost = !!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1'
if (!isHost) {
  console.log('  (跳过：不在宿主运行时里，第 1、2 段需要 DSH 的 asar 模块)')
} else {
  let registered = null
  let directory = null
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: console.error },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    get: (n) => (n === 'dshHome' ? path.join(os.homedir(), '.dsh') : undefined),
    llm: {
      registerAdapter: (ids, a) => { registered = { ids, adapter: a }; return () => {} },
      registerConfigurableProviders: (rows) => { directory = rows; return () => {} }
    }
  }
  const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
  mod.apply(ctx, { displayName: 'OpenCode Free', timeoutMs: 180000 })
  let waited = 0
  while (!registered && waited < 20000) { await new Promise((r) => setTimeout(r, 500)); waited += 500 }

  if (!registered) {
    bad('registerAdapter 未被调用')
  } else {
    const infos = []
    for (const id of ['deepseek-v4.1-flash-free', 'big-pickle']) {
      try {
        infos.push(await registered.adapter.resolveModel('opencode-free', id))
      } catch (e) {
        bad(`resolveModel(${id}) 失败: ${e.message}`)
      }
    }
    const ds = infos.find((i) => i?.id === 'deepseek-v4.1-flash-free')
    const bp = infos.find((i) => i?.id === 'big-pickle')

    if (ds?.reasoning) {
      const ids = ds.reasoning.efforts.map((e) => e.id)
      if (ids.includes('low') && ids.includes('high') && ids.includes('max')) {
        ok(`deepseek 的界面档位 = ${ids.join(' / ')}`)
      } else {
        bad('deepseek 档位不对: ' + JSON.stringify(ids))
      }
    } else {
      bad('deepseek 没有 reasoning 字段 —— 界面不会出现推理等级选择器')
    }

    if (bp && !bp.reasoning) ok('big-pickle 没有 reasoning 字段（本来就没有档位，正确）')
    else if (bp) bad('big-pickle 不该有 reasoning: ' + JSON.stringify(bp.reasoning))
  }
  for (const d of disposers) { try { d() } catch { /* 已卸载 */ } }
}

console.log('')
console.log('═'.repeat(64))
if (failed) {
  console.error(`FAIL: ${failed} 项失败`)
  process.exit(1)
}
console.log('PASS: 推理等级链路四段全部正常')
