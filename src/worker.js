const CONFIG_KEY = "config";
const STATE_KEY = "state";
const EVENTS_KEY = "events";
const SESSIONS_PREFIX = "session:";

const ACTION_PATHS = {
  power_on: "/hosts/{id}/module/on",
  hard_off: "/hosts/{id}/module/hard_off",
  reboot: "/hosts/{id}/module/reboot",
  hard_reboot: "/hosts/{id}/module/hard_reboot",
};

const ACTION_LABELS = {
  power_on: "开机",
  hard_off: "硬关机",
  reboot: "重启",
  hard_reboot: "硬重启",
};

const ONLINE_VALUES = new Set(["on", "running", "online"]);
const OFF_VALUES = new Set(["off", "shutdown", "stopped"]);

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      const url = new URL(request.url);
      const status = error?.status || 400;
      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: humanError(error) }, status);
      }
      return html(`<!doctype html><meta charset="utf-8"><title>错误</title><pre>${escapeHtml(humanError(error))}</pre>`, status);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env, { force: false }));
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/login" && request.method === "GET") {
    return html(loginPage());
  }
  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD) return json({ ok: false, error: "ADMIN_PASSWORD 未配置" }, 500);
    if (String(body.password || "") !== String(env.ADMIN_PASSWORD)) {
      return json({ ok: false, error: "密码错误" }, 401);
    }
    const token = crypto.randomUUID();
    const ttl = Number(env.SESSION_TTL_SECONDS || 604800);
    await kvPut(env, SESSIONS_PREFIX + token, "1", { expirationTtl: ttl });
    return json({ ok: true }, 200, {
      "Set-Cookie": `hy_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}`,
    });
  }
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const token = cookie(request, "hy_session");
    if (token) await kvDelete(env, SESSIONS_PREFIX + token);
    return json({ ok: true }, 200, {
      "Set-Cookie": "hy_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    });
  }

  const authed = await isAuthed(request, env);
  if (!authed) {
    if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "未登录" }, 401);
    return Response.redirect(`${url.origin}/login`, 302);
  }

  if (url.pathname === "/" && request.method === "GET") return html(dashboardPage());
  if (url.pathname === "/api/status" && request.method === "GET") return json(await snapshot(env));
  if (url.pathname === "/api/poll" && request.method === "POST") return json(await runMonitor(env, { force: true }));
  if (url.pathname === "/api/action" && request.method === "POST") return json(await apiAction(env, await request.json()));
  if (url.pathname === "/api/accounts" && request.method === "POST") return json(await addAccount(env, await request.json()));
  if (url.pathname === "/api/host-settings" && request.method === "POST") return json(await updateHost(env, await request.json()));
  if (url.pathname === "/api/host-delete" && request.method === "POST") return json(await deleteHost(env, await request.json()));

  return new Response("Not found", { status: 404 });
}

async function isAuthed(request, env) {
  const token = cookie(request, "hy_session");
  if (!token) return false;
  return (await kvGet(env, SESSIONS_PREFIX + token)) === "1";
}

function cookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return "";
}

async function snapshot(env) {
  const config = await getConfig(env);
  const state = await getState(env);
  const events = await getEvents(env);
  const accountMap = new Map(config.accounts.map((a) => [a.id, a]));
  const hosts = config.hosts.map((host) => {
    const key = hostKey(host.provider, host.id);
    const account = accountMap.get(host.provider) || {};
    return {
      key,
      id: host.id,
      provider: host.provider,
      provider_name: account.name || host.provider,
      name: host.name || host.id,
      ip: host.ip || "",
      interval_seconds: host.interval_seconds || config.interval_seconds || 60,
      auto_enabled: host.auto_recovery?.enabled !== false,
      auto_action: host.auto_recovery?.action || config.auto_recovery?.action || "hard_reboot",
      power: state.hosts?.[key]?.power || "unknown",
      status: state.hosts?.[key]?.status || "unknown",
      failures: state.hosts?.[key]?.failures || 0,
      last_seen: state.hosts?.[key]?.last_seen || "",
      last_error: state.hosts?.[key]?.last_error || "",
      last_latency_ms: state.hosts?.[key]?.last_latency_ms ?? null,
      history: state.hosts?.[key]?.history || [],
      last_action: state.hosts?.[key]?.last_action || "",
      last_action_at: state.hosts?.[key]?.last_action_at || "",
      api_account: account.api_account || "",
      has_api_password: Boolean(account.api_password),
    };
  });
  return {
    ok: true,
    last_poll_at: state.last_poll_at || "",
    summary: {
      total: hosts.length,
      online: hosts.filter((h) => h.status === "online").length,
      offline: hosts.filter((h) => h.status === "offline").length,
      errors: hosts.filter((h) => h.status === "error").length,
    },
    accounts: config.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      api_base_url: a.api_base_url,
      api_account: a.api_account,
      has_password: Boolean(a.api_password),
      host_count: config.hosts.filter((h) => h.provider === a.id).length,
    })),
    hosts,
    events,
  };
}

async function runMonitor(env, { force = false } = {}) {
  const config = await getConfig(env);
  const state = await getState(env);
  state.hosts ||= {};
  const accounts = new Map(config.accounts.map((a) => [a.id, a]));
  const now = Date.now();

  for (const host of config.hosts) {
    const key = hostKey(host.provider, host.id);
    const runtime = state.hosts[key] || {};
    const intervalMs = Number(host.interval_seconds || config.interval_seconds || 60) * 1000;
    if (!force && runtime.last_check_ts && now - runtime.last_check_ts < intervalMs) continue;
    const account = accounts.get(host.provider);
    if (!account) continue;
    const started = Date.now();
    try {
      const power = await getPower(account, host.id);
      const powerLower = String(power).toLowerCase();
      const healthy = ONLINE_VALUES.has(powerLower);
      const oldPower = String(runtime.power || "").toLowerCase();
      const next = {
        ...runtime,
        power,
        status: healthy ? "online" : "offline",
        failures: healthy ? 0 : Number(runtime.failures || 0) + 1,
        last_seen: nowIso(),
        last_error: "",
        last_latency_ms: Date.now() - started,
        last_check_ts: Date.now(),
        history: [...(runtime.history || []).slice(-39), { t: nowHms(), v: healthy ? 1 : 0 }],
      };
      state.hosts[key] = next;
      if (healthy && oldPower && oldPower !== "unknown" && oldPower !== "on") {
        await addEvent(env, "action", `服务器已开机，恢复在线（${oldPower} -> on）`, host.id, host.provider);
      } else if (oldPower && oldPower !== powerLower) {
        await addEvent(env, healthy ? "info" : "warning", `状态变化：${oldPower} -> ${powerLower}`, host.id, host.provider);
      }
      if (OFF_VALUES.has(powerLower)) {
        if (oldPower !== powerLower) await addEvent(env, "warning", `电源状态为 ${powerLower}`, host.id, host.provider);
        await maybeAutoRecover(env, config, state, host, account);
      }
    } catch (error) {
      state.hosts[key] = {
        ...runtime,
        status: "error",
        failures: Number(runtime.failures || 0) + 1,
        last_error: humanError(error),
        last_check_ts: Date.now(),
      };
      await addEvent(env, "error", `检测失败：${humanError(error)}`, host.id, host.provider);
    }
  }

  state.last_poll_at = nowIso();
  await putState(env, state);
  return snapshot(env);
}

async function maybeAutoRecover(env, config, state, host, account) {
  const key = hostKey(host.provider, host.id);
  const runtime = state.hosts[key] || {};
  if (runtime.last_action === "hard_off" && Date.now() < Number(runtime.manual_shutdown_until || 0)) {
    if (!runtime.manual_shutdown_suppressed_notified) {
      runtime.manual_shutdown_suppressed_notified = true;
      await addEvent(env, "info", "手动硬关机保护中，暂停自动恢复", host.id, host.provider);
    }
    return;
  }
  const auto = host.auto_recovery || {};
  if (auto.enabled === false) return;
  const action = auto.action || config.auto_recovery?.action || "hard_reboot";
  await runPowerAction(env, state, host, account, action, `自动恢复，电源状态=${runtime.power || "off"}`);
}

async function apiAction(env, body) {
  const config = await getConfig(env);
  const state = await getState(env);
  const host = config.hosts.find((h) => hostKey(h.provider, h.id) === body.host_key);
  if (!host) throw new Error("未知服务器");
  const account = config.accounts.find((a) => a.id === host.provider);
  if (!account) throw new Error("账号不存在");
  await runPowerAction(env, state, host, account, String(body.action || ""), "手动操作");
  await putState(env, state);
  return { ok: true };
}

async function runPowerAction(env, state, host, account, action, reason) {
  if (!ACTION_PATHS[action]) throw new Error("不支持的动作");
  const result = await zjmfRequest(account, ACTION_PATHS[action].replace("{id}", encodeURIComponent(host.id)), { method: "PUT" });
  const key = hostKey(host.provider, host.id);
  const runtime = state.hosts[key] || {};
  runtime.last_action = action;
  runtime.last_action_at = nowIso();
  if (action === "hard_off") runtime.manual_shutdown_until = Date.now() + 15 * 60 * 1000;
  if (action !== "hard_off") runtime.manual_shutdown_until = 0;
  state.hosts[key] = runtime;
  await addEvent(env, "action", `${reason}：已发送${ACTION_LABELS[action]}指令，结果=${result.msg || result.message || "成功"}`, host.id, host.provider);
}

async function addAccount(env, body) {
  const config = await getConfig(env);
  const account = {
    id: cleanId(body.id || body.name || body.api_account || `account${config.accounts.length + 1}`),
    name: String(body.name || body.api_account || "账号"),
    api_base_url: normalizeBase(body.api_base_url || "https://www.heyunidc.cn/v1"),
    api_account: String(body.api_account || ""),
    api_password: String(body.api_password || ""),
  };
  if (!account.api_account || !account.api_password) throw new Error("账号和 API 密钥必填");
  const existing = config.accounts.find((a) => a.api_base_url === account.api_base_url && a.api_account === account.api_account);
  const provider = existing?.id || uniqueId(account.id, new Set(config.accounts.map((a) => a.id)));
  if (!existing) config.accounts.push({ ...account, id: provider });
  else if (account.api_password) existing.api_password = account.api_password;

  const hosts = await listHosts({ ...account, id: provider });
  const existingIds = new Set(config.hosts.map((h) => h.id));
  let imported = 0;
  const skipped = [];
  for (const h of hosts) {
    const id = String(h.id || h.host_id || "");
    const productStatus = String(h.domainstatus || "").toLowerCase();
    if (productStatus && !["active", "on", "running"].includes(productStatus)) {
      skipped.push({ id, name: h.product_name || h.name || h.domain || id || "-", reason: `非 Active 状态：${productStatus}` });
      continue;
    }
    if (!id || existingIds.has(id)) {
      if (id) skipped.push({ id, name: h.product_name || h.name || h.domain || id, reason: "重复服务器" });
      continue;
    }
    config.hosts.push({
      provider,
      id,
      name: h.product_name || h.name || h.domain || `server-${id}`,
      ip: h.dedicatedip || h.ip || "",
      interval_seconds: 60,
      auto_recovery: { enabled: true, action: "hard_reboot" },
    });
    existingIds.add(id);
    imported++;
  }
  await putConfig(env, config);
  await addEvent(env, "info", `${existing ? "已复用账号" : "已添加账号"}：${account.name}，导入 ${imported} 台服务器，跳过 ${skipped.length} 台重复`);
  return { ok: true, imported, skipped_count: skipped.length, skipped };
}

async function updateHost(env, body) {
  const config = await getConfig(env);
  const host = config.hosts.find((h) => hostKey(h.provider, h.id) === body.host_key);
  if (!host) throw new Error("未知服务器");
  if (body.server_id) host.id = String(body.server_id);
  host.interval_seconds = Number(body.interval_seconds || host.interval_seconds || 60);
  host.auto_recovery = {
    ...(host.auto_recovery || {}),
    enabled: body.auto_enabled !== false,
    action: String(body.auto_action || host.auto_recovery?.action || "hard_reboot"),
  };
  const account = config.accounts.find((a) => a.id === host.provider);
  if (account) {
    if (body.provider_name) account.name = String(body.provider_name);
    if (body.api_account) account.api_account = String(body.api_account);
    if (body.api_password) account.api_password = String(body.api_password);
  }
  await putConfig(env, config);
  return { ok: true };
}

async function deleteHost(env, body) {
  const config = await getConfig(env);
  const before = config.hosts.length;
  config.hosts = config.hosts.filter((h) => hostKey(h.provider, h.id) !== body.host_key);
  if (config.hosts.length === before) throw new Error("未知服务器");
  const state = await getState(env);
  delete state.hosts?.[body.host_key];
  await putConfig(env, config);
  await putState(env, state);
  await addEvent(env, "warning", "已删除服务器监控项");
  return { ok: true };
}

async function listHosts(account) {
  const limit = 100;
  let page = 1;
  const hosts = [];
  while (true) {
    const data = await zjmfRequest(account, `/hosts?page=${page}&limit=${limit}`);
    const raw = data.data;
    let batch = [];
    let total = null;
    if (Array.isArray(raw)) {
      batch = raw;
    } else if (raw && typeof raw === "object") {
      batch = raw.host || raw.list || raw.data || [];
      total = raw.total;
    }
    batch = batch.filter((item) => item && typeof item === "object");
    hosts.push(...batch);
    if (!batch.length || batch.length < limit) break;
    if (total && hosts.length >= Number(total)) break;
    page += 1;
  }
  return hosts;
}

async function getPower(account, id) {
  const data = await zjmfRequest(account, `/hosts/${encodeURIComponent(id)}/module/status?type=host`);
  if (Number(data.status) >= 400) throw new Error(data.msg || data.message || `API status ${data.status}`);
  const raw = data.data;
  return raw?.status || raw?.state || raw?.power_status || raw?.power_state || data.state || data.power_status || data.status;
}

async function zjmfRequest(account, path, init = {}) {
  const jwt = await login(account);
  const res = await fetch(normalizeBase(account.api_base_url) + path, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers || {}), Authorization: `JWT ${jwt}` },
    cf: { cacheTtl: 0 },
  });
  const text = await res.text();
  const data = parseMaybeJson(text);
  if (!res.ok) throw new Error(zjmfErrorMessage("请求核云接口", res.status, data, text));
  return data;
}

async function login(account) {
  const url = new URL(normalizeBase(account.api_base_url) + "/login_api");
  url.searchParams.set("account", account.api_account);
  url.searchParams.set("password", account.api_password);
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 0 },
  });
  const text = await res.text();
  const data = parseMaybeJson(text);
  if (!res.ok) throw new Error(zjmfErrorMessage("登录核云 API", res.status, data, text));
  const jwt = data.jwt || data.data?.jwt;
  if (!jwt) throw new Error(data.msg || data.message || data.error || `登录失败，未返回 JWT。接口返回：${compactText(text)}`);
  return jwt;
}

async function getConfig(env) {
  const fallback = {
    interval_seconds: 60,
    accounts: [],
    hosts: [],
    auto_recovery: { enabled: true, action: "hard_reboot", trigger_statuses: ["off"], failure_threshold: 1, cooldown_seconds: 600 },
  };
  return (await kvGetJson(env, CONFIG_KEY)) || fallback;
}
async function putConfig(env, config) { await kvPut(env, CONFIG_KEY, JSON.stringify(config)); }
async function getState(env) { return (await kvGetJson(env, STATE_KEY)) || { hosts: {} }; }
async function putState(env, state) { await kvPut(env, STATE_KEY, JSON.stringify(state)); }
async function getEvents(env) { return (await kvGetJson(env, EVENTS_KEY)) || []; }
async function addEvent(env, level, message, host_id = "", provider = "") {
  const events = await getEvents(env);
  events.unshift({ time: nowIso(), level, message, host_id, provider });
  await kvPut(env, EVENTS_KEY, JSON.stringify(events.slice(0, 100)));
}

async function kvGet(env, key) {
  if (!env.HEYUN_KV) return null;
  return env.HEYUN_KV.get(key);
}
async function kvGetJson(env, key) {
  const raw = await kvGet(env, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
async function kvPut(env, key, value, options) {
  if (!env.HEYUN_KV) throw new Error("HEYUN_KV 未绑定");
  return env.HEYUN_KV.put(key, value, options);
}
async function kvDelete(env, key) {
  if (!env.HEYUN_KV) return;
  return env.HEYUN_KV.delete(key);
}

function hostKey(provider, id) { return `${provider}:${id}`; }
function cleanId(value) { return String(value || "").replace(/[^\w-]/g, "_").slice(0, 32) || crypto.randomUUID(); }
function uniqueId(base, used) { let id = base; let i = 2; while (used.has(id)) id = `${base}_${i++}`; return id; }
function normalizeBase(value) { const v = String(value || "https://www.heyunidc.cn/v1").replace(/\/$/, ""); return v.endsWith("/v1") ? v : `${v}/v1`; }
function nowIso() { return new Date().toISOString().slice(0, 19); }
function nowHms() { return new Date().toISOString().slice(11, 19); }
function humanError(error) { return String(error?.message || error); }
function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return { message: compactText(text) }; }
}
function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
}
function zjmfErrorMessage(action, status, data, text) {
  const body = compactText(data?.msg || data?.message || data?.error || text);
  if (status === 522 || /error code:\s*522/i.test(body)) {
    return `${action}失败：核云 API 返回 522，Cloudflare 连接核云源站超时。请稍后重试；如果一直这样，说明核云接口不适合直接从 Cloudflare Worker 访问，需要改用本地监控或加一个国内/普通服务器中转。`;
  }
  if (status === 401 || status === 403) return `${action}失败：账号或 API 密钥可能不正确，HTTP ${status}，${body}`;
  return `${action}失败：HTTP ${status}${body ? `，${body}` : ""}`;
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function html(body, status = 200) { return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

function loginPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><style>${css()}</style><body><main class="login"><form id="f" class="card small"><h1>核云监控</h1><p>输入管理密码</p><input name="password" type="password" placeholder="登录密码" autofocus><button>登录</button><div id="msg"></div></form></main><script>f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const j=await r.json();if(j.ok)location='/';else msg.textContent=j.error||'登录失败'}</script></body></html>`;
}

function dashboardPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>核云监控</title>
  <style>${css()}</style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo">核</div>
      <div>
        <h1>核云监控</h1>
        <div class="sub">ZJMF 电源状态监控 · 自动恢复 · Cloudflare</div>
      </div>
    </div>
    <div class="topbar">
      <span class="pill"><span id="globalDot" class="dot"></span><span id="globalText">连接中</span></span>
      <span class="pill">账号：<b id="accountCount">-</b></span>
      <span class="pill">上次检查：<b id="lastPoll">-</b></span>
      <button id="pollBtn" type="button">立即检测</button>
      <button id="logoutBtn" type="button">退出</button>
    </div>
  </header>

  <main>
    <div id="notice" class="notice hidden"></div>
    <section class="metrics">
      <div class="metric"><span>总监控</span><strong id="mTotal">0</strong></div>
      <div class="metric"><span>在线</span><strong id="mOnline">0</strong></div>
      <div class="metric"><span>离线</span><strong id="mOffline">0</strong></div>
      <div class="metric"><span>错误</span><strong id="mErrors">0</strong></div>
    </section>

    <section class="layout">
      <div id="servers" class="grid"></div>
      <aside class="panel">
        <h2>账号管理</h2>
        <div class="settings">
          <form id="accountForm">
            <div class="form-grid">
              <input name="name" placeholder="账号名称，例如 备用账号">
              <input name="api_base_url" placeholder="API 地址，默认核云">
            </div>
            <input name="api_account" placeholder="登录邮箱或手机号" autocomplete="username">
            <input name="api_password" type="password" placeholder="API 密钥" autocomplete="current-password">
            <button type="submit">添加账号并导入服务器</button>
          </form>
          <div id="accounts" class="accounts"></div>
        </div>
        <h2>事件流</h2>
        <div id="events" class="events"></div>
      </aside>
    </section>
  </main>
  <script>${clientJs()}</script>
</body>
</html>`;
}

function css() {
  return `:root{color-scheme:dark;--bg:#070b10;--panel:#0d141d;--card:#111a24;--line:rgba(148,163,184,.18);--text:#e7edf2;--muted:#8fa0ad;--ok:#20d19b;--bad:#ef4444;--warn:#f59e0b;--blue:#60a5fa;--field:#162232;--shadow:0 20px 60px rgba(0,0,0,.22)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,rgba(32,209,155,.12),transparent 34rem),linear-gradient(180deg,#070b10,#07110f 60%,#070b10);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px clamp(16px,4vw,44px);border-bottom:1px solid var(--line);background:rgba(7,11,16,.86);backdrop-filter:blur(14px);position:sticky;top:0;z-index:2}.brand{display:flex;align-items:center;gap:12px}.logo{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;color:#05100d;font-weight:900;background:linear-gradient(135deg,var(--blue),var(--ok))}h1{margin:0;font-size:18px;line-height:1.1}.sub{color:var(--muted);font-size:12px;margin-top:4px}.topbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.pill{display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:rgba(13,20,29,.74);color:var(--muted);font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);box-shadow:0 0 18px currentColor}.dot.ok{background:var(--ok);color:var(--ok)}.dot.warn{background:var(--warn);color:var(--warn)}.dot.bad{background:var(--bad);color:var(--bad)}main{padding:22px clamp(16px,4vw,44px) 44px}.notice{margin-bottom:14px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:rgba(96,165,250,.12);color:#dbeafe}.notice.bad{background:rgba(239,68,68,.12);color:#fecaca}.notice.ok{background:rgba(32,209,155,.12);color:#bbf7d0}.hidden{display:none}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}.metric{border:1px solid var(--line);border-radius:8px;background:linear-gradient(180deg,rgba(17,26,36,.86),rgba(13,20,29,.86));box-shadow:var(--shadow);padding:16px}.metric span{color:var(--muted);font-size:12px}.metric strong{display:block;font-size:28px;margin-top:8px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:14px}.card{border:1px solid var(--line);border-radius:8px;background:linear-gradient(180deg,rgba(17,26,36,.94),rgba(11,17,24,.96));padding:16px;overflow:hidden;box-shadow:var(--shadow)}.server-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.server-title{min-width:0}.server-title h2{margin:0;font-size:16px;overflow-wrap:anywhere}.server-title p{margin:6px 0 0;color:var(--muted);font-size:12px}.badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:rgba(255,255,255,.04)}.badge.online{color:var(--ok)}.badge.offline,.badge.error{color:#fecaca}.facts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0}.fact{padding:10px;border-radius:8px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.035)}.fact label{display:block;color:var(--muted);font-size:11px;margin-bottom:6px}.fact b{font-size:14px;overflow-wrap:anywhere}.spark{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;align-items:end;gap:3px;height:44px;padding:6px;border-radius:8px;background:rgba(0,0,0,.22)}.bar{min-width:3px;border-radius:3px 3px 0 0;background:var(--bad);height:18%;opacity:.95}.bar.ok{background:var(--ok);height:80%}.actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}.card-settings{margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.07)}.strategy-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;color:var(--muted);font-size:12px}.host-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:end}.host-settings>div{min-width:0}.host-settings .span-2{grid-column:1/-1}.host-settings button[type=submit]{grid-column:1/-1;justify-self:end;min-width:92px}.settings{display:grid;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06)}.settings form{display:grid;gap:10px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}input,select{width:100%;min-width:0;border:1px solid rgba(148,163,184,.18);color:var(--text);background:var(--field);border-radius:8px;padding:9px 10px;font:inherit;font-size:13px}input::placeholder{color:#64748b}input:focus,select:focus{outline:none;border-color:rgba(32,209,155,.56);box-shadow:0 0 0 3px rgba(32,209,155,.10)}.label{color:var(--muted);font-size:11px;margin-bottom:5px}.accounts{display:grid;gap:7px}.account-row{display:flex;justify-content:space-between;gap:8px;padding:9px 10px;border-radius:8px;background:rgba(255,255,255,.035);font-size:12px}.account-row span{color:var(--muted)}button{cursor:pointer;border:1px solid var(--line);color:var(--text);background:rgba(255,255,255,.045);border-radius:8px;padding:9px 11px;font:inherit;font-size:13px}button:hover{border-color:var(--blue)}button:disabled{opacity:.58;cursor:not-allowed}button.danger{border-color:rgba(239,68,68,.46);color:#fecaca}button.warn{border-color:rgba(245,158,11,.46);color:#fde68a}.panel{border:1px solid var(--line);border-radius:8px;background:rgba(13,20,29,.82);overflow:hidden;box-shadow:var(--shadow)}.panel h2{margin:0;padding:15px 16px;font-size:15px;border-bottom:1px solid var(--line)}.events{max-height:540px;overflow:auto}.event{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.06)}.event:last-child{border-bottom:0}.event .meta{color:var(--muted);font-size:11px;margin-bottom:5px}.event.warning{border-left:3px solid var(--warn)}.event.error{border-left:3px solid var(--bad)}.event.action{border-left:3px solid var(--blue)}.empty{color:var(--muted);padding:18px}.login{min-height:100vh;display:grid;place-items:center}.small{width:min(360px,calc(100vw - 32px))}@media(max-width:900px){header{align-items:flex-start;flex-direction:column}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.layout{grid-template-columns:1fr}.host-settings{grid-template-columns:1fr 1fr}}@media(max-width:520px){.metrics,.facts{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.host-settings{grid-template-columns:1fr}.host-settings .span-2,.host-settings button[type=submit]{grid-column:1}}`;
}

function clientJs() {
  return `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmtAction = (a) => ({power_on:'开机', hard_off:'硬关机', reboot:'重启', hard_reboot:'硬重启'}[a] || a || '-');
let busy = false;

function notice(message, type) {
  const el = $('notice');
  el.textContent = message || '';
  el.className = message ? 'notice ' + (type || '') : 'notice hidden';
}

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || data.message || ('HTTP ' + res.status));
  return data;
}

function renderSpark(history) {
  const rows = (history || []).slice(-40);
  if (!rows.length) return '<div class="empty">暂无历史</div>';
  return rows.map((x) => '<span class="bar '+(x.v ? 'ok' : '')+'" title="'+esc(x.t)+'"></span>').join('');
}

function renderHost(h) {
  const status = h.status || 'unknown';
  const dotClass = status === 'online' ? 'ok' : status === 'offline' ? 'bad' : 'warn';
  const latency = h.last_latency_ms == null ? '-' : h.last_latency_ms + ' ms';
  const selected = (value, current) => value === current ? 'selected' : '';
  const autoEnabled = h.auto_enabled !== false;
  const autoAction = h.auto_action || 'hard_reboot';
  const interval = String(h.interval_seconds || 60);
  return '<article class="card">'
    + '<div class="server-head"><div class="server-title"><h2>'+esc(h.name || h.id)+'</h2><p>'+esc(h.provider_name || h.provider || '账号')+' · #'+esc(h.id)+' · '+esc(h.ip || '无 IP')+'</p></div><span class="badge '+esc(status)+'"><span class="dot '+dotClass+'"></span>'+esc(status)+'</span></div>'
    + '<div class="facts"><div class="fact"><label>电源状态</label><b>'+esc(h.power || '-')+'</b></div><div class="fact"><label>接口延迟</label><b>'+esc(latency)+'</b></div><div class="fact"><label>连续异常</label><b>'+esc(h.failures || 0)+'</b></div><div class="fact"><label>最近动作</label><b>'+esc(fmtAction(h.last_action))+'</b></div></div>'
    + '<div class="spark">'+renderSpark(h.history)+'</div>'
    + '<div class="actions"><button data-action="power_on" data-host="'+esc(h.key)+'">开机</button><button class="warn" data-action="hard_off" data-host="'+esc(h.key)+'">硬关机</button><button data-action="reboot" data-host="'+esc(h.key)+'">重启</button><button class="danger" data-action="hard_reboot" data-host="'+esc(h.key)+'">硬重启</button><button class="danger" data-delete-host="'+esc(h.key)+'">删除监控</button></div>'
    + '<div class="card-settings"><div class="strategy-title"><b>监控策略</b><span>下次异常按本卡片策略处理</span></div>'
    + '<form class="host-settings" data-host-settings="'+esc(h.key)+'">'
    + '<div><div class="label">服务器 ID</div><input name="server_id" value="'+esc(h.id || '')+'"></div>'
    + '<div><div class="label">账号名称</div><input name="provider_name" value="'+esc(h.provider_name || h.provider || '')+'"></div>'
    + '<div class="span-2"><div class="label">登录账号</div><input name="api_account" value="'+esc(h.api_account || '')+'" autocomplete="username"></div>'
    + '<div class="span-2"><div class="label">API 密钥</div><input name="api_password" type="password" placeholder="'+(h.has_api_password ? '已配置，留空不改' : '请输入 API 密钥')+'" autocomplete="current-password"></div>'
    + '<div><div class="label">检测间隔</div><select name="interval_seconds">'
    + [10,30,60,180,300,600].map((v) => '<option value="'+v+'" '+selected(String(v), interval)+'>'+({10:'10 秒',30:'30 秒',60:'1 分钟',180:'3 分钟',300:'5 分钟',600:'10 分钟'}[v])+'</option>').join('')
    + '</select></div>'
    + '<div><div class="label">自动恢复</div><select name="auto_enabled"><option value="true" '+(autoEnabled ? 'selected' : '')+'>开启</option><option value="false" '+(!autoEnabled ? 'selected' : '')+'>关闭</option></select></div>'
    + '<div><div class="label">离线动作</div><select name="auto_action"><option value="hard_reboot" '+selected('hard_reboot', autoAction)+'>硬重启</option><option value="reboot" '+selected('reboot', autoAction)+'>重启</option><option value="power_on" '+selected('power_on', autoAction)+'>开机</option></select></div>'
    + '<button type="submit">保存</button></form></div>'
    + (h.last_error ? '<p class="sub">错误：'+esc(h.last_error)+'</p>' : '')
    + '</article>';
}

function renderEvents(events) {
  if (!events || !events.length) return '<div class="empty">暂无事件</div>';
  const levelText = {info:'信息', warning:'警告', error:'错误', action:'操作'};
  return events.map((e) => '<div class="event '+esc(e.level)+'"><div class="meta">'+esc(e.time)+' '+(e.provider ? '· '+esc(e.provider) : '')+(e.host_id ? ' · #'+esc(e.host_id) : '')+' · '+esc(levelText[e.level] || e.level)+'</div><div>'+esc(e.message)+'</div></div>').join('');
}

function renderAccounts(accounts) {
  if (!accounts || !accounts.length) return '<div class="empty">暂无账号</div>';
  return accounts.map((a) => '<div class="account-row"><b>'+esc(a.name || a.id)+'</b><span>'+esc(a.api_account || '')+' · '+esc(a.host_count || 0)+' 台</span></div>').join('');
}

function render(data) {
  $('mTotal').textContent = data.summary.total;
  $('mOnline').textContent = data.summary.online;
  $('mOffline').textContent = data.summary.offline;
  $('mErrors').textContent = data.summary.errors;
  $('lastPoll').textContent = data.last_poll_at || '-';
  $('accountCount').textContent = (data.accounts || []).length;
  const bad = data.summary.offline || data.summary.errors;
  $('globalDot').className = 'dot ' + (bad ? 'bad' : 'ok');
  $('globalText').textContent = bad ? '需要关注' : '全部正常';
  $('servers').innerHTML = (data.hosts || []).map(renderHost).join('') || '<div class="empty">暂无服务器</div>';
  $('events').innerHTML = renderEvents(data.events);
  $('accounts').innerHTML = renderAccounts(data.accounts);
}

async function refresh() {
  try {
    render(await api('/api/status'));
  } catch (err) {
    $('globalDot').className = 'dot bad';
    $('globalText').textContent = '连接失败';
    notice('连接失败：' + err.message, 'bad');
  }
}

document.addEventListener('click', async (e) => {
  const delBtn = e.target.closest('button[data-delete-host]');
  if (delBtn && !busy) {
    const hostKey = delBtn.dataset.deleteHost;
    if (!confirm('确定删除监控项 ' + hostKey + '？这不会删除核云服务器。')) return;
    busy = true; delBtn.disabled = true; notice('正在删除监控项...');
    try {
      await api('/api/host-delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({host_key:hostKey})});
      notice('已删除监控项', 'ok');
      await refresh();
    } catch (err) { notice(err.message, 'bad'); alert(err.message); }
    finally { busy = false; delBtn.disabled = false; }
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn || busy) return;
  const action = btn.dataset.action;
  const hostKey = btn.dataset.host;
  if (!confirm('确定对 ' + hostKey + ' 执行' + fmtAction(action) + '？')) return;
  busy = true; btn.disabled = true; notice('正在发送' + fmtAction(action) + '指令...');
  try {
    await api('/api/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({host_key:hostKey, action})});
    notice('已发送' + fmtAction(action) + '指令', 'ok');
    await refresh();
  } catch (err) { notice(err.message, 'bad'); alert(err.message); }
  finally { busy = false; btn.disabled = false; }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-host-settings]');
  if (!form) return;
  e.preventDefault();
  const b = Object.fromEntries(new FormData(form));
  notice('正在保存服务器设置...');
  try {
    await api('/api/host-settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({host_key:form.dataset.hostSettings, server_id:b.server_id || '', provider_name:b.provider_name || '', api_account:b.api_account || '', api_password:b.api_password || '', interval_seconds:Number(b.interval_seconds || 60), auto_enabled:b.auto_enabled === 'true', auto_action:b.auto_action || 'hard_reboot'})});
    notice('服务器设置已保存', 'ok');
    await refresh();
  } catch (err) { notice(err.message, 'bad'); alert(err.message); }
});

$('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = Object.fromEntries(new FormData(e.target));
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  notice('正在登录核云并导入服务器...');
  try {
    const res = await api('/api/accounts', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(b)});
    e.target.reset();
    const msg = '已导入 ' + res.imported + ' 台服务器，跳过 ' + (res.skipped_count || 0) + ' 台。';
    notice(msg, res.imported ? 'ok' : '');
    alert(msg + (res.skipped && res.skipped.length ? '\\n' + res.skipped.slice(0, 5).map((x) => x.id + '：' + x.reason).join('\\n') : ''));
    await refresh();
  } catch (err) {
    notice('导入失败：' + err.message, 'bad');
    alert('导入失败：' + err.message);
  } finally {
    btn.disabled = false;
  }
});

$('pollBtn').addEventListener('click', async () => {
  $('pollBtn').disabled = true;
  notice('正在立即检测所有服务器...');
  try {
    render(await api('/api/poll', {method:'POST'}));
    notice('检测完成', 'ok');
  } catch (err) { notice('检测失败：' + err.message, 'bad'); alert(err.message); }
  finally { $('pollBtn').disabled = false; }
});

$('logoutBtn').addEventListener('click', () => fetch('/api/logout', {method:'POST'}).then(() => location='/login'));
refresh();
setInterval(refresh, 3000);
`;
}
