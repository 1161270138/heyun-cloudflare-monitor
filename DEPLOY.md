# Cloudflare 部署说明

## GitHub Secrets

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`
- `ADMIN_PASSWORD`
- `CLOUDFLARE_PAGES_PROJECT`，可选，默认 `heyun-monitor-pages`

## Cloudflare KV

创建一个 KV namespace，并把 namespace id 填到 GitHub Secret `CLOUDFLARE_KV_NAMESPACE_ID`。

Worker 的 KV 绑定名必须是 `HEYUN_KV`。Pages 项目也需要在 Cloudflare Pages 项目设置里绑定同一个 KV：

- Binding name: `HEYUN_KV`
- KV namespace: 你创建的 namespace

## 部署

推送到 GitHub 后，Actions 会部署：

- Worker: `heyun-monitor-worker`
- Pages: `heyun-monitor-pages`，或 `CLOUDFLARE_PAGES_PROJECT` 指定的项目名

首次打开网站会跳转到 `/login`，输入 `ADMIN_PASSWORD` 登录。登录后在页面里添加核云账号，服务器会自动导入。

不要提交 `heyun_monitor.json`，里面有真实账号和 API 密钥，已加入 `.gitignore`。
