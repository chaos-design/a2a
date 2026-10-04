# 排障指南

## 1. 最短排障路径

按顺序执行：

```bash
npm run check
npm test
npm run demo
curl -i http://127.0.0.1:4310/.well-known/a2a-agent.json
```

然后确认五项：

1. 客户端 URL 能访问 Agent Card。
2. Agent Card 的 `agentId` 等于客户端 `expectedAgentId`。
3. 客户端公钥已在服务端 `PeerRegistry` 注册。
4. 客户端请求的 scope 在 `grantedScopes` 内，且覆盖 handler 要求。
5. 两端系统时间已同步，消息和 challenge 未过期。

## 2. 先判断错误发生在哪一层

| 表现 | 层 | 优先检查 |
| --- | --- | --- |
| 连接拒绝、DNS、超时 | 网络/传输 | endpoint、host、port、代理、超时 |
| Agent Card 身份不符 | 发现/信任 | `expectedAgentId`、网关路由 |
| challenge 401 | Peer 信任 | client agent ID、key ID、公钥状态 |
| challenge 签名失败 | 服务端信任 | `trustedServerKeys`、服务端密钥轮换 |
| message 401 | Session/签名 | token、sender/keyId、消息是否被修改 |
| message 403 | 授权 | requested、granted、handler scopes |
| message 408 | 时效 | TTL、NTP、重试总耗时 |
| ACK rejected / 客户端 422 | 业务处理器 | 签名 error payload |
| duplicate ACK | 重试去重 | 首次响应是否丢失，不代表重复执行 |
| 状态不一致 | 状态同步 | namespace、cursor、tombstone、反向 delta |

## 3. 配置启动错误

### `CONFIGURATION_ERROR: Environment file does not exist`

原因：

- 显式传入了不存在的 `envPath`。
- `A2A_ENV_PATH` 指向错误路径。
- 把尚未创建的目录当成配置目录传入。

检查：

```bash
printf '%s\n' "$A2A_ENV_PATH"
ls -l "$A2A_ENV_PATH"
```

修复：

- 指向实际文件。
- 如果传目录，先创建目录和其中的 `.env`。
- 本地不要求文件时，不要显式设置 `envPath`。

### `A2A_ENDPOINT must be a valid URL`

错误示例：

```dotenv
A2A_ENDPOINT=127.0.0.1:4310
```

正确：

```dotenv
A2A_ENDPOINT=http://127.0.0.1:4310
```

只支持 `http:`、`https:` 和 `memory:`。

### `A2A_LISTEN_PORT must be an integer`

端口必须是 `0..65535` 的十进制整数：

```dotenv
A2A_LISTEN_PORT=4310
```

`0` 让操作系统分配临时端口，只适合测试。Agent Card 中的 endpoint 不会自动更新成这个临时端口。

### 私钥无法加载

常见原因：

- 文件路径按启动目录理解了。实际相对路径基于 `.env` 所在目录。
- PEM 不是 PKCS#8 私钥。
- 密钥算法不是 Ed25519。
- 同时设置了文件和内联私钥。

检查：

```bash
openssl pkey -in ./secrets/a2a-signing.pem -text -noout
```

重新生成：

```bash
openssl genpkey -algorithm Ed25519 -out ./secrets/a2a-signing.pem
chmod 600 ./secrets/a2a-signing.pem
```

## 4. 网络和 HTTP 错误

### `ECONNREFUSED`

检查：

```bash
curl -i http://127.0.0.1:4310/.well-known/a2a-agent.json
lsof -nP -iTCP:4310 -sTCP:LISTEN
```

常见原因：

- `A2A_LISTEN_PORT` 与客户端 URL 不同。
- 服务只监听 `127.0.0.1`，但客户端来自其他主机或容器。
- `A2A_ENDPOINT` 是对外地址，但代理没有启动。

容器内通常需要：

```dotenv
A2A_LISTEN_HOST=0.0.0.0
```

同时确保 `A2A_ENDPOINT` 仍是客户端可达地址，而不是容器内部绑定地址。

### 请求超时

默认：

```text
HttpTransport request timeout: 10 s
HTTP Server request timeout:    30 s
消息默认 TTL:                    30 s
```

如果 handler 正常耗时超过 10 秒，客户端会先超时并重试。解决方式：

- 缩短 handler 执行时间。
- 把长任务改成异步队列模式。
- 提高客户端 `requestTimeoutMs`，同时检查消息 TTL 和网关超时。
- 确保 handler 本身有取消或超时策略。

### `Content-Type must be application/json`

所有 POST 都必须发送：

```http
Content-Type: application/json
```

`HttpTransport` 会自动添加。自定义客户端需要自行设置。

### `Request body exceeds ... bytes`

有两层大小限制：

- HTTP Server `maxRequestBytes`：原始请求体。
- A2ANode `maxMessageBytes`：确定性 JSON 消息。

还可能有网关限制。三者应明确协调。

## 5. 发现和服务端信任

### `Expected agent X, received Y`

客户端连接到了一个可响应 A2A 的服务，但逻辑身份不对。

检查：

```bash
curl -s https://target.example.com/.well-known/a2a-agent.json
```

确认：

- 网关 hostname 和路由正确。
- Agent 的 `A2A_AGENT_ID` 正确。
- 客户端 `expectedAgentId` 没有沿用其他环境值。

不要为了绕过错误而删除 `expectedAgentId`。生产环境应固定逻辑身份。

### `Remote agent has no trusted active signing key`

原因：

- `trustedServerKeys` 是空映射，且 Agent Card 没有非 revoked 公钥。
- 固定公钥配置未正确装载。

生产修复应更新可信 key 配置，不应临时接受未知公钥。

### `Remote challenge signature is invalid`

检查：

- `challenge.serverKeyId` 是否存在于 `trustedServerKeys`。
- 固定公钥是否属于当前服务端私钥。
- 服务端是否刚完成密钥轮换。
- 中间件是否修改了 challenge JSON 字段。
- 客户端系统时间是否导致 challenge 被判过期。

## 6. 调用方认证

### `UNKNOWN_KEY: Peer key is not registered`

服务端缺少精确的二元组：

```text
client identity.agentId
+ client identity.keyId
```

注册：

```ts
peers.register({
  agentId: clientIdentity.agentId,
  keyId: clientIdentity.keyId,
  publicKey: clientIdentity.publicKey,
  grantedScopes: ["tasks:execute"],
});
```

如果客户端每次启动都调用 `generateSigningIdentity()`，key ID 和公钥会改变。跨进程或跨重启环境必须加载持久客户端身份。

### `Peer key is revoked`

该 key 已被 `peers.revoke(agentId, keyId)` 撤销。旧 Session 也会在下一次消息认证时失效。

修复方式是完成密钥轮换并注册新 key，而不是把旧 key 重新标记为可信。

### `Authentication challenge is missing, expired, or already used`

可能原因：

- challenge 超过 TTL。
- 同一个 proof 被提交两次。
- 多副本部署中，challenge 在副本 A 创建、在副本 B 验证。
- 进程在 challenge 和 verify 之间重启。

单实例先检查延迟和时间同步。多副本需要共享 challenge 存储或临时使用认证粘性路由。

### Session 经常 401

检查：

- `A2A_SESSION_TTL_MS` 是否过短。
- `sessionRefreshMarginMs` 是否大于或接近 Session TTL。
- 请求是否被分发到没有该 Session 的另一个副本。
- Peer key 是否被撤销。
- 网关是否移除了 `Authorization`。

## 7. 消息校验和签名

### `INVALID_SIGNATURE`

常见原因：

- 签名后修改了 payload。
- 签名后修改了 recipient、TTL、scope、trace 或扩展字段。
- 服务端 Peer Registry 中公钥错误。
- 自定义传输对 JSON 做了语义变化，例如丢字段或改变数字。
- 用 key-1 签名但 `security.keyId` 指向 key-2。

正确模式：

```ts
const signed = createSignedMessage(identity, input);
await client.sendSigned(signed);
```

签名后把消息当作不可变值。重试也复用同一对象。

### `Session identity does not match the signed message`

Session 的 `agentId/keyId` 与消息 `sender/security.keyId` 不一致。通常是：

- 多个客户端身份错误复用了同一个 `A2AClient` 或 Session。
- 手工构造消息时 sender 错误。
- 轮换密钥后继续复用旧 Session。

为每个身份创建独立 `A2AClient`。

### `MESSAGE_EXPIRED`

有效截止：

```text
createdAt + ttlMs + allowedClockSkewMs
```

检查：

- 客户端和服务端时钟。
- 排队和重试总时长。
- 消息是否被离线保存后过晚发送。

过期消息必须重新创建和签名。高价值操作仍使用相同业务 `idempotencyKey`，由服务端持久层判断是否已经执行。

### `Message creation time is too far in the future`

客户端时钟比服务端快，超过 `allowedClockSkewMs`。优先修复 NTP，不要直接无限放大时钟偏差。

### `RECIPIENT_MISMATCH`

`message.recipient` 必须等于接收节点的 Agent ID，或显式为 `*`。

生产中慎用广播接收人 `*`，因为业务语义和授权仍需要明确约束。

## 8. 授权错误

### `AUTHORIZATION_DENIED`

排查三个集合：

```text
客户端 requestedScopes
服务端 PeerRegistry.grantedScopes
handler.requiredScopes + message.requiredScopes
```

Session 最终 scopes 是前两个集合的交集，且必须覆盖第三个集合。

示例：

```text
requested = [tasks:execute]
granted   = [tasks:read]
session   = []
handler   = [tasks:execute]
result    = AUTHORIZATION_DENIED
```

错误 `details.missingScopes` 会列出缺失项。不要通过把 peer 改成 `["*"]` 作为常规修复，应准确配置需要的 scope。

## 9. 处理器和 ACK

### `HANDLER_NOT_FOUND`

Agent Card 声明 capability 不会自动注册 handler。需要：

```ts
node.registerHandler("request", handler, {
  requiredScopes: ["tasks:execute"],
});
```

同一个 kind 只能有一个 handler。应用内需要多路分发时，在该 handler 内根据 payload 的操作字段路由。

### 客户端收到 422

这通常表示服务端 handler 已运行并返回 `rejected` ACK + 签名 error。检查捕获到的 `A2AError`：

```ts
try {
  await client.send(input);
} catch (error) {
  if (error instanceof A2AError) {
    console.error({
      code: error.code,
      message: error.message,
      retriable: error.retriable,
      details: error.details,
    });
  }
}
```

客户端不会自动重试 handler 422，即使 payload 中标为 retriable。业务如需再次尝试，应明确创建新消息，并复用业务 `idempotencyKey`。

### 收到 `duplicate` ACK

含义是服务端已见过同一 `sender + message.id`，并返回缓存结果。它通常发生在第一次响应丢失后。

检查：

- `delivery.messages` 中是否包含原 response。
- 客户端是否错误地重复调用了 `sendSigned()`。
- 网络或代理是否在首次响应后断开。

`duplicate` 不表示 handler 被再次执行。

## 10. 状态同步

### `State namespace X does not match Y`

发送方和接收方 `ReplicatedState` 必须使用相同 namespace：

```ts
new ReplicatedState("agent://alpha", "workflow");
new ReplicatedState("agent://beta", "workflow");
```

### 数据没有双向同步

`state-delta` handler 会在 response 中返回反向 delta，但调用方需要显式应用：

```ts
const response = delivery.messages.find(
  (message) => message.kind === "state-delta",
);

if (response) {
  localState.applyDelta(response.payload as StateDelta);
}
```

### 已删除数据重新出现

通常是 tombstone 被过早清理。删除必须作为状态 entry 传播。只有确认所有副本都观察到对应 vector clock 后，才能压缩 tombstone。

### 并发结果不符合业务优先级

当前冲突规则是：

```text
updatedAt
  -> updatedBy
  -> canonical JSON
```

它保证确定性收敛，不表达角色权重或审批优先级。需要业务优先级时，应在 value 中加入明确版本/权重并实现领域合并器，或使用事务系统。

## 11. 载荷加密

### `Encrypted payload metadata does not match the recipient`

`recipientKeyId` 与解密身份的 key ID 不一致。检查是否选择了正确环境和轮换版本。

### `Encrypted payload authentication failed`

可能原因：

- 密文、IV、auth tag 或临时公钥被损坏。
- 解密私钥不匹配。
- 两端 associated data 不一致。

Associated data 区分大小写，并按 UTF-8 字节精确匹配。

### 为什么用了载荷加密仍需要 HTTPS

载荷加密不保护：

- Authorization Bearer token。
- URL 和 HTTP headers。
- Agent ID、消息 kind、时间和大小等信封元数据。
- 流量模式。

因此公网 HTTP 仍不安全。

## 12. 错误码速查

| 错误码 | 常见状态 | 默认可重试 | 主要动作 |
| --- | ---: | --- | --- |
| `CONFIGURATION_ERROR` | 500 | 否 | 修复启动配置 |
| `INVALID_MESSAGE` | 400 | 否 | 校验字段、JSON、时间和格式 |
| `UNSUPPORTED_VERSION` | 400 | 否 | 协商或升级协议 |
| `AUTHENTICATION_REQUIRED` | 401 | 否 | 客户端会尝试重新认证一次 |
| `AUTHENTICATION_FAILED` | 401 | 否 | 检查 challenge、身份和固定公钥 |
| `AUTHORIZATION_DENIED` | 403 | 否 | 修复 scope 配置 |
| `INVALID_SIGNATURE` | 401 | 否 | 检查篡改、密钥和序列化 |
| `UNKNOWN_KEY` | 401 | 否 | 注册或轮换 peer key |
| `REPLAY_DETECTED` | 具体实现 | 否 | 当前常量已定义，参考管线以 duplicate ACK 处理消息重放 |
| `MESSAGE_EXPIRED` | 408 | 否 | 创建新消息并检查时钟 |
| `RECIPIENT_MISMATCH` | 400 | 否 | 修复 recipient 或路由 |
| `HANDLER_NOT_FOUND` | 404 | 否 | 注册对应 kind handler |
| `PAYLOAD_TOO_LARGE` | 413 / 502 | 否 | 缩小消息或提高受控限制 |
| `RATE_LIMITED` | 429 | 是 | 退避并降低速率 |
| `CONFLICT` | 409 | 否 | 检查重复 handler/codec 或 namespace |
| `HANDLER_FAILED` | 422 | 由业务定义 | 检查签名 error details |
| `TRANSPORT_FAILED` | 502 / 503 | 是 | 检查网络、代理和返回 JSON |
| `INTERNAL_ERROR` | 500 | 是 | 查看服务端内部日志 |

## 13. 收集诊断信息

建议提供以下非敏感信息：

```text
Node.js 版本
包版本
运行命令
Agent ID 和 key ID
endpoint 与 listen host/port
envPath 和 envLoaded
HTTP 状态
A2A error code/message
message ID / conversation ID / trace ID
是否单实例或多副本
是否经过代理
两端当前 UTC 时间
```

不要提交：

```text
私钥 PEM
Bearer token
challenge proof signature
生产敏感 payload
完整未脱敏环境变量
```
