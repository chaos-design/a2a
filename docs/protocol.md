# A2A/1.0 协议规范

## 1. 目标与边界

A2A/1.0 用于不同实现、不同能力的自治智能体交换命令、请求、事件、响应与复制状态。协议保证：

- 发送方身份可验证，消息信封和载荷不可被静默篡改。
- 接收方先认证和授权，再执行处理器。
- 临时网络故障可自动重试，同一消息不会重复执行处理器。
- 消息可关联为会话和因果链，并携带分布式追踪上下文。
- 状态可通过向量时钟执行双向增量同步。
- 新消息类型、内容类型、传输和扩展字段无需修改核心协议。

协议不替代业务事务、持久化消息队列、服务发现注册中心或密钥管理系统。参考实现给出这些系统的接入边界。

## 2. 协议分层

| 层 | 职责 |
| --- | --- |
| 发现层 | Agent Card 发布身份、公钥、端点、能力和限制 |
| 会话层 | 挑战响应认证，签发短期 Bearer token |
| 消息层 | 版本化信封、签名、寻址、关联、TTL 和扩展 |
| 传输层 | HTTP 或进程内适配器；可实现其他 `ClientTransport` |
| 可靠性层 | ACK、超时、重试、去重和结果缓存 |
| 应用层 | 按消息 kind 注册处理器并声明所需 scope |
| 状态层 | 快照、delta、向量时钟和并发冲突决议 |

## 3. 智能体发现

接收方在以下端点发布 Agent Card：

```http
GET /.well-known/a2a-agent.json
```

Agent Card 包含：

- `agentId`：稳定、全局唯一的逻辑身份。
- `protocolVersions`：支持的协议版本。
- `endpoint` 和 `transports`：可用传输。
- `publicKeys`：当前签名公钥及其轮换状态。
- `capabilities`：能力、消息类型和所需 scope。
- `limits`：最大消息字节数与最大 TTL。

生产客户端必须校验预期的 `agentId`，并通过固定公钥、私有 PKI 或可信注册中心验证 Agent Card 中的公钥。仅通过未验证的 Agent Card 建立信任属于 TOFU，不适合高风险场景。

## 4. 身份验证与授权

### 4.1 挑战响应

1. 调用方提交 `agentId`、`keyId` 和请求的 scopes。
2. 接收方从受信任 Peer Registry 查找 Ed25519 公钥，生成 256-bit 随机 challenge，并使用服务端身份密钥签名。
3. 调用方通过固定或可信发现的服务端公钥验证 challenge，确认 audience、请求 scopes 和有效期。
4. 调用方对同一份确定性 challenge proof material 签名。
5. 接收方一次性消费 challenge、验签，并只授予注册权限与请求权限的交集。
6. 接收方签发短期、不透明的 Bearer token。

Challenge proof material 为以下对象的确定性 JSON：

```json
{
  "agentId": "agent://worker",
  "audience": "agent://coordinator",
  "challenge": "base64url-random-value",
  "challengeId": "019...",
  "expiresAt": "2026-09-07T10:00:30.000Z",
  "keyId": "sig-key-1",
  "protocol": "1.0",
  "purpose": "session-authentication",
  "requestedScopes": [
    "tasks:execute"
  ],
  "serverKeyId": "coordinator-key-1"
}
```

服务端和调用方分别对上述材料签名，服务端签名作为 `serverSignature` 随 challenge 返回。Challenge 默认 30 秒过期且只能使用一次。Session 默认 15 分钟过期。Bearer token 只通过 `Authorization` 请求头传输。

### 4.2 双重身份约束

每条消息同时满足以下条件才会进入处理器：

- Session 中的 `agentId` 等于消息 `sender`。
- Session 中的 `keyId` 等于消息 `security.keyId`。
- Peer Registry 中对应密钥仍为 active。
- Ed25519 消息签名有效。
- Session scopes 覆盖处理器声明和消息附加声明的全部 scopes。

撤销 Peer Registry 中的密钥会立即使该密钥对应的现有 Session 失效。

## 5. 消息格式

### 5.1 完整信封

```json
{
  "protocol": "1.0",
  "id": "31f39781-70dd-4330-b95f-2dc82a1bb4d4",
  "kind": "request",
  "sender": "agent://worker",
  "recipient": "agent://coordinator",
  "createdAt": "2026-09-07T10:00:00.000Z",
  "ttlMs": 30000,
  "sequence": 0,
  "contentType": "application/json",
  "payload": {
    "task": "summarize",
    "input": "..."
  },
  "conversationId": "conversation-42",
  "idempotencyKey": "task-42",
  "requiredScopes": [
    "tasks:execute"
  ],
  "trace": {
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "traceFlags": "01"
  },
  "extensions": {
    "x-priority": "high"
  },
  "security": {
    "keyId": "sig-key-1",
    "algorithm": "Ed25519",
    "payloadDigest": "base64url-sha256",
    "signature": "base64url-ed25519-signature"
  }
}
```

### 5.2 字段语义

| 字段 | 必需 | 语义 |
| --- | --- | --- |
| `protocol` | 是 | 固定为 `1.0` |
| `id` | 是 | 消息唯一 ID，也是传输去重键 |
| `kind` | 是 | 内置类型或 `x-*` 扩展类型 |
| `sender` / `recipient` | 是 | 逻辑 Agent ID；`recipient` 可为 `*` |
| `createdAt` / `ttlMs` | 是 | 消息有效窗口 |
| `sequence` | 是 | 会话内发送方序号；用于观察，不作为并发 HTTP 的阻塞条件 |
| `contentType` | 是 | 载荷 Codec 标识 |
| `payload` | 是 | JSON 值；二进制使用 base64url Codec |
| `conversationId` | 否 | 多轮会话标识 |
| `correlationId` | 否 | 响应或 ACK 对应的原消息 ID |
| `causationId` | 否 | 直接触发当前消息的消息 ID |
| `idempotencyKey` | 否 | 业务幂等键；跨 TTL 或跨服务重启时由业务持久化 |
| `requiredScopes` | 否 | 发送方要求接收方额外执行的授权约束 |
| `trace` | 否 | W3C 风格追踪上下文 |
| `extensions` | 否 | 键名必须以 `x-` 开头 |
| `security` | 是 | 摘要、签名算法、密钥 ID 和签名 |

### 5.3 消息类型

- `request`：期望一个 `response`。
- `command`：执行操作，响应载荷可选。
- `event`：事实通知，响应载荷可选。
- `response`：业务响应。
- `ack`：传输与处理结果。
- `error`：结构化、已签名的处理错误。
- `state-delta`：增量状态交换。
- `state-snapshot`：完整状态快照交换。
- `x-*`：应用自定义消息类型。

## 6. 确定性签名

签名步骤：

1. 对 `payload` 执行确定性 JSON 序列化并计算 SHA-256，结果使用无填充 base64url。
2. 构造 `security = { keyId, algorithm, payloadDigest }`，此时不包含 `signature`。
3. 对完整信封执行确定性 JSON 序列化：对象键按 Unicode 顺序排列，数组保持顺序，拒绝 `undefined`、非有限数字和非 JSON 对象。
4. 使用发送方 Ed25519 私钥签名 UTF-8 字节。
5. 将无填充 base64url 签名写入 `security.signature`。

接收方先重新计算载荷摘要，再验证完整信封签名。信封中的收件人、TTL、scope、追踪信息和载荷均受签名保护。

## 7. 传输与可靠性

### 7.1 HTTP 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/.well-known/a2a-agent.json` | 发现 |
| `POST` | `/a2a/v1/auth/challenge` | 请求 challenge |
| `POST` | `/a2a/v1/auth/verify` | 提交 proof，获取 Session |
| `POST` | `/a2a/v1/messages` | 发送已签名消息 |

所有 POST 使用 `application/json`。消息接口使用 `Authorization: Bearer <token>`。公网必须使用 HTTPS。

### 7.2 ACK

接收方返回已签名 ACK：

- `completed`：处理器执行完成。
- `rejected`：处理器执行但返回协议错误。
- `duplicate`：相同发送方和消息 ID 已处理，返回缓存响应。
- `accepted`：为异步队列扩展保留。

### 7.3 重试与幂等

客户端仅对超时、连接错误、`429` 和 `5xx` 等可重试传输错误执行指数退避。每次重试复用完全相同的已签名消息和消息 ID。

接收方在消息 TTL 加时钟偏差窗口内缓存处理结果。若第一次处理已完成但响应丢失，重试返回 `duplicate` ACK 和原响应，不再次调用处理器。因此参考实现提供：

- 传输：至少一次尝试。
- 单节点、去重保留窗口内的处理器：效果一次。

跨进程重启、跨副本或超过 TTL 的业务效果一次语义必须使用共享 inbox/outbox，并以 `idempotencyKey` 建立持久唯一约束。

## 8. 错误处理

| 错误码 | 常见 HTTP | 可重试 |
| --- | ---: | --- |
| `INVALID_MESSAGE` | 400 | 否 |
| `UNSUPPORTED_VERSION` | 400 | 否 |
| `AUTHENTICATION_REQUIRED` | 401 | 否，重新认证后可重发 |
| `AUTHENTICATION_FAILED` | 401 | 否 |
| `AUTHORIZATION_DENIED` | 403 | 否 |
| `INVALID_SIGNATURE` / `UNKNOWN_KEY` | 401 | 否 |
| `MESSAGE_EXPIRED` | 408 | 否，需创建新消息 |
| `PAYLOAD_TOO_LARGE` | 413 | 否 |
| `RATE_LIMITED` | 429 | 是 |
| `HANDLER_NOT_FOUND` | 404 | 否 |
| `HANDLER_FAILED` | 422 | 由业务决定是否以新消息重试 |
| `TRANSPORT_FAILED` | 503 | 是 |
| `INTERNAL_ERROR` | 500 | 是 |

认证、验签、路由等前置错误使用非 2xx HTTP 响应。处理器错误使用 `rejected` ACK 加已签名 `error` 消息，避免把传输失败与业务失败混淆。

## 9. 端到端载荷加密

`encryptJson` 使用临时 X25519 密钥交换、HKDF-SHA256 派生和 AES-256-GCM：

- 每个载荷生成新的临时 X25519 密钥。
- `recipientKeyId` 进入 HKDF context。
- 调用方可把消息 ID 或业务上下文作为 GCM associated data。
- 加密后的对象作为普通 `payload`，随后再对完整消息签名。

推荐顺序是先加密、后签名；接收方先验签、后解密。TLS 仍然必需，因为它保护端点元数据、Session token 和流量分析边界。

## 10. 状态同步

`ReplicatedState` 是按 key 的 LWW Map：

1. 每个智能体维护 `VectorClock = { agentId: counter }`。
2. 本地 `set` 或 `delete` 递增本智能体 counter，并把完整时钟写入 entry。
3. `createDelta(remoteClock)` 只返回远端尚未观察到的 entry。
4. 因果更新覆盖旧值。
5. 并发更新按 `updatedAt`、`updatedBy`、确定性 entry JSON 依次决议，确保所有副本收敛。
6. 删除操作以 tombstone 传播，不能在所有副本确认前单独清理。

`state-delta` 处理器应用收到的 delta，并返回发送方缺失的反向 delta，可在一次往返内完成常见双向同步。对强一致余额、锁或唯一资源分配，应使用共识数据库而不是 LWW 状态。

## 11. 扩展规则

- 自定义消息 kind 必须使用 `x-` 前缀。
- 自定义信封扩展放入 `extensions`，键名必须使用 `x-` 前缀。
- 新载荷格式通过 `CodecRegistry` 注册，并在 Agent Card 的 `contentTypes` 声明。
- 新传输实现 `ClientTransport`，必须保持完整信封字节语义，不能在途中修改已签名字段。
- 不理解的 `x-*` 扩展可保留并转发；不能让扩展改变核心认证、寻址或 TTL 语义。

## 12. 生产安全清单

- 使用 TLS 1.3，并校验服务端证书。
- 固定 Agent ID 与签名公钥，建立密钥轮换和撤销流程。
- 私钥存入 KMS/HSM；示例中的进程内 `KeyObject` 仅用于开发。
- challenge、Session 和去重记录使用共享、带 TTL 的原子存储。
- 在网关和 Agent ID 维度增加请求速率、并发和消息大小限制。
- 同步 NTP，并保持允许时钟偏差足够小。
- 日志记录消息 ID、Agent ID、错误码和 trace ID，不记录 token、私钥或明文敏感载荷。
- 对高价值副作用使用持久 inbox/outbox 和业务幂等唯一约束。
- 对状态同步限制 namespace、key 数量、delta 大小和 tombstone 保留策略。
