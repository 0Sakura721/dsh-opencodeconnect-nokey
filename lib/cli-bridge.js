/**
 * dsh-opencodeconnect-nokey —— opencode-cli 桥接层
 *
 * ## 为什么必须驱动 CLI，而不是直接打 opencode.ai
 *
 * opencode.ai 的推理网关对 `Authorization: Bearer public` 的免费额度做了
 * **客户端指认**：同一个出口 IP、同一套请求头，用 curl / node / py / bun 直接
 * POST 拿到的永远是
 *
 *   429 {"type":"error","error":{"type":"FreeUsageLimitError", ...}}
 *
 * 而 `opencode-cli --standalone run ...` 在**同一秒、同一 IP** 能正常推理
 * （实测 91*47=4277、88*66=5808 均正确）。差别来自 CLI 内部的请求路径，
 * 不是 header 拼写问题 —— 我们把 CLI 的完整请求头复制过来直发，仍然 429。
 *
 * 因此本插件不去猜网关的判定规则，而是**复用官方 CLI 作为推理通道**：
 * 免费额度只在官方客户端内生效，我们就把请求交给官方客户端。
 *
 * ## 走哪个 CLI 子命令
 *
 * `run --format json` 会输出 NDJSON 事件流：
 *
 *   {"type":"step_start", ...}
 *   {"type":"text","part":{"text":"4277", ...}}
 *   {"type":"step_finish","part":{"reason":"stop","cost":0,
 *     "tokens":{"input":16,"output":2,"reasoning":0,"cache":{"read":5376,...}}}}
 *
 * 单次往返约 3–4 秒（含一次标题生成），成本字段是 0（免费）。
 * 注意 `text` 事件可能不止一条（多段文本），也兼容 `reasoning` 事件。
 *
 * ## 隔离性
 *
 * CLI 默认读写 `~/.local/share/opencode`。我们给它一个**独立 HOME**，
 * 这样它不会污染用户真实的 OpenCode 会话库，也不会和桌面版抢 `service.json`。
 * 独立 HOME 下 `run --standalone` 实测可直接工作（无需登录、无需 auth.json）。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** CLI 在一次 run 中可能输出的事件类型。 */
const EVENT_STEP_START = 'step_start'
const EVENT_TEXT = 'text'
const EVENT_REASONING = 'reasoning'
const EVENT_STEP_FINISH = 'step_finish'
const EVENT_ERROR = 'error'

/**
 * OpenCode 内置免费模型的静态清单。
 *
 * 来源是本机 opencode-cli v2.2.5 的 `/api/model` 实采（`providerID=opencode`，
 * `settings.baseURL=https://opencode.ai/inference/openai/v1`，`apiKey=public`）。
 * 全部 `cost.input=0`，即免费。
 *
 * `variants` 是**推理等级**，也就是 `--model opencode/<id>#<variant>` 里的 `#<variant>`。
 * 上游每个模型的可选档位不同（下面是实采结果），不是统一的一套：
 *
 *   没 variants（big-pickle / mimo / nemotron-lightning）→ 不支持调节
 *   low / high / max            （deepseek / glm）
 *   low / medium / high / xhigh （flint / beam）
 *   none / minimal / low / medium / high / xhigh / max（nemotron-super-vl）
 *
 * 上游随时可能增减模型，所以 `discoverModels()` 会优先用 CLI 实采覆盖这份清单；
 * 这份静态表的作用是**首启动可用**，不是权威目录。
 */
export const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', context: 200000, maxOutput: 32000, vision: true, variants: ['low', 'high', 'max'] },
  { id: 'big-pickle', name: 'Big Pickle', context: 200000, maxOutput: 32000, vision: false, variants: [] },
  { id: 'glm-5.3-flash-free', name: 'GLM-5.3-Flash Free', context: 200000, maxOutput: 32000, vision: true, variants: ['low', 'high', 'max'] },
  { id: 'flint-40b-free', name: 'Flint 40B Free', context: 262144, maxOutput: 32000, vision: false, variants: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', context: 1048576, maxOutput: 32000, vision: true, variants: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'beam-free', name: 'Beam Free', context: 1048576, maxOutput: 32000, vision: false, variants: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', context: 200000, maxOutput: 32000, vision: true, variants: [] },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', context: 262144, maxOutput: 32000, vision: false, variants: [] }
]

/**
 * 候选 CLI 路径（按优先级）。
 *
 * 桌面版会把 CLI 落在 `%APPDATA%\\ai.opencode.desktop\\cli\\<ver>-<arch>\\opencode-cli.exe`，
 * 版本号会变，所以目录要扫而不是写死。
 */
export function candidateCliPaths() {
  const home = homedir()
  const out = []
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const cliRoot = path.join(appData, 'ai.opencode.desktop', 'cli')
  if (existsSync(cliRoot)) {
    for (const name of readdirSync(cliRoot)) {
      const dir = path.join(cliRoot, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch { continue }
      for (const exe of ['opencode-cli.exe', 'opencode-cli']) {
        out.push(path.join(dir, exe))
      }
    }
  }
  out.push(
    path.join(home, '.opencode', 'bin', 'opencode-cli.exe'),
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, '.local', 'bin', 'opencode-cli'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode'
  )
  return out
}

/** 找第一个真实存在的 CLI。返回 null 表示本机没装 OpenCode。 */
export function locateCli(configured = '') {
  if (configured && existsSync(configured)) return configured
  for (const p of candidateCliPaths()) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 每次 run 都在这里落一个独立 HOME，避免污染真实 OpenCode 数据。
 * 结构：<root>/home/.local/share/opencode/…
 */
export function isolatedHome(root) {
  const dir = path.join(root, 'cli-home')
  mkdirSync(path.join(dir, '.local', 'share', 'opencode', 'log'), { recursive: true })
  mkdirSync(path.join(dir, '.config', 'opencode'), { recursive: true })
  mkdirSync(path.join(dir, '.cache'), { recursive: true })
  return dir
}

/** Windows 上必须带 USERPROFILE，POSIX 认 HOME。两个都设，免得各版本行为不一致。 */
function cliEnv(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    // 免费额度校验依赖官方 UA；这层由 CLI 自己加，我们不去覆盖
    NO_COLOR: '1',
    CI: '1'
  }
}

/**
 * 把一个 OpenAI 风格的 messages 数组压成 CLI 的单个 prompt。
 *
 * `opencode run` 的接口是「一条 message」，没有多轮结构，所以历史被压成
 * 带角色标记的文本。system 单独提到最前面，避免被当成用户发言。
 *
 * 这是**有损**的：真正的多轮 tool-calling 走不通。DSH 侧如果发来 tool 定义，
 * 我们只把文本部分转过去（见 shim.js 的说明）。
 */
export function flattenMessages(messages = []) {
  const systems = []
  const turns = []
  for (const m of messages) {
    const text = textOf(m.content)
    if (!text) continue
    switch (m.role) {
      case 'system':
      case 'developer':
        systems.push(text)
        break
      case 'assistant':
        turns.push(`Assistant: ${text}`)
        break
      case 'tool':
        turns.push(`Tool result (${m.tool_call_id ?? 'tool'}): ${text}`)
        break
      default:
        turns.push(`User: ${text}`)
    }
  }
  // 只有一轮用户输入时不要加角色前缀，CLI 的提示词更好用
  if (turns.length === 1 && turns[0].startsWith('User: ')) turns[0] = turns[0].slice(6)
  const head = systems.length ? systems.join('\n\n') + '\n\n' : ''
  return head + turns.join('\n\n')
}

/** content 既可以是字符串，也可以是 OpenAI 的 part 数组。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.type === 'text') return p.text ?? ''
        if (p?.type === 'image_url') return '[image omitted]'
        return ''
      })
      .join('')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/**
 * Windows 单条命令行参数的硬上限。
 *
 * 实测：40000 字符的 prompt 传 argv 直接失败（"Argument list too long" /
 * 在 DSH 里表现为 `spawn ENAMETOOLONG`）。CreateProcess 整条命令行上限是
 * 32767 字节，再减去 exe 路径、`--standalone run --format json --model ...`
 * 这些固定参数，留给 prompt 的余量很小。而 DSH 的 system prompt 动辄上万字。
 *
 * 所以 prompt 不走 argv，改走 **stdin** —— CLI 在没有 message 参数时会读标准输入
 * （实测：`echo "计算 91*47" | opencode-cli --standalone run --format json`
 * 正确返回 4277）。这样长度只受内存限制。
 */
const ARGV_PROMPT_LIMIT = 4000

export { ARGV_PROMPT_LIMIT }

/**
 * 跑一次 CLI 推理，返回 { text, usage, finishReason }。
 *
 * 用 spawn 而不是 execFile，因为 NDJSON 是逐行来的，我们边收边解析：
 * 一次 3 秒的调用里首段文本通常 1 秒多就到，没必要等进程退完。
 *
 * prompt 传递方式按长度二选一：
 *   - 短 prompt（≤ ARGV_PROMPT_LIMIT）走 argv，行为最接近官方用法
 *   - 长 prompt 走 stdin，绕开 Windows 命令行长度硬上限
 */
export function runCliOnce({ cliPath, home, model, variant, prompt, timeoutMs = 300000, signal }) {
  return new Promise((resolve, reject) => {
    const useStdin = prompt.length > ARGV_PROMPT_LIMIT
    /**
     * `--model` 支持 `provider/model#variant` 语法，variant 就是推理等级。
     *
     * 实测（deepseek-v4.1-flash-free，同一道需要推理的题）：
     *   默认   → reasoning_tokens = 0
     *   #low   → reasoning_tokens = 24
     *   #high  → reasoning_tokens = 26
     *   #max   → reasoning_tokens = 35
     * 而 `#off` 会被上游拒绝（"Variant unavailable"），因为该模型没有 off 档 ——
     * 所以 variant 必须来自模型自己的 variants 列表，不能硬塞。
     */
    const modelRef = variant ? `opencode/${model}#${variant}` : `opencode/${model}`
    const args = ['--standalone', 'run', '--format', 'json', '--model', modelRef]
    if (!useStdin) args.push(prompt)

    const child = spawn(cliPath, args, {
      env: cliEnv(home),
      cwd: home,
      windowsHide: true,
      // 长 prompt 必须把 stdin 打开来喂
      stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })

    // 我们把 prompt 写进 stdin 而不是留空：CLI 会把它当成用户 message。
    // 写完立刻 end()，否则 CLI 会一直等输入导致超时。
    if (useStdin) {
      child.stdin.on('error', () => { /* CLI 提前退出时写管道会报 EPIPE，忽略 */ })
      child.stdin.end(prompt, 'utf8')
    }

    const texts = []
    let usage = null
    let reason = null
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
      reject(Object.assign(new Error(`opencode-cli 超时（${timeoutMs}ms）`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        const raw = line.trim()
        if (!raw) continue
        let evt
        try { evt = JSON.parse(raw) } catch { continue } // 非 JSON 行（警告/进度）直接跳过
        switch (evt.type) {
          case EVENT_TEXT:
            if (typeof evt.part?.text === 'string') texts.push(evt.part.text)
            break
          case EVENT_STEP_FINISH:
            if (evt.part?.tokens) usage = evt.part.tokens
            if (typeof evt.part?.reason === 'string') reason = evt.part.reason
            break
          case EVENT_ERROR:
            stderr += (evt.error?.message ?? JSON.stringify(evt.error ?? evt)) + '\n'
            break
          default:
            break
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => { stderr += d })

    child.on('error', (err) => finish(reject, err))
    child.on('close', (code) => {
      const text = texts.join('').trim()
      // 429/额度用尽时 CLI 往往退出码 0 但只有错误文本，所以两种都要认
      if (code !== 0 && !text) {
        return finish(reject, Object.assign(new Error(describeCliFailure(stderr, code)), { code: 'ECLIFATAL', stderr }))
      }
      if (!text) {
        return finish(reject, Object.assign(new Error(describeCliFailure(stderr, code)), { code: 'EEMPTY', stderr }))
      }
      finish(resolve, { text, usage, finishReason: reason ?? 'stop', stderr })
    })

    if (signal) {
      if (signal.aborted) {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      } else {
        signal.addEventListener('abort', () => {
          try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        }, { once: true })
      }
    }
  })
}

/** 把 CLI 的失败信号翻译成能直接给用户看的一句话。 */
function describeCliFailure(stderr, code) {
  const s = stderr || ''
  if (/ENAMETOOLONG|Argument list too long/i.test(s)) {
    return 'prompt 太长，超出 Windows 命令行参数上限。本插件已改为走 stdin，若仍见此错误说明 stdin 通道也失败。'
  }
  if (/FreeUsageLimitError|Free usage limit/i.test(s)) {
    return 'OpenCode 免费额度已用尽（FreeUsageLimitError）。等待额度重置，或在 OpenCode 里订阅 Go 后重试。'
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(s)) {
    return 'opencode-cli 无法连到 opencode.ai（网络/代理问题）。'
  }
  if (/ModelNotFound|not found/i.test(s)) {
    return 'opencode-cli 不认识这个模型（可能已被上游下线）。'
  }
  const tail = s.trim().split('\n').filter(Boolean).slice(-3).join(' / ')
  return `opencode-cli 退出码 ${code}${tail ? `：${tail}` : '（无 stderr 输出）'}`
}

/**
 * 实采一次模型清单：`models` 子命令输出 `opencode/<model-id>` 每行一条。
 * 只保留 `opencode/` 前缀的（那是内置免费通道）。
 */
export function discoverModels({ cliPath, home, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    execFile(cliPath, ['--standalone', 'models'], { env: cliEnv(home), cwd: home, timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const ids = stdout.split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('opencode/'))
          .map((l) => l.slice('opencode/'.length))
          .filter(Boolean)
        resolve(ids.length ? ids : null)
      })
  })
}

/**
 * 把上游的 variants 规整成字符串数组。
 *
 * 上游 `/api/model` 给的是 `[{id:"low",settings:{reasoningEffort:"low"}}, ...]`，
 * 但设置页缓存、旧版本落盘数据可能直接给 `["low","high"]`。
 * 两种都认，认不出来就是"不支持调节"（空数组），不猜。
 */
export function normalizeVariants(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const v of raw) {
    const id = typeof v === 'string' ? v : v?.id
    if (typeof id === 'string' && id !== '') out.push(id)
  }
  return out
}

/**
 * 静态清单 + 实采结果合并：实采优先，静态表兜底补充元信息。
 *
 * 入参容忍三种形态，因为目录既可能来自 `discoverModels()` 的字符串数组，
 * 也可能来自设置页/缓存里的对象数组：
 *   - `["deepseek-v4.1-flash-free", ...]`
 *   - `[{ id, name?, context?, variants? }]`
 *   - null / 空数组 → 整份静态表
 */
export function mergeModelCatalog(liveIds) {
  if (!liveIds || !liveIds.length) return FALLBACK_MODELS.map((m) => ({ ...m }))
  const known = new Map(FALLBACK_MODELS.map((m) => [m.id, m]))
  const out = []
  for (const raw of liveIds) {
    const id = typeof raw === 'string' ? raw : raw?.id
    if (typeof id !== 'string' || id === '') continue
    const base = known.get(id)
    if (base) {
      // 静态表的 variants 是实采结果，实采若没给 variants 就保留静态表那份
      const merged = { ...base, ...(typeof raw !== 'string' ? raw : {}) }
      merged.variants = normalizeVariants(merged.variants)
      out.push(merged)
      continue
    }
    // 未知新模型：优先用上游给的名字，否则从 id 推一个可读名
    out.push({
      id,
      name: (typeof raw !== 'string' && typeof raw?.name === 'string' && raw.name) ||
        id.replace(/-free$/, '') + ' (Free)',
      context: (typeof raw !== 'string' && Number.isFinite(raw?.context)) ? raw.context : 200000,
      maxOutput: (typeof raw !== 'string' && Number.isFinite(raw?.maxOutput)) ? raw.maxOutput : 32000,
      vision: typeof raw !== 'string' && raw?.vision === true,
      variants: normalizeVariants(typeof raw !== 'string' ? raw?.variants : undefined)
    })
  }
  return out.length ? out : FALLBACK_MODELS.map((m) => ({ ...m }))
}
