# 声明式设置示例

当前 `component.json` 演示“工具页面 + Host 服务 + 声明式设置”。这一结构仍受支持：工具页面调用服务，设置表单由主程序根据插件声明渲染。无需修改此示例的服务和 UI 来适配纯设置页支持。

## 只需要设置入口时

已有运行库或命令行插件若不需要工具页面，可将清单中的 `componentHost` 声明为下面的结构。它不包含 `workspace.toolbarAction`、`component.fullPage` 或 `service`：

```json
{
  "contractVersion": 2,
  "contributions": [
    {
      "type": "application.settingsForm",
      "id": "settings",
      "label": "运行库设置",
      "title": "运行库设置",
      "form": {
        "schemaVersion": 1,
        "groups": [
          {
            "id": "general",
            "title": "常规",
            "fields": [
              {
                "id": "enabled",
                "type": "toggle",
                "label": "启用自动处理",
                "default": true
              }
            ]
          }
        ]
      }
    }
  ]
}
```

这段内容是 `componentHost` 的值，不是完整组件清单。保留插件实际使用的顶层 `entrypoints`、运行文件和平台声明；运行库入口与 Host UI 服务是两回事。同步移除不再使用的 `requiredFiles` 和开发文件映射，不要留下指向已删除 UI 或服务文件的声明。设置保存到该组件独立的 `componentSettings` 中，不会启动服务；插件实际执行功能时自行使用这些参数，声明表单本身不会添加处理逻辑。

只有全部贡献均为 `application.settingsForm`、且没有 `customPage` 时，才能省略 Host 服务。需要自定义页面或 RPC 时，继续使用现有的服务和权限声明。

## 图标和许可

图标使用顶层 `icon` 声明包内文件，开发映射及打包内容应包含该文件。主程序从插件注册列表读取名称、设置页和图标，不需要修改侧栏代码。

第三方软件说明可放在 `form.notices` 中，每项包含 `title`、`description`、`license`、`sourceUrl`、`licenseUrl`。链接必须是无凭据的 HTTPS 地址。仅展示许可的页面可以使用 `groups: []`，但至少要有一条 notice；所有版本和许可内容应填写该插件实际使用的依赖信息。

实现标准视频播放后端的插件可按能力声明 `form.preferenceScope: "videoPlayback"`，访问共享播放器的 `hdrMode`、`toneMapping`、`targetPeakNits` 显示偏好。Host 校验字段和后端能力。普通插件应省略此字段，使用独立组件设置。

完整约定见 [插件开发说明](../../docs/PLUGIN_DEVELOPMENT.md)。
