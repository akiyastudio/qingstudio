# PhotoFlow 组件 UI 契约

[English](README.md) | 简体中文

普通组件偏好使用 `application.settingsForm`。PhotoFlow 校验声明、渲染原生设置行、应用默认值，并通过 `component.settings` 保存，不加载组件 HTML。

当普通偏好还需要账号授权、环境安装或诊断时，在同一个 `application.settingsForm` 中添加 `customPage`。PhotoFlow 保留一个导航项，同时呈现原生表单与隔离的高级区域。没有声明式字段的页面仍可使用独立 `application.settingsPage`。自定义页面应导入 `component-sdk/ui.css` 并调用 `component-sdk/index.js` 的 `mountUiTheme()`。

UI 契约版本 1 提供设计变量和不依赖框架的设置组、行、按钮、输入框、下拉框、开关、状态标记、加载动画、提示、对话框和路径选择器样式。自定义页面可调用 `host.notify(...)` 与 `host.dialog(...)`；文件和目录选择返回有作用域的令牌，不返回持久化的原始路径。`openComponentDirectory` 可在调用组件根目录内创建并打开一个直接子目录，应用设置 surface 也可使用。其他操作仍通过版本化 RPC 与生命周期 API 完成。CSS 类不授予任何能力。

表单 schema version 1 的字段类型为 `toggle`、`select`、`text`、`number`、`range`。值按字段 ID 保存在组件自有设置对象中。不提供持久化文件系统路径字段：输入访问使用有作用域的令牌。

表单可以声明最多 16 条纯文本 `help`，每项含 `title`（160 字符）与 `description`（2000 字符）。说明显示在设置与第三方声明之前，不产生可写偏好。有至少一项说明或声明时，信息页可使用空 `groups`。

已有原生播放会话可用 `host.setPlaybackPaused(sessionId, paused)` 直接向宿主播放器发送播放/暂停，不经过组件服务。它要求 `component.runtime.execute` 能力及权限，并检查页面所有者和项目作用域。Promise 只确认派发；实际解码状态通过 `onPlaybackState` 获取。支持较旧宿主时应检测此方法是否存在，并保留播放 RPC 回退。

## 显示语言

`getContext()` 的 `locale` 提供宿主显示语言。使用 `mountUiLanguage(onChange)` 更新文档语言并接收后续变化，无需重启组件任务；返回函数用于取消订阅。较旧宿主默认为 `zh-CN`。组件页面维护自己的词典，语言切换不得修改项目标识、文件名或已保存的用户数据。
