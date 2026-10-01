# dsh-im-weixin-video

让微信渠道把视频发成**原生视频气泡**（而不是文件消息）的上游补丁。

对象是第三方插件 [`@xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im)（本机装在
`~/.dsh/profiles/web/node_modules/@xmanrui/dsh-im`，当前 v4.21.2）。这里只放补丁与验证脚本，
**不含**该插件的任何副本 —— 上游代码不进本仓库。

背景与取舍见 [Agent Note](../../.agents/notes/proposed/feature/2026-09-30-weixin-native-video-send.md)。

## 为什么是补丁而不是就地改

运行时装的是 `lib/index.js` —— esbuild 打包 + minify 的单文件（8.6 MB）；`src/` 只是随包发布的
源码副本，**不参与运行时加载**，改它不生效。而重建 `lib/` 也走不通：`esbuild`、`dingtalk-stream`、
`undici`、`qrcode`、`@larksuiteoapi` 等构建期依赖在这份 profile 里全部缺失，`test/` 也没随包发布。

改 `node_modules` 里的压缩产物可行但错一次就是静默的错消息，且任何一次 `pnpm install` / 插件升级
都会覆盖它。所以本补丁的定位是**提交上游**，不是本地热修。

## 补丁改了三处

| 文件 | 改动 |
|---|---|
| `src/channels/weixin/weixin-api.mjs` | 新增 `sendVideo`：`mediaType: 2` + `item.type: 5` + `video_item.video_size` |
| `src/channels/weixin/weixin-bridge.mjs` | `#deliverArtifacts` 补 `sendVideo` 闭包 |
| `src/channels/shared/semantic/artifact-delivery.mjs` | `sendMaterializedArtifact` 增加 video 优先分支，失败降级到文件；判定收成 `providerSupports` |

未提供 `sendVideo` 的渠道走原路径，行为与改动前逐字节相同。

## 怎么用

在 dsh-im 仓库根目录：

```sh
git apply /path/to/0001-weixin-send-native-video.patch
npm run build && npm test
```

## 怎么验证

`validate-patch.mjs` 做的事与 `git apply --check` 等价：每个 hunk 声明的行数必须与正文一致，
且每条上下文/删除行必须与目标文件在声明位置**逐行相符**；`--apply` 再落盘，用于证明补丁能
精确还原目标源码树。

```sh
# 对着 dsh-im 包里的 src/ 校验（只读）
node validate-patch.mjs 0001-weixin-send-native-video.patch ~/.dsh/profiles/web/node_modules/@xmanrui/dsh-im

# 校验并写到一份副本上（别对着真包跑 --apply）
node validate-patch.mjs 0001-weixin-send-native-video.patch /path/to/copy --apply
```

本轮已验证：5 个 hunk 全部匹配，`--apply` 后与预期源码树**逐字节一致**，三个文件 `node --check` 通过。

**未验证**：真实 provider 行为。`media_type: 2` 的线上表现没有 fixture 可测，
缩略图问题也未解（当前所有媒体类型都发 `no_need_thumb: true`）。需由能发微信的评审者在真机确认
收到的是可播放气泡、而不是又一条文件消息。
