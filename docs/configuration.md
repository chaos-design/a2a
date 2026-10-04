# 配置指南

A2A 配置分成三个平面。先区分它们，可以避免把所有内容都塞进 `.env`：

| 配置平面 | 放什么 | 当前入口 |
| --- | --- | --- |
| 节点静态配置 | Agent ID、对外地址、监听地址、协议限制、服务端签名私钥 | `AgentProvider` + `.env` |
| 服务端运行时配置 | 可信调用方、公钥、授权 scopes、能力、处理器 | `PeerRegistry`、`createNode()`、`registerHandler()` |
| 客户端连接配置 | 目标地址、目标身份、固定公钥、请求 scopes、重试和超时 | `A2AClient`、`HttpTransport` |

`.env` 只负责第一类配置。对端信任关系和业务处理器必须在代码或外部配置系统中装配。

## 1. 配置加载规则

### 1.1 配置文件路径

`AgentProvider` 按以下优先级选择一个配置文件：

1. `new AgentProvider({ envPath: "..." })`
2. 进程环境中的 `A2A_ENV_PATH`
3. 当前工作目录的 `.env`

`envPath` 可以指向：

- 一个具体文件，例如 `/etc/a2a/coordinator.env`。
- 一个已经存在的目录，例如 `/etc/a2a`，此时读取 `/etc/a2a/.env`。

相对路径基于 `cwd` 解析。默认 `cwd` 是 `process.cwd()`。

```ts
const provider = new AgentProvider({
  cwd: "/srv/coordinator",
  envPath: "./config/production.env",
});
```

上例最终读取 `/srv/coordinator/config/production.env`。

### 1.2 文件是否必须存在

- 显式提供 `envPath` 或 `A2A_ENV_PATH` 时，默认要求文件存在。
- 未显式指定、只使用默认 `$PWD/.env` 时，文件可以不存在。
- 可以用 `requireEnvFile: true` 强制要求默认文件存在。

生产环境推荐：

```ts
const provider = new AgentProvider({
  envPath: process.env.A2A_ENV_PATH,
  requireEnvFile: true,
});
```

### 1.3 值的覆盖顺序

同名配置的优先级：

```text
options.environment 或 process.env
  > .env 文件
  > 内置默认值
```

`AgentProvider` 不会修改全局 `process.env`。

测试中可以传入隔离环境：

```ts
const provider = new AgentProvider({
  cwd: fixtureDirectory,
  environment: {
    A2A_AGENT_ID: "agent://test",
    A2A_LISTEN_PORT: "0",
  },
});
```

## 2. 完整环境变量

### 2.1 身份与展示信息

| 环境变量 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- |
| `A2A_AGENT_ID` | `agent://local` | 非空 | 稳定逻辑身份，必须与对端信任配置一致 |
| `A2A_AGENT_NAME` | `Local A2A Agent` | 非空 | Agent Card 展示名称 |
| `A2A_AGENT_DESCRIPTION` | 未设置 | 非空时生效 | Agent Card 描述 |
| `A2A_SIGNING_KEY_ID` | 自动生成或由公钥推导 | 非空 | 签名密钥版本标识 |
| `A2A_SIGNING_PRIVATE_KEY_FILE` | 未设置 | Ed25519 PKCS#8 PEM | 私钥文件路径 |
| `A2A_SIGNING_PRIVATE_KEY` | 未设置 | Ed25519 PKCS#8 PEM | 内联私钥，支持字面量 `\n` |

`A2A_SIGNING_PRIVATE_KEY_FILE` 和 `A2A_SIGNING_PRIVATE_KEY` 不能同时设置。

未提供私钥时，进程启动会生成临时 Ed25519 密钥。这样可以快速开发，但每次重启后公钥和默认 key ID 都会变化，已经固定该公钥的客户端无法再连接。

### 2.2 网络与发现

| 环境变量 | 默认值 | 约束 | 说明 |
| --- | --- | --- | --- |
| `A2A_ENDPOINT` | `http://127.0.0.1:4310` | `http`、`https` 或 `memory` URL | Agent Card 对外公布的地址 |
| `A2A_LISTEN_HOST` | 从 endpoint 主机推导 | 合法监听地址 | Node.js HTTP Server 绑定地址 |
| `A2A_LISTEN_PORT` | 从 endpoint 端口推导 | `0..65535` | 实际监听端口，`0` 仅适合测试 |
| `A2A_TRANSPORTS` | 从 endpoint 协议推导 | `http,https,in-memory` | Agent Card 公布的传输列表 |
| `A2A_CONTENT_TYPES` | `application/json` | 逗号分隔非空列表 | Agent Card 公布的载荷类型 |

`A2A_ENDPOINT` 和监听地址不是同一个概念：

```text
客户端看到：A2A_ENDPOINT=https://agents.example.com/coordinator
反向代理转发到：A2A_LISTEN_HOST=127.0.0.1
服务实际监听：A2A_LISTEN_PORT=4310
```

使用反向代理时的推荐配置：

```dotenv
A2A_ENDPOINT=https://agents.example.com
A2A_LISTEN_HOST=127.0.0.1
A2A_LISTEN_PORT=4310
A2A_TRANSPORTS=https
```

注意：当前 `HttpTransport` 使用固定协议路径并通过 `new URL(path, baseUrl)` 解析。推荐让 `A2A_ENDPOINT` 指向域名根地址。如果需要子路径前缀，应在网关做重写或提供自定义 `ClientTransport`。

### 2.3 消息与会话限制

| 环境变量 | 默认值 | 最小值 | 作用 |
| --- | ---: | ---: | --- |
| `A2A_MAX_MESSAGE_BYTES` | `1048576` | `1` | 单条确定性 JSON 消息的最大 UTF-8 字节数 |
| `A2A_MAX_TTL_MS` | `300000` | `1` | 客户端可声明的最大消息 TTL |
| `A2A_ALLOWED_CLOCK_SKEW_MS` | `30000` | `0` | 接受的发送方时钟偏差 |
| `A2A_CHALLENGE_TTL_MS` | `30000` | `1` | 一次性 challenge 有效期 |
| `A2A_SESSION_TTL_MS` | `900000` | `1` | Bearer Session 有效期 |

这些值必须是安全整数。非法值会在启动时抛出 `CONFIGURATION_ERROR`。

### 2.4 列表格式

列表用逗号分隔，空白会被清理，重复项会去重：

```dotenv
A2A_TRANSPORTS=https,http
A2A_CONTENT_TYPES=application/json,application/octet-stream
```

完全为空的显式列表会被视为未配置并使用默认值。

## 3. 推荐配置模板

### 3.1 本地开发

```dotenv
A2A_AGENT_ID=agent://coordinator-dev
A2A_AGENT_NAME=Coordinator Dev
A2A_AGENT_DESCRIPTION=Local development coordinator
A2A_ENDPOINT=http://127.0.0.1:4310
A2A_LISTEN_HOST=127.0.0.1
A2A_LISTEN_PORT=4310
A2A_TRANSPORTS=http
A2A_CONTENT_TYPES=application/json
A2A_MAX_MESSAGE_BYTES=1048576
A2A_MAX_TTL_MS=300000
A2A_ALLOWED_CLOCK_SKEW_MS=30000
A2A_CHALLENGE_TTL_MS=30000
A2A_SESSION_TTL_MS=900000
```

可以不配置私钥。临时身份只用于本机测试。

### 3.2 容器或内网环境

```dotenv
A2A_AGENT_ID=agent://platform/coordinator
A2A_AGENT_NAME=Task Coordinator
A2A_AGENT_DESCRIPTION=Coordinates internal agent workloads
A2A_ENDPOINT=http://coordinator.a2a.svc.cluster.local:4310
A2A_LISTEN_HOST=0.0.0.0
A2A_LISTEN_PORT=4310
A2A_TRANSPORTS=http
A2A_CONTENT_TYPES=application/json
A2A_MAX_MESSAGE_BYTES=1048576
A2A_MAX_TTL_MS=120000
A2A_ALLOWED_CLOCK_SKEW_MS=10000
A2A_CHALLENGE_TTL_MS=15000
A2A_SESSION_TTL_MS=600000
A2A_SIGNING_KEY_ID=coordinator-2026-09
A2A_SIGNING_PRIVATE_KEY_FILE=/run/secrets/a2a-signing.pem
```

即使集群内使用 HTTP，也应由 service mesh 或同等机制提供传输加密和服务身份。

### 3.3 公网生产

```dotenv
A2A_AGENT_ID=agent://example.com/coordinator
A2A_AGENT_NAME=Production Coordinator
A2A_AGENT_DESCRIPTION=Production task coordination endpoint
A2A_ENDPOINT=https://agents.example.com
A2A_LISTEN_HOST=127.0.0.1
A2A_LISTEN_PORT=4310
A2A_TRANSPORTS=https
A2A_CONTENT_TYPES=application/json
A2A_MAX_MESSAGE_BYTES=524288
A2A_MAX_TTL_MS=60000
A2A_ALLOWED_CLOCK_SKEW_MS=5000
A2A_CHALLENGE_TTL_MS=15000
A2A_SESSION_TTL_MS=300000
A2A_SIGNING_KEY_ID=coordinator-2026-q3
A2A_SIGNING_PRIVATE_KEY_FILE=/run/secrets/a2a-signing.pem
```

公网 TLS 在反向代理或负载均衡器终止，应用仅监听 loopback。多副本生产还需要共享 challenge、Session 和去重存储，详见 [生产部署](./deployment.md)。

## 4. 签名密钥

### 4.1 生成 Ed25519 私钥

```bash
mkdir -p secrets
openssl genpkey -algorithm Ed25519 -out secrets/a2a-signing.pem
chmod 600 secrets/a2a-signing.pem
```

导出公钥：

```bash
openssl pkey \
  -in secrets/a2a-signing.pem \
  -pubout \
  -out secrets/a2a-signing-public.pem
```

`.env`：

```dotenv
A2A_SIGNING_KEY_ID=coordinator-2026-q3
A2A_SIGNING_PRIVATE_KEY_FILE=./secrets/a2a-signing.pem
```

相对私钥路径基于 `.env` 文件所在目录，而不是启动命令所在目录。

### 4.2 key ID 怎么选

建议使用可审计的稳定版本号：

```text
coordinator-2026-q3
worker-prod-03
sig-<public-key-fingerprint>
```

`keyId` 不是秘密，也不是公钥指纹校验本身。它用于定位公钥和表达轮换版本。

### 4.3 密钥轮换

当前 `A2ANode` 的 Agent Card 只发布当前运行身份的一把 active 公钥。平滑轮换需要在外围注册中心或扩展实现中完成：

1. 发布新公钥，同时保留旧公钥为 `retiring`。
2. 客户端固定并接受新旧两把服务端公钥。
3. 服务端在 `PeerRegistry` 注册调用方的新旧公钥。
4. 切换签名私钥和 key ID。
5. 等待旧 Session 与最长消息 TTL 过期。
6. 撤销旧公钥并移除固定配置。

不要只修改 `keyId` 而继续使用无法追踪来源的临时密钥。

## 5. Peer Registry 和 scopes

服务端在代码中注册可信调用方：

```ts
const peers = new PeerRegistry();

peers.register({
  agentId: "agent://worker",
  keyId: "worker-2026-q3",
  publicKey: workerPublicKeyPem,
  grantedScopes: [
    "tasks:execute",
    "state:sync",
  ],
});
```

权限实际授予过程：

```text
Session scopes
  = 客户端 requestedScopes
  ∩ PeerRegistry.grantedScopes
```

处理消息时还会校验：

```text
Session scopes
  必须覆盖 handler.requiredScopes
  加上 message.requiredScopes
```

建议：

- scope 使用 `资源:动作`，例如 `tasks:execute`、`state:sync`。
- 每类处理器使用最小权限。
- 避免生产环境使用 `grantedScopes: ["*"]`。
- Peer Registry 的源数据应来自受控配置、数据库或可信身份目录。
- 调用 `peers.revoke(agentId, keyId)` 后，使用该密钥的现有 Session 会立即失效。

## 6. 服务端运行时配置

`AgentProvider.createNode()` 接收不适合放在 `.env` 的结构化配置：

```ts
const node = provider.createNode({
  peers,
  capabilities: [
    {
      name: "execute-task",
      description: "Execute an approved task.",
      messageKinds: ["command"],
      requiredScopes: ["tasks:execute"],
      inputSchema: {
        type: "object",
        required: ["taskId"],
      },
    },
  ],
  extensions: {
    "x-region": "cn-north",
  },
});
```

处理器配置：

```ts
node.registerHandler(
  "command",
  async ({ message, principal, receivedAt }) => {
    return {
      payload: {
        accepted: true,
        actor: principal.agentId,
        receivedAt,
      },
    };
  },
  { requiredScopes: ["tasks:execute"] },
);
```

一个 `kind` 只能注册一个处理器。重复注册会返回 `CONFLICT`。

HTTP Server 还支持：

```ts
const server = await provider.listen(node, {
  host: "127.0.0.1",
  port: 4310,
  maxRequestBytes: 1_048_576,
  requestTimeoutMs: 30_000,
});
```

`maxRequestBytes` 限制原始 HTTP 请求体，`A2A_MAX_MESSAGE_BYTES` 限制规范化后的协议消息。建议前者不大于网关限制，并与后者保持一致。

## 7. 客户端配置

```ts
const transport = new HttpTransport("https://agents.example.com", {
  requestTimeoutMs: 10_000,
  maxResponseBytes: 2_097_152,
});

const client = new A2AClient({
  identity: workerIdentity,
  transport,
  requestedScopes: ["tasks:execute"],
  expectedAgentId: "agent://example.com/coordinator",
  trustedServerKeys: {
    "coordinator-2026-q3": coordinatorPublicKeyPem,
  },
  sessionRefreshMarginMs: 5_000,
  retryPolicy: {
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 2_000,
    backoffFactor: 2,
    jitterRatio: 0.2,
  },
});
```

| 字段 | 推荐 | 说明 |
| --- | --- | --- |
| `expectedAgentId` | 必填 | 防止连接到错误的逻辑 Agent |
| `trustedServerKeys` | 生产必填 | 固定服务端公钥，避免只信任发现响应 |
| `requestedScopes` | 最小集合 | 服务端只会授予注册权限内的交集 |
| `sessionRefreshMarginMs` | 小于 Session TTL | 到期前主动重新认证 |
| `requestTimeoutMs` | 小于消息 TTL | 单次 HTTP 尝试的超时 |
| `maxResponseBytes` | 明确设置 | 防止异常或恶意超大响应 |

当 `trustedServerKeys` 为空时，客户端会使用 Agent Card 中未撤销的公钥。这属于依赖发现通道的信任，不适合高风险公网场景。

### 取消单次发送

`send()` 和 `sendSigned()` 接受 `SendOptions.signal`：

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(new Error("caller cancelled")), 200);

await client.send(
  { kind: "request", recipient: "agent://example.com/coordinator", payload: {} },
  { signal: controller.signal },
);
```

取消会同时中断进行中的 HTTP 请求和后续重试，不会等到 `requestTimeoutMs` 才返回。取消以 `signal.reason` 原样抛出，不包装成 `A2AError`，因此不会被当作可重试的传输失败而重发消息。

自定义 `ClientTransport` 实现可以通过 `send()` 的第三个可选参数 `signal` 感知取消；不接收该参数的实现仍然满足接口，只是无法中断进行中的尝试。

## 8. 时间参数如何配合

建议满足：

```text
challenge TTL > 完成两次认证 HTTP 请求的最坏耗时
session TTL > 典型任务批次时长
session refresh margin < session TTL
message TTL > 单次请求超时
message TTL < 业务允许的最大陈旧时间
clock skew >= 节点间可观测到的最大时钟误差
```

示例：

```text
HTTP timeout       10 s
challenge TTL      15 s
message TTL        30 s
clock skew          5 s
session refresh     5 s
session TTL       300 s
```

所有节点应同步 NTP。不要用很大的 `A2A_ALLOWED_CLOCK_SKEW_MS` 掩盖时钟漂移，因为它同时扩大过期消息可被接受的窗口。

## 9. 配置检查

启动时记录非敏感配置：

```ts
const config = provider.getConfig();
console.log({
  agentId: config.agentId,
  endpoint: config.endpoint,
  listenHost: config.listenHost,
  listenPort: config.listenPort,
  envPath: config.envPath,
  envLoaded: config.envLoaded,
  keyId: provider.identity.keyId,
});
```

不要记录：

- `A2A_SIGNING_PRIVATE_KEY`
- Bearer token
- challenge proof
- 明文敏感 payload

快速自检：

```bash
curl -s http://127.0.0.1:4310/.well-known/a2a-agent.json
```

重点确认：

- `agentId` 与客户端 `expectedAgentId` 一致。
- `endpoint` 是客户端真实可达地址。
- `publicKeys[].keyId` 与固定公钥配置一致。
- `capabilities[].requiredScopes` 与客户端请求 scopes 一致。
- `limits` 与客户端消息大小和 TTL 匹配。
