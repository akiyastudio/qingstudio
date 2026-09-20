[English](HOST_PLAYER_API.md) | 简体中文

# 宿主播放器 v1

主程序提供播放界面、快捷键、会话生命周期、Chromium 播放和原生后端选择。插件提供已授权媒体来源及字幕、裁剪、切割和编码预览等业务扩展。每次挂载都是独立实例。

在插件入口脚本前加载宿主资源：

```html
<link rel="stylesheet" href="photoflow-player://runtime/v1/player.css">
<script src="photoflow-player://runtime/v1/player.js"></script>
```

组件分区只允许这些精确地址及可选的 `v1/timeline.js`、`v1/timeline.css`，不会因此获得文件或媒体权限。有 CSP 时，需在 script-src、style-src 中允许 `photoflow-player:`。`scripts/build-host-player.cjs` 从主程序使用的同一 VideoPlayer 构建 `artifacts/player-runtime/v1`。插件包不要再内嵌播放器副本；已安装旧插件可以在升级前保留旧副本。

初始化前检查 `window.PhotoFlowPlayback?.apiVersion === 1`，不匹配时提示升级。mount 在创建 React 根节点前也会拒绝不兼容版本。破坏性变更使用新 URL 版本；仍支持 v1 插件时需保留 v1 资源。

```js
const player = PhotoFlowPlayback.mount(container, {
  apiVersion: 1,
  filePath: authorizedRelativeName,
  electronApi: scopedPlaybackFacade,
  onState: ({ time, duration, paused }) => updateBusinessTimeline(time),
  onError: message => showError(message),
});
player.control({ action: 'pause' });
player.playFrom(12.5);
const stoppedAt = await player.pauseAtFrame();
player.close();
```

`scopedPlaybackFacade` 适配已有授权 RPC 和宿主播放通道，提供 getVideoPlaybackSource、getVideoPlaybackBackends、startVideoPlayer、stopVideoPlayer、controlVideoPlayer、setVideoPlayerBounds、onVideoPlayerState、getVideoDisplayCapabilities、captureVideoPlayerFrame、publishVideoPlayerFrame、chooseVideoSubtitle 和 setHostSurfaceSuspended。不要替换 window.electronAPI。媒体、会话、窗口位置、字幕和保存帧仍由 Host 检查权限。原生 bounds 使用设备像素并附带 viewportDip；需转换为组件本地 DIP，并应用页面可见性、对话框和裁切规则。

## 挂载扩展与实例方法

- `timeline`：插入公共控制条上方的 DOM 节点。
- `surfaceOverlay`：播放画面内的 DOM 节点，不得遮挡控制条。
- `toolbar`：插入公共工具条的 DOM 节点。
- `onNavigate`、`onMetadata`、`onReady({backendId})`：业务通知。
- `playbackEnabled:false`：保留界面但不打开媒体。
- `controlsVisible:false`：隐藏工具条，适用于后台取帧。
- `editorState:{time,duration,paused,ready}`：外部业务时间线，包括尚无可播放输出的静帧状态。
- `onControlRequest(request)`：仅当业务已处理用户控制请求时返回 true；返回 false 使用普通播放。

`update(patch)` 更新选项，但不替换授权适配层。授权范围改变时创建新实例。实例暴露 control、playFrom、pauseAtFrame、fullscreen、refreshBounds、frameAt、backendId、update 和可重复调用的 close。

`frameAt(time)` 暂停并定位已授权 Chromium 来源，等待解码后返回 PNG data URL。原生后端或无法捕获时返回 null，插件可改用已有授权的 Host 取帧能力。关闭或替换来源取消待完成读取。Chromium 可读视频的裁剪取帧无需第二套播放器或可选原生解码器。

control 是插件显式命令；onControlRequest 只拦截用户控制操作。暂停并标记必须等待 pauseAtFrame，它等待原生确认，不接受乐观界面位置。

close 移除公共监听、取消启动、关闭所属会话并拒绝待完成暂停请求。外部 DOM 节点仅脱离挂载，不被销毁；插件还需释放自身业务监听。

## 公共帧时间线

可选时间线资源暴露 `PhotoFlowTimeline.mount`，提供 noUiSlider、帧时间码编辑、进度拖动、裁剪区间和标记交互。省略 #trim-slider 禁用裁剪区间但保留标记；省略标记控件则用于转码布局。连续源播放只应用空间变换，不运行编码器；明确选择输出效果预览时才为最终滤镜、音频处理和压缩生成编码预览。

#timeline-current 使用时、分、秒、帧四个数字框和固定冒号。Enter 或移出整组时提交；Escape 恢复播放位置；上下键调整当前单位，左右键切换单位，Tab 正常切换焦点。逐帧按钮位于编辑器旁，挂载时间线后隐藏底部工具条重复按钮。已索引来源按实际时间戳逐帧移动，支持 VFR；setEditorEnabled 在忙碌时禁用编辑和逐帧按钮。

`npm run test:host-player` 验证实际宿主资源 URL、媒体协议限制和两个独立原生模拟实例。上游转码、转写浏览器测试使用相同构建资源验证业务流程；这些插件实现不包含在本开源仓库中。
