[English](README.md) | 简体中文

# 照片流

照片流（PhotoFlow）是一款面向摄影师、修图师和影像团队的桌面影像管理工具，以本地项目为核心，将素材导入、文件整理、影像预览、评级筛选、版本追踪与工作进度管理集中在一个工作空间。

本仓库提供主程序源码，采用 **Apache License 2.0**。开源的主要目的是方便社区开发插件，提供可运行的桌面宿主、SDK、接口规范和最小示例。

## 开源范围

- `src/`：React 界面、前端状态、项目和素材交互。
- `electron/`：桌面主进程、本地文件服务、原生辅助程序源码、插件宿主和接口。
- `python/`：主程序所需的本地数据库、导入和影像处理工具。
- `component-sdk/`：插件接口与 SDK。
- `examples/`：六个可运行的插件开发示例。
- `docs/`：插件教程、Host API、服务协议与开发注册说明。
- `scripts/`：主程序开发、构建和验证脚本。

## 从插件开发开始

1. 阅读 [示例索引与运行方法](examples/README.md)，从 `hello-component` 或 `panel-only` 开始。
2. 按下文安装主程序环境，设置 `PHOTOFLOW_COMPONENT_DEV_ROOTS` 指向示例或自己的插件目录。
3. 运行 `npm run test:examples`，再运行 `npm run electron:dev` 联调。
4. 通过 [开发教程](docs/PLUGIN_DEVELOPMENT.md)、[Host API](docs/PLUGIN_HOST_API.md) 和 [SDK 类型](component-sdk/index.d.ts) 增加能力。

教学示例随主程序一起采用 Apache 2.0。

## 环境

当前验证目标为 **Windows x64**。建议使用 Node.js 24、npm 11、Python 3.12（64 位）和 Git。

原生辅助程序通过 Windows 自带的 .NET Framework 4.x C# 编译器构建；构建脚本会检查编译器是否存在。其他平台代码保留，但尚未完成完整构建与运行验证。

## 安装与开发

```powershell
git clone https://github.com/akiyastudio/qingstudio.git
cd qingstudio
npm ci
npm run setup:python
npm run electron:dev
```

`electron:dev` 启动 Vite、编译本地辅助程序并启动 Electron。仅运行 `npm run dev` 只能提供前端开发服务器，不能代替桌面宿主。

Python 虚拟环境生成在 `.venv/`。npm 使用锁文件；Python 直接依赖固定版本，传递依赖由 pip 解析。

## 验证

```powershell
npm test
npm run build
npm run build:native
npm run check:python
npm run test:smoke
```

启动测试使用独立的临时目录和空白配置，不读取日常工作区。测试失败时保留临时目录用于排查。测试覆盖公开源码边界、部分文件操作安全性、插件状态策略和无插件 Electron 启动；不代表所有业务功能均已验证。

## 构建安装包

```powershell
npm run electron:build
```

本地构建产物位于 `artifacts/installers/`；不会自动上传或发布。自行分发二进制时，需要一并满足所打包第三方依赖的许可证要求，参见 [第三方说明](THIRD_PARTY_NOTICES.md)。本仓库首次发布以源码交付为范围。

## 许可证

本仓库原创代码采用 [Apache License 2.0](LICENSE)，版权信息见 [NOTICE](NOTICE)。第三方依赖适用各自许可证。软件许可不授予商标权。

欢迎提交问题和改进。提交截图、日志和示例项目前，请移除私人路径、凭据及真实客户资料。
