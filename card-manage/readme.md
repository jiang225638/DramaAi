# DramaAI 卡密管理平台 (`card-manage`)

独立的前端卡密管理后台，直连 `cloudflare-license-worker`（默认 `https://license.explorlove.online`）提供管理员界面。

## 功能概览

- **管理员鉴权**：通过 `ADMIN_SECRET` 鉴权登录，凭据仅保存在当前标签页 `sessionStorage`。
- **数据统计与检索**：按卡密/备注关键词、授权档位（终身买断 / 年度专业 / 月度体验）、状态（未使用 / 已激活 / 已过期 / 已封禁）分页检索。
- **批量制卡与导出**：支持批量生成 1~100 张卡密，生成后可一键复制或导出 `.txt` / `.csv`。
- **售后与设备管理**：查看每张卡密的绑定设备列表，支持修改设备上限/备注/到期时间、封禁/解封卡密、解绑单台设备或清空全部绑定。

## 本地运行与构建

```bash
cd card-manage
bun install
bun run dev
```

类型检查与生产构建：

```bash
bun run typecheck
bun run build
```

> 注意：新增的卡密列表、详情、封禁与单设备解绑接口位于 [cloudflare-license-worker/src/index.ts](../cloudflare-license-worker/src/index.ts)，使用前请先在该目录执行 `bun install && bun run deploy` 将最新 Worker 部署至 Cloudflare。
