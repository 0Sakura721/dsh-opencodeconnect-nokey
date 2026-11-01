/**
 * dsh-opencodeconnect-nokey —— 本地 OpenAI 兼容 shim
 *
 * DSH 的 `PiAiAdapter` 只认 OpenAI Chat Completions 的线格式，而推理实际由
 * `opencode-cli` 执行。这一层就是把两者对接起来的翻译机：
 *
 *   DSH ──POST /v1/chat/completions──▶ 本模块 ──spawn──▶ opencode-cli run --format json
 *        ◀──SSE / JSON──────────────       ◀──NDJSON──
 *
 * ## 设计取舍：不做真流式 token 级输出
 *
 * CLI 的 `--format json` 是**事件级**流（step_start → text → step_finish），
 * 不是 token 级。一次典型调用约 3–4 秒，文本通常整体到达。
 * 所以这里采取「等 CLI 出文本，再按句切块下发 SSE」：
 *
 *   - 对 DSH 的 UI 来说，看到的是标准的 `chat.completion.chunk` 序列，
 *     首字节延迟 ≈ CLI 完成时间，之后按标点快速吐完；
 *   - 相比假装 token 级流（把一段文本按字符硬切、中间塞 `delay`），
 *     这种切法不撒谎：每个 chunk 都对应真实已生成的文本。
 *
 * ## 安全
 *
 * 端口只绑 127.0.0.1；访问需要 `Authorization: Bearer <token>`，
 * token 每次进程启动随机生成，只交给同进程内的 adapter。
 * 不做 origin 校验是因为调用方是 DSH 主进程（Node 侧），不是浏览器。
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { runCliOnce, mergeModelCatalog } from './cli-bridge.js'
import { renderToolsPrompt, parseToolCalls, toOpenAiToolCalls } from './tool-calling.js'

/** 按标点切块：中文句号/问号/叹号/分号 + 英文句点 + 换行。 */
const SENTENCE_BREAK = /([。！？；\n]|(?<=[.!?])\s+)/

/**
 * 把一段完整文本切成若干「自然块」。
 *
 * 不按固定长度切，是因为固定长度会把单词/符号拦腰斩断，
 * 前端 markdown 渲染会看到半个 `**` 或半个代码围栏。
 */
export function* textChunks(text, maxLen = 80) {
  let buf = ''
  const parts = text.split(SENTENCE_BREAK)
  for (const part of parts) {
    buf += part
    if (buf.length >= 12) {
      yield buf
      buf = ''
    }
  }
  if (buf) yield buf
}

/** 极简 SSE 写入器：每块一个 chunk，最后补 finish_reason + [DONE]。 */
function writeSseChunk(res, { id, created, model, index, delta, finishReason = null }) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index, delta, finish_reason: finishReason }]
  }
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 把 CLI 的 token 统计翻译成 OpenAI 的 usage 字段。 */
export function toOpenAiUsage(tokens) {
  if (!tokens) return undefined
  const prompt = Number(tokens.input ?? 0)
  const completion = Number(tokens.output ?? 0)
  const cached = Number(tokens.cache?.read ?? 0)
   return {
     prompt_tokens: prompt,
     completion_tokens: completion,
     total_tokens: prompt + completion,
     prompt_tokens_details: { cached_tokens: cached }
   }
}

/**
 * 创建一个 shim 实例。
 *
 * 返回的 `start()` 拿到端口后就不再变；`token()` 供 adapter 取鉴权串。
 * `catalog` 是活引用 —— 设置页改了模型开关，这里立刻看到。
 */
export function createShim({ cliPath, home, log, timeoutMs = 300000, catalog }) {
  const token = randomBytes(32).toString('base64url')
  let server = null
  let port = 0

  const modelsSnapshot = () => {
    const rows = typeof catalog === 'function' ? catalog() : catalog
    return mergeModelCatalog(rows)
  }

  /** GET /v1/models —— DSH 用它校验端点连通性。 */
  const handleModels = (res) => {
    const body = {
      object: 'list',
      data: modelsSnapshot().map((m) => ({
        id: `opencode/${m.id}`,
        object: 'model',
        created: 0,
        owned_by: 'opencode'
      }))
    }
    const raw = JSON.stringify(body)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) })
    res.end(raw)
  }

  /** 核心：POST /v1/chat/completions */
  const handleChat = async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let payload
    try {
      payload = JSON.parse(raw || '{}')
    } catch {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'body 不是合法 JSON' } })
    }

    const requested = String(payload.model ?? '')
    const modelId = requested.includes('/') ? requested.split('/').pop() : requested
    if (!modelId) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: '缺少 model 字段' } })
    }

    const stream = payload.stream === true
    const id = `chatcmpl-${randomBytes(12).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)

    /**
     * 工具调用：把 DSH 的 tools 定义译成提示词，稍后把模型输出解析回
     * OpenAI 的 `tool_calls` 结构，交给 DSH 自己执行。
     *
     * 为什么不交给 opencode 执行：它内置 agent loop，会自己跑工具并回灌结果，
     * 那样 DSH 就失去了权限控制，而且工具名/语义都对不上（DSH 的 `ops_bash`
     * ≠ opencode 的 `bash`）。所以 cli-bridge 会在隔离 HOME 里写一份
     * 「全部工具 deny」的配置，让模型只能"说出意图"。
     *
     * `tools` 为空时 toolsPrompt 是空串，prompt 不变，退化成普通对话。
     */
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
    const toolsPrompt = hasTools ? renderToolsPrompt(payload.tools) : ''

    const prompt = payloadPrompt(payload, toolsPrompt)
    if (!prompt) {
      return sendJson(res, 400, { error: { type: 'invalid_request_error', message: 'messages 为空或没有文本内容' } })
    }

    /**
     * 读取推理等级。
     *
     * pi-ai 的 `openai-completions` 在 `model.reasoning && compat.supportsReasoningEffort`
     * 成立时，会把用户选的档位写进请求体的 `reasoning_effort`
     * （见 pi-ai dist/api/openai-completions.js 第 712-714 行）。
     * 我们把它映射成 CLI 的 `--model opencode/<id>#<variant>`。
     *
     * 校验：只接受该模型**自己声明过**的档位。上游对不存在的档位会直接
     * 报 "Variant unavailable"（实测给 deepseek 传 `#off` 就是这样），
     * 与其把错误甩给用户，不如在这里明确告诉他是哪一档不支持。
     */
    const requestedEffort = typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : undefined
    let variant = requestedEffort
    if (requestedEffort) {
      const rows = modelsSnapshot()
      const row = rows.find((m) => m.id === modelId)
      const allowed = Array.isArray(row?.variants) ? row.variants : []
      if (allowed.length === 0) {
        // 模型不支持调节：静默忽略，不要因此让请求失败
        log?.warn?.(`[opencodeconnect] 模型 ${modelId} 不支持推理等级，忽略 reasoning_effort=${requestedEffort}`)
        variant = undefined
      } else if (!allowed.includes(requestedEffort)) {
        return sendJson(res, 400, {
          error: {
            type: 'invalid_request_error',
            message: `模型 ${modelId} 不支持推理等级 "${requestedEffort}"，可选：${allowed.join(' / ')}`,
            code: 'UNSUPPORTED_REASONING_EFFORT'
          }
        })
      }
    }

    let result
    try {
      result = await runCliOnce({ cliPath, home, model: modelId, variant, prompt, timeoutMs })
    } catch (err) {
      const status = err?.code === 'ETIMEDOUT' ? 504 : 502
      return sendJson(res, status, {
        error: {
          type: 'upstream_error',
          message: err?.message ?? String(err),
          code: err?.code ?? 'EUPSTREAM'
        }
      })
    }

    const usage = toOpenAiUsage(result.usage)

    /**
     * 把模型输出解析成工具调用（只在客户端提供了 tools 时才做）。
     *
     * 解析是宽容的：模型若直接给了正常回答（没打算调工具），calls 为空，
     * 就按纯文本返回 —— 不能因为"客户端传了 tools"就把普通回答也当成错误。
     */
    const parsed = hasTools ? parseToolCalls(result.text) : { calls: [], leftoverText: result.text }
    const toolCalls = parsed.calls.length ? toOpenAiToolCalls(parsed.calls) : null
    // 调工具时正文通常是空的（协议要求"只输出调用块"），残留文字作为 content 保留
    const textOut = parsed.calls.length ? (parsed.leftoverText || null) : result.text
    const finishReason = toolCalls ? 'tool_calls' : mapFinish(result.finishReason)

    if (!stream) {
      const body = {
        id,
        object: 'chat.completion',
        created,
        model: requested,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: textOut,
              ...(toolCalls ? { tool_calls: toolCalls } : {})
            },
            finish_reason: finishReason
          }
        ],
        ...(usage ? { usage } : {})
      }
      const rawOut = JSON.stringify(body)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawOut) })
      return res.end(rawOut)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    writeSseChunk(res, { id, created, model: requested, index: 0, delta: { role: 'assistant' } })

    if (toolCalls) {
      /**
       * 流式下的 tool_calls 分两段下发，这是 OpenAI 协议的规定形状：
       *   1. 先发 `delta.tool_calls[i].{index,id,type,function.name}`（只有名字）
       *   2. 再发 `delta.tool_calls[i].function.arguments`（完整 JSON 字符串）
       *
       * 中间省略掉这两步不是"能跑就行"的问题 —— DSH 侧按 index 累积，
       * 缺 id 会把结果回填到错误的调用上。
       */
      toolCalls.forEach((call, i) => {
        writeSseChunk(res, {
          id, created, model: requested, index: 0,
          delta: {
            tool_calls: [{
              index: i,
              id: call.id,
              type: call.type,
              function: { name: call.function.name, arguments: '' }
            }]
          }
        })
      })
      toolCalls.forEach((call, i) => {
        writeSseChunk(res, {
          id, created, model: requested, index: 0,
          delta: { tool_calls: [{ index: i, function: { arguments: call.function.arguments } }] }
        })
      })
      // 调工具时也可能带一句过渡性正文（模型没完全守协议的情况下才有）
      if (textOut) {
        for (const piece of textChunks(textOut)) {
          writeSseChunk(res, { id, created, model: requested, index: 0, delta: { content: piece } })
        }
      }
    } else {
      for (const piece of textChunks(result.text)) {
        writeSseChunk(res, { id, created, model: requested, index: 0, delta: { content: piece } })
      }
    }

    writeSseChunk(res, {
      id,
      created,
      model: requested,
      index: 0,
      delta: {},
      finishReason
    })
    if (usage) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requested, choices: [], usage })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const handler = async (req, res) => {
    // 只允许本进程内的 adapter 调；token 每次启动随机
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      return sendJson(res, 401, { error: { type: 'authentication_error', message: 'bad shim token' } })
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return handleModels(res)
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      return handleChat(req, res)
    }
    return sendJson(res, 404, { error: { type: 'not_found', message: `${req.method} ${url.pathname} 未实现` } })
  }

  return {
    /** 幂等启动：已启动返回既有端口。 */
    start() {
      if (server) return Promise.resolve(port)
      return new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          handler(req, res).catch((err) => {
            log?.error?.('[opencodeconnect] shim handler 异常', err)
            try { sendJson(res, 500, { error: { type: 'internal_error', message: String(err?.message ?? err) } }) } catch { /* 响应可能已发出 */ }
          })
        })
        server.on('error', reject)
        // 0 = 让 OS 分配；只绑回环
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port
          log?.info?.(`[opencodeconnect] shim 监听 127.0.0.1:${port}`)
          resolve(port)
        })
      })
    },
    token: () => token,
    port: () => port,
    baseUrl: () => `http://127.0.0.1:${port}/v1`,
    dispose() {
      if (!server) return
      const s = server
      server = null
      port = 0
      try { s.close() } catch { /* 已关闭 */ }
    }
  }
}

/** OpenAI 的 finish_reason 只有 stop/length/tool_calls/content_filter。 */
function mapFinish(reason) {
  switch (reason) {
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'tool-calls':
    case 'tool_calls':
      return 'tool_calls'
    case 'content-filter':
      return 'content_filter'
    default:
      return 'stop'
  }
}

function sendJson(res, status, obj) {
  const raw = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) })
  res.end(raw)
}

/**
 * 从 OpenAI 请求体取出要发给 CLI 的 prompt。
 *
 * @param payload OpenAI Chat Completions 请求体
 * @param toolsPrompt renderToolsPrompt 的产物（无工具时是空串）
 */
function payloadPrompt(payload, toolsPrompt = '') {
  // 少数客户端用 prompt 而非 messages（completions 老风格）
  if (typeof payload.prompt === 'string' && payload.prompt.trim()) {
    return (toolsPrompt ? toolsPrompt + '\n' : '') + payload.prompt
  }
  if (!Array.isArray(payload.messages)) return ''

  const systems = []
  const turns = []
  for (const m of payload.messages) {
    /**
     * assistant 的 tool_calls 与 tool 角色的结果要原样呈现给模型，
     * 否则多轮工具对话里模型看不到"上一轮我要求了什么、结果是什么"，
     * 会反复提同一个调用。
     */
    if (m.role === 'assistant') {
      const callText = Array.isArray(m.tool_calls)
        ? m.tool_calls.map((c) => `${c?.function?.name ?? 'tool'}(${c?.function?.arguments ?? '{}'})`).join(', ')
        : ''
      const body = contentText(m.content)
      if (callText) turns.push(`Assistant (called): ${callText}`)
      else if (body) turns.push(`Assistant: ${body}`)
      continue
    }
    if (m.role === 'tool') {
      const label = m.tool_call_id ? `Tool result (${m.tool_call_id})` : 'Tool result'
      const text = contentText(m.content)
      if (text) turns.push(`${label}: ${text}`)
      continue
    }
    const text = contentText(m.content)
    if (!text) continue
    if (m.role === 'system' || m.role === 'developer') systems.push(text)
    else turns.push(`User: ${text}`)
  }
  if (turns.length === 1 && turns[0].startsWith('User: ')) turns[0] = turns[0].slice(6)

  // 工具说明放在 system 之后、正文之前：模型对"靠前的规则"依从性更好
  const head = [
    systems.length ? systems.join('\n\n') : '',
    toolsPrompt
  ].filter(Boolean).join('\n\n')
  return (head ? head + '\n\n' : '') + turns.join('\n\n')
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text ?? '' : '')).join('')
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}
