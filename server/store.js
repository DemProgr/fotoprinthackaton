"use strict";
/*
 * Персистентное хранилище приложения: решения, журнал действий, отозванные сессии.
 * Два бэкенда:
 *   • файл storage/state.json (локальный запуск; атомарная запись tmp + rename);
 *   • Redis по REST (Upstash / Vercel KV) — для бессерверного развёртывания (Vercel),
 *     включается переменными KV_REST_API_URL + KV_REST_API_TOKEN
 *     (или UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 * Без Redis на Vercel используется /tmp — данные живут, пока жив экземпляр функции.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const AUDIT_LIMIT = 5000;
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const PREFIX = process.env.STORE_PREFIX || "pulse";
const useRedis = !!(REDIS_URL && REDIS_TOKEN);
const STORAGE_DIR = process.env.STORAGE_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), "pulse-storage") : path.join(__dirname, "..", "storage"));
const STATE_FILE = path.join(STORAGE_DIR, "state.json");

const empty = () => ({ decisions: [], audit: [], revoked: {}, secret: null, seq: { decision: 0, audit: 0 } });

let state = empty();
let pendingAudit = [];
let dirty = false;
let fileLoaded = false;

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
  if (useRedis) {
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
  if (useRedis) pendingAudit.push(e);
  else {
    state.audit.push(e);
    pendingAudit.push(e);
  }
}

/** Журнал: от новых к старым. */
async function listAudit() {
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
  backend: useRedis ? "redis" : "file",
  get state() {
    return state;
  },
  STATE_FILE,
};
