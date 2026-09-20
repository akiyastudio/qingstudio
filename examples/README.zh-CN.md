[English](README.md) | 简体中文

# Component Host 示例

现有示例演示带工具页面和服务的组件，包含 `component.json`、`service.cjs` 和 `ui/index.html`。这不是所有插件的必需结构：仅声明纯设置表单的插件可以没有工具页面和 Host 服务。按目标选择一个示例复制即可，不需要把整个目录打包进组件。

| 目录 | 用途 | 申请的 Host 能力 |
| --- | --- | --- |
| `hello-component` | 入门组件：从 UI 调用服务并读取一页项目媒体 | `project.media.page` |
| `panel-only` | 只贡献文件页侧边面板，不创建工具栏入口 | 无 |
| `host-api` | 演示多个 Host 入口共享页面和受限入口上下文 | 无 |
| `project-read` | 分页读取授权范围内的非媒体文件与 sidecar | `project.files.page` |
| `project-write` | 使用 revision 和幂等键写入媒体评分 | `project.media.ratings.write` |
| `declarative-settings` | 带工具页面的声明式设置；[附纯设置页声明方式](declarative-settings/README.zh-CN.md) | `component.settings` |

所有插件设置入口、名称、图标和专属许可都应由插件清单声明，不能把插件入口或资源写入主程序侧栏。已有带服务的示例仍然有效，无需为了使用新机制而删除其服务。

## 快速验证

在仓库根目录验证入门服务的 JSON Lines 协议：

```powershell
node scripts/mock-component-service.cjs examples/hello-component/service.cjs
```

验证所有示例的清单、权限、入口和开发注册：

```powershell
npm run test:examples
```

## 在主程序中运行

先按仓库 README 安装主程序依赖和 Python 环境。在仓库根目录执行：

```powershell
$env:PHOTOFLOW_COMPONENT_DEV_ROOTS = (Resolve-Path examples).Path
npm run electron:dev
```

此命令加载全部六个示例。仅加载一个示例时，将路径换成 `examples/hello-component`。启动后选择本地测试项目，在项目文件页查看示例入口；`panel-only` 使用侧边面板入口，`declarative-settings` 还贡献设置表单。读取示例需要项目内有对应文件；评分写入示例应使用测试素材。

示例自带 `package.json` 开发注册，不需要额外 npm 依赖、UI 构建或复制到用户数据目录。修改清单和服务后重启主程序。开发根目录仅对未打包主程序有效。

## 创建自己的插件

复制示例到独立目录，修改 `component.json` 的组件 ID、页面、RPC、能力和权限，并同步 `package.json`。将开发根目录指向该目录即可。示例代码同样采用 Apache 2.0。

- [开发教程](../docs/PLUGIN_DEVELOPMENT.zh-CN.md)
- [Host API](../docs/PLUGIN_HOST_API.zh-CN.md)
- [开发注册](../docs/COMPONENT_DEVELOPMENT.zh-CN.md)
- [服务协议](../docs/COMPONENT_SERVICE_PROTOCOL_V1.zh-CN.md)
- [SDK 类型](../component-sdk/index.d.ts)

真实组件应只声明实际调用的能力和对应权限。需要组合多个功能时，以这些最小示例为起点逐项增加声明。
