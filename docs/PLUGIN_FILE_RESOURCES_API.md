# 文件资源与大数据 API

本页是当前 Host API 的补充契约。类型在 `component-sdk/index.d.ts`，请求和结果在 `component-host-api.schema.json`。组件 service 调用 Host capability；renderer 通过组件声明的 `.vN` RPC 转发，不获得本地路径或任意文件系统权限。

## 任意格式项目文件

声明 `project.files.inputToken` capability，以及 `project.files.read`、`project.input.read` 两项 permission。

```js
const file = await host.callHost(parentId, 'project.files.inputToken', {
  relativePath: '视觉文档/方案.qs',
  // expectedDigest: '上次保存的 SHA-256，可选'
});
const snapshot = await host.callHost(parentId, 'project.input.tokens', {
  action: 'materialize', token: file.input.token
});
// service 读取 snapshot.privatePath；不把这个路径传给 UI。
```

示例中的 host 来自 SDK 的 `createServiceHostClient`，parentId 是正在处理的组件 RPC 请求 ID。物化还需声明 `project.input.tokens` capability。

接受 scope 内任何扩展名或没有扩展名的普通文件，包括图片、QS、ABR、字体；解析、显示和编辑由插件实现。返回 `{input:{token,expiresAt},relativePath,name,byteLength,sha256,fileId}`。路径使用 `/`，拒绝绝对路径、`..`、符号链接/目录联接、NTFS 数据流及 `.photoflow-*` 内部项。

令牌十分钟有效、一次消费，绑定组件/工作区/项目和 scope；原始文件在授权或复制期间变化，或 expectedDigest 不匹配，返回 `COMPONENT_HOST_CONFLICT`。摘要基于完整文件流式计算，不把文件整体读入内存。fileId 是 scope/来源页内的物理身份标识；改名保留，原位替换可改变。分页仍按原有 `project.files.page/search` 与 `project.media.page` 分工。

## 链接资源

声明 `project.files.watch` capability 和 `project.files.read` permission。

| action | 参数 | 结果 |
| --- | --- | --- |
| subscribe | `relativePaths`（1–256 个唯一已有文件）、可选 `includeVersions` | `subscriptionId,cursor,expiresAt,files` |
| poll | `subscriptionId,cursor` | `subscriptionId,cursor,expiresAt,files,events,rescanRequired` |
| unsubscribe | `subscriptionId` | `unsubscribed:true` |

files 包含 `relativePath,fileId,revision,versionId`；缺失时带 `missing:true`。事件类型为 `modified/renamed/deleted/versionChanged`，包含文件信息、`subscriptionId`、单调 `sequence` 和 `previousRelativePath`。按 sequence 去重，保存返回的 cursor。原路径恢复会发出 modified。版本跟踪仅用于项目，另需 `project.versions.read`，跟踪关联照片的当前版本 ID。

这是资源**状态订阅**，不是逐次操作日志：两次轮询间的变化会合并，不保留短暂的中间状态。每次最多扫描 scope 下 20,000 个目录项；扫描或版本快照截断、cursor 不匹配、轮询间隔超过 30 秒时返回 `rescanRequired:true`，调用方必须核对资源。截断扫描不会把没找到的文件直接判为删除。同 inode 多个硬链接造成改名定位歧义时不猜测目标。

建议可见页面每 2–5 秒 poll，一次订阅不并发 poll。无变化返回空 events。收到变化后另取读取令牌；订阅本身不赋予读取权。

绑定组件、工作区、项目、scope 和来源页，每组件最多 16 个订阅，全宿主最多 256 个。五分钟无调用过期；view 清理或组件卸载/升级时释放。重连时带旧 cursor 核对最新状态，过期则重新 subscribe 建立基线。

## 大二进制传输

声明 `component.transfer` capability 和 `project.input.read` permission。原图/ABR 输入优先用令牌在宿主内流式物化，服务导出优先直接写 output stage；跨 renderer/service 传输时使用以下会话。

上传：

1. `{action:'create',name,byteLength}` 返回 `transferId,byteLength,chunkBytes,expiresAt`。
2. `{action:'write',transferId,offset,base64}` 顺序写入私有文件，返回 `nextOffset`，确认后再发送下一块。同位置相同内容可重试，不同内容或跳跃写入返回冲突。
3. `{action:'finish',transferId,expectedDigest}` 检查完整大小和 SHA-256，返回 `input,byteLength,sha256`。相同摘要重复 finish 返回同一结果，但令牌仍只能消费一次。
4. `{action:'close',transferId}` 释放传输文件。finish 的令牌仍可物化，也可传入 `project.output` 的 write 操作，继续 validate/commit。

下载：`{action:'openInput',token}` 消费一次性令牌，返回读取会话；`{action:'read',transferId,offset,byteLength}` 返回 `offset,nextOffset,base64,eof`；最后 close。可重复读取同一区间。支持空文件，不支持目录输入。

每块原始数据最多 1 MiB；上传单文件、每组件活动上传总预算均为 2 GiB。每组件最多 8 个会话，全宿主最多 64 个。会话绑定与订阅相同，单会话串行调用，十分钟无操作过期，view 清理或卸载时释放。在有效会话内可重试；宿主重启或过期后需重新创建，不提供持久断点恢复。

每块应使用独立组件 RPC 请求转发，避免同一 RPC 超过 128 次嵌套 capability 调用或请求超时。协议仍为 base64 JSON，单帧仍限 2 MiB，并保留原有并发限制。这一接口使传输内存和帧大小有界，不是零拷贝通道；finish 会创建校验后的私有快照。

## RPC 数量

`component.sidePanel`、`media.contextAction`、`project.contextAction`、`project.importProvider`、`project.exportProvider`、`application.command` 每个 contribution 的 `rpcMethods` 上限从 16 提高到 **128**，与 service 总上限一致。仍要求唯一、版本化、已在 service 中声明，且不能暴露 host-only 方法。设置页保持 32，其他贡献数量不变。

项目外另存为、可选 capability 协商和插件绘画引擎功能不在本次改动范围。
