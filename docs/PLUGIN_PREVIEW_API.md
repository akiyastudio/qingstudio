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

宿主会检查来源 scope、输出令牌归属、PNG 头和尺寸，再实际解码、重新编码为图片交给预览页。输出 PNG 文件最多 32 MiB；不接受插件返回的 HTML、脚本、任意 URL 或物理文件路径。**输入格式可任意扩展，当前输出显示契约是位图预览**；文本选择、原始文档编辑、3D 交互或音频播放不包含在这份静态预览协议中。视频首先使用现有播放器/播放后端；播放失败且存在匹配的静态解码器时可显示其预览。

## 点击和失败行为

非媒体文件有已启用的匹配解码器时，点击显示预览，不再立即使用系统应用打开。没有匹配解码器则保留原打开行为。普通点击在双击打开模式下也能显示已支持的文件预览；Ctrl/Shift 多选仍遵循文件页原规则。

解码失败显示错误、重试和外部打开按钮，不自动启动外部程序。翻页重新请求指定页；快速切换文件时丢弃旧响应，不把旧图片显示到新文件上。每文件页同时只执行一个解码，全宿主最多 8 个；占用期间短暂等待重试。普通服务超时仍为 60 秒。切换文件会停止等待旧结果，但不承诺终止插件已经开始的任意本机解码算法；组件卸载沿用服务监管流程。

开放接口不等于内置所有解码器。只有实际安装并启用的插件，才能为相应格式提供正确预览。
