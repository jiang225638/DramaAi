# DramaAI 外部下载插件内置化目录

如果你从网页、社区或第三方下载了**已经编译好的插件单文件**，可以直接放入本目录对应的子文件夹中。  
打包时或本地运行 `bun dev:desktop` 时，系统会自动将它们识别并打包为**官方内置插件**（新安装的用户开箱即用，并在插件市场显示为内置）。

## 目录与文件格式对照表

| 插件类型 | 存放目录 | 支持的文件名格式 | 示例 |
| :--- | :--- | :--- | :--- |
| **节点 (Node)** | `packages/builtin/nodes/` | `*Node.umd.js` 或 `*.umd.js` (小驼峰) | `characterNode.umd.js` |
| **文件扩展 (Ext)** | `packages/builtin/ext/` | `ext-*.umd.js` | `ext-subtitle.umd.js` |
| **工具 (Tool)** | `packages/builtin/tools/` | `*.tool.js` | `mySearch.tool.js` |
| **技能 (Skill)** | `packages/skills/<技能名>/` | 解压后的文件夹（内含 `SKILL.md`） | `packages/skills/storyWriter/` |

> 提示：放入后执行本地运行 `bun dev:desktop` 或上传 GitHub 自动打包，插件就会全自动被打包为内置插件！
