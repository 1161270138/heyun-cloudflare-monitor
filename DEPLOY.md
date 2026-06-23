# Cloudflare 部署说明

## GitHub Secrets

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 添加：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`
- `ADMIN_PASSWORD`
- `CLOUDFLARE_PAGES_PROJECT`，可选，默认 `heyun-monitor-pages`

如果 Cloudflare Worker 直连核云 API 出现 522，再添加：

- `HEYUN_RELAY_URL`：中转服务地址，例如 `https://relay.example.com/zjmf`
- `HEYUN_RELAY_TOKEN`：中转服务密钥，和中转服务器上的 `RELAY_TOKEN` 一致

## Cloudflare KV

创建一个 KV namespace，并把 namespace id 填到 GitHub Secret `CLOUDFLARE_KV_NAMESPACE_ID`。

Worker 和 Pages 都会通过 Actions 绑定同一个 KV：

- Binding name: `HEYUN_KV`
- KV namespace: 你创建的 namespace

## 部署

推送到 GitHub 后，Actions 会部署：

- Worker: `heyun-monitor-worker`
- Pages: `heyun-monitor-pages`，或 `CLOUDFLARE_PAGES_PROJECT` 指定的项目名

首次打开网站会跳转到 `/login`，输入 `ADMIN_PASSWORD` 登录。登录后在页面里添加核云账号，服务器会自动导入。

不要提交 `heyun_monitor.json`，里面有真实账号和 API 密钥，已加入 `.gitignore`。

## 核云 API 522 时的中转服务

如果页面提示“核云 API 返回 522”，说明 Cloudflare Worker 到核云 API 的链路超时。可以把 `relay/heyun-relay.js` 部署到一台能正常访问核云 API 的普通服务器上。

服务器需要 Node.js 18 或更新版本。

```bash
git clone https://github.com/1161270138/heyun-cloudflare-monitor.git
cd heyun-cloudflare-monitor
npm install
export RELAY_TOKEN="换成一串随机长密码"
export PORT=3000
npm run relay
```

然后用 Nginx、宝塔、1Panel、PM2 或 systemd 把 `http://127.0.0.1:3000` 反代成 HTTPS，例如：

```text
https://relay.example.com/zjmf
```

再到 GitHub Secrets 添加：

- `HEYUN_RELAY_URL=https://relay.example.com/zjmf`
- `HEYUN_RELAY_TOKEN=你服务器上的 RELAY_TOKEN`

重新运行 Actions 后，导入、检测、开机、硬关机、重启、硬重启都会走中转。
