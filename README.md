# A2A/1.0 Reference Implementation

一个用于自治智能体安全通信的 TypeScript 参考实现。它把智能体之间的发现、认证、授权、签名消息、可靠重试和状态同步放进同一套协议流程。

## 5 分钟跑通

要求 Node.js 20 或更高版本。

```bash
npm install
npm test
npm run demo
```

`npm run demo` 会临时启动两个智能体：

```text
worker
  -> 发现 coordinator
  -> 完成 Ed25519 挑战认证
  -> 发送已签名 request
  -> 接收已签名 ACK 和 response
  -> 自动退出
```

正常结果：

```json
{
  "remoteAgent": "agent://local",
  "acknowledgement": {
    "messageId": "...",
    "status": "completed"
  },
  "response": {
    "summary": "A2A messages are authenticated, authorized, signed, and retried",
    "processedBy": "agent://local"
  }
}
```

示例默认监听 `127.0.0.1:4310`。端口冲突时执行：

```bash
A2A_DEMO_PORT=4320 npm run demo
```

## 最小配置

复制示例配置并按需修改：

```bash
cp .env.example .env
```

开发环境只需要关注：

```dotenv
A2A_AGENT_ID=agent://coordinator
A2A_AGENT_NAME=Coordinator
A2A_ENDPOINT=http://127.0.0.1:4310
A2A_LISTEN_HOST=127.0.0.1
A2A_LISTEN_PORT=4310
```

未配置私钥时会生成一次性的 Ed25519 密钥，适合本地调试。生产环境必须配置持久私钥、可信对端、公网 TLS 和共享会话/去重存储。

## 在代码中使用

服务端需要四步：

1. 用 `AgentProvider` 读取配置。
2. 在 `PeerRegistry` 注册允许访问的对端公钥和 scopes。
3. 创建 `A2ANode` 并注册消息处理器。
4. 调用 `provider.listen(node)` 启动 HTTP 服务。

客户端需要三步：

1. 创建自己的签名身份和 `HttpTransport`。
2. 用 `A2AClient` 配置目标 Agent ID、所需 scopes 和可信服务端公钥。
3. 调用 `connect()`，然后用 `send()` 发送消息。

完整可运行代码见 [HTTP 示例](./examples/http-demo.ts) 和 [快速开始](./docs/quick-start.md)。

## 文档入口

| 我想了解 | 文档 |
| --- | --- |
| 第一次运行和接入 | [快速开始](./docs/quick-start.md) |
| `.env` 每个配置项怎么填 | [配置指南](./docs/configuration.md) |
| 各模块如何协作 | [架构说明](./docs/architecture.md) |
| 请求、认证、重试、同步的数据如何流动 | [数据流详解](./docs/data-flow.md) |
| 上生产要补哪些组件 | [生产部署](./docs/deployment.md) |
| 错误码和常见故障 | [排障指南](./docs/troubleshooting.md) |
| 完整线协议 | [协议规范](./docs/protocol.md) |
| TypeScript 类与函数 | [API 参考](./docs/api.md) |
| HTTP 接口定义 | [OpenAPI 3.1](./openapi.yaml) |
| 可交互架构演示 | [Architecture Slider](./docs/architecture-slider.html) |

文档总览见 [docs/index.md](./docs/index.md)。

## 核心能力

| 领域 | 实现 |
| --- | --- |
| 发现 | `GET /.well-known/a2a-agent.json` |
| 认证 | Ed25519 双向挑战证明和短期 Bearer Session |
| 授权 | Peer Registry 授权与处理器 scope 校验 |
| 完整性 | 确定性 JSON、SHA-256 摘要、Ed25519 消息签名 |
| 可靠性 | 超时、指数退避、ACK、消息 ID 去重、结果缓存 |
| 机密性 | TLS 加可选 X25519 / HKDF / AES-256-GCM 载荷加密 |
| 状态同步 | 向量时钟、delta、snapshot、tombstone、确定性冲突合并 |
| 扩展 | `x-*` 消息、Codec 注册表、自定义传输接口 |

## 项目结构

```text
src/
  agent-provider.ts   配置加载、身份创建、服务启动
  auth.ts             对端目录、挑战认证、Session、scope
  client.ts           客户端连接、签名发送、重试、响应验签
  crypto.ts           Ed25519、SHA-256、X25519、AES-GCM
  node.ts             服务端接收管线、处理器、去重缓存
  state-sync.ts       向量时钟与 LWW 状态复制
  transport.ts        HTTP 和进程内传输
  validation.ts       线消息边界校验
docs/
  index.md            文档地图
  architecture-slider.html
examples/
  http-demo.ts        完整双 Agent HTTP 示例
```

## 常用命令

```bash
npm test          # 运行测试
npm run check     # TypeScript 静态检查
npm run build     # 构建 dist/
npm run demo      # 运行端到端 HTTP 示例
```

## License

Apache-2.0
