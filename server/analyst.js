"use strict";
/*
 * Функции аналитика / администратора данных:
 *   • планы и нормативы KPI — корректировки поверх plans.json с историей изменений;
 *   • разбор проблем качества данных — статус, ответственный, комментарий;
 *   • сравнение двух периодов по всем KPI;
 *   • выгрузка таблиц в CSV.
 */
const store = require("./store");
const kpi = require("./kpi");
const { isoNow, dayNum, dayStr, round } = require("./util");

/* ------------------------------ Планы и нормативы ------------------------------ */

/** Редактируемые параметры plans.json: группа, ключ, подпись, единица, затронутые KPI. */
const PLAN_FIELDS = [
  ["monthly", "revenue", "Выручка в месяц", "BYN", ["revenue"]],
  ["monthly", "expenses", "Расходы в месяц", "BYN", ["expenses"]],
  ["monthly", "orders", "Заказов в месяц", "шт.", ["orders"]],
  ["monthly", "new_clients", "Новых клиентов в месяц", "чел.", ["new_clients"]],
  ["targets", "margin_pct", "Рентабельность", "%", ["margin"]],
  ["targets", "avg_check", "Средний чек", "BYN", ["avg_check"]],
  ["targets", "conversion_pct", "Конверсия воронки", "%", ["conversion"]],
  ["targets", "repeat_pct", "Доля повторных клиентов", "%", ["repeat"]],
  ["targets", "active_clients_month", "Активных клиентов в месяц", "чел.", ["active_clients"]],
  ["targets", "sla_pct", "Обращения в срок (SLA)", "%", ["sla"]],
  ["targets", "output_pct", "Выполнение плана выпуска", "%", ["output"]],
  ["targets", "on_time_pct", "Заказы в срок", "%", ["on_time"]],
  ["targets", "defect_pct", "Доля брака (не более)", "%", ["defect"]],
  ["targets", "lead_time_days", "Срок изготовления (не более)", "дн.", ["lead_time"]],
  ["targets", "capacity_load_pct", "Загрузка мощностей", "%", ["capacity"]],
  ["targets", "staffing_pct", "Укомплектованность штата", "%", ["staffing"]],
  ["targets", "sick_max", "Больничных в месяц (не более)", "чел.", ["sick"]],
].map(([group, key, label, unit, kpis]) => ({ id: `${group}.${key}`, group, key, label, unit, kpis }));

const overrides = () => store.state.plan_overrides || {};

/** База данных с применёнными корректировками планов (исходный объект не меняется). */
function withPlans(db) {
  const ov = overrides();
  if (!Object.keys(ov).length) return db;
  const plans = { ...db.plans, monthly: { ...db.plans.monthly }, targets: { ...db.plans.targets } };
  for (const [id, o] of Object.entries(ov)) {
    const [g, k] = id.split(".");
    if (plans[g]) plans[g][k] = o.value;
  }
  return { ...db, plans };
}

function plansView(db) {
  const ov = overrides();
  return {
    fields: PLAN_FIELDS.map((f) => ({
      ...f,
      kpis: f.kpis.map((id) => kpi.byId(id)?.title || id),
      base: db.plans[f.group][f.key],
      value: ov[f.id] ? ov[f.id].value : db.plans[f.group][f.key],
      override: ov[f.id] || null,
    })),
    history: (store.state.plan_history || []).slice(-100).reverse(),
    base_updated_at: db.plans.updated_at,
  };
}

/** Принимает { changes: { "targets.defect_pct": 2.5, ... }, reason } ; null — вернуть значение из plans.json. */
function updatePlans(db, body, user) {
  const errors = {};
  const changes = body && typeof body.changes === "object" && !Array.isArray(body.changes) ? body.changes : null;
  const reason = String(body?.reason || "").trim().slice(0, 300);
  if (!changes || !Object.keys(changes).length) return { errors: { _: "Нет изменений для сохранения" } };
  if (reason.length < 5) errors.reason = "Укажите обоснование изменения (не менее 5 символов)";
  for (const [id, v] of Object.entries(changes)) {
    const f = PLAN_FIELDS.find((x) => x.id === id);
    if (!f) errors[id] = "Неизвестный параметр плана";
    else if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) errors[id] = "Введите неотрицательное число";
    else if (v !== null && f.unit === "%" && v > 100) errors[id] = "Процент не может быть больше 100";
  }
  if (Object.keys(errors).length) return { errors };
  const ov = (store.state.plan_overrides = { ...overrides() });
  const hist = store.state.plan_history || (store.state.plan_history = []);
  const at = isoNow();
  const applied = [];
  for (const [id, v] of Object.entries(changes)) {
    const f = PLAN_FIELDS.find((x) => x.id === id);
    const base = db.plans[f.group][f.key];
    const from = ov[id] ? ov[id].value : base;
    const to = v === null ? base : round(v, 2);
    if (from === to) continue;
    if (to === base) delete ov[id];
    else ov[id] = { value: to, by: user.login, by_name: user.name, at, reason };
    applied.push({ id, label: f.label, unit: f.unit, from, to });
  }
  if (applied.length) {
    hist.push({ at, by: user.login, by_name: user.name, reason, changes: applied });
    if (hist.length > 500) hist.splice(0, hist.length - 500);
    store.markDirty();
  }
  return { applied };
}

/* ------------------------------ Проблемы качества ------------------------------ */

const ISSUE_STATUSES = ["новая", "в работе", "исправлена в источнике", "ложное срабатывание"];
const issueKey = (i) => `${i.source}|${i.check}`;

function qualityWithWorkflow(quality) {
  const st = store.state.issue_status || {};
  const issues = quality.issues.map((i) => {
    const key = issueKey(i);
    return { ...i, key, workflow: st[key] || { status: "новая" } };
  });
  const open = issues.filter((i) => !["исправлена в источнике", "ложное срабатывание"].includes(i.workflow.status));
  return { ...quality, issues, open_issues: open.length, issue_statuses: ISSUE_STATUSES };
}

function updateIssue(quality, body, user) {
  const key = String(body?.key || "");
  if (!quality.issues.some((i) => issueKey(i) === key)) return { error: "Проблема не найдена — возможно, данные уже перезагружены" };
  const status = String(body.status || "");
  if (!ISSUE_STATUSES.includes(status)) return { error: `Статус: одно из значений — ${ISSUE_STATUSES.join(", ")}` };
  const comment = String(body.comment || "").trim().slice(0, 500);
  const assignee = String(body.assignee || "").trim().slice(0, 100);
  const st = store.state.issue_status || (store.state.issue_status = {});
  const prev = st[key];
  st[key] = { status, comment, assignee, by: user.login, by_name: user.name, at: isoNow(), history: [...(prev?.history || []), { at: isoNow(), by_name: user.name, status, comment }].slice(-20) };
  store.markDirty();
  return { workflow: st[key] };
}

/* ------------------------------ Сравнение периодов ------------------------------ */

function comparePeriods(db, user, f, mode) {
  const len = dayNum(f.to) - dayNum(f.from) + 1;
  let b;
  if (mode === "yoy") b = { from: dayStr(dayNum(f.from) - 364), to: dayStr(dayNum(f.to) - 364) };
  else b = { from: dayStr(dayNum(f.from) - len), to: dayStr(dayNum(f.from) - 1) };
  const fb = { ...f, ...b };
  const rows = kpi.KPIS.filter((k) => user.domains.includes(k.domain) && (!f.domain || k.domain === f.domain)).map((k) => {
    const a = kpi.evaluate(db, k, f);
    const p = kpi.evaluate(db, k, fb);
    const delta = a.value !== null && p.value !== null ? round(a.value - p.value, 2) : null;
    const deltaPct = delta !== null && p.value ? round((delta / Math.abs(p.value)) * 100, 1) : null;
    const trend = delta === null || Math.abs(deltaPct ?? 0) < 1 ? "flat" : (k.better === "up") === delta > 0 ? "better" : "worse";
    return {
      id: k.id,
      title: k.title,
      domain: k.domain,
      domain_label: kpi.DOMAIN_LABEL[k.domain],
      unit: k.unit,
      better: k.better,
      current: { value: a.value, plan: a.plan, status: a.status },
      previous: { value: p.value, plan: p.plan, status: p.status },
      delta,
      delta_pct: deltaPct,
      trend,
    };
  });
  return {
    current: { from: f.from, to: f.to },
    previous: b,
    mode: mode === "yoy" ? "yoy" : "prev",
    rows,
    summary: { better: rows.filter((r) => r.trend === "better").length, worse: rows.filter((r) => r.trend === "worse").length, flat: rows.filter((r) => r.trend === "flat").length },
  };
}

/* ------------------------------------ CSV ------------------------------------ */

function toCsv(columns, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Разделитель «;» и BOM — чтобы файл корректно открывался в Excel с русской локалью.
  return "﻿" + [columns.map((c) => cell(c.label)).join(";"), ...rows.map((r) => columns.map((c) => cell(r[c.id])).join(";"))].join("\r\n");
}

module.exports = { PLAN_FIELDS, withPlans, plansView, updatePlans, qualityWithWorkflow, updateIssue, ISSUE_STATUSES, comparePeriods, toCsv };
