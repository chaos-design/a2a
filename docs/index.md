# A2A/1.0 文档中心

这套文档按实际接入顺序组织。第一次使用只读“快速开始”和“配置指南”；需要排查协议行为时再进入架构、数据流和协议规范。

## 推荐阅读路径

### 路径 A：先跑起来

1. [快速开始](./quick-start.md)：运行 Demo，并完成第一个服务端和客户端。
2. [配置指南](./configuration.md)：确定 Agent ID、端口、密钥和 scopes。
3. [排障指南](./troubleshooting.md)：根据错误码定位问题。

### 路径 B：理解协议

1. [可交互架构 Slider](./architecture-slider.html)：用 20 个页面建立完整认知，包含 Mermaid 全链路、Fan-out/Fan-in、消息契约、状态同步和运维容量。
2. [架构说明](./architecture.md)：理解模块边界、信任边界和处理顺序。
3. [数据流详解](./data-flow.md)：逐步跟踪发现、认证、发送、重试、加密和同步。
4. [协议规范](./protocol.md)：查看线格式和规范约束。

### 路径 C：准备生产

1. [配置指南](./configuration.md)：切换到持久身份和明确的配置文件。
2. [生产部署](./deployment.md)：增加 TLS、共享存储、限流、可观测性和密钥轮换。
3. [OpenAPI 3.1](../openapi.yaml)：对接网关或生成 HTTP SDK。

## 文档地图

| 文档 | 解决的问题 | 适合读者 |
| --- | --- | --- |
| [quick-start.md](./quick-start.md) | 怎么安装、运行、写服务端和客户端 | 首次接入者 |
| [configuration.md](./configuration.md) | `.env` 怎么加载，每个值怎么选 | 开发、运维 |
| [architecture.md](./architecture.md) | 各模块为什么存在，边界在哪里 | 架构师、维护者 |
| [data-flow.md](./data-flow.md) | 数据逐跳如何变化，失败如何返回 | 开发、排障人员 |
| [deployment.md](./deployment.md) | 单机参考实现如何扩展到生产 | 平台、SRE、安全 |
| [troubleshooting.md](./troubleshooting.md) | 常见报错如何定位和修复 | 所有人 |
| [protocol.md](./protocol.md) | 线协议、签名、错误与扩展规则 | 协议实现者 |
| [api.md](./api.md) | TypeScript API 的参数和用法 | SDK 使用者 |
| [architecture-slider.html](./architecture-slider.html) | 用交互页面演示核心思路和数据流 | 评审、分享、培训 |

## 三个最重要的概念

### 1. 身份、Session 和消息签名是三层不同的校验

- `PeerRegistry` 决定“这个 Agent 的这把公钥是否可信，以及最多拥有哪些 scopes”。
- Challenge / Session 决定“当前请求是否来自刚刚证明过私钥持有权的对端”。
- 消息签名决定“这条消息的发送方、收件人、TTL、scope、追踪信息和载荷是否被篡改”。

任一层失败，业务处理器都不会执行。

### 2. 重试复用同一条已签名消息

客户端发生可重试传输错误时，不生成新消息，不更换消息 ID。服务端以 `sender + message.id` 去重并返回第一次的缓存结果，因此响应丢失不会重复执行处理器。

这只覆盖单进程和去重保留窗口。跨副本、跨重启和高价值副作用必须增加共享 inbox/outbox 与业务唯一约束。

### 3. 状态同步是最终一致，不是事务系统

`ReplicatedState` 用向量时钟判断因果关系，用确定性规则解决并发写入。它适合工作流进度、缓存元数据和协作状态，不适合余额、锁、库存扣减或唯一资源分配。

## 快速命令

```bash
npm install
npm test
npm run check
npm run demo
```

直接打开 [architecture-slider.html](./architecture-slider.html) 即可离线演示，不需要开发服务器、CDN 或外部资源。
