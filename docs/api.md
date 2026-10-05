# TypeScript API

所有公开 API 从 `@a2a/reference` 导出。

## `AgentProvider`

从 `.env` 创建 Agent 配置、身份和服务端运行时。配置路径优先级：

1. 构造参数 `envPath`
2. 环境变量 `A2A_ENV_PATH`
3. 当前工作目录下的 `.env`

`envPath` 可指向文件，也可指向一个已存在的目录。目录会自动解析为 `<目录>/.env`。显式指定的文件不存在时会快速失败；默认的 `$PWD/.env` 不存在时使用默认值和运行时环境变量。

```ts
const provider = new AgentProvider({
  envPath: "/etc/my-agent/agent.env",
  requireEnvFile: true,
});

const config = provider.getConfig();
const node = provider.createNode({
  peers,
  capabilities,
});
const server = await provider.listen(node);
```

`environment` 可在测试或嵌入式场景替代 `process.env`。合并顺序为 `.env` 后加载、运行时环境覆盖，且不会修改全局 `process.env`。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `A2A_ENV_PATH` | `$PWD/.env` | 动态配置文件或目录 |
| `A2A_AGENT_ID` | `agent://local` | Agent ID |
| `A2A_AGENT_NAME` | `Local A2A Agent` | 展示名称 |
| `A2A_AGENT_DESCRIPTION` | 空 | Agent 描述 |
| `A2A_ENDPOINT` | `http://127.0.0.1:4310` | Agent Card 公布的地址 |
| `A2A_LISTEN_HOST` | endpoint host | HTTP 监听主机 |
| `A2A_LISTEN_PORT` | endpoint port | HTTP 监听端口 |
| `A2A_TRANSPORTS` | 根据 endpoint 推导 | 逗号分隔的传输类型 |
| `A2A_CONTENT_TYPES` | `application/json` | 逗号分隔的内容类型 |
| `A2A_MAX_MESSAGE_BYTES` | `1048576` | 最大消息字节数 |
| `A2A_MAX_TTL_MS` | `300000` | 最大消息 TTL |
| `A2A_ALLOWED_CLOCK_SKEW_MS` | `30000` | 允许时钟偏差 |
| `A2A_CHALLENGE_TTL_MS` | `30000` | challenge 有效期 |
| `A2A_SESSION_TTL_MS` | `900000` | Session 有效期 |
| `A2A_SIGNING_KEY_ID` | 自动生成/推导 | 签名密钥 ID |
| `A2A_SIGNING_PRIVATE_KEY_FILE` | 空 | Ed25519 PKCS#8 PEM 文件 |
| `A2A_SIGNING_PRIVATE_KEY` | 空 | 内联 PEM，支持转义换行 |

相对私钥路径基于 `.env` 所在目录解析。未配置私钥时会生成临时 Ed25519 身份，适合开发；生产环境应提供持久密钥。

## 身份与密码学

### `generateSigningIdentity(agentId, keyId?)`

生成 Ed25519 身份。返回 `SigningIdentity`，包含 `agentId`、`keyId`、`publicKey` 和 `privateKey`。

### `generateEncryptionIdentity(keyId?)`

生成 X25519 加密身份。

### `createSignedMessage(identity, input)`

创建、摘要并签名一个 `A2AMessage`。`input` 需要 `kind`、`recipient` 和 JSON `payload`，可指定 TTL、会话 ID、幂等键、scope、trace 和扩展。

### `verifyMessageSignature(message, publicKey)`

同时验证 payload SHA-256 摘要与 Ed25519 信封签名。

### `encryptJson(payload, recipientPublicKey, recipientKeyId, associatedData?)`

返回可直接放入消息 payload 的 `EncryptedPayload`。

### `decryptJson(payload, recipientIdentity, associatedData?)`

验证 AES-GCM tag 并还原 JSON。Associated data 必须与加密时完全一致。

### 密钥导出

```ts
exportPublicKeyPem(identity.publicKey);
exportPrivateKeyPem(identity.privateKey);
```

生产环境应由 KMS/HSM 提供签名操作，不应导出私钥。

## `PeerRegistry`

服务端受信任调用方目录。

```ts
const peers = new PeerRegistry();

peers.register({
  agentId: "agent://worker",
  keyId: "worker-signing-key",
  publicKey: publicKeyOrPem,
  grantedScopes: ["tasks:execute", "state:sync"],
});

peers.revoke("agent://worker", "worker-signing-key");
```

`grantedScopes: ["*"]` 授予所有处理器 scope，应谨慎使用。

## `A2ANode`

服务端协议运行时。

```ts
const node = new A2ANode({
  identity,
  peers,
  name: "Coordinator",
  description: "Coordinates work.",
  endpoint: "https://agent.example.com",
  capabilities: [],
  maxMessageBytes: 1_048_576,
  maxTtlMs: 300_000,
  allowedClockSkewMs: 30_000,
  maxProcessedMessages: 10_000,
  maxTrackedConversations: 10_000,
  session: {
    challengeTtlMs: 30_000,
    sessionTtlMs: 900_000,
  },
});
```

`maxProcessedMessages` 限制去重结果缓存的条目数，`maxTrackedConversations` 限制按会话追踪序号的会话数。超出后按插入顺序淘汰最旧条目。淘汰只会缩短保留窗口，不会延长消息的去重有效期；需要跨重启或跨副本保证效果一次时仍应使用持久 inbox。

### `registerHandler(kind, handler, options?)`

注册唯一消息处理器并返回注销函数。

```ts
const unregister = node.registerHandler(
  "command",
  async ({ message, principal, receivedAt }) => {
    await execute(message.payload);
    return {
      kind: "response",
      payload: { completed: true, actor: principal.agentId, receivedAt },
    };
  },
  { requiredScopes: ["jobs:write"] },
);
```

处理器返回 `void` 时只有 ACK；返回 `HandlerResult` 时同时产生已签名响应。处理器抛出 `A2AError` 会产生 `rejected` ACK 和已签名 `error` 消息。

### 其他方法

- `getAgentCard()`：返回 Agent Card 副本。
- `issueChallenge(request)`：创建一次性 challenge。
- `verifyChallenge(verification)`：验签并创建 Session。
- `receive(message, bearerToken)`：执行完整接收管线并返回 `DeliveryBundle`。

同一消息的并发副本只会触发一次处理器调用：接收方在进入处理器前先占用去重键，其余副本等待该次处理的结果并收到 `duplicate` ACK。去重键按 `sender + message.id` 划分，因此不同消息仍并行处理，互不排队。

## `A2AClient`

客户端负责发现、认证、序号、签名、重试和响应验签。

```ts
const client = new A2AClient({
  identity: workerIdentity,
  transport: new HttpTransport("https://agent.example.com"),
  requestedScopes: ["tasks:execute"],
  expectedAgentId: "agent://coordinator",
  trustedServerKeys: {
    "coordinator-key-2026": pinnedPublicKey,
  },
  retryPolicy: {
    maxAttempts: 4,
    initialDelayMs: 100,
    maxDelayMs: 2_000,
    backoffFactor: 2,
    jitterRatio: 0.2,
  },
});

await client.connect();
const delivery = await client.send({
  kind: "request",
  recipient: "agent://coordinator",
  payload: { task: "summarize" },
  conversationId: "conversation-1",
  idempotencyKey: "task-42",
});
```

- `connect(options?)`：发现 Agent Card 并认证。`options.signal` 可取消发现与认证。
- `send(input, options?)`：创建签名消息并可靠发送。
- `sendSigned(message, options?)`：可靠发送已签名消息，重试时不重新签名。

`options` 为 `SendOptions`：`retryPolicy` 覆盖本次发送的重试策略，`signal` 用于取消。取消会中断进行中的传输并停止重试，以 `signal.reason` 抛出，详见[配置指南](./configuration.md)。

重试预算的消耗规则：

| 失败 | 是否消耗预算 | 说明 |
| --- | --- | --- |
| 401 触发重新认证 | 否 | 认证成功后恢复完整预算 |
| 重新认证本身失败 | 是 | 瞬时故障可继续重试，不可重试则立即失败 |
| 可重试的传输失败 | 是 | 受 `maxAttempts` 限制 |
| 422 handler 拒绝 | 是（立即抛出） | 重放只会重复一次蓄意拒绝 |
| 不可重试错误 | 是（立即抛出） | 由调用方决策 |

`trustedServerKeys` 非空时只接受固定密钥。为空时使用 Agent Card 公钥，信任强度取决于发现传输。

## 传输

### `HttpTransport`

```ts
const transport = new HttpTransport("https://agent.example.com", {
  requestTimeoutMs: 10_000,
  maxResponseBytes: 2_097_152,
});
```

### `createA2AHttpServer(node, options?)`

创建 Node.js `http.Server`。

```ts
const server = createA2AHttpServer(node, {
  maxRequestBytes: 1_048_576,
  requestTimeoutMs: 30_000,
});
server.listen(4310, "127.0.0.1");
```

`maxRequestBytes` 默认取 `node.maxMessageBytes`，也就是 Agent Card 对外宣告的 `limits.maxMessageBytes`，因此对端按 Card 上限构造的消息不会被本节点以 413 拒绝。显式传入 `maxRequestBytes` 可以进一步收紧到与网关一致。

生产环境可把服务挂在 TLS 反向代理后，或用相同路由实现原生 HTTPS。

### `InMemoryTransport`

进程内调用，仍执行线消息边界校验、认证、授权、签名和去重逻辑，适合测试和同进程智能体。`requestChallenge` 和 `verifyChallenge` 与 HTTP 绑定使用同一组 `assert*` 校验，非法输入统一返回 `A2AError`。

### 自定义传输

实现 `ClientTransport`：

```ts
interface ClientTransport {
  discover(signal?: AbortSignal): Promise<AgentCard>;
  requestChallenge(
    request: ChallengeRequest,
    signal?: AbortSignal,
  ): Promise<Challenge>;
  verifyChallenge(
    verification: ChallengeVerification,
    signal?: AbortSignal,
  ): Promise<SessionGrant>;
  send(
    message: A2AMessage,
    token: string,
    signal?: AbortSignal,
  ): Promise<DeliveryBundle>;
}
```

四个方法的 `signal` 都是可选的，用于感知调用方取消。只声明更少参数的实现仍然满足该接口，只是无法中断进行中的尝试。

## 状态同步

### `ReplicatedState`

```ts
const state = new ReplicatedState("agent://worker", "workflow");
state.set("currentStep", 3);
state.delete("temporaryLease");

const delta = state.createDelta(remoteVectorClock);
state.applyDelta(remoteDelta);

const snapshot = state.snapshot();
state.applySnapshot(remoteSnapshot);
```

### `registerStateSyncHandlers(node, state, requiredScope?)`

注册 `state-delta` 和 `state-snapshot` 处理器。默认 scope 为 `state:sync`，返回的注销函数会同时移除两个处理器。

两个处理器的响应 payload 都是 `StateSyncResult`：

```ts
interface StateSyncResult {
  namespace: string;
  clock: VectorClock;
  applied: number;
  delta?: StateDelta; // 仅 state-delta 处理器返回
}
```

`delta` 是对端缺失内容的完整 `StateDelta`，可直接交给 `applyDelta()`。它与 `applied`、`clock` 分开存放，而不是把计数混入 delta，因此整个 payload 不会只因为校验器宽松才凑巧满足 `StateDelta`。`state-snapshot` 处理器只返回计数器，接收方需自行用 `createDelta()` 拉取差异。

### 向量时钟工具

- `compareVectorClocks(left, right)`：返回 `before | after | equal | concurrent`。
- `mergeVectorClocks(left, right)`：逐分量取最大值。

## Codec

`createDefaultCodecRegistry()` 默认注册：

- `application/json`
- `application/octet-stream`，线格式为 base64url JSON 对象

```ts
const codecs = createDefaultCodecRegistry();
const payload = codecs.encode("application/octet-stream", bytes);
const decoded = codecs.decode<Uint8Array>(
  "application/octet-stream",
  payload,
);
```

自定义格式实现 `PayloadCodec<T>` 后调用 `registry.register(codec)`。

## 错误

`A2AError` 包含：

- `code`：稳定机器可读错误码。
- `status`：建议 HTTP 状态。
- `retriable`：传输层是否可以安全重试同一消息。
- `details`：可选 JSON 诊断信息。

`ErrorCode` 导出全部内置错误码。使用 `asA2AError(error)` 可把未知异常转换为不泄露内部细节的 `INTERNAL_ERROR`。
