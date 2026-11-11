"use strict";
/* Реестр управленческих решений: валидация, создание, изменение с историей. */
const store = require("./store");
const { isoNow, isDate } = require("./util");

const PRIORITIES = ["низкий", "средний", "высокий", "критический"];
const STATUSES = ["новое", "в работе", "выполнено", "отменено"];
const DOMAINS = ["finance", "sales", "production", "hr"];
const FIELDS = ["title", "kpi_id", "domain", "problem", "impact", "cause", "action", "owner", "due_date", "priority", "status", "context"];
const LABELS = {
  title: "Название",
  problem: "Проблема",
  impact: "Влияние",
  cause: "Причина",
  action: "Действие",
  owner: "Ответственный",
  due_date: "Срок",
  priority: "Приоритет",
  status: "Статус",
  domain: "Подразделение",
};

function clean(v, max = 2000) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

/** Возвращает { value, errors } — ошибки на русском, по полям. */
function validate(input, { partial = false, today }) {
  const errors = {};
  const v = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { errors: { _: "Некорректный формат данных: ожидается объект JSON" } };
  for (const f of FIELDS) if (f in input) v[f] = f === "context" ? input.context : clean(input[f], f === "title" ? 200 : 2000);

  const need = ["title", "problem", "cause", "action", "owner", "due_date", "priority", "domain"];
  for (const f of need) {
    if (!partial && !v[f]) errors[f] = `Поле «${LABELS[f]}» обязательно`;
    if (partial && f in v && !v[f]) errors[f] = `Поле «${LABELS[f]}» не может быть пустым`;
  }
  if (v.title && v.title.length < 5) errors.title = "Название — не короче 5 символов";
  if (v.problem && v.problem.length < 10) errors.problem = "Опишите проблему подробнее (не менее 10 символов)";
  if (v.action && v.action.length < 5) errors.action = "Опишите действие подробнее (не менее 5 символов)";
  if (v.due_date) {
    if (!isDate(v.due_date)) errors.due_date = "Срок должен быть датой в формате ГГГГ-ММ-ДД";
    else if (!partial && v.due_date < today) errors.due_date = "Срок не может быть в прошлом";
  }
  if (v.priority && !PRIORITIES.includes(v.priority)) errors.priority = `Приоритет: одно из значений — ${PRIORITIES.join(", ")}`;
  if (v.status && !STATUSES.includes(v.status)) errors.status = `Статус: одно из значений — ${STATUSES.join(", ")}`;
  if (v.domain && !DOMAINS.includes(v.domain)) errors.domain = "Неизвестное подразделение";
  if (v.context !== undefined && (typeof v.context !== "object" || Array.isArray(v.context) || JSON.stringify(v.context).length > 4000)) errors.context = "Некорректный контекст решения";
  return { value: v, errors };
}

function list(user) {
  return store.state.decisions.filter((d) => user.domains.includes(d.domain)).slice().reverse();
}

function get(id) {
  return store.state.decisions.find((d) => d.id === id) || null;
}

function create(value, user) {
  const now = isoNow();
  const d = {
    id: store.nextId("decision"),
    number: "",
    title: value.title,
    kpi_id: value.kpi_id || null,
    domain: value.domain,
    problem: value.problem,
    impact: value.impact || "",
    cause: value.cause,
    action: value.action,
    owner: value.owner,
    due_date: value.due_date,
    priority: value.priority,
    status: value.status || "новое",
    context: value.context || null,
    created_by: user.login,
    created_by_name: user.name,
    created_at: now,
    updated_at: now,
    history: [{ at: now, by: user.login, by_name: user.name, action: "создано", changes: {} }],
  };
  d.number = `РЕШ-${String(d.id).padStart(4, "0")}`;
  store.state.decisions.push(d);
  store.save(true);
  return d;
}

function update(d, value, user) {
  const changes = {};
  for (const f of FIELDS) {
    if (!(f in value) || f === "context") continue;
    if (String(d[f] ?? "") !== String(value[f] ?? "")) {
      changes[f] = { from: d[f], to: value[f] };
      d[f] = value[f];
    }
  }
  if (Object.keys(changes).length) {
    d.updated_at = isoNow();
    d.history.push({ at: d.updated_at, by: user.login, by_name: user.name, action: changes.status ? `статус → ${changes.status.to}` : "изменено", changes });
    store.save(true);
  }
  return { decision: d, changes };
}

module.exports = { validate, list, get, create, update, PRIORITIES, STATUSES, LABELS };
