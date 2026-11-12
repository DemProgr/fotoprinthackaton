"use strict";
/* Автотесты критериев приёмки Трека 1 (УП-01…УП-05, ОТ-02, ОТ-04, ОТ-05). Запуск: npm test */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-test-"));
const { start } = require("../server/index.js");

let server;
let base;
const j = async (p, { token, method = "GET", body } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const login = async (l, p) => (await j("/api/login", { method: "POST", body: { login: l, password: p } })).body.token;
const tokens = {};

before(async () => {
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.director = await login("director", "director2026");
  tokens.sales = await login("sales", "sales2026");
  tokens.prod = await login("prod", "prod2026");
  tokens.analyst = await login("analyst", "analyst2026");
});
after(() => server.close());

test("неверный пароль отклоняется с понятной ошибкой", async () => {
  const r = await j("/api/login", { method: "POST", body: { login: "director", password: "x" } });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Неверный логин или пароль/);
});

test("без входа API закрыт", async () => {
  const r = await j("/api/kpi");
  assert.equal(r.status, 401);
});

test("УП-02: ≥ 10 KPI с формулой, источником и временем обновления", async () => {
  const r = await j("/api/kpi?period=90d", { token: tokens.director });
  assert.equal(r.status, 200);
  assert.ok(r.body.kpis.length >= 10, `KPI: ${r.body.kpis.length}`);
  for (const k of r.body.kpis) {
    assert.ok(k.formula && k.sources.length && k.updated_at, k.id);
    assert.match(k.updated_at, /[+-]\d\d:\d\d$/, "время с часовым поясом");
    assert.ok(["green", "yellow", "red", "gray"].includes(k.status));
    assert.ok("plan" in k && "forecast" in k);
  }
  assert.ok(r.body.critical.length > 0, "есть красные отклонения для демонстрации");
});

test("УП-03: фильтр периода и продукта меняет показатели", async () => {
  const a = await j("/api/kpi?period=90d", { token: tokens.director });
  const b = await j("/api/kpi?period=365d", { token: tokens.director });
  const c = await j("/api/kpi?period=90d&product=" + encodeURIComponent("календарь"), { token: tokens.director });
  const rev = (r) => r.body.kpis.find((k) => k.id === "revenue").value;
  assert.notEqual(rev(a), rev(b));
  assert.ok(rev(c) < rev(a));
});

test("УП-03: детализация объясняет отклонение и доходит до записей", async () => {
  const d = await j("/api/kpi/defect/drill?period=90d&dim=machine", { token: tokens.director });
  assert.equal(d.status, 200);
  assert.ok(d.body.rows.length > 0);
  assert.match(d.body.explanation, /Главный вклад/);
  const key = d.body.rows[0].key;
  const r = await j(`/api/kpi/defect/records?period=90d&dim=machine&key=${encodeURIComponent(key)}`, { token: tokens.director });
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.every((x) => x.machine === key));
});

test("УП-01: источники связаны общими ID (сквозная карточка заказа)", async () => {
  const r = await j("/api/kpi/defect/records?period=all", { token: tokens.director });
  const orderId = r.body.rows.find((x) => x.order__order_id && !String(x.order).includes("нет в CRM")).order__order_id;
  const c = await j(`/api/orders/${orderId}`, { token: tokens.director });
  assert.equal(c.status, 200);
  assert.ok(c.body.client, "CRM клиент");
  assert.ok(c.body.production.length > 0, "ERP производство");
  assert.ok(c.body.production[0].shift?.operator_id, "HR оператор смены");
});

test("УП-05 / ОТ-02: руководитель продаж не видит производство и финансы", async () => {
  const k = await j("/api/kpi", { token: tokens.sales });
  assert.ok(k.body.kpis.every((x) => x.domain === "sales"));
  assert.ok(k.body.hidden_domains.length >= 3);
  for (const p of ["/api/kpi/defect/drill", "/api/kpi/revenue/records", "/api/screens/production", "/api/screens/finance", "/api/kpi?domain=finance", "/api/quality", "/api/audit"]) {
    const r = await j(p, { token: tokens.sales });
    assert.equal(r.status, 403, p);
    assert.match(r.body.error, /[А-Яа-я]/);
  }
});

test("УП-05: руководитель производства не видит продажи; суммы оплат в карточке скрыты", async () => {
  const k = await j("/api/kpi", { token: tokens.prod });
  assert.ok(k.body.kpis.every((x) => x.domain === "production"));
  assert.equal((await j("/api/kpi/revenue/drill", { token: tokens.prod })).status, 403);
  const c = await j("/api/orders/1", { token: tokens.prod });
  assert.ok(c.body.payments.every((p) => p.amount === null));
});

test("валидация решения возвращает ошибки на русском по полям", async () => {
  const r = await j("/api/decisions", { token: tokens.director, method: "POST", body: { title: "x", due_date: "31.12.2026", priority: "срочно" } });
  assert.equal(r.status, 422);
  assert.ok(r.body.details.title && r.body.details.due_date && r.body.details.priority && r.body.details.owner);
  const bad = await j("/api/decisions", { token: tokens.director, method: "POST", body: "{не json" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /JSON/);
});

test("УП-04: решение сохраняется, переживает выход/вход, изменения в истории и журнале", async () => {
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const c = await j("/api/decisions", {
    token: tokens.prod,
    method: "POST",
    body: { title: "Снизить брак на станке №14", domain: "production", kpi_id: "defect", problem: "Брак 5,7% при плане 3% на станке №14", cause: "Износ печатной головки", action: "Заменить головку, перепроверить калибровку", owner: "Главный инженер", due_date: due, priority: "высокий" },
  });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(c.body.number, /^РЕШ-\d{4}$/);
  // выход и повторный вход
  await j("/api/logout", { token: tokens.prod, method: "POST" });
  tokens.prod = await login("prod", "prod2026");
  const list = await j("/api/decisions", { token: tokens.prod });
  assert.ok(list.body.decisions.some((d) => d.id === c.body.id));
  const u = await j(`/api/decisions/${c.body.id}`, { token: tokens.prod, method: "PATCH", body: { status: "в работе" } });
  assert.equal(u.body.status, "в работе");
  assert.equal(u.body.history.length, 2);
  // руководитель продаж не видит и не меняет чужое решение
  assert.ok(!(await j("/api/decisions", { token: tokens.sales })).body.decisions.some((d) => d.id === c.body.id));
  assert.equal((await j(`/api/decisions/${c.body.id}`, { token: tokens.sales, method: "PATCH", body: { status: "выполнено" } })).status, 403);
  // аналитик — только просмотр
  assert.equal((await j("/api/decisions", { token: tokens.analyst, method: "POST", body: {} })).status, 403);
  const a = await j("/api/audit", { token: tokens.director });
  const actions = a.body.entries.map((e) => e.action);
  assert.ok(actions.includes("создание решения") && actions.includes("изменение решения") && actions.includes("доступ запрещён") && actions.includes("вход") && actions.includes("выход"));
  assert.ok(a.body.entries.every((e) => e.at && e.user && e.action && e.result));
});

test("аналитик: свежесть, дубли/пропуски, сверка финансов", async () => {
  const q = await j("/api/quality", { token: tokens.analyst });
  assert.equal(q.status, 200);
  assert.ok(q.body.freshness.length >= 14);
  assert.ok(q.body.issues.some((i) => /Дубли/.test(i.check)));
  assert.ok(q.body.issues.some((i) => /→/.test(i.check)), "разорванные связи");
  assert.ok(q.body.reconciliation.some((r) => !r.ok), "найдено расхождение сверки");
  assert.equal((await j("/api/admin/reload", { token: tokens.analyst, method: "POST" })).status, 200);
});

test("прогноз спроса и мощности ≥ 4 недель с неделей дефицита", async () => {
  const f = await j("/api/forecast", { token: tokens.director });
  assert.ok(f.body.weeks.length >= 4);
  assert.ok(f.body.first_deficit_week);
});

test("некорректные фильтры дают понятную ошибку, а не падение", async () => {
  const r = await j("/api/kpi?period=custom&from=2026-10-01&to=2026-01-01", { token: tokens.director });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /позже/);
  assert.equal((await j("/api/kpi?product=ракета", { token: tokens.director })).status, 400);
});

test("качество данных: ровно 2 критичные проблемы", async () => {
  const q = await j("/api/quality", { token: tokens.analyst });
  assert.equal(q.body.totals.critical, 2);
});

test("аналитик ведёт планы KPI, директор — только просмотр; план меняет статус KPI", async () => {
  const before = (await j("/api/kpi?period=90d", { token: tokens.director })).body.kpis.find((k) => k.id === "conversion");
  const d = await j("/api/plans", { token: tokens.director });
  assert.equal(d.status, 200);
  assert.equal(d.body.editable, false);
  assert.equal((await j("/api/plans", { token: tokens.director, method: "PUT", body: { changes: { "targets.conversion_pct": 10 }, reason: "тест" } })).status, 403);
  assert.equal((await j("/api/plans", { token: tokens.sales })).status, 403);
  const bad = await j("/api/plans", { token: tokens.analyst, method: "PUT", body: { changes: { "targets.conversion_pct": 150 }, reason: "" } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.details.reason && bad.body.details["targets.conversion_pct"]);
  const ok = await j("/api/plans", { token: tokens.analyst, method: "PUT", body: { changes: { "targets.conversion_pct": 10 }, reason: "Тестовая корректировка" } });
  assert.equal(ok.status, 200);
  const after = (await j("/api/kpi?period=90d", { token: tokens.director })).body.kpis.find((k) => k.id === "conversion");
  assert.equal(after.plan, 10);
  assert.notEqual(after.plan, before.plan);
  await j("/api/plans", { token: tokens.analyst, method: "PUT", body: { changes: { "targets.conversion_pct": null }, reason: "Вернуть значение plans.json" } });
  assert.equal((await j("/api/kpi?period=90d", { token: tokens.director })).body.kpis.find((k) => k.id === "conversion").plan, before.plan);
});

test("аналитик разбирает проблемы данных, сравнивает периоды и выгружает CSV; директору это закрыто", async () => {
  const q = await j("/api/quality", { token: tokens.analyst });
  const key = q.body.issues[0].key;
  const u = await j("/api/quality/issues", { token: tokens.analyst, method: "PATCH", body: { key, status: "в работе", comment: "Заявка в CRM" } });
  assert.equal(u.status, 200);
  assert.equal((await j("/api/quality", { token: tokens.director })).body.issues.find((i) => i.key === key).workflow.status, "в работе");
  assert.equal((await j("/api/quality/issues", { token: tokens.director, method: "PATCH", body: { key, status: "новая" } })).status, 403);
  const c = await j("/api/analysis/compare?period=90d&mode=prev", { token: tokens.analyst });
  assert.equal(c.status, 200);
  assert.ok(c.body.rows.length >= 10 && c.body.previous.to < c.body.current.from);
  assert.equal((await j("/api/analysis/compare?period=90d", { token: tokens.director })).status, 403);
  const csv = await j("/api/kpi/defect/records?period=90d&format=csv", { token: tokens.analyst });
  assert.equal(csv.status, 200);
  assert.match(csv.body.csv, /;/);
  assert.equal((await j("/api/kpi/defect/records?period=90d&format=csv", { token: tokens.director })).status, 403);
});

test("журнал: объект записывается как путь", async () => {
  await j("/api/kpi/defect/drill?period=90d&dim=machine", { token: tokens.director });
  const a = await j("/api/audit", { token: tokens.director });
  const e = a.body.entries.find((x) => x.action === "детализация");
  assert.match(e.object, /^Пульс компании › KPI «.+» › Детализация: /);
});

test("entrypoint Vercel — вызываемая функция (req, res)", () => {
  const entry = require("../api/index.js");
  assert.equal(typeof entry, "function", "Vercel требует вызываемый module.exports");
});
