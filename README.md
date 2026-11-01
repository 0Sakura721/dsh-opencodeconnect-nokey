# dsh-opencodeconnect-nokey

把 **OpenCode 内置的免费模型**接进 DSH，**不需要任何 API Key**。

装完之后，DSH 的模型选择器里多出一个 provider `OpenCode Free`，里面有 8 个模型：

| 模型 ID | 名称 | 上下文 | 图像输入 |
|---|---|---|---|
| `deepseek-v4.1-flash-free` | DeepSeek V4.1 Flash Free | 200K | ✅ |
| `big-pickle` | Big Pickle | 200K | — |
| `glm-5.3-flash-free` | GLM-5.3-Flash Free | 200K | ✅ |
| `flint-40b-free` | Flint 40B Free | 256K | — |
| `nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL Free | 1M | ✅ |
| `beam-free` | Beam Free | 1M | — |
| `mimo-v2.6-flash-free` | MiMo-V2.6-Flash Free | 200K | ✅ |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 256K | — |

全部 `cost.input = 0`，即免费。

---

## 它到底怎么工作的

这是本仓库最重要的一节 —— 因为它**没有**走你想的那条路。

### 直接打 opencode.ai 是不行的

OpenCode 的推理网关地址是公开的：

```
POST https://opencode.ai/inference/openai/v1/chat/completions
Authorization: Bearer public
{"model":"deepseek-v4.1-flash-free", ...}
```

看起来 `apiKey` 就是字面量 `public`，任何人都能调。**实际不行为什么？**

因为网关对免费额度做了**客户端指认**。实测（同一台机器、同一出口 IP、同一秒）：

| 客户端 | 请求 | 结果 |
|---|---|---|
| `curl` | 完整复刻 CLI 的请求头 | `429 FreeUsageLimitError` |
| Node `https.request` | 同上 | `429` |
| Node `fetch`（bun 运行时） | 同上 | `429` |
| Python `ssl` 裸 TLS | 同上 | `429` |
| `node:http2` 真实 HTTP/2 | 同上 | 协议错误 / `429` |
| **`opencode-cli --standalone run`** | 它自己的请求 | **`200`，推理正确** |

我甚至用反向代理把 CLI 的**完整请求头原样转发**出去 —— 还是 429。
也就是说：差异不在 header 拼写、不在 HTTP 版本、不在 User-Agent，
而在 **CLI 进程内部的请求路径**（它有自己的签名/票据链路）。

所以本插件**不去猜网关的判定规则**，而是直接**复用官方 CLI 作为推理通道**：
免费额度只在官方客户端内生效，那就把请求交给官方客户端。

### 数据流

```
DSH 主进程
   │  ctx.llm.registerAdapter(['opencode-free'], adapter)
   ▼
PiAiAdapter（宿主自带）
   │  POST http://127.0.0.1:PORT/v1/chat/completions   （Bearer 随机 token）
   ▼
lib/shim.js   ← 本地 OpenAI 兼容 shim（只绑回环）
   │  spawn
   ▼
opencode-cli --standalone run --format json --model opencode/<id> "<prompt>"
   │  NDJSON 事件流
   ▼
{"type":"text","part":{"text":"4277"}}
{"type":"step_finish","part":{"tokens":{"input":16,"output":2,...}}}
```

一次典型往返 **3–5 秒**，`cost` 字段为 0。

### 为什么依赖是动态 import

`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-llm-pi-ai`
三个宿主模块**活在 DSH 的 app.asar 里**，不在 profile 的 `node_modules` 里。
而且：

- `~/.dsh/profiles/node_modules/@earendil-works/pi-ai` 是一条**死链**
  （指向已卸载的全局 npm 包），`require.resolve` 给 `ERR_MODULE_NOT_FOUND`；
- 即使解析到 asar 内，pi-ai 的 `exports` 只声明 `./dist/*` 子路径，
  CJS 条件解析裸 specifier 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

所以 `lib/index.js` 按「宿主基准目录 + 显式 dist 路径」做 ESM 动态导入：

```js
// <install>/resources/app.asar/dsh/node_modules/@earendil-works/pi-ai/dist/models.js
// <install>/resources/app.asar/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js
// <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js
// <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js
```

因此 **本插件零运行时依赖**，不需要装任何 npm 包，也不会碰你的 lockfile。

---

## 安装

### 前置（两件事，缺一不可）

1. **装好 OpenCode 桌面版** —— 推理由它的 CLI 发起。
   下载：https://opencode.ai

   装完后确认 CLI 存在：

   ```bash
   # Windows
   dir "%APPDATA%\ai.opencode.desktop\cli"
   # Linux / macOS
   ls ~/.local/bin/opencode
   ```

   > 插件会自动扫 `%APPDATA%\ai.opencode.desktop\cli\<版本>-<架构>\opencode-cli.exe`，
   > 版本号变了也不用改配置。

2. **DSH 用目标 profile 启动过至少一次**，让 `~/.dsh/profiles/desktop` 目录存在。

不需要 API Key，不需要登录 OpenCode 账号。

### 安装（三条命令）

```bash
git clone https://github.com/0Sakura721/dsh-opencodeconnect-nokey.git
cd dsh-opencodeconnect-nokey
node install.mjs
```

然后**重启 DSH**。

`install.mjs` 做四件事，全部打印出来：

```
profile    = C:\Users\你\.dsh\profiles\desktop
安装目标   = ...\node_modules\dsh-opencodeconnect-nokey
patch 文件 = ...\cordis.patch.yml
  copy package.json
  copy cordis.patch.yml
  copy lib/cli-bridge.js
  copy lib/index.js
  copy lib/shim.js
  patch 行已追加
  bundles 已追加
```

先用 `--dry-run` 看一眼计划不写盘，换 profile 用 `--profile`：

```bash
node install.mjs --dry-run          # 只看计划
node install.mjs --profile web      # 装到 web profile
```

脚本是幂等的：重复跑不会产生重复挂载行；改 `cordis.patch.yml` 前会留一份 `.bak`。

### 脚本到底改了哪三处

| 位置 | 动作 |
|---|---|
| `<profile>/node_modules/dsh-opencodeconnect-nokey/` | 复制插件文件 |
| `<profile>/cordis.patch.yml` | 追加 `- insert:` 挂载行（含 `inject: [llm]` 与 `config`） |
| `<profile>/package.json` → `dsh.profile.bundles` | 追加包名 |

### ⚠️ 两条实测踩出来的坑

**坑 1：`[]` 空数组后面不能直接追加**

DSH 新 profile 的 `cordis.patch.yml` 默认内容是 `[]`。直接在后面追加 `- insert:` 会得到非法 YAML：

```
end of the stream or a document separator is expected
```

因为 `[]` 已经是完整的 YAML 流式空序列，后面不能再跟数组元素 —— **整个 profile 起不来**。
`install.mjs` 会先把只有 `[]` 的那行剥掉再从数组根写起；手动安装时你要自己注意。

**坑 2：插件的 `cordis.patch.yml` 不能挂载插件自己**

这是最隐蔽的一个。本仓库早期版本在 `cordis.patch.yml` 里写了一条

```yaml
- insert:
    - id: opencodeconnect-nokey
      name: dsh-opencodeconnect-nokey
```

结果插件**在 DSH 里静默不加载** —— 没有日志、没有 shim 端口、模型选择器里没有 provider，
但「插件」页面里它明明显示为**已安装、开关是打开的**。

原因是加载链路套了两层 patch：

1. profile 的 `cordis.patch.yml` 先 insert 本插件（用户侧那三行）
2. 本插件 `package.json` 的 `dsh.bundle.patch` 又指向插件自带的 `cordis.patch.yml`，
   loader 把**插件自带的 patch 再叠加一层**

于是同一个 id 被插入两次，第二次是「一个叫 A 的行去 insert 一个叫 A 的行」的自引用。
**loader 遇到重复 id 不报错，只是不再启动那一行** —— 所以现象是"装了但什么都没发生"。

正确分工（对照 `dsh-xdpool`、`dsh-bili-whale` 等已验证插件）：

- **profile 的 patch 负责挂载插件**（用户侧三行）
- **插件自带的 patch 只负责插件内部要补充的行**

本插件没有内部子行要注册（provider 是在 `apply()` 里用
`ctx.llm.registerAdapter()` 动态注册的，不走 loader 行），所以仓库里的
`cordis.patch.yml` 就是一个空数组 `[]`。`install.mjs` 会原样复制它，你不需要动。

### 装完怎么确认真的在跑

「插件」页面显示"已安装 + 开关打开"**不代表启动成功**（坑 2 就是这样骗过眼睛的）。
真正可靠的判据是 **shim 端口 + 日志**：

```bash
# 发一条消息后，插件会有一个自己监听的 127.0.0.1 端口
# Windows
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' }
```

DSH 日志里应该出现：

```
[opencodeconnect] 使用 CLI: ...\opencode-cli.exe
[opencodeconnect] shim 监听 127.0.0.1:xxxxx
[opencodeconnect] provider "opencode-free" 已注册
[opencodeconnect] 模型目录更新为 8 个: ...
```

> **为什么不用 `dsh plugin add`**
>
> 本机 profile 的 `pnpm-lock.yaml` 与 registry integrity 对不上，pnpm 会直接拒绝：
>
> ```
> The downloaded tarball does not match the integrity recorded in the lockfile.
> ```
>
> 本插件**零运行时依赖**（宿主模块全部从 asar 动态导入），复制安装完全可行，
> 而且**不会动你的 lockfile** —— 比让 pnpm 重写一遍更安全。

### 手动安装（不想跑脚本）

1. 把 `lib/`、`package.json`、`cordis.patch.yml` 复制到
   `~/.dsh/profiles/desktop/node_modules/dsh-opencodeconnect-nokey/`

   > 注意 `cordis.patch.yml` 复制过去后应该是**空数组 `[]`**（内容照原样，
   > 别往前加挂载行 —— 见坑 2）。

2. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` **末尾**追加：

   ```yaml
   - insert:
       - id: opencodeconnect-nokey
         name: dsh-opencodeconnect-nokey
         inject: [llm]
         config:
           enabled: true
           displayName: OpenCode Free
           cliPath: ""
           timeoutMs: 300000
   ```

   > ⚠️ 如果你的 patch 文件内容是空数组 `[]`，**要先把它删掉**再追加。
   > `[]` 已经是完整的 YAML 流式空序列，后面跟 `- insert:` 会变成非法 YAML，
   > profile 直接起不来。`install.mjs` 会自动处理这种情况（有回归测试守着）。

3. 重启 DSH

### 卸载

```bash
node -e "
const fs=require('fs'),os=require('os'),path=require('path');
const d=path.join(os.homedir(),'.dsh','profiles','desktop');
fs.rmSync(path.join(d,'node_modules','dsh-opencodeconnect-nokey'),{recursive:true,force:true});
const p=path.join(d,'cordis.patch.yml');
fs.writeFileSync(p, fs.readFileSync(p,'utf8').replace(/\n# dsh-opencodeconnect-nokey[\s\S]*?(?=\n#|\n- id:|\Z)/,'').replace(/\n- insert:\n    - id: opencodeconnect-nokey\n      name: dsh-opencodeconnect-nokey\n?/,''));
console.log('已卸载，重启 DSH 生效');
"
```

或直接删掉 `node_modules/dsh-opencodeconnect-nokey/` 和 `cordis.patch.yml` 里那三行，再重启。

---

## 验证

重启后 DSH 日志里应该有：

```
[opencodeconnect] 使用 CLI: C:\Users\...\opencode-cli.exe
[opencodeconnect] 隔离 HOME: ...\.dsh\opencodeconnect\cli-home
[opencodeconnect] shim 监听 127.0.0.1:xxxxx
[opencodeconnect] provider "opencode-free" 已注册，shim=http://127.0.0.1:xxxxx/v1
[opencodeconnect] 模型目录更新为 8 个: beam-free, big-pickle, ...
```

然后在 DSH 里选模型 `opencode-free/deepseek-v4.1-flash-free`，
发一句「计算 91*47，只回数字」。正确结果是 `4277`。

### 本地测试（不需要 DSH 重启）

```bash
# 1. 安装脚本回归：空文件 / [] 空数组 / 只有注释 / 已有真实 patch 四种 profile 状态
ELECTRON_RUN_AS_NODE=1 "D:\DeepSeek Harness\DeepSeek Harness.exe" tests/install-test.mjs

# 2. 纯 shim 冒烟：起 shim，打一次 /v1/models + 一次非流式 + 一次流式
node tests/smoke.mjs

# 3. 宿主集成：在宿主环境里 load apply()，检查 registerAdapter 与 listModels
ELECTRON_RUN_AS_NODE=1 "D:\DeepSeek Harness\DeepSeek Harness.exe" tests/host-integration.mjs

# 4. 真实推理：走 adapter.prepareCall -> stream 完整路径，断言输出含 4277
ELECTRON_RUN_AS_NODE=1 "D:\DeepSeek Harness\DeepSeek Harness.exe" tests/real-inference.mjs

# 5. 长 prompt：13 万字符走 stdin（守住 ENAMETOOLONG 那条修复）
node tests/long-prompt.mjs
```

装完之后用一条命令体检：

```bash
node tools/diagnose.mjs
```

> Windows 上必须用 `ELECTRON_RUN_AS_NODE=1` + DSH 主程序跑测试 3/4：
> 只有在这种形态下 `process.execPath` 才指向 DSH 安装目录，
> 插件才能像宿主一样从 `resources/app.asar/dsh/node_modules` 推出依赖位置。
> 测试 1/2 用普通 `node` 即可。

四个测试都输出 `PASS` 即链路完整。

---

## 配置

在 `cordis.patch.yml` 的挂载行下加 `config:`：

```yaml
- insert:
    - id: opencodeconnect-nokey
      name: dsh-opencodeconnect-nokey
      config:
        displayName: OpenCode Free      # 模型选择器里的分组名
        cliPath: ""                      # 留空自动探测
        timeoutMs: 300000                # 单次推理超时
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `displayName` | `OpenCode Free` | provider 在模型选择器里的显示名 |
| `cliPath` | 空（自动探测） | 手动指定 `opencode-cli` 路径 |
| `timeoutMs` | `300000` | 单次 `opencode-cli` 调用超时 |

---

## 隔离性

插件给 CLI 一个**独立 HOME**：`~/.dsh/opencodeconnect/cli-home/`。

这意味着：

- 不会污染你真实的 OpenCode 会话库（`~/.local/share/opencode/opencode.db`）
- 不会和 OpenCode 桌面版抢 `~/.config/opencode/service.json`
- 不需要登录、不需要 `auth.json`（实测 `run --standalone` 在空 HOME 下直接可用）

想清理直接删掉那个目录即可。

---

## 推理等级（thinking effort）

部分免费模型支持调节思考强度。在 DSH 里选中模型后，输入框下方的**「推理等级」**
就是它 —— 但只在该模型真的支持时才出现。

各模型的可选档位（实采自上游，各不相同）：

| 模型 | 可选档位 |
|---|---|
| `deepseek-v4.1-flash-free` | `low` / `high` / `max` |
| `glm-5.3-flash-free` | `low` / `high` / `max` |
| `flint-40b-free` | `low` / `medium` / `high` / `xhigh` |
| `beam-free` | `low` / `medium` / `high` / `xhigh` |
| `nemotron-3.5-super-vl-free` | `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `big-pickle` · `mimo-v2.6-flash-free` · `nemotron-3.5-lightning-free` | 不支持（无选择器） |

档位确实生效，用 `reasoning_tokens` 可验证（同一道推理题）：

```
variant=low    reasoning_tokens=30
variant=high   reasoning_tokens=50
variant=max    reasoning_tokens=33
```

没有这个档位的模型**不会出现**「推理等级」选项 —— 这是刻意的：
给 deepseek 传 `off` 会被上游直接拒绝（`Variant unavailable`）。

### 传递链路

```
DSH 界面选档
  → 模型描述里的 reasoning + thinkingLevelMap（决定列出哪几档）
  → pi-ai 写进请求体 reasoning_effort
  → 本插件 shim 读到后转成 --model opencode/<id>#<variant>
  → opencode-cli 用它选上游 variant
```

> ⚠️ 这里有个容易踩的坑：宿主 `getSupportedThinkingLevels()` 判断"不支持"时
> **只认显式的 `null`**，`undefined` 会被当成"支持"。所以 `thinkingLevelMap`
> 必须把每个标准档位都写出来 —— 先全部钉成 `null`，再把模型真正拥有的档位
> 覆盖上去。只写支持的那几个，会让 `off`/`minimal`/`medium` 也出现在界面上。

---
## 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| **不支持工具调用（tool calling）** | `opencode run` 只接受单条 message，没有多轮 tool 结构 | DSH 的 agent 工具链在这个 provider 上跑不通；纯对话可用 |
| **不支持图片输入** | CLI 的 `run` 通道只传文本 | 模型标了 `image` 能力，但图片会被丢弃 |
| **首字节延迟 3–5 秒** | CLI 是事件级流（step_start→text→step_finish），不是 token 级 | shim 会等文本到齐后按标点切块下发 SSE；不是逐字流 |
| ~~prompt 长度受命令行限制~~ | 已修复：长 prompt 改走 stdin | DSH 的 system prompt 动辄上万字，argv 会 `ENAMETOOLONG` |
| **不支持工具调用** | CLI 单轮 message 通道 | 推理等级可用，但 agent 工具链跑不通 |
| **额度由 OpenCode 账号决定** | 免费额度是上游控制的 | 用尽后返回 `FreeUsageLimitError`，插件会把原文透出给用户 |
| **依赖本机装有 OpenCode** | 推理必须由官方 CLI 发起 | 没装 OpenCode 时插件记一条 error 并静默不注册 provider |

### 坑 3：长 prompt 不能走 argv（`spawn ENAMETOOLONG`）

在 GUI 里用 OpenCode Free 发第一条消息时，可能拿到：

```
502 {"type":"upstream_error","message":"spawn ENAMETOOLONG","code":"ENAMETOOLONG"}
```

原因是 DSH 每次请求都带上万字的 system prompt（工具说明、harness 规则、Code Mode 目录…），
而早期实现把整个 prompt 拼进 `opencode-cli` 的**命令行参数**。
Windows 的 `CreateProcess` 整条命令行上限 32767 字节，远超即失败。

本机实测：

| 方式 | prompt 长度 | 结果 |
|---|---|---|
| argv | 40000 字符 | `Argument list too long` |
| argv | 134033 字符 | 失败（DSH 真实请求体量） |
| **stdin** | 134033 字符 | **成功**，5.1s 返回 |

修复方式：`cli-bridge.js` 按长度分流 —— 短 prompt（≤4000 字符）仍走 argv，
长 prompt 走 stdin（`opencode-cli` 在没给 message 参数时读标准输入，实测可用）。

`tests/long-prompt.mjs` 用 13 万字符的 prompt 守住这条路径，同时验证短 prompt 没被改坏。

---

## 项目结构

```
lib/
  cli-bridge.js   CLI 定位、隔离 HOME、spawn + NDJSON 解析、模型实采
  shim.js         本地 OpenAI 兼容 HTTP 服务（/v1/models、/v1/chat/completions、SSE）
  index.js        宿主入口：apply()、provider 装配、ctx.llm.registerAdapter
tests/
  smoke.mjs           纯 shim 端到端（无需 DSH）
  host-integration.mjs 宿主环境 load + registerAdapter + listModels 验收
  real-inference.mjs  adapter.prepareCall -> stream 真实推理，断言 4277
install.mjs       安装到 profile（复制 + patch + bundles）
```

---

## License

MIT
