# Agent Note: WeFlow 推送被服务端禁用时的重连风暴

Status: implemented

## Problem

2026-09-28 起，bot 的 stderr 里每秒一行
`[cyberboss] WeFlow push reconnecting: WeFlow message push returned HTTP 403`
（当天两份服务日志分别 3605 行与 419 行，此前几天 0 行；任务直启的
`bot-direct.err.log` 涨到 1 MB）。

直接打端点确认了根因：

```
GET /api/v1/health          -> 200 {"status":"ok"}
GET /api/v1/messages?...    -> 200 {"success":true,...}
GET /api/v1/push/messages   -> 403 {"error":"Message push is disabled"}
```

也就是说 **不是鉴权坏了，是 WeFlow 服务端把消息推送关掉了**（本部署只有轮询可用）。
而 `weflow-inbox.js` 的推送循环把任何异常都当成"断线重连"：`assertHttpOk` 抛错 → 记一行 error →
等 `DEFAULT_RECONNECT_DELAY_MS`（1000ms）→ 重来。于是一个**永远不会成功**的请求被无限重试，
日志、CPU 与 SSE 握手全白费；真正在干活的轮询循环（`runOutgoingPollLoop`，独立的 promise）反而
被这堆噪声淹没了。

## Decision

在 `src/integrations/weflow-inbox.js` 里区分"暂时性失败"和"服务端明确拒绝"：

1. `consumePushStream` 在 `assertHttpOk` 之前先看状态码：`401`/`403` 直接抛一个带
   `pushDisabled` 标记的错误（正文形如 `Message push is disabled`，说明这是策略而非故障）。
2. `runLoop` 的 catch 里识别该标记：**只记一行** `WeFlow message push is disabled by the server;
   polling only (HTTP 403)`，然后 `break` 退出推送循环。
3. 其它错误保持原样的重连行为（不改变既有语义）。

选 `break` 而不是"退避到 60 秒再试"：服务端关闭推送是**进程生命周期内的稳定事实**，重试没有
恢复路径；轮询已经是完整可用的收消息通道，继续试探只会持续制造噪声。若将来服务端开启推送，
重启 bot 即可恢复。

## Alternatives considered

- **只把退避拉长（例如 60s 一次）**：噪声小了，但仍在为一个确定不会成功的请求付代价，而且日志
  里会永远留着看不懂的 403；一旦真出故障，这行噪声还会掩盖它。
- **把 403 当作健康问题让心跳去修**：修不了——这是服务端策略，重启 bot 也不会变；反而会把
  "推送被禁用"升级成假的管线故障。
- **改 WeFlow 服务端配置开启推送**：属于另一个程序（session 3 的 WeFlow），改它需要它的配置
  面；而当前轮询已满足收发，收益不足以承担风险。留作后续可选项。
- **什么都不做（只忽略日志）**：日志是排查入口，1MB/天的噪声会淹掉真正的错误（本次就是靠它才
  发现 403 的）。

## Consequences

收益：

- 实测重启后新增日志为 3 行（其中 2 行是旧进程临死前写的），**之后 45 秒 0 行**；修复前是 ~1 行/秒。
- 推送不可用时明确降级为"polling only"，状态可读、可检索，不再是无限重连的噪声。
- 轮询通道不受影响（本来就是它承载全部流量）。

代价与边界：

- 推送流被永久放弃（本进程内），所以消息到达依赖轮询周期，不是事件驱动；这是服务端的既有限制，
  不是本次改动引入的。
- 只对 401/403 生效；如果服务端返回 404（路径不存在）或 5xx，仍走原来的重连路径——那类确实
  可能是暂时性的。
- 没有为它加自动化回归（推送是 HTTP 流式接口，离线桩成本高于收益）；验证方式是本文档记录的
  端点探测 + 重启后日志行数对比。
