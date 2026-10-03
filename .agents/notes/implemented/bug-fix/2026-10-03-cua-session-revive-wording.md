# Agent Note: 会话结束的判据跟不上驱动的措辞，机器人静默失声

Status: implemented

## Problem

2026-10-03 生产实测：机器人有一段时间**完全发不出去**，日志里反复出现

```
[cyberboss] deferred retry failed sender=文件传输助手 count=1 requeued=1 givenUp=0:
  driver call list_windows failed: {"refusal":{"code":"session_ended",
  "message":"session 'cyberboss-out-6780' has ended; call start_session with
  session 'cyberboss-out-6780' to start it again, or use a new session label"}}
```

驱动是健康的（换一个进程用同样的标签调 `list_windows` 立刻成功），坏的是**判据**。

`CuaSession.call()` 本来就设计了自愈：识别到"会话没了"就 `revive()`（`start_session` 同一标签）再重试一次。但它的正则写的是 0.31.0 **早期**的措辞：

```js
const SESSION_ENDED = /session has ended/i;   // 匹配 "session has ended; tool call ..."
```

而当前构建把标签插进了句子中间：`session 'cyberboss-out-6780' has ended`。正则不匹配 → `revive()` 从不执行 → 每一次发送都直接失败。

**触发条件是"空闲"**：驱动会回收空闲会话，所以刚启动时能发（13:05 启动、13:06 回复成功），闲置一段时间后所有出站全部失败——而失败信息长得像驱动挂了，排查方向会被带偏。

## Decision

判据改成同时认**结构化错误码**和两种措辞：

```js
const SESSION_ENDED = /session (?:'[^']*' )?has ended|session_ended/i;

function isSessionEnded(res) {
  if (!res?.__failed) return false;
  if (res.payload?.refusal?.code === "session_ended") return true;   // 权威信号
  return SESSION_ENDED.test(String(failureText(res)));              // 兜底
}
```

优先认 `refusal.code`：措辞会随构建变化（这次就是），错误码不会。

## Evidence

单元（`test/cua-session-revive.test.js`，4 项）：当前措辞触发 revive+重试、旧措辞仍兼容、只有错误码也能触发、无关拒绝**不**重试（避免把真实拒绝变成重试风暴）。

生产：重启后卡住的积压立刻出清，聊天里出现真正的回答——

```
[cyberboss] deferred retry delivered sender=文件传输助手 count=1
[cyberboss] deferred retry delivered sender=柳毓琳 count=2
```

且模型确实看到了图（附件链路同批验证）：「啥意思 / 两张图收到了：一张是 Timeline 仪表盘截图——上面一排统计数字，中间时间轴甘特图，下面饼图、环形图、柱状图三块…」。

## Alternatives considered

1. **每次发送都先 `start_session`。** 否决：多一次 ~150ms 驱动调用，而且把"会话还活着"这个正常情况当成异常处理；错误码驱动的自愈已经够用。
2. **给会话加心跳保活（定时 start_session）。** 否决：在长时间空闲时白白占用驱动会话，且驱动的回收策略一变就又失效；按需自愈不依赖对回收策略的假设。
3. **只把正则放宽。** 部分采纳但不够：措辞已经变过一次，下次还会变；所以结构化错误码是一等判据。

## Consequences

- 出站不再因为"闲置过"而整体失声；任何一次被拒绝的调用都会先尝试自愈再重试一次（有界，不会变成重试循环）。
- 仍存在的边界：如果 `start_session` 本身也失败，调用会失败并照常进入延迟重试队列——这是对的，因为"驱动真的不可用"必须能和"会话标签过期"区分开。
- 这一条与数据库入站无关，是 Cua 写侧早就存在的缺陷；它之所以在这次暴露，是因为读侧换成数据库后不再依赖驱动，驱动会话得以长期空闲。
