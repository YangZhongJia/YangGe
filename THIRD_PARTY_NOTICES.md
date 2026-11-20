# 第三方资源声明

> [简体中文](THIRD_PARTY_NOTICES.md) · [English](THIRD_PARTY_NOTICES.en.md)

## Naive UI

茶话间渲染层使用 Naive UI 的标准表单、搜索与常规操作组件，代码随 renderer 本地构建，运行时不访问外网。

- 来源：<https://github.com/tusen-ai/naive-ui>
- 版本：2.43.2
- 使用方式：按组件导入并通过茶话间主题 token 覆盖视觉
- 许可：MIT License
- 版权：Copyright (c) 2021 TuSimple

## Twemoji

茶话间内置头像与 emoji 兼容渲染使用 Twemoji SVG 图形子集，并随应用本地打包，不在运行时访问外网。

- 来源：<https://github.com/jdecked/twemoji>
- 版本：v15.1.0 图形子集
- 使用方式：仅选取所需 SVG 文件，未改绘
- 图形许可：Creative Commons Attribution 4.0 International（CC-BY 4.0），<https://creativecommons.org/licenses/by/4.0/>
- 版权：Copyright Twitter, Inc and other contributors

## 左侧导航图标

左侧导航使用 Lucide 0.468.0 的 `message-circle`、`users`、`package-2`、`refresh-cw`、`settings`。保留上游图形路径，统一显示尺寸与描边；仅内置这五个图标，不引入图标库运行时依赖或外网请求。

- Lucide：<https://github.com/lucide-icons/lucide/tree/0.468.0>，ISC License（部分图形源自 Feather / MIT）
- 完整版权与许可：[navigation-icons.txt](build/licenses/navigation-icons.txt)，随应用打包到 `licenses/navigation-icons.txt`。

## 人脸识别模型

锁屏人脸识别使用 @vladmandic/face-api 的 Tiny Face Detector、68 点人脸关键点与 128 维人脸特征模型，模型文件随应用本地打包，通过只读本地协议加载；不访问外网，不保存照片。

- 来源：<https://github.com/vladmandic/face-api>
- 版本：1.7.15
- 使用方式：`tiny_face_detector_model`、`face_landmark_68_model`、`face_recognition_model` 权重
- 许可：MIT License
- 版权：Copyright (c) Vladimir Mandic 及上游贡献者

## 掼蛋（内嵌游戏）

主界面左侧「掼蛋」入口打开的内嵌单机游戏来自第三方开源项目，静态资源随应用本地打包，运行时不访问外网。

- 来源：<https://github.com/dengweiqh/guandan-windows>
- 提交：`600c175aa6a0fef12eb7f408e489871b9144939a`
- 使用方式：上游 `dist` 静态构建，经本地 `yangge-game://` 协议加载；已移除推广徽章、外部字体与 Trae 外链，构建目标固定 Chrome 108
- 联机服务：由上游 `server/index.js` 增加玩家昵称、1000 分初始积分与排行榜事件后打包为 `guandan-server/server.cjs`，随应用启动并监听内网 17890 端口
- 许可：Apache License 2.0，全文见 [build/guandan/LICENSE](build/guandan/LICENSE)
- 版权：上游作者及贡献者


## 麻将（内嵌独立游戏）

游戏中心「麻将」入口加载的是独立的第三方静态页面，未与阳鸽主程序链接或共享代码，运行时不访问外网。

- 来源：<https://github.com/gregoryjayuk/mahjong>
- 提交：`f04e13e9bb36b8072c62b8f1f0d188c550f7ed79`
- 使用方式：原样复制 `classic.html` / `index.html` 及其 JS 运行时到本地游戏目录，仅增加「返回游戏中心」入口
- 许可：GNU General Public License v2，全文见 [build/guandan/mahjong/LICENSE](build/guandan/mahjong/LICENSE)；`three.min.js` 为 MIT
- 版权：上游作者及贡献者
