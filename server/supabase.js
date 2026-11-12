"use strict";
/*
 * Минимальный клиент Supabase (PostgREST) на встроенном fetch — без npm-зависимостей.
 * Работает только на сервере: использует service_role / secret-ключ, который обходит RLS.
 * Включается переменными SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (или SUPABASE_SECRET_KEY).
 */
const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const enabled = !!(URL_ && KEY);

function headers(extra = {}) {
  const h = { apikey: KEY, "Content-Type": "application/json", ...extra };
  // Классический service_role — это JWT, его нужно передать и в Authorization.
  // Новые ключи sb_secret_… передаются только в apikey.
  if (!KEY.startsWith("sb_")) h.Authorization = "Bearer " + KEY;
  return h;
}

async function request(method, pathAndQuery, { body, prefer, range } = {}) {
  const extra = {};
  if (prefer) extra.Prefer = prefer;
  if (range) extra.Range = range;
  let res;
  try {
    res = await fetch(`${URL_}/rest/v1/${pathAndQuery}`, {
      method,
      headers: headers(extra),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Хранилище недоступно (Supabase: ${err.message})`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.hint || text;
    } catch {}
    throw new Error(`Ошибка хранилища (Supabase ${res.status}): ${msg}`);
  }
  return text ? JSON.parse(text) : null;
}

/** SELECT всех строк таблицы постранично (PostgREST отдаёт не более 1000 строк за раз). */
async function selectAll(table, query = "select=*&order=id") {
  const page = 1000;
  const out = [];
  for (let from = 0; ; from += page) {
    const rows = await request("GET", `${table}?${query}`, { range: `${from}-${from + page - 1}` });
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const select = (table, query) => request("GET", `${table}?${query}`);

/** INSERT … ON CONFLICT DO UPDATE для пачки строк. */
async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    await request("POST", `${table}${onConflict ? "?on_conflict=" + onConflict : ""}`, {
      body: rows.slice(i, i + 500),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
}

async function insert(table, rows) {
  if (!rows.length) return;
  await request("POST", table, { body: rows, prefer: "return=minimal" });
}

module.exports = { enabled, url: URL_, request, select, selectAll, upsert, insert };
