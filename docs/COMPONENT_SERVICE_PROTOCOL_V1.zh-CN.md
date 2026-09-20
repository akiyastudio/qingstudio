# 组件服务协议 V1

[English](COMPONENT_SERVICE_PROTOCOL_V1.md) | 简体中文

组件服务协议 V1 是 Component Host V2 当前使用的进程传输协议。协议版本描述 JSON Lines 信封，与无版本的当前 Host API，以及组件自有 `.v1`、`.v2` RPC 版本相互独立。

组件渲染器运行在宿主管理的沙箱 `WebContentsView` 中。服务以受监管 `node` 或 `executable` 子进程启动；Electron 不导入或 require 组件业务代码。

## 清单边界

`componentHost.service` 声明：

- `protocolVersion: 1`；
- 运行时及平台入口；
- 有数量限制、带版本号的组件 RPC 白名单；
- 精确的 Host 能力与权限白名单；
- 发出的事件及可选运行时/生命周期动作；
- 使用相关能力时的网络 origin 与秘密绑定。

入口及生命周期文件必须是已安装组件根目录内的普通非符号链接文件。发现阶段拒绝未知字段、未声明文件、重复或无版本 RPC、路径穿越、外部绝对路径、未知能力及缺少权限的声明。

## 当前 Host 能力

权威词汇表是 `component-sdk/index.d.ts` 中的 `HostCapabilityMap`，以及 `electron/contracts/schemas/component-manifest-v2.schema.json` 的枚举。

- 媒体和输入：`project.media.page`、`project.media.variants`、`project.input.tokens`、`project.media.metadata`、`project.media.ratings`、`project.media.ratings.write`、`project.media.process`。
- 项目文件及版本：`project.files.page`、`project.files.search`、`project.files.inputToken`、`project.files.watch`、`project.files.mutate`、`project.versions.page`、`project.version.graph`、`project.version.update`、`project.version.delete`、`project.progress`、`project.progress.manage`、`project.import`、`project.output`、`version.create`。
- 组件服务：`component.storage`、`component.settings`、`component.events`、`component.lifecycle`、`component.media`、`component.runtime.execute`、`component.secrets`、`component.transfer`、`component.panel`、`network.fetch`。
- 宿主交互：`tasks`、`dialogs`、`notifications`、`project.preview`。

Host 能力使用稳定名称，不带 `.vN`。组件 RPC 与事件仍显式带版本。声明能力不等于获得授权：每次调用都检查已安装清单、权限白名单及绑定的组件/项目上下文。

## 进程协议

私有 stdin/stdout 每行传输一个有大小限制的 JSON 对象：

1. 服务发送包含协议版本的 `ready`。
2. 宿主发送带 ID、版本化组件方法、载荷和有界上下文的 `request`。
3. 处理期间，服务可发送绑定父请求的 `capability`。
4. 宿主授权并验证后返回 `capability-response`。
5. 服务用成功或失败的 `response` 完成父请求。

帧及载荷上限为 2 MiB。未知、格式错误及超大帧会拒绝。服务只得到最小环境变量集，不继承完整宿主环境。工作区原始路径保留在宿主内，特定能力可提供受限令牌或已授权项目相对引用。

意外退出会使进行中的请求失败。服务有受监管且有次数限制的重启策略，但不会自动重放请求。变更只能通过对应操作的幂等键重试。

普通父 RPC 最多发起 128 次嵌套能力调用。成功的 `tasks.start` 或 `tasks.resume` 返回未取消宿主任务后，该父请求得到最多 262,144 次调用的长任务预算，可在四小时截止时间内轮询取消、报告进度和发布输出。失败任务调用、状态查询或单独声明权限均不授予此预算。

长任务每一秒窗口最多 128 次调用。所有父请求仍限制八个并发能力调用，拒绝重复 ID，并保留帧大小上限。能力 ID 最多 128 字符；有限的调用预算限制去重 ID 集合大小。每次调用仍通过正常权限及项目作用域检查。

## 数据、输出与迁移

`component.storage` 返回组件私有位置，也可能报告异步 adoption 状态。等待迁移时只读且不公开目标路径。项目写入通过 `project.output`、`version.create`、`project.files.mutate` 或有界导入/进度等事务能力完成。

旧数据只通过显式 adoption grant 所授权的迁移路径接收。通用 Electron 模块和宿主数据库不得增加组件业务表、路由或字段。

## 权威来源

- 清单：`electron/contracts/schemas/component-manifest-v2.schema.json`。
- 传输信封：`electron/contracts/schemas/component-service-protocol-v1.schema.json`。
- Host 请求/结果：`electron/contracts/schemas/component-host-api.schema.json`。
- 公共 TypeScript API：`component-sdk/index.d.ts`。
- 运行时验证与监管：`electron/component-host-contract.cjs`、`electron/services/component-service-manager.cjs`。
