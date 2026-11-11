"use strict";
/*
 * Персистентное хранилище приложения (решения, журнал действий, сессии).
 * Простой JSON-файл storage/state.json с атомарной записью (tmp + rename),
 * чтобы данные переживали перезапуск сервера и выход/вход пользователя.
 */
const fs = require("fs");
const path = require("path");

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "..", "storage");
const STATE_FILE = path.join(STORAGE_DIR, "state.json");
const AUDIT_LIMIT = 5000;

const empty = () => ({ decisions: [], audit: [], sessions: {}, seq: { decision: 0, audit: 0 } });

let state = empty();
let writeTimer = null;

function load() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) {
    state = empty();
    flush();
    return;
  }
  try {
    state = { ...empty(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
  } catch (err) {
    // Повреждённый файл не должен ронять сервер: сохраняем копию и начинаем с чистого состояния.
    const backup = STATE_FILE + ".broken-" + Date.now();
    fs.copyFileSync(STATE_FILE, backup);
    console.error(`[store] state.json повреждён, копия сохранена в ${backup}`);
    state = empty();
    flush();
  }
}

function flush() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

/** Отложенная запись, чтобы частые события журнала не писали файл на каждый запрос. */
function save(immediate = false) {
  if (immediate) {
    clearTimeout(writeTimer);
    writeTimer = null;
    flush();
    return;
  }
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 300);
}

function nextId(kind) {
  state.seq[kind] = (state.seq[kind] || 0) + 1;
  return state.seq[kind];
}

function trimAudit() {
  if (state.audit.length > AUDIT_LIMIT) state.audit.splice(0, state.audit.length - AUDIT_LIMIT);
}

module.exports = {
  load,
  save,
  nextId,
  trimAudit,
  get state() {
    return state;
  },
  STATE_FILE,
};
