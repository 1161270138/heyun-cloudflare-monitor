import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const ALLOWED_API_HOSTS = new Set(
  (process.env.ALLOWED_API_HOSTS || "www.heyunidc.cn,heyunidc.cn")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000);

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== "POST" || req.url !== "/zjmf") {
      return sendJson(res, 404, { ok: false, error: "not found" });
    }
    if (RELAY_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${RELAY_TOKEN}`) {
        return sendJson(res, 401, { ok: false, error: "invalid relay token" });
      }
    }

    const body = await readJson(req);
    const apiBaseUrl = normalizeBase(body.api_base_url);
    const apiHost = new URL(apiBaseUrl).hostname.toLowerCase();
    if (!ALLOWED_API_HOSTS.has(apiHost)) {
      return sendJson(res, 400, { ok: false, error: `api host not allowed: ${apiHost}` });
    }

    const account = String(body.api_account || "");
    const password = String(body.api_password || "");
    const path = String(body.path || "");
    const method = String(body.method || "GET").toUpperCase();
    if (!account || !password) return sendJson(res, 400, { ok: false, error: "api_account and api_password required" });
    if (!path.startsWith("/hosts")) return sendJson(res, 400, { ok: false, error: "path not allowed" });
    if (!["GET", "POST", "PUT"].includes(method)) return sendJson(res, 400, { ok: false, error: "method not allowed" });

    const jwt = await login(apiBaseUrl, account, password);
    const upstream = await fetchJson(apiBaseUrl + path, {
      method,
      headers: { Authorization: `JWT ${jwt}`, Accept: "application/json" },
      body: body.body || undefined,
    });
    return sendJson(res, 200, { ok: true, data: upstream.data });
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: String(error?.message || error) });
  }
});

server.listen(PORT, () => {
  console.log(`heyun relay listening on :${PORT}`);
});

async function login(apiBaseUrl, account, password) {
  const url = new URL(apiBaseUrl + "/login_api");
  url.searchParams.set("account", account);
  url.searchParams.set("password", password);
  const result = await fetchJson(url, { method: "POST", headers: { Accept: "application/json" } });
  const jwt = result.data.jwt || result.data.data?.jwt;
  if (!jwt) throw new Error(result.data.msg || result.data.message || "login failed: missing jwt");
  return jwt;
}

async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { message: compactText(text) }; }
    if (!response.ok) {
      throw new Error(data.msg || data.message || `HTTP ${response.status}`);
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBase(value) {
  const base = String(value || "https://www.heyunidc.cn/v1").replace(/\/+$/, "");
  const url = new URL(base.endsWith("/v1") ? base : `${base}/v1`);
  if (url.protocol !== "https:") throw new Error("api_base_url must use https");
  return url.toString().replace(/\/$/, "");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 64) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
}
