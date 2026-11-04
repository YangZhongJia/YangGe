# 茶话间文档

> **简体中文** · [English](en/README.md)

中文文档是需求、协议、界面与技术设计的主事实源；英文文档维护当前有效规范的完整翻译。涉及已记录行为的改动需在同一提交中同步两种语言，并运行 `npm run check:docs`。

## 用户与贡献者

- [项目简介与安装](../README.md) · [English](../README.en.md)
- [参与开发](../CONTRIBUTING.md) · [English](../CONTRIBUTING.en.md)
- [二次开发指南](../DEVELOPMENT.md) · [English](../DEVELOPMENT.en.md)
- [第三方资源声明](../THIRD_PARTY_NOTICES.md) · [English](../THIRD_PARTY_NOTICES.en.md)

## 产品与工程设计

| 中文文档 | 职责 | 英文版本 |
|---|---|---|
| [开发交接](handoff.md) | 当前状态、工作流、代码地图、下一步 | [Handoff](en/handoff.md) |
| [需求](requirements.md) | 功能范围、优先级、决议记录 | [Requirements](en/requirements.md) |
| [协议](protocol.md) | 线上报文、时序、常量与兼容性 | [Protocol](en/protocol.md) |
| [UI / 交互](ui-design.md) | 页面结构、关键流程、视觉 token | [UI and interaction](en/ui-design.md) |
| [技术设计](tech-design.md) | 选型、分层、存储、风险与 CI | [Technical design](en/tech-design.md) |
| [内网通兼容设计](nwt-compat-design.md) | 暂缓功能的隔离式兼容方案 | [Neiwangtong compatibility](en/nwt-compat-design.md) |
| [代码优化方案](optimization-plan.md) | 优化项、状态与执行边界 | [Optimization plan](en/optimization-plan.md) |
| [双人角斗场](duel-arena.md) | 入口、规则、协议收敛与兼容边界 | [Duel arena](en/duel-arena.md) |

历史实施计划保留为中文工程记录，不属于对外维护的当前规范。目标平台私有打包记录继续按仓库现有忽略规则留在本地。
