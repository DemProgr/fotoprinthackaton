"use strict";
/*
 * Хранилище Supabase: решения не пропадают между экземплярами сервера (баг «решение
 * исчезает через пару минут»), журнал пишется в audit_log, данные читаются из БД.
 * Реальная БД не используется — фейковый PostgREST в памяти (tests/fake-supabase.js).
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fake = require("./fake-supabase");

fake.env();
const db = fake.create();

const SERVER_MODULES = ["index", "store", "data", "auth", "kpi", "views", "decisions", "analyst", "supabase", "util"];
/** Новый «экземпляр функции»: чистый кеш модулей, как при холодном старте на Vercel. */
function freshServer() {
  for (const m of SERVER_MODULES) delete require.cache[require.resolve(`../server/${m}.js`)];
  return require("../server/index.js");
}

let srv;
let base;
const j = async (p, { token, method = "GET", body, at = base } = {}) => {
  const r = await fetch(at + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const login = async (l, p, at = base) => (await j("/api/login", { method: "POST", body: { login: l, password: p }, at })).body.token;
const DECISION = {
  title: "Снизить брак на станке №14",
  domain: "production",
  problem: "Брак 5,7% при нормативе 3% за квартал",
  cause: "Ошибки оператора при настройке",
  action: "Провести обучение операторов",
  owner: "Павел Цехов",
  due_date: "2099-01-31",
  priority: "высокий",
};

before(async () => {
  srv = await freshServer().start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  srv.close();
  db.restore();
});

test("сервер работает в режиме Supabase", async () => {
  const t = await login("analyst", "analyst2026");
  const q = await j("/api/quality", { token: t });
  assert.equal(q.status, 200);
  assert.equal(q.body.storage, "supabase");
});

test("данные CRM/ERP/Финансов/HR читаются из Supabase, проверки качества те же", async () => {
  const t = await login("analyst", "analyst2026");
  const q = await j("/api/quality", { token: t });
  assert.equal(q.body.totals.critical, 2);
  assert.ok(q.body.freshness.some((f) => f.file === "Supabase · crm_orders"), "источник — таблица Supabase");
  assert.ok(db.calls.some((c) => c.table === "crm_orders" && c.method === "GET"));
});

test("решение сохраняется в таблицу decisions со связью на пользователя", async () => {
  const t = await login("director", "director2026");
  const r = await j("/api/decisions", { method: "POST", token: t, body: DECISION });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = db.tables.decisions.find((d) => d.id === r.body.id);
  assert.ok(row, "строка есть в БД");
  assert.equal(row.number, "РЕШ-0001");
  assert.equal(row.created_by, "director");
  assert.equal(row.due_date, "2099-01-31");
  assert.equal(row.history.length, 1);
});

test("решение НЕ пропадает: новый экземпляр сервера видит его (холодный старт)", async () => {
  const srv2 = await freshServer().start(0);
  const at = `http://127.0.0.1:${srv2.address().port}`;
  try {
    const t = await login("director", "director2026", at);
    const r = await j("/api/decisions", { token: t, at });
    assert.equal(r.status, 200);
    assert.equal(r.body.decisions.length, 1);
    assert.equal(r.body.decisions[0].title, DECISION.title);
    // Время возвращается в прежнем формате приложения (UTC+3), а не в формате PostgreSQL
    assert.match(r.body.decisions[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+03:00$/);
  } finally {
    srv2.close();
  }
});

test("изменение статуса пишется в БД с историей; следующий номер не повторяется", async () => {
  const t = await login("prod", "prod2026");
  const id = db.tables.decisions[0].id;
  const r = await j(`/api/decisions/${id}`, { method: "PATCH", token: t, body: { status: "в работе" } });
  assert.equal(r.status, 200);
  const row = db.tables.decisions.find((d) => d.id === id);
  assert.equal(row.status, "в работе");
  assert.equal(row.history.length, 2);
  const r2 = await j("/api/decisions", { method: "POST", token: t, body: { ...DECISION, title: "Второе решение по браку" } });
  assert.equal(r2.body.number, "РЕШ-0002");
});

test("решение, изменённое в БД другим экземпляром, сразу видно (без кеша)", async () => {
  db.tables.decisions[0].status = "выполнено";
  const t = await login("director", "director2026");
  const r = await j("/api/decisions", { token: t });
  assert.equal(r.body.decisions.find((d) => d.id === db.tables.decisions[0].id).status, "выполнено");
});

test("чтение без изменений не перезаписывает решения", async () => {
  const t = await login("director", "director2026");
  const before = db.calls.filter((c) => c.table === "decisions" && c.method === "POST").length;
  await j("/api/decisions", { token: t });
  await j("/api/kpi?period=90d", { token: t });
  const after = db.calls.filter((c) => c.table === "decisions" && c.method === "POST").length;
  assert.equal(after, before);
});

test("журнал действий пишется в audit_log и читается обратно", async () => {
  await j("/api/login", { method: "POST", body: { login: "director", password: "wrong" } });
  // Неудачный вход пишется от имени «аноним», введённый логин — в объекте
  assert.ok(db.tables.audit_log.some((a) => a.action === "вход" && a.user_login === "аноним" && /director/.test(a.object) && a.result !== "успех"), "неудачный вход в журнале");
  const t = await login("director", "director2026");
  const a = await j("/api/audit?result=fail", { token: t });
  assert.equal(a.status, 200);
  assert.ok(a.body.entries.length >= 1);
  assert.equal(a.body.entries[0].action, "вход");
  assert.match(a.body.entries[0].result, /^отказ/);
});

test("планы аналитика и отозванные сессии хранятся в app_state", async () => {
  const t = await login("analyst", "analyst2026");
  const plans = await j("/api/plans", { token: t });
  const f = plans.body.fields[0];
  const r = await j("/api/plans", { method: "PUT", token: t, body: { changes: { [f.id]: f.base + 1 }, reason: "Тест: новый бюджет" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(db.tables.app_state.some((s) => s.key === "plan_overrides"), "переопределения планов в БД");
  await j("/api/logout", { method: "POST", token: t });
  assert.ok(db.tables.app_state.some((s) => s.key === "revoked"), "отозванный токен в БД");
  assert.equal((await j("/api/me", { token: t })).status, 401, "после выхода токен не работает и на других экземплярах");
});
