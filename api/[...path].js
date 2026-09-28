import { neon } from "@neondatabase/serverless";

export const config = { runtime: "edge" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessionDays = 30;
let schemaReady;

const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

function now() { return new Date().toISOString(); }
function future(minutes) { return new Date(Date.now() + minutes * 60_000).toISOString(); }
function clean(value, max = 500) { return String(value ?? "").replace(/[<>]/g, "").trim().slice(0, max); }
function json(value, status = 200, extra = {}) { return new Response(JSON.stringify(value), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8", ...extra } }); }
function readCookies(request) { return Object.fromEntries((request.headers.get("cookie") || "").split(";").map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key)); }
function sameOrigin(request) { const origin = request.headers.get("origin"); return !origin || origin === new URL(request.url).origin; }
function appCookie(token, maxAge = sessionDays * 86_400) { return `ps3d_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function clearCookie() { return "ps3d_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"; }
function base64Url(bytes) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function bytes(value) { const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/"); const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function randomToken(size = 32) { const value = new Uint8Array(size); crypto.getRandomValues(value); return base64Url(value); }
async function digest(value) { return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))); }

function database() {
  if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL antes de ativar a central.");
  const query = neon(process.env.DATABASE_URL);
  const convert = (statement) => { let index = 0; return statement.replace(/\?/g, () => `$${++index}`); };
  const prepare = (statement) => {
    const values = [];
    return {
      bind(...bound) { values.push(...bound); return this; },
      async first() { return (await query(convert(statement), values))[0] || null; },
      async run() { await query(convert(statement), values); return { success: true }; }
    };
  };
  return { prepare, batch: async (statements) => Promise.all(statements.map((statement) => statement.run())) };
}

async function ensureSchema(db) {
  if (!schemaReady) schemaReady = db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at)")
  ]);
  await schemaReady;
}

async function configGet(db, key) { return (await db.prepare("SELECT value FROM app_config WHERE key = ?").bind(key).first())?.value || null; }
async function configSet(db, entries) { const updated = now(); await db.batch(entries.map(([key, value]) => db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at").bind(key, value, updated))); }
async function aesKey() { return crypto.subtle.importKey("raw", bytes(process.env.APP_DATA_KEY || ""), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
async function encrypt(value) { const iv = new Uint8Array(12); crypto.getRandomValues(iv); const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), encoder.encode(value)); return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`; }
async function decrypt(value) { const [iv, encrypted] = String(value || "").split("."); if (!iv || !encrypted) throw new Error("Dados protegidos inválidos."); const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(iv) }, await aesKey(), bytes(encrypted)); return decoder.decode(plain); }
async function passwordHash(password, salt) { const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]); const result = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: bytes(salt), iterations: 210000, hash: "SHA-256" }, material, 256); return base64Url(new Uint8Array(result)); }
async function createSession(db) { const token = randomToken(); await db.prepare("INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)").bind(await digest(`${process.env.APP_SESSION_KEY}:${token}`), future(sessionDays * 24 * 60), now()).run(); return token; }
async function isAdmin(request, db) { const token = readCookies(request).ps3d_session; if (!token) return false; return Boolean(await db.prepare("SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ?").bind(await digest(`${process.env.APP_SESSION_KEY}:${token}`), now()).first()); }
async function cleanup(db) { await db.batch([db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now()), db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(now())]); }
async function requireAdmin(request, db) { return (await isAdmin(request, db)) ? null : json({ error: "Entre no painel para continuar." }, 401); }

async function mlToken(fields) {
  const response = await fetch("https://api.mercadolibre.com/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || value.error_description || "O Mercado Livre recusou a conexão.");
  return value;
}
async function storeTokens(db, data) { await configSet(db, [["access_token", await encrypt(data.access_token)], ["refresh_token", await encrypt(data.refresh_token)], ["access_expires_at", new Date(Date.now() + Math.max(60, Number(data.expires_in || 0) - 90) * 1000).toISOString()], ["ml_user_id", String(data.user_id || "")]]); }
async function refreshToken(db) { const refresh = await configGet(db, "refresh_token"); const secret = await configGet(db, "client_secret"); if (!refresh || !secret) throw new Error("Conexão Mercado Livre não encontrada."); const data = await mlToken({ grant_type: "refresh_token", client_id: process.env.ML_CLIENT_ID, client_secret: await decrypt(secret), refresh_token: await decrypt(refresh) }); await storeTokens(db, data); return data.access_token; }
async function accessToken(db) { const token = await configGet(db, "access_token"); const expiresAt = await configGet(db, "access_expires_at"); return !token || !expiresAt || Date.parse(expiresAt) <= Date.now() ? refreshToken(db) : decrypt(token); }
async function mlFetch(db, path, options = {}, retried = false) { const response = await fetch(`https://api.mercadolibre.com${path}`, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${await accessToken(db)}` } }); if (response.status === 401 && !retried) { await refreshToken(db); return mlFetch(db, path, options, true); } return response; }
async function responseError(response) { const value = await response.json().catch(() => ({})); const causes = Array.isArray(value.cause) ? value.cause.map((cause) => cause.message || cause.code).filter(Boolean).join("; ") : ""; return causes || value.message || value.error || `Erro ${response.status} do Mercado Livre.`; }
async function category(db, title) { const response = await mlFetch(db, `/sites/MLB/domain_discovery/search?limit=1&q=${encodeURIComponent(title)}`); if (!response.ok) throw new Error(await responseError(response)); const values = await response.json(); const id = Array.isArray(values) ? values[0]?.category_id : values?.category_id; if (!id) throw new Error("Não foi possível localizar a categoria automaticamente."); return id; }
async function uploadPhoto(db, photo) { const form = new FormData(); form.append("file", photo, photo.name || "enfeite-natalino.jpg"); const response = await mlFetch(db, "/pictures/items/upload", { method: "POST", body: form }); if (!response.ok) throw new Error(await responseError(response)); const picture = await response.json(); return picture.secure_url || picture.url; }
async function createItem(db, item, description) { const response = await mlFetch(db, "/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item) }); if (!response.ok) throw new Error(await responseError(response)); const created = await response.json(); const descriptionResponse = await mlFetch(db, `/items/${encodeURIComponent(created.id)}/description`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plain_text: description }) }); if (!descriptionResponse.ok) throw new Error(`O anúncio ${created.id} foi criado, mas a descrição não foi salva: ${await responseError(descriptionResponse)}`); return created; }

function productTitle(model) { return `Enfeite Natalino 3D ${model} Decorativo 10 a 12 cm`; }
function productDescription(model, base) { return `${base}\n\nModelo: ${model}.\nConteúdo: 1 unidade do modelo escolhido.`; }
const defaultDescription = "Enfeite natalino decorativo produzido em impressão 3D.\n\nTamanho aproximado: 10 a 12 cm.\nProduto fixo (não articulado).\nProduzido artesanalmente; podem existir leves marcas naturais da impressão 3D.\nA bandeja da foto não acompanha.";

export default async function handler(request, context) {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (!process.env.DATABASE_URL) {
    if (path === "/api/status" && request.method === "GET") {
      return json({ setupComplete: false, authenticated: false, connected: false, databaseConfigured: false });
    }
    return json({ error: "Conecte o banco de dados seguro antes de ativar a central." }, 503);
  }
  const db = database();
  await ensureSchema(db);
  try {
    if (path === "/api/mercadolivre/notificacoes") return json({ received: true });
    if (path === "/api/status" && request.method === "GET") { const setupComplete = (await configGet(db, "setup_complete")) === "1"; const authenticated = setupComplete && await isAdmin(request, db); return json({ databaseConfigured: true, setupComplete, authenticated, connected: authenticated && Boolean(await configGet(db, "refresh_token")) }); }
    if (path === "/api/setup" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Origem não permitida." }, 403);
      if ((await configGet(db, "setup_complete")) === "1") return json({ error: "O painel já foi ativado." }, 409);
      const form = await request.formData(); const code = String(form.get("setupCode") || ""); const password = String(form.get("adminPassword") || ""); const secret = String(form.get("clientSecret") || "");
      if (code !== process.env.APP_SETUP_CODE) return json({ error: "Código de ativação inválido." }, 403);
      if (password.length < 8 || secret.length < 12) return json({ error: "Crie uma senha de 8 caracteres e informe a chave do Mercado Livre." }, 400);
      const salt = randomToken(16); await configSet(db, [["admin_salt", salt], ["admin_hash", await passwordHash(password, salt)], ["client_secret", await encrypt(secret)], ["setup_complete", "1"]]);
      return json({ ok: true }, 200, { "set-cookie": appCookie(await createSession(db)) });
    }
    if (path === "/api/login" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Origem não permitida." }, 403);
      const { password } = await request.json().catch(() => ({})); const salt = await configGet(db, "admin_salt"); const stored = await configGet(db, "admin_hash");
      if (!salt || !stored || typeof password !== "string" || (await passwordHash(password, salt)) !== stored) return json({ error: "Senha incorreta." }, 401);
      return json({ ok: true }, 200, { "set-cookie": appCookie(await createSession(db)) });
    }
    if (path === "/api/logout" && request.method === "POST") { const token = readCookies(request).ps3d_session; if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digest(`${process.env.APP_SESSION_KEY}:${token}`)).run(); return json({ ok: true }, 200, { "set-cookie": clearCookie() }); }
    if (path === "/api/connect" && request.method === "GET") {
      const denied = await requireAdmin(request, db); if (denied) return denied;
      const state = randomToken(24); await db.prepare("INSERT INTO oauth_states (state_hash, expires_at, created_at) VALUES (?, ?, ?)").bind(await digest(`${process.env.APP_SESSION_KEY}:${state}`), future(10), now()).run(); await cleanup(db);
      const target = new URL("https://auth.mercadolivre.com.br/authorization"); target.search = new URLSearchParams({ response_type: "code", client_id: process.env.ML_CLIENT_ID, redirect_uri: process.env.ML_REDIRECT_URI, state }).toString(); return Response.redirect(target, 302);
    }
    if (path === "/api/mercadolivre/oauth/callback" && request.method === "GET") {
      const url = new URL(request.url); const code = url.searchParams.get("code"); const state = url.searchParams.get("state"); if (!code || !state) return new Response("Autorização inválida.", { status: 400, headers });
      const pending = await db.prepare("SELECT state_hash FROM oauth_states WHERE state_hash = ? AND expires_at > ?").bind(await digest(`${process.env.APP_SESSION_KEY}:${state}`), now()).first(); if (!pending) return new Response("Autorização expirada. Volte ao painel.", { status: 400, headers });
      const secret = await configGet(db, "client_secret"); if (!secret) return new Response("Ative o painel antes de conectar.", { status: 400, headers });
      await storeTokens(db, await mlToken({ grant_type: "authorization_code", client_id: process.env.ML_CLIENT_ID, client_secret: await decrypt(secret), code, redirect_uri: process.env.ML_REDIRECT_URI })); await db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(await digest(`${process.env.APP_SESSION_KEY}:${state}`)).run();
      return Response.redirect(new URL("/?conectado=1", request.url), 302);
    }
    if (path === "/api/listings" && request.method === "POST") {
      if (!sameOrigin(request)) return json({ error: "Origem não permitida." }, 403); const denied = await requireAdmin(request, db); if (denied) return denied;
      if (!(await configGet(db, "refresh_token"))) return json({ error: "Conecte o Mercado Livre antes de publicar." }, 409);
      const form = await request.formData(); const photo = form.get("photo"); const model = clean(form.get("model"), 40); const isKit = form.get("kit") === "sim"; const description = clean(form.get("description"), 3500) || defaultDescription;
      if (!(photo instanceof File) || photo.size === 0 || photo.size > 8 * 1024 * 1024) return json({ error: "Envie uma foto de até 8 MB." }, 400); if (!model && !isKit) return json({ error: "Selecione um modelo ou o kit." }, 400);
      const source = await uploadPhoto(db, photo); const title = isKit ? "Kit 6 Enfeites Natalinos 3D Decorativos 10 a 12 cm" : productTitle(model); const categoryId = await category(db, title);
      const item = { title, category_id: categoryId, price: isKit ? 159.9 : 30, currency_id: "BRL", available_quantity: 3, buying_mode: "buy_it_now", listing_type_id: "gold_special", condition: "new", pictures: [{ source }] };
      const descriptionText = isKit ? `${description}\n\nConteúdo do kit: 2 renas, Papai Noel, boneco de neve, pinguim e urso polar.` : productDescription(model, description);
      const created = await createItem(db, item, descriptionText); return json({ ok: true, id: created.id, permalink: created.permalink || "" });
    }
    if (path === "/api/cron/marketplace-sync") {
      const authorization = request.headers.get("authorization"); if (authorization !== `Bearer ${process.env.CRON_SECRET}`) return json({ error: "Não autorizado." }, 401);
      const connected = Boolean(await configGet(db, "refresh_token")); if (connected) await accessToken(db); await cleanup(db); return json({ ok: true, connected, checkedAt: now() });
    }
    return new Response("Não encontrado.", { status: 404, headers });
  } catch (error) { return json({ error: error?.message || "Ocorreu um erro inesperado." }, 500); }
}
