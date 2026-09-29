const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHmac, webcrypto } = require("node:crypto");
const vm = require("node:vm");

const source = readFileSync(new URL("../api/[...path].js", `file://${__dirname}/`), "utf8")
  .replace('import { neon } from "@neondatabase/serverless";', "const neon = () => {}")
  .replace("export const config", "const config")
  .replace("export default async function handler", "async function handler");
const requests = [];
const sandbox = {
  crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
  process: { env: { SHOPEE_PARTNER_ID: "12345", SHOPEE_PARTNER_KEY: "test-secret", SHOPEE_REDIRECT_URI: "https://example.com/api/shopee/callback" } },
  fetch: async (url, options) => { requests.push({ url: String(url), options }); return { ok: true, json: async () => ({ response: { order_list: [] } }) }; }
};
vm.createContext(sandbox);
vm.runInContext(source + "\nthis.shops = { shopeeSign, shopeeRequest };", sandbox);

test("assinatura Shopee usa o caminho e o token da loja na ordem correta", async () => {
  const path = "/api/v2/order/get_order_list";
  const actual = await sandbox.shops.shopeeSign(path, 1700000000, "token", "42");
  const expected = createHmac("sha256", "test-secret").update("12345" + path + "1700000000token42").digest("hex");
  assert.equal(actual, expected);
});

test("chamada de pedidos envia parâmetros assinados sem expor a chave", async () => {
  await sandbox.shops.shopeeRequest("/api/v2/order/get_order_list", { token: "token", shopId: "42", params: { page_size: "50" } });
  const url = new URL(requests.at(-1).url);
  assert.equal(url.searchParams.get("access_token"), "token");
  assert.equal(url.searchParams.get("shop_id"), "42");
  assert.equal(url.searchParams.get("page_size"), "50");
  assert.equal(url.searchParams.get("sign").length, 64);
  assert.equal(url.href.includes("test-secret"), false);
});
