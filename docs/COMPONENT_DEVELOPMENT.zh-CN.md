# 组件开发注册

[English](COMPONENT_DEVELOPMENT.md) | 简体中文

PhotoFlow 发行版仅从用户组件安装目录发现组件。`app.isPackaged` 为 true 时，不读取源码树、`extensions`、环境覆盖或开发清单。已安装包仍须通过正常的包、兼容性、完整性、Component Host V2、权限和路径检查。

无论是否打包，组件安装及包目录都使用用户目录。开发发现仅叠加源码来源，不会把安装目录改为仓库内的 `components`。同一组件同时存在时，未打包的宿主优先使用当前开发源码。

开发版还从 `PHOTOFLOW_COMPONENT_DEV_ROOTS` 发现组件。多个绝对本地目录用平台 `path.delimiter` 分隔（Windows 为 `;`，POSIX 为 `:`）。项目 `extensions` 是默认开发根目录，可通过 `PHOTOFLOW_COMPONENT_DEV_DEFAULTS=0`（也接受 `false`、`off`）禁用。忽略不存在、相对、UNC、链接、非目录及重复根目录。

每个子包通过自己的 `package.json` 注册，宿主目录不硬编码组件名称：

```json
{
  "photoflowComponent": {
    "manifest": "component.template.json",
    "development": {
      "prepare": "build",
      "runtime": {
        "command": { "win32": ".venv/Scripts/python.exe", "default": ".venv/bin/python" },
        "entry": "algorithm.py",
        "argsPrefix": ["-u"]
      },
      "files": {
        "ui/index.html": "dist/ui/index.html",
        "ui/settings.html": "dist/ui/settings.html",
        "ui/icon.svg": "renderer/icon.svg"
      }
    }
  }
}
```

`manifest` 是权威的 `component.json` 格式声明，负责页面、设置页、图标、RPC、Node/executable 服务、权限、能力、生命周期动作及算法入口。`development.files` 仅把已声明包路径映射到开发构建或源码文件。未知字段和未声明路径映射会被拒绝。运行命令、入口、映射文件、服务、必需文件、图标及生命周期文件都必须是组件根目录内的普通文件；禁止路径穿越、URL、UNC、目录链接和文件符号链接。渲染器仍使用隔离 `WebContentsView`、Host V2 preload 与 RPC 白名单，宿主不导入插件 Electron 或 React 模块。

直接执行的原生运行库可省略 `development.runtime.entry`，宿主只启动 `command`。Python、Node 等脚本运行器继续声明 `entry`，它接在 `argsPrefix` 后面。

完全由 `componentHost.service.runtime: "node"` 实现的组件可省略 `development.runtime`，通过宿主 Node 运行映射后的服务入口，不附加独立算法参数。独立算法程序仍按上例声明运行库。PSD 预览是这种仅服务模式的一个使用场景，可通过 `prepare:dev` 构建服务和解码 worker；官方插件实现不包含在本仓库。

运行 `npm run prepare:components:dev` 执行各已发现包的 `prepare` 脚本。`npm run electron:dev` 的前置脚本会自动执行。它构建渲染资源，组件可直接使用私有虚拟环境和算法源码，不必运行 PyInstaller 或打包 ZIP。构建缺失时，组件管理会显示可操作的“开发组件不可用”错误，不会隐藏该组件。有效源码注册标记为“开发组件”，不冒充经过完整性验证的安装包。

开发组件与已安装组件都有相同的禁用/启用操作。禁用可逆，保留包与用户数据，移除运行时和 Host 发现，并在用户组件根目录持久化以阻止下次启动加载。禁用活动组件会先关闭页面、停止服务和 worker 进程、终止未完成网络活动，再完成操作。
