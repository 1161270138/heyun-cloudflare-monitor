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
    return handleRequest(request, env, ctx);
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
  const data = await zjmfRequest(account, "/hosts?page=1&limit=100");
  const raw = data.data;
  if (Array.isArray(raw)) return raw;
  return raw?.host || raw?.list || raw?.data || [];
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
    headers: { ...(init.headers || {}), Authorization: `JWT ${jwt}` },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!res.ok) throw new Error(data.msg || data.message || `HTTP ${res.status}`);
  return data;
}

async function login(account) {
  const url = new URL(normalizeBase(account.api_base_url) + "/login_api");
  url.searchParams.set("account", account.api_account);
  url.searchParams.set("password", account.api_password);
  const res = await fetch(url, { method: "POST" });
  const data = await res.json();
  const jwt = data.jwt || data.data?.jwt;
  if (!jwt) throw new Error(data.msg || data.message || "登录失败，未返回 JWT");
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
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function html(body) { return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }); }

function loginPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录</title><style>${css()}</style><body><main class="login"><form id="f" class="card small"><h1>核云监控</h1><p>输入管理密码</p><input name="password" type="password" placeholder="登录密码" autofocus><button>登录</button><div id="msg"></div></form></main><script>f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});const j=await r.json();if(j.ok)location='/';else msg.textContent=j.error||'登录失败'}</script></body></html>`;
}

function dashboardPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>核云监控</title><style>${css()}</style><body><header><div><h1>核云监控</h1><p>ZJMF · Cloudflare</p></div><button onclick="fetch('/api/logout',{method:'POST'}).then(()=>location='/login')">退出</button></header><main><section class="metrics"><div>总监控<b id="mTotal">0</b></div><div>在线<b id="mOnline">0</b></div><div>离线<b id="mOffline">0</b></div><div>错误<b id="mErrors">0</b></div></section><section class="layout"><div id="servers" class="grid"></div><aside class="panel"><h2>账号管理</h2><form id="accountForm"><input name="name" placeholder="账号名称"><input name="api_base_url" placeholder="API 地址，默认核云"><input name="api_account" placeholder="登录邮箱或手机号"><input name="api_password" type="password" placeholder="API 密钥"><button>添加账号并导入服务器</button></form><div id="accounts"></div><h2>事件流</h2><div id="events"></div></aside></section></main><script>${clientJs()}</script></body></html>`;
}

function css() {
  return `:root{color-scheme:dark;--bg:#070b10;--card:#111a24;--line:rgba(148,163,184,.18);--text:#e7edf2;--muted:#8fa0ad;--ok:#20d19b;--bad:#f06464;--warn:#f0b35b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,rgba(32,209,155,.12),transparent 34rem),var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,sans-serif}header{display:flex;justify-content:space-between;align-items:center;padding:18px 36px;border-bottom:1px solid var(--line);background:rgba(7,11,16,.85);position:sticky;top:0}h1{margin:0;font-size:18px}p{color:var(--muted)}main{padding:24px 36px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metrics div,.card,.panel{border:1px solid var(--line);background:linear-gradient(180deg,rgba(17,26,36,.96),rgba(11,17,24,.96));border-radius:8px;padding:16px}.metrics b{display:block;font-size:28px;margin-top:8px}.layout{display:grid;grid-template-columns:1fr 360px;gap:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}.head{display:flex;justify-content:space-between;gap:12px}.badge{border:1px solid var(--line);border-radius:999px;padding:5px 9px}.online{color:var(--ok)}.offline,.error{color:var(--bad)}.facts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.facts div{background:rgba(255,255,255,.04);border-radius:8px;padding:10px}.label{font-size:11px;color:var(--muted);margin-bottom:5px}input,select,button{width:100%;border:1px solid var(--line);background:#141f2b;color:var(--text);border-radius:8px;padding:9px 10px;font:inherit}button{cursor:pointer;width:auto}.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.danger{border-color:rgba(240,100,100,.55)}.warn{border-color:rgba(240,179,91,.55)}.host-settings{display:grid;grid-template-columns:1fr 1fr;gap:8px;border-top:1px solid var(--line);padding-top:12px}.span-2{grid-column:1/-1}.host-settings button{grid-column:1/-1;justify-self:end}.event{padding:10px 0;border-bottom:1px solid var(--line)}.event .meta{font-size:11px;color:var(--muted)}.login{min-height:100vh;display:grid;place-items:center}.small{width:min(360px,calc(100vw - 32px))}@media(max-width:900px){.layout,.metrics{grid-template-columns:1fr}.host-settings{grid-template-columns:1fr}}`;
}

function clientJs() {
  return `const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])),fmt=a=>({power_on:'开机',hard_off:'硬关机',reboot:'重启',hard_reboot:'硬重启'}[a]||a||'-');async function api(p,o){const r=await fetch(p,o),j=await r.json().catch(()=>({}));if(!r.ok||j.ok===false)throw Error(j.error||('HTTP '+r.status));return j}function host(h){const interval=String(h.interval_seconds||60),sel=(v,c)=>v===c?'selected':'';return '<article class="card"><div class="head"><div><b>'+esc(h.name||h.id)+'</b><p>'+esc(h.provider_name||h.provider)+' · #'+esc(h.id)+' · '+esc(h.ip||'无IP')+'</p></div><span class="badge '+esc(h.status)+'">'+esc(h.status)+'</span></div><div class="facts"><div><div class="label">电源</div><b>'+esc(h.power)+'</b></div><div><div class="label">延迟</div><b>'+(h.last_latency_ms??'-')+' ms</b></div><div><div class="label">异常</div><b>'+esc(h.failures||0)+'</b></div><div><div class="label">最近动作</div><b>'+esc(fmt(h.last_action))+'</b></div></div><div class="actions"><button data-action="power_on" data-host="'+esc(h.key)+'">开机</button><button class="warn" data-action="hard_off" data-host="'+esc(h.key)+'">硬关机</button><button data-action="reboot" data-host="'+esc(h.key)+'">重启</button><button class="danger" data-action="hard_reboot" data-host="'+esc(h.key)+'">硬重启</button><button class="danger" data-delete-host="'+esc(h.key)+'">删除监控</button></div><form class="host-settings" data-host-settings="'+esc(h.key)+'"><div><div class="label">服务器ID</div><input name="server_id" value="'+esc(h.id)+'"></div><div><div class="label">账号名称</div><input name="provider_name" value="'+esc(h.provider_name||h.provider)+'"></div><div class="span-2"><div class="label">登录账号</div><input name="api_account" value="'+esc(h.api_account||'')+'"></div><div class="span-2"><div class="label">API密钥</div><input name="api_password" type="password" placeholder="'+(h.has_api_password?'已配置，留空不改':'请输入API密钥')+'"></div><div><div class="label">检测间隔</div><select name="interval_seconds">'+[10,30,60,180,300,600].map(v=>'<option value="'+v+'" '+sel(String(v),interval)+'>'+({10:'10 秒',30:'30 秒',60:'1 分钟',180:'3 分钟',300:'5 分钟',600:'10 分钟'}[v])+'</option>').join('')+'</select></div><div><div class="label">自动恢复</div><select name="auto_enabled"><option value="true" '+(h.auto_enabled!==false?'selected':'')+'>开启</option><option value="false" '+(h.auto_enabled===false?'selected':'')+'>关闭</option></select></div><div><div class="label">离线动作</div><select name="auto_action"><option value="hard_reboot" '+sel('hard_reboot',h.auto_action)+'>硬重启</option><option value="reboot" '+sel('reboot',h.auto_action)+'>重启</option><option value="power_on" '+sel('power_on',h.auto_action)+'>开机</option></select></div><button>保存</button></form></article>'}function render(d){mTotal.textContent=d.summary.total;mOnline.textContent=d.summary.online;mOffline.textContent=d.summary.offline;mErrors.textContent=d.summary.errors;servers.innerHTML=d.hosts.map(host).join('')||'<div class="card">暂无服务器</div>';accounts.innerHTML=d.accounts.map(a=>'<p><b>'+esc(a.name)+'</b> '+esc(a.api_account)+' · '+a.host_count+' 台</p>').join('');events.innerHTML=d.events.map(e=>'<div class="event"><div class="meta">'+esc(e.time)+' · '+esc(e.provider||'')+' #'+esc(e.host_id||'')+'</div>'+esc(e.message)+'</div>').join('')}async function refresh(){render(await api('/api/status'))}document.addEventListener('click',async e=>{const del=e.target.closest('[data-delete-host]');if(del){if(!confirm('删除监控项？不会删除云服务器。'))return;await api('/api/host-delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({host_key:del.dataset.deleteHost})});return refresh()}const b=e.target.closest('[data-action]');if(!b)return;if(!confirm('确定执行 '+fmt(b.dataset.action)+'？'))return;await api('/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({host_key:b.dataset.host,action:b.dataset.action})});refresh()});document.addEventListener('submit',async e=>{const f=e.target;if(f.id==='accountForm'){e.preventDefault();const r=await api('/api/accounts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});alert('导入 '+r.imported+' 台，跳过 '+(r.skipped_count||0)+' 台重复');f.reset();return refresh()}if(f.dataset.hostSettings){e.preventDefault();const b=Object.fromEntries(new FormData(f));await api('/api/host-settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...b,host_key:f.dataset.hostSettings,interval_seconds:Number(b.interval_seconds),auto_enabled:b.auto_enabled==='true'})});return refresh()}});refresh();setInterval(refresh,3000);`;
}
