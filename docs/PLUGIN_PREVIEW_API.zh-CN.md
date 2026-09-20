[English](PLUGIN_PREVIEW_API.md) | 简体中文

# 文件夹面板、播放联动与通用预览解码器

本页描述当前源码接口。具体字幕解析、PSD、DOCX 等解码算法由插件实现，主程序负责挂载面板、提供预览状态、执行跳转和显示解码结果。

## 文件夹页面的常驻面板

在已有 `component.sidePanel` contribution 上声明：

```json
{
  "type": "component.sidePanel",
  "id": "subtitles",
  "label": "字幕",
  "pageId": "subtitle-ui",
  "placement": "workspace.folderPanel",
  "rpcMethods": ["subtitle.load.v1"]
}
```

仍需声明引用的 `component.fullPage`。插件面板直接加入文件夹、预览、详细信息使用的统一面板列表，不再单独分组。菜单和顶部栏共享固定/关闭状态，支持与原生面板混合拖动排序、Alt+左右键排序、相邻边界缩放。多个插件面板可同时显示；关闭或切换文件页时隐藏视图，重新打开保留正文实例，关闭来源页或卸载时释放。固定状态、排序和宽度会保存；未固定面板会和原生预览一样在点击文件区空白处时收起。“恢复默认布局”统一重置顺序/宽度，恢复原生面板并收起默认关闭的插件面板。

顶部栏由主程序共用的 `WorkspacePanelHeader` 绘制，插件只绘制正文。清单 `label` 是菜单名，`title` 是标题，`description` 是默认副标题。需要更新当前文档信息时，声明 `component.panel` capability 和同名 permission，再调用：

```ts
await host.setPanelInfo({ title: '字幕', subtitle: '当前视频 · 120 行字幕' });
```

服务也可 `callHost(parentId, 'component.panel', {action:'update',title,subtitle})`，或 `{action:'get'}` 读取信息。只允许当前文件夹面板修改自己的纯文本标题（1–160 字符）和副标题（0–240 字符）；布局位置、固定状态及标准按钮由用户和主程序控制。不要在正文里重复创建顶部栏、关闭按钮或宽度滑杆。

切换目录或选择项后重新绑定 scope/selection，UI 通过已有 `onContextChange` 接收更新。`workspace.folderPanel` 只允许 `component.sidePanel` 使用，不改变旧浮动面板和 `workspace.videoTools` 的行为。

## 当前视频、播放位置和跳转

声明 `project.preview` capability 和 `project.preview.read` permission；需要跳转时再声明 `project.preview.control`。仅具有来源文件页的项目/灵感库组件上下文可用，不对全局设置页开放。

UI 可以直接使用 SDK：

```ts
const stop = await host.onPreviewChange(({ video }) => {
  if (!video) {
    clearSubtitleHighlight();
    return;
  }
  // sessionId 变化表示预览会话变化，应重新匹配和读取字幕。
  selectSubtitlesFor(video.relativePath, video.sessionId);
  highlightSubtitleAt(video.time);
});

const snapshot = await host.getPreview();
if (snapshot.video?.canSeek) {
  await host.seekPreview(snapshot.video.sessionId, subtitleStartSeconds);
}
// 页面退出时调用 stop()。
```

服务也可 `callHost(parentId, 'project.preview', {action:'get'})` 或 `{action:'seek',sessionId,time}`。subscribe/unsubscribe 需要存活组件页面；普通字幕 UI 优先使用 SDK 通知方法。

快照形状：

```ts
{
  revision: number,
  video: null | {
    sessionId: string,
    relativePath: string,
    time: number,       // 秒
    duration: number,   // 秒
    paused: boolean,
    canSeek: boolean
  }
}
```

位置约每 250ms 发布一次，同时反映暂停和时长；打开、切换或关闭视频会更新快照。尚未加载、预览关闭、切到非视频或视频不在插件 scope 内时可能返回 null/canSeek:false。此频率适合字幕行高亮，不保证逐帧同步。消息只含项目相对路径，不公开本地播放进程 ID、原生窗口或物理路径。

状态按应用窗口、来源文件页、工作区、项目及插件 scope 隔离。seek 必须带刚读到的 sessionId，视频已切换、不可跳转或时间越界时返回冲突；三秒没有收到页面回执则超时。`accepted:true` 表示同一预览会话接受了跳转请求，最终位置以之后的播放状态为准。Chromium 和原生视频后端复用同一播放器跳转入口。

## 任意输入格式的解码器

清单的 `componentHost.service.previewDecoders` 声明解码器。输入扩展名没有固定格式白名单；可以使用任意合法扩展名，包括 Unicode 后缀，也可以使用 `*` 接收无扩展名和未知格式，再由插件检查文件内容。

```json
{
  "id": "documents",
  "label": "文档预览",
  "extensions": [".docx", ".psd", ".自定义"],
  "method": "preview.decode.v1",
  "priority": 10
}
```

method 必须出现在 service.rpcMethods 中，宿主会将其列为 host-only 方法，不能暴露给普通组件页面。每组件最多 16 个解码器，每个最多 64 个扩展匹配规则，priority 为 -100～100。同一后缀按优先级、组件 ID 和解码器 ID 确定顺序；明确后缀匹配优先于 `*`。插件卸载或停用后刷新支持列表。

纯解码器允许 `componentHost.contributions:[]`，不必创建空白页面或无用工具栏按钮。仍需要 service 声明和正常组件安装、完整性检查。

解码器至少声明 `project.input.tokens`、`component.transfer` capabilities，以及 `project.input.read` permission。每次调用包含：

```ts
{
  input: { token: string, expiresAt: number },
  name: string,
  extension: string,
  pageIndex: number,   // 从 0 开始
  maxEdge: number      // 请求的最长边，64～4096
}
```

1. 用 project.input.tokens 物化 input，得到只给服务使用的输入快照。
2. 调用插件自带的解析/解码引擎生成请求页的 PNG，宽高都不能超过 maxEdge。
3. 通过 component.transfer 的 create/write/finish 获得输出输入令牌，然后关闭传输会话。
4. 返回 `{inputToken,mimeType:'image/png',pageIndex,pageCount}`。每次只返回一页，总页数为 1～10,000。

宿主会检查来源 scope、输出令牌归属、PNG 头和尺寸，再实际解码、重新编码为图片交给预览页。输出 PNG 文件最多 32 MiB；不接受插件返回的 HTML、脚本、任意 URL 或物理文件路径。输入格式可任意扩展；输出支持 PNG 位图，以及下面定义的 MOV/MP4 动态预览。文本选择、原始文档编辑和 3D 交互不包含在此协议中。普通视频首先使用现有播放器/播放后端；播放失败且存在匹配解码器时可请求其预览。

### 动态预览结果

同一 `previewDecoders` 注册机制可提供动态预览，无须插件 UI 或格式专用宿主代码。
插件通过输入令牌读取来源，自行解包或生成视频，再通过 `component.transfer` 上传，返回：

```ts
{ inputToken: '输出视频的一次性令牌', mimeType: 'video/quicktime', pageIndex: 0, pageCount: 1 }
// MP4 使用 mimeType: 'video/mp4'。
```

视频仅允许第 0 页、共 1 页；`maxEdge` 只限制位图，不要求视频转码缩小。宿主保留已校验的私有输入快照，检查 MOV/MP4 容器结构，最大 256 MiB；实际编码由公共播放器及已安装的播放后端判断，不保证所有 HEVC 变体均可播放。使用分块上传时仍受每个普通 RPC 最多 128 次 capability 调用约束，插件应自行限制视频大小。

宿主向主预览区返回不透明 `previewId`，在点击来源文件后挂载公共播放器，复用播放、暂停、跳转、原生后端和预览位置通知。插件仅返回输入令牌，不获得播放器窗口、项目写权限或主页面控制权限。原始项目文件不变，视频不会作为项目新文件发布；此类派生预览暂不提供截图保存。

主预览内部 IPC 以窗口归属校验 `previewId`，提供 source/backends/start/keepalive/release；这些 IPC 不对插件页面开放。主页面每 30 秒续租，失联 2 分钟后释放。切换文件、关闭预览、窗口刷新、项目关闭和组件停用撤销媒体令牌、停止原生会话并清理私有快照；等待中的原生启动完成后也必须停止。取消准备会将请求标为失效并丢弃迟到结果，不承诺强行终止插件正在运行的算法。插件仍应提供自己的时间和资源上限。

协议类型在 `component-sdk/index.d.ts`，结果校验在 `component-preview-decoder-v1.schema.json`。静态 PNG 插件保持原返回格式。

## 点击和失败行为

### 文件图标缩略图

解码器可选声明 `thumbnailMethod`，方法必须在 service.rpcMethods 中，并自动列为 host-only。例如 PSD 可以复用原 PNG 解码方法：

```json
{ "id": "photos", "label": "照片", "extensions": [".custom"], "method": "photo.preview.v1", "thumbnailMethod": "photo.thumbnail.v1" }
```

缩略图使用相同的受限输入令牌、pageIndex 和 maxEdge 请求；pageIndex 固定 0，maxEdge 为 64～640，只接受 PNG 结果，不能返回视频。宿主在文件列表、网格和版本树文件图标中按可见区域请求，生成失败保留系统图标。主预览与缩略图分别限流，缩略图最多两个并发请求、同组件最多一个；冲突可退避重试。

宿主提供最多 256 项、64 MiB 的进程内 LRU 缓存，不向项目写入缩略图文件。缓存按窗口、项目、scope、源路径和文件身份/大小/mtime/ctime、组件版本及尺寸区分；每次读取仍验证文件和授权，生成期间源文件改变则丢弃旧结果。重启后按需重建缓存。插件不直接操作宿主缓存。

### 照片式动态预览

视频结果可以额外返回 `posterInputToken`（PNG 封面令牌）和 `presentation: 'live-photo'`。宿主独立验证、重编码封面，每次打开预览时以照片样式自动静音播放一次，结束后恢复封面；左上角提供 LIVE 重播按钮，不显示视频工具条。底层仍复用公共播放器和已安装后端；普通视频结果的呈现不变。

封面与视频必须是不同的一次性令牌，封面最长边仍受 maxEdge 限制。封面解析、照片/视频配对都由插件完成。没有可解码封面时，插件可以省略 presentation 和 posterInputToken 返回普通视频预览。

非媒体文件有已启用的匹配解码器时，点击显示预览，不再立即使用系统应用打开。没有匹配解码器则保留原打开行为。普通点击在双击打开模式下也能显示已支持的文件预览；Ctrl/Shift 多选仍遵循文件页原规则。

解码失败显示错误、重试和外部打开按钮，不自动启动外部程序。翻页重新请求指定页；快速切换文件时丢弃旧响应，不把旧图片显示到新文件上。每文件页同时只执行一个解码，全宿主最多 8 个；占用期间短暂等待重试。普通服务超时仍为 60 秒。切换文件会停止等待旧结果，但不承诺终止插件已经开始的任意本机解码算法；组件卸载沿用服务监管流程。

开放接口不等于内置所有解码器。只有实际安装并启用的插件，才能为相应格式提供正确预览。
