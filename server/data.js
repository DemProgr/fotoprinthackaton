"use strict";
/*
 * Слой интеграции: имитация четырёх систем-источников (CRM, ERP, Финансы, HR/ЗУП)
 * + план/бюджет. Данные читаются из JSON-файлов (mock API), валидируются,
 * индексируются по общим идентификаторам и проверяются на качество.
 */
const fs = require("fs");
const path = require("path");
const { isoNow, dayNum, dayStr, sum, groupBy, round } = require("./util");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

/** Описание источников: система → таблицы → файл и обязательные поля. */
const SOURCES = [
  { system: "CRM", table: "clients", file: "crm/clients.json", required: ["id", "segment", "created_at"], dateField: "created_at" },
  { system: "CRM", table: "orders", file: "crm/orders.json", required: ["id", "order_number", "client_id", "order_date", "status", "amount", "product_type"], dateField: "order_date" },
  { system: "CRM", table: "requests", file: "crm/requests.json", required: ["id", "client_id", "type", "status", "created_at"], dateField: "created_at" },
  { system: "ERP", table: "machines", file: "erp/machines.json", required: ["id", "name", "status"] },
  { system: "ERP", table: "shifts", file: "erp/shifts.json", required: ["id", "shift_date", "operator_id"], dateField: "shift_date" },
  { system: "ERP", table: "production_orders", file: "erp/production_orders.json", required: ["id", "order_id", "machine_id", "planned_qty", "produced_qty", "defect_qty", "start_date", "status"], dateField: "start_date" },
  { system: "ERP", table: "defects", file: "erp/defects.json", required: ["id", "production_order_id", "qty", "reason", "detected_at"], dateField: "detected_at" },
  { system: "Финансы", table: "revenue", file: "finance/revenue.json", required: ["id", "order_id", "amount", "date"], dateField: "date" },
  { system: "Финансы", table: "expenses", file: "finance/expenses.json", required: ["id", "category", "amount", "date"], dateField: "date" },
  { system: "Финансы", table: "profit", file: "finance/profit.json", required: ["id", "month", "revenue", "expenses", "profit"], dateField: "month" },
  { system: "HR / ЗУП", table: "departments", file: "hr/departments.json", required: ["id", "name"] },
  { system: "HR / ЗУП", table: "employees", file: "hr/employees.json", required: ["id", "department_id", "position"] },
  { system: "HR / ЗУП", table: "schedules", file: "hr/schedules.json", required: ["id", "employee_id", "schedule_date"], dateField: "schedule_date" },
  { system: "HR / ЗУП", table: "sick_leaves", file: "hr/sick_leaves.json", required: ["id", "employee_id", "start_date", "end_date"], dateField: "start_date" },
];

let db = null; // текущий загруженный снимок данных

function readJson(rel) {
  const full = path.join(DATA_DIR, rel);
  let text;
  try {
    text = fs.readFileSync(full, "utf8");
  } catch (err) {
    throw new Error(`Файл источника не найден: data/${rel}`);
  }
  try {
    return { data: JSON.parse(text), mtime: fs.statSync(full).mtime };
  } catch (err) {
    throw new Error(`Файл data/${rel} содержит некорректный JSON: ${err.message}`);
  }
}

/**
 * Загружает все источники. При ошибке выбрасывает исключение с понятным текстом
 * и НЕ заменяет ранее загруженный снимок — интерфейс продолжает работать на старых данных.
 */
function load() {
  const tables = {};
  const mtimes = {};
  for (const src of SOURCES) {
    const { data, mtime } = readJson(src.file);
    if (!Array.isArray(data)) throw new Error(`Файл data/${src.file} должен содержать массив записей`);
    tables[src.table] = data;
    mtimes[src.table] = mtime;
  }
  db = build(tables, mtimes, "files");
  return db;
}

/** Имя таблицы в Supabase: crm/orders.json → crm_orders. */
const remoteTable = (src) => src.file.replace(/\.json$/, "").replace("/", "_");

/** Значения из PostgreSQL приводим к виду исходных выгрузок (timestamp без «T00:00:00»). */
function normalizeRow(r) {
  for (const k in r) if (typeof r[k] === "string" && /^\d{4}-\d\d-\d\dT00:00:00$/.test(r[k])) r[k] = r[k].slice(0, 10);
  return r;
}

/** Загрузка всех источников из Supabase (CRM, ERP, Финансы, HR — единая БД). */
async function loadRemote() {
  const sb = require("./supabase");
  const lists = await Promise.all(SOURCES.map((src) => sb.selectAll(remoteTable(src))));
  const tables = {};
  const mtimes = {};
  const now = new Date();
  SOURCES.forEach((src, i) => {
    if (!lists[i].length) throw new Error(`Таблица ${remoteTable(src)} в Supabase пуста — запустите tools/supabase-seed.js`);
    tables[src.table] = lists[i].map(normalizeRow);
    mtimes[src.table] = now;
  });
  db = build(tables, mtimes, "supabase");
  return db;
}

let remoteTried = false;
/** Перед запросом: при настроенном Supabase один раз на экземпляр берём данные из БД, иначе из файлов. */
async function ensure() {
  const sb = require("./supabase");
  if (sb.enabled && !remoteTried) {
    remoteTried = true;
    try {
      await loadRemote();
      return db;
    } catch (err) {
      console.error("[data] Supabase недоступен, работаем на файлах data/*.json:", err.message);
    }
  }
  return get();
}

function build(tables, mtimes, origin) {
  const meta = {};
  for (const src of SOURCES) {
    const data = tables[src.table];
    const mtime = mtimes[src.table];
    const dates = src.dateField ? data.map((r) => String(r[src.dateField] || "").slice(0, 10)).filter(Boolean).sort() : [];
    meta[src.table] = {
      ...src,
      rows: data.length,
      file_updated_at: isoNow(mtime),
      last_record_date: dates.length ? dates[dates.length - 1] : null,
    };
  }
  const plansRaw = readJson("plans.json");
  const plans = plansRaw.data;
  meta.plans = { system: "План/бюджет", table: "plans", file: "plans.json", rows: 1, file_updated_at: isoNow(plansRaw.mtime), last_record_date: String(plans.updated_at || "").slice(0, 10) };

  const idx = {};
  for (const t of Object.keys(tables)) idx[t] = new Map(tables[t].map((r) => [r.id, r]));

  // «Сегодня» для расчётов — последняя дата в транзакционных данных (данные синтетические).
  const lastDates = ["orders", "revenue", "production_orders"].map((t) => meta[t].last_record_date).filter(Boolean).sort();
  const today = lastDates[lastDates.length - 1] || dayStr(Math.floor(Date.now() / 864e5));
  const monthEnd = (() => {
    const d = new Date(today + "T00:00:00Z");
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  })();

  const next = {
    t: tables,
    idx,
    meta,
    plans,
    today: monthEnd,
    loaded_at: isoNow(),
    productTypes: [...new Set(tables.orders.map((o) => o.product_type))].sort(),
    origin,
  };
  next.quality = checkQuality(next);
  return next;
}

function get() {
  if (!db) load();
  return db;
}

/* --------------------------- Качество данных --------------------------- */

function checkQuality(d) {
  const { t, idx, meta } = d;
  const issues = [];
  const add = (severity, source, check, count, details, sample = []) => {
    if (count > 0) issues.push({ severity, source, check, count, details, sample: sample.slice(0, 10) });
  };

  // 1. Пропуски обязательных полей
  for (const src of SOURCES) {
    const bad = t[src.table].filter((r) => src.required.some((f) => r[f] === null || r[f] === undefined || r[f] === ""));
    add("warning", `${src.system} · ${src.table}`, "Пропуски обязательных полей", bad.length, `Не заполнены поля: ${src.required.join(", ")}`, bad.map((r) => r.id));
  }

  // 2. Дубли
  const dup = (arr, keyFn) => {
    const g = groupBy(arr.filter((x) => keyFn(x)), keyFn);
    return [...g.entries()].filter(([, v]) => v.length > 1);
  };
  for (const src of SOURCES) {
    const d1 = dup(t[src.table], (r) => r.id);
    add("critical", `${src.system} · ${src.table}`, "Дубли первичного ключа", d1.length, "Несколько записей с одинаковым id", d1.map(([k]) => k));
  }
  const dOrd = dup(t.orders, (r) => r.order_number);
  add("critical", "CRM · orders", "Дубли номера заказа", dOrd.length, "Одинаковый order_number у разных заказов", dOrd.map(([k]) => k));
  const dMail = dup(t.clients, (r) => (r.email || "").toLowerCase());
  add("warning", "CRM · clients", "Дубли клиентов по e-mail", dMail.length, "Вероятно, один клиент заведён несколько раз", dMail.map(([k]) => k));
  const dRev = dup(t.revenue, (r) => `${r.order_id}|${r.amount}|${r.date}`);
  add("warning", "Финансы · revenue", "Дубли платежей", dRev.length, "Одинаковые заказ, сумма и дата", dRev.map(([k]) => k));

  // 3. Разорванные связи между системами (общие идентификаторы)
  // Критичны только разрывы основной цепочки «клиент → заказ → производство → оператор»:
  // они ломают сквозную карточку заказа и KPI. Остальные — предупреждения для разбора аналитиком.
  const fk = (table, field, target, label, severity = "warning") => {
    const bad = t[table].filter((r) => r[field] !== null && r[field] !== undefined && !idx[target].has(r[field]));
    add(severity, label, `Ссылка ${table}.${field} → ${target}.id`, bad.length, "Запись ссылается на несуществующий объект другой системы", bad.map((r) => r.id));
  };
  fk("orders", "client_id", "clients", "CRM ↔ CRM", "critical");
  fk("requests", "client_id", "clients", "CRM ↔ CRM");
  fk("requests", "order_id", "orders", "CRM ↔ CRM");
  fk("production_orders", "order_id", "orders", "ERP ↔ CRM", "critical");
  fk("production_orders", "machine_id", "machines", "ERP ↔ ERP");
  fk("production_orders", "shift_id", "shifts", "ERP ↔ ERP");
  fk("defects", "production_order_id", "production_orders", "ERP ↔ ERP");
  fk("defects", "order_id", "orders", "ERP ↔ CRM");
  fk("revenue", "order_id", "orders", "Финансы ↔ CRM");
  fk("revenue", "client_id", "clients", "Финансы ↔ CRM");
  fk("shifts", "operator_id", "employees", "ERP ↔ HR", "critical");
  fk("employees", "department_id", "departments", "HR ↔ HR");
  fk("sick_leaves", "employee_id", "employees", "HR ↔ HR");

  // 4. Логические противоречия
  const overDefect = t.production_orders.filter((p) => p.defect_qty > p.produced_qty);
  add("critical", "ERP · production_orders", "Брак больше выпуска", overDefect.length, "defect_qty > produced_qty", overDefect.map((p) => p.id));
  const revOrders = new Set(t.revenue.map((r) => r.order_id));
  const shippedNoRev = t.orders.filter((o) => ["отгружен", "закрыт"].includes(o.status) && !revOrders.has(o.id));
  add("warning", "CRM ↔ Финансы", "Отгружен, но нет оплаты", shippedNoRev.length, "Заказ отгружен/закрыт, но в финансах нет поступления", shippedNoRev.map((o) => o.id));
  const resolvedBefore = t.requests.filter((r) => r.resolved_at && dayNum(r.resolved_at) < dayNum(r.created_at));
  add("warning", "CRM · requests", "Решено раньше создания", resolvedBefore.length, "resolved_at < created_at", resolvedBefore.map((r) => r.id));
  const sickConflict = [];
  const shiftsByOp = groupBy(t.shifts, (s) => s.operator_id);
  for (const sl of t.sick_leaves) {
    for (const s of shiftsByOp.get(sl.employee_id) || []) {
      const dn = dayNum(s.shift_date);
      if (dn >= dayNum(sl.start_date) && dn <= dayNum(sl.end_date)) sickConflict.push(s.id);
    }
  }
  add("warning", "HR ↔ ERP", "Смена во время больничного", sickConflict.length, "Сотрудник на больничном назначен на смену", sickConflict);
  const lateDefects = t.defects.filter((df) => {
    const p = idx.production_orders.get(df.production_order_id);
    return p && p.end_date && dayNum(df.detected_at) > dayNum(p.end_date) + 30;
  });
  add("info", "ERP · defects", "Брак выявлен позже 30 дней после выпуска", lateDefects.length, "Возможна рекламация от клиента", lateDefects.map((x) => x.id));

  // 5. Сверка финансовых итогов: выручка по платежам vs месячная отчётность
  const revByMonth = new Map();
  for (const r of t.revenue) revByMonth.set(r.date.slice(0, 7), (revByMonth.get(r.date.slice(0, 7)) || 0) + r.amount);
  const expByMonth = new Map();
  for (const e of t.expenses) expByMonth.set(e.date.slice(0, 7), (expByMonth.get(e.date.slice(0, 7)) || 0) + e.amount);
  const reconciliation = t.profit
    .slice()
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((p) => {
      const rv = round(revByMonth.get(p.month) || 0, 2);
      const ex = round(expByMonth.get(p.month) || 0, 2);
      const dRevenue = round(p.revenue - rv, 2);
      const dExpenses = round(p.expenses - ex, 2);
      const dProfit = round(p.revenue - p.expenses - p.profit, 2);
      return {
        month: p.month,
        report_revenue: p.revenue,
        payments_revenue: rv,
        diff_revenue: dRevenue,
        report_expenses: p.expenses,
        ledger_expenses: ex,
        diff_expenses: dExpenses,
        diff_profit_formula: dProfit,
        ok: Math.abs(dRevenue) < 1 && Math.abs(dExpenses) < 1 && Math.abs(dProfit) < 1,
      };
    });
  const recBad = reconciliation.filter((r) => !r.ok);
  add("critical", "Финансы", "Расхождение сверки итогов", recBad.length, "Месячная отчётность не совпадает с первичными платежами/расходами", recBad.map((r) => r.month));

  // 6. Свежесть источников
  const today = dayNum(d.today);
  const freshness = Object.values(meta).map((m) => {
    const lag = m.last_record_date ? today - dayNum(m.last_record_date) : null;
    const status = lag === null ? "ok" : lag <= 7 ? "ok" : lag <= 31 ? "warning" : "critical";
    return {
      system: m.system,
      table: m.table,
      file: d.origin === "supabase" && m.table !== "plans" ? "Supabase · " + remoteTable(m) : "data/" + m.file,
      rows: m.rows,
      file_updated_at: m.file_updated_at,
      last_record_date: m.last_record_date,
      lag_days: lag,
      status,
    };
  });

  const totals = {
    critical: sum(issues.filter((i) => i.severity === "critical"), (i) => i.count),
    warning: sum(issues.filter((i) => i.severity === "warning"), (i) => i.count),
    info: sum(issues.filter((i) => i.severity === "info"), (i) => i.count),
  };
  return { checked_at: isoNow(), issues, reconciliation, freshness, totals };
}

module.exports = { load, loadRemote, ensure, get, SOURCES, DATA_DIR, remoteTable };
