# 云端插件目录

[English](PLUGIN_CATALOG_API.md) | 简体中文

开源构建的 API base URL 保持为空，不连接商业服务。源码保留通用目录契约，供明确配置了获准 HTTPS 端点的宿主使用；本仓库不包含相应后端或凭据。

GET /v1/plugins 返回 {plugins:[...]}，公开字段为 id、name、homepage、latestVersion、capabilities、formats、previewPromptEnabled，仅返回已发布记录。主页必须通过宿主 HTTPS/域名检查。预览提示要求完整后缀匹配、preview 能力及严格布尔 true；已有启用的解码器时不提示，快捷方式不提示。

成功列表缓存一分钟；刷新失败清除提示、不阻止本地预览，最短十五秒后重试。请求独立于遥测，不发送安装身份、文件名或本地路径。云端管理和部署不在公开宿主范围内。
