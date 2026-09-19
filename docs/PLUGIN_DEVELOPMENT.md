# PhotoFlow 插件（组件）开发教程

PhotoFlow 把可选扩展包称为 **组件（Component）**。文件名保留“Plugin”便于检索；新包必须使用 Component Host V2，并且不能导入 PhotoFlow 的 React 渲染层或 Electron 主进程代码。

## 快速开始

需要字幕常驻面板、跟随当前视频、点击字幕跳转，或为任意后缀文件提供预览时，使用 [预览扩展 API](PLUGIN_PREVIEW_API.md)。非媒体文件安装匹配解码器后，普通点击会进入预览窗口。

文件编辑器可使用 `project.files.inputToken` 打开项目内任意格式文件，使用 `project.files.watch` 跟踪链接资源，使用 `component.transfer` 分段传递大二进制。侧栏、上下文菜单、导入/导出及命令 contribution 的 RPC 白名单上限为 128。权限、调用顺序及限制见 [文件资源与大数据 API](PLUGIN_FILE_RESOURCES_API.md)；文件格式解析仍由插件负责。

1. 把 `examples/hello-component` 复制到以组件 ID 命名的目录。
2. 所有组件使用唯一、无版本协商的当前 Host API；不要声明 `componentHost.compatibility` 或任何 Host API 版本字段，未知字段和未知能力名均会拒绝。
3. 添加一个 `workspace.toolbarAction` 或 `component.sidePanel`、一个与之相连的 `component.fullPage`、包内 UI 入口和服务入口。仅面板组件可以省略 toolbarAction；标准全局设置优先贡献 `application.settingsForm`，只有需要自定义交互时才使用 `application.settingsPage`。
4. 声明全部服务 RPC、Host 能力、权限和发出的事件。未声明的访问会默认拒绝。升级历史数据时，可声明 `component.storage.previous.v1` 和/或 `project.output.existing.v1` adoption grant；不要把组件业务表或路径字段加入宿主代码。
5. 运行 `node scripts/mock-component-service.cjs examples/hello-component/service.cjs` 验证入门示例协议。此 mock 使用该示例的固定 RPC，自定义服务需调整测试。
6. 按 [示例运行步骤](../examples/README.md) 配置 `PHOTOFLOW_COMPONENT_DEV_ROOTS`。保留示例的 `package.json` 开发注册，单独的 `component.json` 不会启用源码发现。完整规则见 [开发注册](COMPONENT_DEVELOPMENT.md)。

完整示例包含静态页面和 Node 服务。页面只调用 `window.photoFlowComponent`，服务向宿主请求一页媒体。`component-sdk/index.d.ts` 提供全部 Host API 能力的请求、结果、错误、事件和 JSONL 帧映射；`component-sdk/service.cjs` 为服务后端提供 `callHost`、`acceptFrame` 和 `failAll`。

## 包结构

```text
hello-component/
  component.json
  service.cjs
  ui/index.html
  ui/icon.svg          # 可选，只允许 PNG 或被动 SVG
```

清单路径都是包内相对路径。符号链接、路径穿越、远程页面或图标、主动 SVG、缺失文件和未知贡献类型都会使整套 UI 注册失败。组件不能选择自己的 preload。

## UI 教程

```ts
import { host, assertHostApi } from '../../component-sdk/index.js';

const context = await host.getContext();
assertHostApi(context);
const page = await host.rpc('my-component.load.v1', { cursor: null });
const stop = host.onEvent('my-component.progress.v1', update => render(update));
if (host.notify) {
  await host.notify({ tone: 'success', message: '设置已保存', dedupeKey: 'settings.saved' });
}
window.addEventListener('pagehide', stop, { once: true });
```

UI 运行在沙箱 `WebContentsView` 中，Node 集成、WebView、任意导航、新窗口和浏览器权限都被关闭。使用上下文中解析后的明暗主题，并监听主题/上下文变化。控件应支持键盘操作、显示可见焦点、为表单提供标签、尊重“减少动态效果”，并且不能假设宿主页面始终激活。页面停用或销毁时释放计时器和订阅。

这里的沙箱只隔离 UI `WebContents`，不隔离组件后端。service、生命周期动作和 executable 是用户主动安装的受信本机代码，以当前用户权限运行，可以读取或修改用户可访问的文件、联网并启动进程。Host API capability/permission 是正常组件的互操作契约与最小授权，不是针对恶意本机进程的安全边界；受监管子进程也不等于 OS 沙箱。当前不要把 PhotoFlow 的离线安装描述为可安全运行不受信第三方市场插件。

### 文件页面板

`component.sidePanel` 使用与内置工具相同的面板外框。宿主负责标题、组件图标、遮罩、关闭按钮和内容 View 的尺寸；插件 UI 负责内容区域，不要自行再绘制一层模态窗口。面板上下文的 `surface` 为 `component.sidePanel`，`scopeRelativePath`、`selectedRelativePaths` 和 `sourcePageId` 绑定打开它的文件页。不同文件页使用不同实例，关闭文件页、卸载或升级组件会关闭所属面板。

宿主会在面板显示前自动注入 `component-sdk/ui.css` 对应的稳定颜色、间距、圆角、表单、按钮、卡片和滚动条契约；上下文中的 `panelStyleContractVersion` 表示当前样式契约。组件可以直接使用 `--pf-*` 变量以及 `.pf-panel-card`、`.pf-panel-section`、`.pf-form-label`、`.pf-form-input`、`.pf-button`、`.pf-button-primary`，不应复制主程序内部 Tailwind 实现。

面板高度由组件预加载层自动测量正文并上报，宿主按实际内容高度收缩，最高为 `90vh`，超出后才在正文 View 内滚动；上下文中的 `panelLayoutContractVersion` 表示此布局契约。组件正文应保持自然高度，不要给 `html`、`body` 或顶层容器设置 `height:100vh`、固定高度或非必要的 `min-height`，否则该声明会成为上报的内容高度。

```json
{
  "type": "component.sidePanel",
  "id": "panel",
  "label": "批量处理",
  "title": "批量处理图片",
  "pageId": "panel-ui",
  "rpcMethods": ["my-component.run.v1"]
}
```

组件仍须声明被引用的 `component.fullPage`，但仅面板组件不需要声明 `workspace.toolbarAction`。面板内部监听 `onThemeChange`、`onContextChange`、`onActivate` 和 `onDeactivate`；长任务继续使用 `tasks`。可运行示例见 `examples/panel-only`。

需要保留宿主工具分组时，`component.sidePanel` 或 `project.contextAction` 可以声明以下 `placement`：

| placement | 菜单 |
| --- | --- |
| `workspace.videoTools` | 视频工具 |
| `workspace.imageTools` | 图片工具 |
| `workspace.officeTools` | Office 文档 |

三个菜单在项目文件页和灵感库均可用；灵感库的三个图标常驻，Office 即使只有一个工具也保留下拉菜单。未选择文件时仍可展开菜单，需选择内容的工具置灰。插件入口按贡献声明顺序追加到对应菜单，同时进入文件选择右键菜单的同名分组，不再重复出现在独立工具栏或右键根菜单。任意 ID 的侧边面板均可挂载，不限于内置视频工具。

`project.contextAction` 若有同组件、同 `pageId` 的 `workspace.toolbarAction`，点击时打开对应完整页面；否则走标准 contribution 打开流程。`component.sidePanel` 打开组件面板。两种入口均接收完整的安全文件／文件夹选择以及 `sourcePageId`、`contentKind`（项目为 `project`，灵感库为 `inspiration`）；不支持的快捷方式选择不可执行。菜单位置只决定入口归属，不自动按文件后缀过滤，插件仍须校验输入、声明页面、RPC 和权限。其他 contribution type 或未知的 placement 会被拒绝。`workspace.folderPanel` 仍只适用于 `component.sidePanel`，不属于工具菜单。

例如在 `componentHost.contributions` 中加入以下面板入口，并同时声明 `panel-ui` 页面及允许的服务 RPC：

```json
{
  "type": "component.sidePanel",
  "id": "document-tool",
  "label": "我的文档工具",
  "pageId": "panel-ui",
  "placement": "workspace.officeTools",
  "rpcMethods": ["my-component.run.v1"]
}
```

可从 `examples/panel-only` 开始，增加贡献声明以创建多个分组面板入口。

渲染层通常调用组件自有 RPC，而不是直接调用 Host 能力。唯一的受控 UI 快捷桥是 Host API `notify`：它只接受严格的纯文本结构，不能携带 HTML、回调、URL、路径或任意 channel。组件服务是后端协议端点，按契约只能请求清单授权的 Host 能力；这不阻止受信服务代码直接调用其 OS 用户权限。只有后端自身产生短状态时才使用 `notifications`。长任务和确认仍分别使用 `tasks` 与 `dialogs`。

### 可选的应用设置

标准偏好使用 `application.settingsForm`。字段结构写在清单中，由 PhotoFlow 原生渲染、校验并通过 `component.settings` 保存，因此不需要组件维护另一套设置页面。完整示例见 `examples/declarative-settings`。

插件设置入口、名称、图标和专属许可必须由插件清单声明，主程序侧栏不得硬编码插件入口或直接导入插件资源。仅包含 `application.settingsForm`、且所有表单都没有 `customPage` 的组件，可以省略工具页面、工具栏操作及服务；Host 直接保存其组件设置，不启动服务。已有自定义页面和服务插件无需迁移。

表单可声明 `help` 展示使用说明：最多 16 项，每项包含 `title`（最多 160 字符）和 `description`（最多 2000 字符），仅作为纯文本展示，不产生设置值或执行操作。第三方许可使用独立的 `notices`：每项包含 `title`、`description`、`license`、`sourceUrl`、`licenseUrl`，链接仅接受无凭据的 HTTPS 地址。只展示说明或许可的页面可以使用空 `groups`，但必须至少提供一项 help 或 notice。普通表单仍保存到对应组件的独立设置中。

实现标准视频播放后端的插件可在表单中声明 `preferenceScope: "videoPlayback"`，将 `hdrMode`、`toneMapping`、`targetPeakNits` 绑定到共享播放器已有的显示偏好。Host 校验字段、取值范围和后端声明能力；其他应用配置不可访问。此绑定保留旧设置值并直接供播放器读取，不依赖插件 ID。

需要清单字段无法表达的自定义交互时，可以使用 `application.settingsPage`。它是 Host API 特性，会在已安装且校验成功后动态出现在“组件管理”之后。它与项目整页一样使用独立的 sandboxed `WebContentsView` 和组件 preload，但 `context.surface` 为 `application.settings`，项目字段为空。

```json
{
  "type": "application.settingsPage",
  "id": "settings",
  "label": "示例组件",
  "title": "示例组件设置",
  "entry": "ui/settings.html",
  "rpcMethods": ["hello.settings.get.v1", "hello.settings.update.v1"]
}
```

`rpcMethods` 必须是 `service.rpcMethods` 的子集，且只有这些方法能从设置页调用。设置 surface 的服务再向 Host 请求时，默认拒绝所有项目、媒体、存储、任务和事件能力；只允许清单已授权的 `component.settings`、`component.lifecycle`、确认对话框和 Host API 通知。不要在此 surface 调用项目 RPC。

## 后端服务教程

服务通过 stdin/stdout 上的 UTF-8 JSON Lines 通信：

1. 初始化后输出 `{ "type":"ready", "protocolVersion":1 }`。
2. 接收带不透明请求 ID、已声明版本化方法、JSON 载荷和无路径项目上下文的 `request`。
3. 返回 `response`；需要宿主资源时，发送绑定请求 `parentId` 的 `capability`，并等待 `capability-response`。
4. 日志写 stderr；stdout 只输出协议帧。

完整实现见 `examples/hello-component/service.cjs`。普通同步请求 60 秒超时，帧和载荷上限 2 MiB。长任务应启动 `tasks` 操作，频繁保存检查点，把控制权还给 UI，并在取消或重启后从最后检查点恢复。

Host API 服务可在清单显式声明后调用只读扩展，例如 `callHost(parentId, 'project.files.search', { query:'xmp', pageSize:50 })`。同时声明 `project.files.read`；媒体元数据复用 `project.media.read`，版本与评分分别声明 `project.versions.read`、`project.media.ratings.read`。这些结果只含项目虚拟相对路径和稳定 ID，不要尝试从游标、媒体引用或图节点推导绝对路径。

Host API 提供按能力拆分权限的项目写入扩展。参考 `examples/project-write`：评分使用逐项语义，checked 与旧评分 outbox 共用 ExifTool per-file 队列；版本/进度使用数据库 CAS，并在 DB 内再次验证 scope；导入 reservation 不延长一次性 input token 的原始寿命；所有恢复重新验证物理 canonical scope、链接、摘要和 owner/identity。文件变更及 undo 都使用逐项 intent/applied 日志；目录 move 限同卷，trash/restore 的未知 OS 结果会安全停止并要求人工恢复。Office 空输出先在私有 stage 写 owner marker，再原子发布。媒体长调用当前会 await 完成，可用相同幂等键调用 `status`/`cancel`；receipt 恢复会同步 task 为 completed，卸载会取消活动 import/process。所有幂等键、plan、token 和收据都绑定 component/workspace/project/scope，设置页 surface 默认拒绝。

## 安全的“媒体 → 版本”流程

1. 使用 `project.media.page` 分页读取媒体。
2. 使用 `variants:[]` 取得稳定媒体元数据。只有真正需要像素或 URL 时，才解析 `thumbnail`、`preview` 或 `original`。
3. 服务需要私有文件副本时，用 `project.input.tokens` 交换返回的短时、一次性输入令牌。
4. 调用 `project.output` 的 `stage`；在返回的私有 stage 目录下写入文件；通过 `write` 登记每个文件，然后 `validate`。
5. 使用稳定幂等键调用 `commit`。宿主只会把已声明的相对目标发布到绑定项目下。
6. 可选：使用返回的 commit/artifact ID 和另一个稳定幂等键调用 `version.create`。
7. 对放弃的 stage 调用 `rollback`。

stage 元数据与登记文件保留 24 小时，因此宿主重启后可以继续 `validate`、`commit` 或 `rollback`。保存返回的 `stageId`、`commitId` 和 artifact ID，而不是私有路径。已提交制品可以通过 `dialogs` 打开或显示；迁移时可用 `materializeOwned` 校验并导入私有存储。系统从不接受任意输出路径。

插件私有存储下的媒体使用 `component.media`；项目进度节点及来源关系使用 `project.progress`。进度创建可以携带扁平 `sourceMetadata`：`category`、`role`、`displayName` 和 `parentCapability`。文本最多 128 字符；`parentCapability` 只允许 `structural`、`workflow-input` 或 `none`。宿主写入绑定的 `componentId`，省略或空元数据默认采用结构化进度，并拒绝未知或嵌套字段。

如果 `component.storage` 返回 `adoption.state === "pending"`，尚未授予任何组件存储路径。显示迁移状态，以 500–1000 ms 有界退避轮询，并拒绝所有依赖存储的读写和变更。不要创建公布的组件目录、猜测 `dataPath`/`databasePath` 或启动第二次复制。提交后先验证同组件收据再重写私有路径；项目输出迁移应单独记录并增量执行。宿主保留 V1 来源，并能在中断后恢复复制日志。

替换项目输出必须显式提供 `replace:true`、`previousCommitId`、`previousArtifactId` 和 `expectedDigest`。宿主只替换由旧提交收据拥有、且当前字节仍匹配的目标，并在多文件事务期间记录旧内容。不要通过自行删除目标实现覆盖。

不要把项目路径作为组件业务身份持久化。保存 PhotoFlow ID 和组件自有元数据。token、cursor、stage、commit 和 artifact ID 都是不透明值，并限定在一个组件和项目范围内。

## 测试与发布

- `npm run test:component-host-api` 先检查 SDK 类型，再检查无版本 Host API 一致性、权限、读写 scope、stage/导入恢复、CAS、幂等、文件 undo、进度、任务、媒体处理、对话框、事件和服务模拟器。
- `npm run test:component-host`、`npm run test:component-service`、`npm run test:electron-security` 和 `npm run test:architecture` 覆盖隔离与兼容性。
- 打包前用 `electron/contracts/schemas/component-manifest-v2.schema.json` 校验清单。
- 安装包只包含构建后的 UI、服务和运行资源；为清单声明的生命周期动作计算哈希；在干净用户配置中安装，测试取消、重启，再用真实 V1 数据测试升级与降级。
- 每次发布提升组件业务版本。只有语义破坏性变化才提升 RPC/事件的 `.vN`；迁移期新增版本应与旧版本并存。

旧宿主业务适配器已经移除。组件只能通过当前 Host API 与显式 adoption grant 运行。
