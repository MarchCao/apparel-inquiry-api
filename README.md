# apparel-inquiry-api

HAICE Apparel（apparel.haice.top）询盘表单后端 — Vercel Serverless Function。

为什么不用 Cloudflare Worker 地址：`*.workers.dev` 在中国大陆移动网络下不可达，
本站表单改走自有子域名 `https://apparel-api.haice.top/api/inquiry`（Vercel 函数 + 自定义域名，
DNS 在 DNSPod 加 CNAME 指向 Vercel）。

## 接口
`POST /api/inquiry`，与 Cloudflare Worker 版（MarchCao/apparel 的 worker/）同一契约：
校验、honeypot、限流（5/小时/IP）、四语言自动回复、双收件人询盘。

## 环境变量（在 Vercel 项目 Settings → Environment Variables 设置，禁止写进代码/仓库）
- `RESEND_API_KEY`（必填，secret）
- `FROM_EMAIL`（选填，默认 `HAICE Apparel <sales@haice.top>`）
- `INQUIRY_TO`（选填，默认 `sales@haice.top, junhcao@163.com`；双收件人是因为腾讯企业邮会静默丢弃 Resend 发往 sales@ 的邮件，163 为兜底）

## 域名
`apparel-api.haice.top` — Vercel 项目 Domains 添加后，在 DNSPod 加 CNAME：
主机记录 `apparel-api` → `cname.vercel-dns.com`（以 Vercel 后台显示为准）。

## Supabase 版（当前主推）
`supabase/functions/inquiry/index.ts` — 部署到项目 crm（exvsglemldxqunmrbvez）的 Edge Function，
入口 `https://exvsglemldxqunmrbvez.supabase.co/functions/v1/inquiry`，`verify_jwt = false`。
选它是因为 `*.supabase.co` 已由用户手机实测可达（2026-10-12），且用户已有 Supabase 账号、无需新平台审核。
密钥：`supabase secrets set RESEND_API_KEY=...`（只存 Supabase，不进仓库）。
注意：该函数与供应链数据库无任何关系；今后若删除 crm 项目，须先把本函数迁走（源码以本仓库为准，一条命令可重新部署到任意项目）。
