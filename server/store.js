"use strict";
/*
 * Персистентное хранилище приложения: решения, журнал действий, планы, отозванные сессии.
 * Три бэкенда (выбирается автоматически по переменным окружения):
 *   • Supabase (PostgreSQL) — основной для продакшена: таблицы decisions, audit_log, app_state.
 *     Включается SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *   • Redis по REST (Upstash / Vercel KV) — KV_REST_API_URL + KV_REST_API_TOKEN.
 *   • файл storage/state.json — локальный запуск (атомарная запись tmp + rename).
 * Без БД на Vercel файл лежит в /tmp и живёт, только пока жив экземпляр функции —
 * именно поэтому решения «пропадали» через несколько минут. Supabase это устраняет.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const sb = require("./supabase");
const { isoNow } = require("./util");

const AUDIT_LIMIT = 5000;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const PREFIX = process.env.STORE_PREFIX || "pulse";
const useSupabase = sb.enabled;
const useRedis = !useSupabase && !!(REDIS_URL && REDIS_TOKEN);
const STORAGE_DIR = process.env.STORAGE_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), "pulse-storage") : path.join(__dirname, "..", "storage"));
const STATE_FILE = path.join(STORAGE_DIR, "state.json");

const empty = () => ({ decisions: [], audit: [], revoked: {}, secret: null, seq: { decision: 0, audit: 0 } });
/** Ключи состояния, которые в Supabase лежат не в app_state, а в своих таблицах. */
const OWN_TABLES = new Set(["decisions", "audit", "seq"]);

let state = empty();
let pendingAudit = [];
let dirty = false;
let fileLoaded = false;
// Снимки последнего чтения из Supabase — чтобы записывать только изменившееся.
let snapDecisions = new Map();
let snapState = new Map();

/* ------------------------------- Supabase -------------------------------- */
const DECISION_COLS = ["id", "number", "title", "kpi_id", "domain", "problem", "impact", "cause", "action", "owner", "due_date", "priority", "status", "context", "created_by", "created_by_name", "created_at", "updated_at", "history"];

function decisionFromRow(r) {
  const d = {};
  for (const c of DECISION_COLS) d[c] = r[c];
  d.created_at = r.created_at ? isoNow(new Date(r.created_at)) : null;
  d.updated_at = r.updated_at ? isoNow(new Date(r.updated_at)) : null;
  d.history = Array.isArray(r.history) ? r.history : [];
  if (d.impact === null) d.impact = "";
  return d;
}
function decisionToRow(d) {
  const r = {};
  for (const c of DECISION_COLS) r[c] = d[c] === undefined ? null : d[c];
  if (r.due_date === "") r.due_date = null;
  return r;
}
function auditToRow(a) {
  return { id: a.id, at: a.at, user_login: a.user, user_name: a.user_name, role: a.role, action: a.action, object: a.object, result: a.result, details: a.details ?? null, ip: a.ip || null };
}
function auditFromRow(r) {
  return { id: r.id, at: isoNow(new Date(r.at)), user: r.user_login, user_name: r.user_name, role: r.role, action: r.action, object: r.object, result: r.result, details: r.details, ip: r.ip };
}

async function supabaseRefresh() {
  const [rows, kv] = await Promise.all([sb.selectAll("decisions", "select=*&order=id"), sb.select("app_state", "select=key,value")]);
  state = empty();
  state.decisions = rows.map(decisionFromRow);
  for (const { key, value } of kv) if (!OWN_TABLES.has(key)) state[key] = value;
  state.seq.decision = state.decisions.reduce((m, d) => Math.max(m, d.id), 0);
  snapDecisions = new Map(state.decisions.map((d) => [d.id, JSON.stringify(d)]));
  snapState = new Map(Object.keys(state).filter((k) => !OWN_TABLES.has(k)).map((k) => [k, JSON.stringify(state[k])]));
}

async function supabaseCommit() {
  const changedDecisions = state.decisions.filter((d) => snapDecisions.get(d.id) !== JSON.stringify(d));
  const now = isoNow();
  const changedState = Object.keys(state)
    .filter((k) => !OWN_TABLES.has(k) && state[k] !== undefined && snapState.get(k) !== JSON.stringify(state[k]))
    .map((k) => ({ key: k, value: state[k], updated_at: now }));
  const jobs = [];
  if (changedDecisions.length) jobs.push(sb.upsert("decisions", changedDecisions.map(decisionToRow), "id"));
  if (changedState.length) jobs.push(sb.upsert("app_state", changedState, "key"));
  if (pendingAudit.length) jobs.push(sb.insert("audit_log", pendingAudit.map(auditToRow)));
  await Promise.all(jobs);
  for (const d of changedDecisions) snapDecisions.set(d.id, JSON.stringify(d));
  for (const s of changedState) snapState.set(s.key, JSON.stringify(s.value));
}

/* ------------------------------- Redis REST ------------------------------- */
async function redis(commands) {
  const res = await fetch(REDIS_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Хранилище недоступно (Redis ${res.status})`);
  const out = await res.json();
  for (const r of out) if (r.error) throw new Error("Ошибка хранилища: " + r.error);
  return out.map((r) => r.result);
}

/* --------------------------------- Файл --------------------------------- */
function loadFile() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    state = empty();
    writeFile();
    return;
  }
  try {
    state = { ...empty(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch {
    // Повреждённый файл не должен ронять сервер: сохраняем копию и начинаем с чистого состояния.
    const backup = STATE_FILE + ".broken-" + Date.now();
    fs.copyFileSync(STATE_FILE, backup);
    console.error(`[store] state.json повреждён, копия сохранена в ${backup}`);
    state = empty();
    writeFile();
  }
}
function writeFile() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

/* ------------------------------ Публичный API ------------------------------ */

/** Подтянуть актуальное состояние перед обработкой запроса. */
async function refresh() {
  if (useSupabase) {
    await supabaseRefresh();
  } else if (useRedis) {
    const [raw] = await redis([["GET", `${PREFIX}:state`]]);
    state = { ...empty(), ...(raw ? JSON.parse(raw) : {}) };
    state.audit = [];
  } else if (!fileLoaded) {
    loadFile();
    fileLoaded = true;
  }
  pendingAudit = [];
  dirty = false;
}

/** Записать изменения после обработки запроса. */
async function commit() {
  if (useSupabase) {
    await supabaseCommit();
    pendingAudit = [];
    dirty = false;
    return;
  }
  if (!dirty && !pendingAudit.length) return;
  if (useRedis) {
    const cmds = [];
    if (dirty) cmds.push(["SET", `${PREFIX}:state`, JSON.stringify({ ...state, audit: undefined })]);
    if (pendingAudit.length) {
      cmds.push(["RPUSH", `${PREFIX}:audit`, ...pendingAudit.map((a) => JSON.stringify(a))]);
      cmds.push(["LTRIM", `${PREFIX}:audit`, String(-AUDIT_LIMIT), "-1"]);
    }
    await redis(cmds);
  } else {
    if (state.audit.length > AUDIT_LIMIT) state.audit.splice(0, state.audit.length - AUDIT_LIMIT);
    writeFile();
  }
  pendingAudit = [];
  dirty = false;
}

function markDirty() {
  dirty = true;
}

function nextId(kind) {
  state.seq[kind] = (state.seq[kind] || 0) + 1;
  dirty = true;
  return state.seq[kind];
}

function addAudit(entry) {
  const e = { id: crypto.randomBytes(6).toString("hex"), ...entry };
  if (useRedis || useSupabase) pendingAudit.push(e);
  else {
    state.audit.push(e);
    pendingAudit.push(e);
  }
}

/** Журнал: от новых к старым. */
async function listAudit() {
  if (useSupabase) {
    const rows = await sb.select("audit_log", `select=*&order=seq.desc&limit=${AUDIT_LIMIT}`);
    return pendingAudit.slice().reverse().concat(rows.map(auditFromRow));
  }
  if (useRedis) {
    const [list] = await redis([["LRANGE", `${PREFIX}:audit`, "0", "-1"]]);
    return list.map((x) => JSON.parse(x)).concat(pendingAudit).reverse();
  }
  return state.audit.slice().reverse();
}

/** Секрет подписи токенов: из окружения или сгенерированный и сохранённый в хранилище. */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!state.secret) {
    state.secret = crypto.randomBytes(32).toString("hex");
    dirty = true;
  }
  return state.secret;
}

module.exports = {
  refresh,
  commit,
  markDirty,
  nextId,
  addAudit,
  listAudit,
  sessionSecret,
  backend: useSupabase ? "supabase" : useRedis ? "redis" : "file",
  get state() {
    return state;
  },
  STATE_FILE,
};
