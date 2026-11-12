"use strict";
/*
 * Фейковый Supabase (PostgREST) в памяти для тестов: подменяет global.fetch для запросов
 * к SUPABASE_URL, остальные запросы (к локальному серверу) пропускает к настоящему fetch.
 * Поддерживает то, что использует server/supabase.js: select/order/limit/eq, Range,
 * insert и upsert (on_conflict), delete.
 */
const fs = require("fs");
const path = require("path");

const URL_ = "https://fake.supabase.test";

function create({ seed = true, fail = false } = {}) {
  const tables = { decisions: [], audit_log: [], app_state: [] };
  const calls = [];
  if (seed) {
    const { SOURCES, DATA_DIR, remoteTable } = require("../server/data");
    for (const src of SOURCES) tables[remoteTable(src)] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, src.file), "utf8"));
  }
  let auditSeq = 0;
  const realFetch = global.fetch;

  const json = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function handler(url, init = {}) {
    const u = new URL(url);
    const table = u.pathname.replace("/rest/v1/", "");
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, table, query: u.search });
    if (fail) return json(503, { message: "service unavailable" });
    if (!init.headers || !init.headers.apikey) return json(401, { message: "No API key" });
    if (!tables[table]) return json(404, { message: `relation "${table}" does not exist` });
    const q = u.searchParams;
    let rows = tables[table];
    const filters = [...q.entries()].filter(([k, v]) => !["select", "order", "limit", "on_conflict"].includes(k) && v.startsWith("eq."));
    const match = (r) => filters.every(([k, v]) => String(r[k]) === v.slice(3));

    if (method === "GET") {
      rows = rows.filter(match);
      if (q.get("order")) {
        const [col, dir] = q.get("order").split(".");
        rows = rows.slice().sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === "desc" ? -1 : 1));
      }
      if (q.get("limit")) rows = rows.slice(0, Number(q.get("limit")));
      const range = init.headers.Range;
      if (range) {
        const [a, b] = range.split("-").map(Number);
        rows = rows.slice(a, b + 1);
      }
      return json(200, JSON.parse(JSON.stringify(rows)));
    }
    if (method === "POST") {
      const body = JSON.parse(init.body);
      const key = q.get("on_conflict");
      for (const row of body) {
        const r = JSON.parse(JSON.stringify(row));
        if (table === "audit_log") r.seq = ++auditSeq;
        if (key) {
          const i = tables[table].findIndex((x) => x[key] === r[key]);
          if (i >= 0) tables[table][i] = { ...tables[table][i], ...r };
          else tables[table].push(r);
        } else {
          if (r.id !== undefined && tables[table].some((x) => x.id === r.id)) return json(409, { message: "duplicate key value violates unique constraint" });
          tables[table].push(r);
        }
      }
      return json(201);
    }
    if (method === "DELETE") {
      tables[table] = tables[table].filter((r) => !match(r));
      return json(204);
    }
    return json(405, { message: "method not allowed" });
  }

  global.fetch = (url, init) => (String(url).startsWith(URL_) ? handler(String(url), init) : realFetch(url, init));
  return { tables, calls, restore: () => (global.fetch = realFetch) };
}

/** Включить Supabase-режим: вызывать ДО require("../server/..."). */
function env() {
  process.env.SUPABASE_URL = URL_;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.SESSION_SECRET = "test-session-secret";
  delete process.env.KV_REST_API_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
}

module.exports = { create, env, URL: URL_ };
