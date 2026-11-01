/**
 * dsh-opencodeconnect-nokey —— DSH 宿主入口
 *
 * 职责三件：
 *   1. 找到本机 opencode-cli，建立一个**隔离 HOME**（不碰用户真实 OpenCode 数据）
 *   2. 起本地 OpenAI 兼容 shim（lib/shim.js），把推理转发给 CLI
 *   3. 用 `ctx.llm.registerAdapter([providerId], adapter)` 把 shim 注册成 DSH provider
 *
 * provider 的构造照抄 DSH 官方插件（dsh-xdpool）验证过的形态：
 * `createProvider({...}) + openAICompletionsApi()` + `PiAiAdapter`。
 * 关键点是 `createProvider` 会快照 models 数组，而宿主按 `profiles` map 的
 * **引用**缓存快照 —— 所以模型清单变了必须换一个新 provider + 新 profiles map，
 * 复用同一个对象改数组是无效的（见 makeProvider 注释）。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { locateCli, isolatedHome, discoverModels, mergeModelCatalog, FALLBACK_MODELS } from './cli-bridge.js'
import { createShim } from './shim.js'

/**
 * ## 为什么依赖是动态 import 而不是静态 import
 *
 * 静态 `import ... from '@earendil-works/pi-ai'` 在本插件里**一定会失败**，
 * 原因有两层：
 *
 * 1. 这三个宿主模块（pi-ai / dsh-llm / dsh-llm-pi-ai）活在 DSH 的 app.asar 里，
 *    不在 profile 的 node_modules 里。`~/.dsh/profiles/node_modules/@earendil-works/pi-ai`
 *    是一条指向已卸载的全局 npm 包的**死链**，`require.resolve` 会给
 *    `ERR_MODULE_NOT_FOUND`。
 * 2. 即使按 require 解析到 asar 内，pi-ai 的 `exports` 只声明了
 *    `./dist/*` 下的子路径，`require.resolve('@earendil-works/pi-ai')` 走 CJS
 *    条件会报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，而它的 `"import"` 条件
 *    指向 `./dist/index.js`，用 ESM 的 `import()` 才能成功。
 *
 * 所以这里按「宿主基准目录 + 显式 dist 路径」做 ESM 动态导入：
 * 基准目录从 `process.execPath` 同级的 `resources/app.asar/dsh` 推出来，
 * 和宿主自己 `fileURLToPath(new URL('../../node_modules/...', import.meta.url))`
 * 拿到的是同一棵树。
 */
function hostModuleRoot() {
  const candidates = []
  // Electron 主程序旁：<install>/resources/app.asar/dsh/node_modules
  try {
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  } catch { /* 非 Electron 环境 */ }
  // Electron 以 node 模式跑时 execPath 也是主程序；但如果是纯 node，则退到 profile 根
  const home = os.homedir()
  candidates.push(path.join(home, '.dsh', 'profiles', 'node_modules'))
  candidates.push(path.join(home, '.dsh', 'profiles', 'desktop', 'node_modules'))
  for (const c of candidates) {
    // asar 内路径在 Electron 里能 stat；纯 node 下 stat 会抛，只是跳过该候选
    try {
      if (fs.statSync(path.join(c, '@deepseek-ai', 'dsh-llm-pi-ai')).isDirectory() ||
          fs.statSync(path.join(c, '@earendil-works', 'pi-ai')).isDirectory()) {
        return c
      }
    } catch { /* 试下一个 */ }
  }
  return null
}

/**
 * 解析宿主模块的入口文件。
 *
 * 先走「基准目录 + 显式 dist 路径」（asar 内唯一可行路径），
 * 再退化到普通 Node 解析（用户自建 profile、宿主管线不同版本时）。
 */
function resolveHostEntry(specifier) {
  const root = hostModuleRoot()
  if (root) {
    const asarPath = path.join(root, specifier)
    try {
      if (fs.statSync(asarPath).isFile()) return pathToFileURL(asarPath).href
    } catch { /* 继续退化 */ }
  }
  const require = createRequire(import.meta.url)
  try {
    return pathToFileURL(require.resolve(specifier)).href
  } catch {
    return null
  }
}

/**
 * 宿主模块的具体入口清单。
 *
 * pi-ai 的 package.json exports 把 `./api/*` 映射到 `./dist/api/*.js`，
 * 但 CJS 条件解析不到裸 specifier，因此这里写死 dist 相对路径。
 */
const HOST_ENTRIES = {
  createProvider: '@earendil-works/pi-ai/dist/models.js',
  openAICompletionsApi: '@earendil-works/pi-ai/dist/api/openai-completions.lazy.js',
  PiAiAdapter: '@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  resolveRetryPolicy: '@deepseek-ai/dsh-llm/lib/index.js'
}

let HOST = null

/**
 * 懒加载宿主模块。返回 { createProvider, openAICompletionsApi, PiAiAdapter, resolveRetryPolicy }。
 *
 * 失败时抛出**带明确下一步**的错误 —— 这个失败点最容易发生在用户
 * 把插件装到了一个和宿主版本不匹配的 profile 上。
 */
async function loadHostModules() {
  if (HOST) return HOST
  const out = {}
  const missing = []

  for (const [key, spec] of Object.entries(HOST_ENTRIES)) {
    const url = resolveHostEntry(spec)
    if (!url) { missing.push(`${key}(${spec})`); continue }
    try {
      out[key] = (await import(url))[key]
    } catch (err) {
      missing.push(`${key}(${spec}): ${err?.code ?? err?.message}`)
      continue
    }
    if (typeof out[key] !== 'function') missing.push(`${key} 未导出`)
  }

  // pi-ai 1.1.0 把 createProvider 放在 dist/models.js，而不是 dist/index.js
  if (!out.createProvider) {
    const models = resolveHostEntry('@earendil-works/pi-ai/dist/models.js')
    if (models) {
      try {
        const mod = await import(models)
        if (typeof mod.createProvider === 'function') {
          out.createProvider = mod.createProvider
          const i = missing.indexOf('createProvider(@earendil-works/pi-ai/dist/dist-models.js)')
          if (i !== -1) missing.splice(i, 1)
        }
      } catch { /* 下面统一报错 */ }
    }
  }

  if (missing.length) {
    throw new Error(
      'dsh-opencodeconnect-nokey: 无法解析宿主 LLM 模块 —— ' + missing.join('; ') +
      '。请确认插件装在 DSH 正在使用的那个 profile 里，且 DSH 版本包含 @deepseek-ai/dsh-llm-pi-ai。'
    )
  }
  HOST = out
  return HOST
}

/** 稳定 Cordis 插件名，必须与 cordis.patch.yml 的 name 一致。 */
export const name = 'opencodeconnect-nokey'

/** 需要 llm 服务才能真正注册 provider。 */
export const inject = ['llm']

/** DSH 里这个 provider 的 id。改了会让用户已保存的模型选择失效。 */
const PROVIDER_ID = 'opencode-free'

/** 模型选择器里显示的分组名。 */
const DEFAULT_DISPLAY_NAME = 'OpenCode Free'

const STREAM_IDLE_TIMEOUT_MS = 3e5

/** 图片请求预算，取 dsh-llm-pi-ai 的默认值。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576
}

/** 惰性 pi-ai 鉴权面：鉴权只在 shim 请求头里做，不让 pi-ai 造凭据。 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return [] },
    async modify() { throw new Error('dsh-opencodeconnect-nokey: 此路由没有 pi-ai 凭据生命周期') },
    async delete() {}
  }
}

/**
 * 把目录里的一行模型信息转成 pi-ai 的模型描述。
 *
 * 字段依据宿主 `PiAiAdapter.listModels()` / `modelInfo()` 的实际读取：
 *   - `input` 是**必填**，宿主直接做 `[...model.input]`，缺了会 TypeError
 *   - `contextWindow` / `maxTokens` 是 token 预算，宿主读 `model.contextWindow`
 *   - `baseUrl` 指向本地 shim，`api` 决定走 openai-completions 协议
 */
function toPiModel(info, baseUrl, providerId) {
  const input = info.vision ? ['text', 'image'] : ['text']
  return {
    id: info.id,
    name: info.name,
    provider: providerId,
    api: 'openai-completions',
    baseUrl,
    contextWindow: info.context,
    maxTokens: info.maxOutput ?? 32000,
    input,
    inputModalities: input,
    supportsImages: info.vision === true,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
}

/**
 * 装配一个 provider（模型清单可变）。
 *
 * 每次 invalidate 都要重新调用，原因见文件头：宿主按 profiles map 引用缓存快照。
 */
function createOpenCodeFreeAdapter({ ctx, shim, catalog, displayName, host }) {
  const providerId = PROVIDER_ID
  const buildModels = () => mergeModelCatalog(catalog()).map((m) => toPiModel(m, `${shim.baseUrl()}`, providerId))

  const makeProvider = () => ({
    ...host.createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: 'OpenCode Free loopback secret',
          async resolve({ credential }) {
            const key = credential?.key
            if (key === undefined || key.length === 0) return undefined
            return { auth: { apiKey: key }, source: 'OpenCode Free' }
          }
        }
      },
      models: buildModels(),
      api: host.openAICompletionsApi()
    }),
    getModels: () => buildModels()
  })

  const makeProfile = (piProvider) => ({
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: host.resolveRetryPolicy(undefined, 'dsh-opencodeconnect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider
  })

  let profiles = new Map([[providerId, makeProfile(makeProvider())]])

  return {
    providerId,
    displayName,
    adapter: new host.PiAiAdapter({
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      resolveAttachments: () => ctx.get('attachments'),
      // 免费通道是多模态的（deepseek/glm/mimo 都收图），但 CLI 的 run 通道
      // 只传文本，所以图片一律不转，交给上游报"不支持"
      resolveImageAccess: () => undefined
    }),
    buildModels,
    invalidate() {
      profiles = new Map([[providerId, makeProfile(makeProvider())]])
    }
  }
}

/**
 * 宿主插件入口。
 *
 * config 来自 cordis.patch.yml；所有字段都有安全的缺省，
 * 用户不改配置也能直接跑起来。
 */
export function apply(ctx, config = {}) {
  const displayName = typeof config.displayName === 'string' && config.displayName
    ? config.displayName
    : DEFAULT_DISPLAY_NAME
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 300000

  const log = ctx.logger ?? console

  // ---- 1. 找 CLI ----
  const cliPath = locateCli(config.cliPath ?? '')
  if (!cliPath) {
    log.error?.(
      '[opencodeconnect] 没找到 opencode-cli。' +
      '请先安装 OpenCode 桌面版（https://opencode.ai），或在插件配置里填 cliPath。'
    )
    return
  }
  log.info?.(`[opencodeconnect] 使用 CLI: ${cliPath}`)

  // ---- 2. 隔离 HOME ----
  const dataRoot = ctx.get('dshHome')
    ? path.join(String(ctx.get('dshHome')), 'opencodeconnect')
    : path.join(os.homedir(), '.dsh', 'opencodeconnect')
  const home = isolatedHome(dataRoot)
  log.info?.(`[opencodeconnect] 隔离 HOME: ${home}`)

  // ---- 3. 模型目录（活引用）----
  let catalogRows = FALLBACK_MODELS.map((m) => ({ ...m }))
  const catalog = () => catalogRows

  /** 后台实采一次，成功后刷新 provider 快照。 */
  const refreshModels = async () => {
    const live = await discoverModels({ cliPath, home, timeoutMs: 90000 })
    if (!live) return
    const before = JSON.stringify(catalogRows.map((m) => m.id))
    catalogRows = mergeModelCatalog(live)
    const after = JSON.stringify(catalogRows.map((m) => m.id))
    if (before !== after) {
      log.info?.(`[opencodeconnect] 模型目录更新为 ${catalogRows.length} 个: ${catalogRows.map((m) => m.id).join(', ')}`)
      built?.invalidate()
    }
  }

  // ---- 4. 起 shim + 注册 provider ----
  let built = null
  let releaseAdapter = null

  ctx.effect(() => {
    const shim = createShim({ cliPath, home, log, timeoutMs, catalog })
    let disposed = false

    shim.start().then(async () => {
      if (disposed) return
      let host
      try {
        host = await loadHostModules()
      } catch (err) {
        log.error?.(String(err?.message ?? err))
        return
      }
      if (disposed) return
      try {
        built = createOpenCodeFreeAdapter({ ctx, shim, catalog, displayName, host })
        releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], built.adapter)
        log.info?.(`[opencodeconnect] provider "${PROVIDER_ID}" 已注册，shim=${shim.baseUrl()}`)
      } catch (err) {
        log.error?.('[opencodeconnect] provider 注册失败', err)
        return
      }
      // 实采模型清单（不阻塞启动）
      refreshModels().catch((err) => log.warn?.('[opencodeconnect] 模型实采失败，用静态清单', err))
    }, (err) => {
      log.error?.('[opencodeconnect] shim 启动失败', err)
    })

    return () => {
      disposed = true
      try { releaseAdapter?.() } catch { /* 释放顺序由宿主决定 */ }
      releaseAdapter = null
      built = null
      shim.dispose()
      log.info?.('[opencodeconnect] 已卸载')
    }
  })
}

export { PROVIDER_ID, DEFAULT_DISPLAY_NAME, FALLBACK_MODELS }
export default { name, inject, apply }
