# 快速开始

本章只解决三个问题：

1. 如何确认项目可运行。
2. 如何启动一个接收消息的 Agent。
3. 如何让另一个 Agent 完成认证并发送消息。

协议原理和生产部署细节可以稍后阅读。

## 1. 环境要求

- Node.js 20 或更高版本。
- npm 9 或更高版本。
- 本地 HTTP Demo 不需要数据库、证书或外部服务。

检查环境：

```bash
node --version
npm --version
```

安装并验证：

```bash
npm install
npm test
npm run check
```

## 2. 运行内置 Demo

```bash
npm run demo
```

Demo 位于 `examples/http-demo.ts`，会在一个进程内创建：

- `agent://local`：服务端 coordinator。
- `agent://worker`：客户端 worker。
- `PeerRegistry`：coordinator 对 worker 公钥和 scope 的信任记录。
- `A2AClient`：自动执行发现、认证、签名发送、重试和响应验签。

完整调用顺序：

```text
AgentProvider -> 读取 .env/默认值
              -> 创建 coordinator 身份与 A2ANode

worker -> GET Agent Card
       -> POST challenge
       -> 验证 coordinator 的 challenge 签名
       -> 签名 challenge proof
       -> POST verify，获得短期 Session
       -> 签名 request
       -> POST message
       -> 验证 ACK 和 response 的签名
```

端口冲突时：

```bash
A2A_DEMO_PORT=4320 npm run demo
```

## 3. 最小心智模型

服务端只需要记住四个对象：

| 对象 | 作用 |
| --- | --- |
| `AgentProvider` | 从 `.env` 读取监听地址、限制和服务端身份 |
| `PeerRegistry` | 声明允许哪些调用方公钥访问哪些 scopes |
| `A2ANode` | 执行认证、验签、授权、去重和处理器调用 |
| HTTP Server | 把 `A2ANode` 暴露为四个 HTTP 端点 |

客户端只需要记住三个对象：

| 对象 | 作用 |
| --- | --- |
| `SigningIdentity` | 客户端 Agent ID 和 Ed25519 密钥 |
| `HttpTransport` | 访问目标 Agent 的 HTTP 端点 |
| `A2AClient` | 自动发现、认证、签名、重试和验签 |

## 4. 创建服务端

下面代码展示服务端的必要步骤。项目内可以直接从 `../src/index.js` 导入；发布为 npm 包后使用 `@a2a/reference`。

```ts
import {
  AgentProvider,
  PeerRegistry,
  generateSigningIdentity,
} from "@a2a/reference";

const provider = new AgentProvider();

// 示例中临时生成调用方身份。真实部署应从安全存储加载其公钥。
const workerIdentity = generateSigningIdentity("agent://worker");

const peers = new PeerRegistry();
peers.register({
  agentId: workerIdentity.agentId,
  keyId: workerIdentity.keyId,
  publicKey: workerIdentity.publicKey,
  grantedScopes: ["tasks:execute"],
});

const node = provider.createNode({
  peers,
  capabilities: [
    {
      name: "summarize",
      description: "Summarize supplied text.",
      messageKinds: ["request"],
      requiredScopes: ["tasks:execute"],
    },
  ],
});

node.registerHandler(
  "request",
  ({ message, principal }) => {
    const input = message.payload as { text: string };
    return {
      payload: {
        summary: input.text.split(/\s+/).slice(0, 8).join(" "),
        handledFor: principal.agentId,
      },
    };
  },
  { requiredScopes: ["tasks:execute"] },
);

const server = await provider.listen(node);
console.log("A2A server listening", server.address());
```

关键约束：

- `PeerRegistry` 中没有调用方公钥时，challenge 请求会直接失败。
- `grantedScopes` 是调用方的权限上限。
- `registerHandler(...requiredScopes)` 是执行该处理器的最低权限。
- 两者必须同时满足，业务处理器才会运行。

## 5. 创建客户端

客户端必须知道目标地址、目标 Agent ID，并在生产环境固定服务端公钥。

```ts
import {
  A2AClient,
  HttpTransport,
} from "@a2a/reference";

const client = new A2AClient({
  identity: workerIdentity,
  transport: new HttpTransport("http://127.0.0.1:4310"),
  requestedScopes: ["tasks:execute"],
  expectedAgentId: provider.identity.agentId,
  trustedServerKeys: {
    [provider.identity.keyId]: provider.identity.publicKey,
  },
});

const remote = await client.connect();

const delivery = await client.send({
  kind: "request",
  recipient: remote.agentId,
  conversationId: "summary-session-1",
  idempotencyKey: "summary-job-42",
  payload: {
    text: "A2A verifies identity before executing an agent request.",
  },
});

console.log(delivery.ack.payload.status);
console.log(delivery.messages[0]?.payload);
```

`send()` 会自动调用 `connect()`，所以显式 `connect()` 不是必需的。显式调用的好处是启动时就能发现信任配置、协议版本或权限问题。

## 6. 配置 `.env`

从模板开始：

```bash
cp .env.example .env
```

本地服务端的最小配置：

```dotenv
A2A_AGENT_ID=agent://coordinator
A2A_AGENT_NAME=Coordinator
A2A_ENDPOINT=http://127.0.0.1:4310
A2A_LISTEN_HOST=127.0.0.1
A2A_LISTEN_PORT=4310
```

配置读取优先级从高到低：

```text
构造参数 environment / 进程环境变量
  > 指定 .env 文件中的值
  > 内置默认值
```

配置文件路径优先级：

```text
new AgentProvider({ envPath })
  > A2A_ENV_PATH
  > $PWD/.env
```

使用其他配置文件：

```bash
A2A_ENV_PATH=./config/coordinator.env node app.js
```

或在代码中：

```ts
const provider = new AgentProvider({
  envPath: "./config/coordinator.env",
  requireEnvFile: true,
});
```

完整字段、推荐值和生产配置见 [配置指南](./configuration.md)。

## 7. 消息类型怎么选

| 类型 | 何时使用 | 典型返回 |
| --- | --- | --- |
| `request` | 查询或需要业务结果 | ACK + `response` |
| `command` | 要求执行一个动作 | ACK，可选 `response` |
| `event` | 发布已经发生的事实 | ACK，可选 `response` |
| `state-delta` | 交换增量状态 | ACK + 反向 delta |
| `state-snapshot` | 初始化或修复完整状态 | ACK + 应用结果 |
| `x-*` | 项目自定义语义 | 由处理器决定 |

`response`、`ack` 和 `error` 通常由服务端运行时产生，业务调用方不需要手工创建。

## 8. 一条成功消息返回什么

`client.send()` 返回 `DeliveryBundle`：

```ts
type DeliveryBundle = {
  ack: A2AMessage<AckPayload>;
  messages: A2AMessage[];
};
```

- `ack.payload.status === "completed"`：处理器已成功执行。
- `ack.payload.status === "duplicate"`：相同消息已执行，返回的是缓存结果。
- `messages[0]`：处理器返回的签名 `response`。
- 处理器返回 `void` 时，`messages` 为空。
- 处理器抛出错误时，客户端会把签名 `error` 转换为 `A2AError`。

## 9. 下一步

- 配置 Agent 身份、密钥和网络：[配置指南](./configuration.md)
- 理解认证和消息处理顺序：[数据流详解](./data-flow.md)
- 增加状态同步：[API 参考：状态同步](./api.md#状态同步)
- 准备多副本部署：[生产部署](./deployment.md)
