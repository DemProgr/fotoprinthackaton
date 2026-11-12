"use strict";
/*
 * Каталог KPI. Каждый показатель описан декларативно:
 *   records(ctx)  — набор первичных записей из источников за период (с учётом фильтров);
 *   value(recs)   — агрегат (формула) по записям;
 *   plan(ctx)     — плановое значение / норматив;
 *   dims          — измерения для детализации (drill-down) — та же формула по группам;
 *   columns       — колонки для уровня отдельных записей.
 * Благодаря этому одна и та же формула используется для карточки, графика, прогноза и детализации.
 */
const { dayNum, dayStr, round, sum, avg, groupBy, linearForecast } = require("./util");

const DOMAIN_LABEL = { finance: "Финансы", sales: "Продажи и клиенты", production: "Производство и качество", hr: "Персонал" };

/* ---------------------------- Контекст фильтров ---------------------------- */

function makeCtx(db, from, to, product) {
  const f = dayNum(from);
  const t = dayNum(to);
  const inRange = (s) => {
    const n = dayNum(s);
    return n >= f && n <= t;
  };
  const order = (id) => db.idx.orders.get(id);
  const productOk = (orderId) => {
    if (!product) return true;
    const o = order(orderId);
    return !!o && o.product_type === product;
  };
  const months = (t - f + 1) / 30.4;
  return { db, from, to, f, t, product, inRange, order, productOk, months };
}

/* ------------------------------ Хелперы записей ----------------------------- */

const D = (ctx) => ctx.db.t;
const P = (ctx) => ctx.db.plans;
const orderLabel = (ctx, id) => ctx.order(id)?.order_number || `#${id} (нет в CRM)`;
const machineName = (ctx, id) => ctx.db.idx.machines.get(id)?.name || `Станок #${id}`;
const deptName = (ctx, id) => ctx.db.idx.departments.get(id)?.name || `Отдел #${id}`;
const segment = (ctx, clientId) => ctx.db.idx.clients.get(clientId)?.segment || "нет в CRM";

function revenueRecs(ctx) {
  return D(ctx).revenue.filter((r) => ctx.inRange(r.date) && ctx.productOk(r.order_id));
}
function expenseRecs(ctx) {
  const all = D(ctx).expenses.filter((e) => ctx.inRange(e.date));
  if (!ctx.product) return all;
  // При фильтре по продукту расходы распределяются пропорционально доле выручки продукта.
  const totalRev = sum(D(ctx).revenue.filter((r) => ctx.inRange(r.date)), (r) => r.amount);
  const share = totalRev ? sum(revenueRecs(ctx), (r) => r.amount) / totalRev : 0;
  return all.map((e) => ({ ...e, amount: e.amount * share }));
}
function orderRecs(ctx) {
  return D(ctx).orders.filter((o) => ctx.inRange(o.order_date) && (!ctx.product || o.product_type === ctx.product));
}
function prodRecs(ctx) {
  return D(ctx).production_orders.filter((p) => ctx.inRange(p.start_date) && ctx.productOk(p.order_id));
}
function requestRecs(ctx) {
  return D(ctx).requests.filter((r) => ctx.inRange(r.created_at) && (!ctx.product || (r.order_id && ctx.productOk(r.order_id))));
}
function slaDays(ctx, r) {
  const end = r.resolved_at ? dayNum(r.resolved_at) : Math.min(ctx.t, dayNum(ctx.db.today));
  return Math.max(0, end - dayNum(r.created_at));
}
function onLeave(ctx, empId) {
  return D(ctx).sick_leaves.some((s) => s.employee_id === empId && dayNum(s.start_date) <= ctx.t && dayNum(s.end_date) >= ctx.f);
}
const duration = (p) => Math.max(0, dayNum(p.end_date || p.start_date) - dayNum(p.start_date));
const operational = (ctx) => D(ctx).machines.filter((m) => m.status !== "выведен из эксплуатации");

/* ---------------------------------- KPI ---------------------------------- */

const KPIS = [
  /* ============================ ФИНАНСЫ ============================ */
  {
    id: "revenue",
    domain: "finance",
    title: "Оборот (выручка)",
    unit: "BYN",
    better: "up",
    additive: true,
    formula: "Σ revenue.amount за период; при фильтре продукта — только платежи по заказам этого продукта (revenue.order_id → orders.product_type)",
    sources: ["Финансы · revenue", "CRM · orders"],
    records: revenueRecs,
    value: (recs) => sum(recs, (r) => r.amount),
    plan: (ctx) => P(ctx).monthly.revenue * ctx.months,
    dims: {
      product: { label: "Продукт", key: (r, ctx) => ctx.order(r.order_id)?.product_type || "нет в CRM" },
      channel: { label: "Канал оплаты", key: (r) => r.source || "не указан" },
      segment: { label: "Сегмент клиента", key: (r, ctx) => segment(ctx, r.client_id) },
      month: { label: "Месяц", key: (r) => r.date.slice(0, 7) },
    },
    columns: [
      ["date", "Дата", (r) => r.date],
      ["order", "Заказ", (r, ctx) => orderLabel(ctx, r.order_id), (r) => r.order_id],
      ["source", "Канал", (r) => r.source],
      ["amount", "Сумма, BYN", (r) => round(r.amount, 2)],
    ],
  },
  {
    id: "margin",
    domain: "finance",
    title: "Валовая маржа",
    unit: "%",
    better: "up",
    formula: "(Выручка − Расходы) / Выручка × 100%; расходы — Σ expenses.amount за период (при фильтре продукта — пропорционально доле выручки)",
    sources: ["Финансы · revenue", "Финансы · expenses"],
    records: (ctx) => [...revenueRecs(ctx).map((r) => ({ ...r, _k: "rev" })), ...expenseRecs(ctx).map((e) => ({ ...e, _k: "exp" }))],
    value: (recs) => {
      const rv = sum(recs.filter((r) => r._k === "rev"), (r) => r.amount);
      const ex = sum(recs.filter((r) => r._k === "exp"), (r) => r.amount);
      return rv ? ((rv - ex) / rv) * 100 : null;
    },
    plan: (ctx) => P(ctx).targets.margin_pct,
    dims: {
      month: { label: "Месяц", key: (r) => r.date.slice(0, 7) },
    },
    columns: [
      ["date", "Дата", (r) => r.date],
      ["kind", "Тип", (r) => (r._k === "rev" ? "Поступление" : "Расход: " + r.category)],
      ["amount", "Сумма, BYN", (r) => round(r._k === "rev" ? r.amount : -r.amount, 2)],
    ],
  },
  {
    id: "expenses",
    domain: "finance",
    title: "Расходы: план/факт",
    unit: "BYN",
    better: "down",
    additive: true,
    formula: "Σ expenses.amount за период; план — месячный бюджет расходов × число месяцев периода",
    sources: ["Финансы · expenses", "План/бюджет"],
    records: expenseRecs,
    value: (recs) => sum(recs, (r) => r.amount),
    plan: (ctx) => P(ctx).monthly.expenses * ctx.months,
    dims: {
      category: { label: "Статья расходов", key: (r) => r.category },
      month: { label: "Месяц", key: (r) => r.date.slice(0, 7) },
    },
    columns: [
      ["date", "Дата", (r) => r.date],
      ["category", "Статья", (r) => r.category],
      ["description", "Описание", (r) => r.description],
      ["amount", "Сумма, BYN", (r) => round(r.amount, 2)],
    ],
  },

  /* ======================= ПРОДАЖИ И КЛИЕНТЫ ======================= */
  {
    id: "orders",
    domain: "sales",
    title: "Заказы",
    unit: "шт.",
    better: "up",
    additive: true,
    formula: "Количество orders с order_date в периоде, кроме статуса «отменён»",
    sources: ["CRM · orders"],
    records: (ctx) => orderRecs(ctx).filter((o) => o.status !== "отменён"),
    value: (recs) => recs.length,
    plan: (ctx) => P(ctx).monthly.orders * ctx.months,
    dims: {
      product: { label: "Продукт", key: (o) => o.product_type },
      status: { label: "Статус", key: (o) => o.status },
      segment: { label: "Сегмент клиента", key: (o, ctx) => segment(ctx, o.client_id) },
      priority: { label: "Приоритет", key: (o) => o.priority },
    },
    columns: orderColumns(),
  },
  {
    id: "avg_check",
    domain: "sales",
    title: "Средний чек",
    unit: "BYN",
    better: "up",
    formula: "Σ orders.amount / количество заказов (без отменённых) за период",
    sources: ["CRM · orders"],
    records: (ctx) => orderRecs(ctx).filter((o) => o.status !== "отменён"),
    value: (recs) => avg(recs, (o) => o.amount),
    plan: (ctx) => P(ctx).targets.avg_check,
    dims: {
      product: { label: "Продукт", key: (o) => o.product_type },
      segment: { label: "Сегмент клиента", key: (o, ctx) => segment(ctx, o.client_id) },
    },
    columns: orderColumns(),
  },
  {
    id: "conversion",
    domain: "sales",
    title: "Конверсия воронки",
    unit: "%",
    better: "up",
    formula: "Заказы в статусе «отгружен»/«закрыт» / все заказы периода × 100%",
    sources: ["CRM · orders"],
    records: orderRecs,
    value: (recs) => (recs.length ? (recs.filter((o) => ["отгружен", "закрыт"].includes(o.status)).length / recs.length) * 100 : null),
    plan: (ctx) => P(ctx).targets.conversion_pct,
    dims: {
      product: { label: "Продукт", key: (o) => o.product_type },
      segment: { label: "Сегмент клиента", key: (o, ctx) => segment(ctx, o.client_id) },
      priority: { label: "Приоритет", key: (o) => o.priority },
    },
    columns: orderColumns(),
  },
  {
    id: "new_clients",
    domain: "sales",
    title: "Новые клиенты",
    unit: "чел.",
    better: "up",
    additive: true,
    formula: "Количество clients с created_at в периоде (фильтр продукта не применяется)",
    sources: ["CRM · clients"],
    records: (ctx) => D(ctx).clients.filter((c) => ctx.inRange(c.created_at)),
    value: (recs) => recs.length,
    plan: (ctx) => P(ctx).monthly.new_clients * ctx.months,
    dims: {
      segment: { label: "Сегмент", key: (c) => c.segment },
      city: { label: "Город", key: (c) => c.city },
    },
    columns: clientColumns(),
  },
  {
    id: "active_clients",
    domain: "sales",
    title: "Активные клиенты",
    unit: "чел.",
    better: "up",
    scaleForecast: true,
    formula: "Число уникальных orders.client_id с заказом в периоде (без отменённых)",
    sources: ["CRM · orders", "CRM · clients"],
    records: (ctx) => orderRecs(ctx).filter((o) => o.status !== "отменён"),
    value: (recs) => new Set(recs.map((o) => o.client_id)).size,
    plan: (ctx) => P(ctx).targets.active_clients_month * Math.max(1, Math.sqrt(ctx.months)),
    dims: {
      segment: { label: "Сегмент", key: (o, ctx) => segment(ctx, o.client_id) },
      product: { label: "Продукт", key: (o) => o.product_type },
    },
    columns: orderColumns(),
  },
  {
    id: "repeat",
    domain: "sales",
    title: "Повторные покупки",
    unit: "%",
    better: "up",
    formula: "Клиенты с ≥ 2 заказами в периоде / активные клиенты × 100%",
    sources: ["CRM · orders"],
    records: (ctx) => orderRecs(ctx).filter((o) => o.status !== "отменён"),
    value: (recs) => {
      const g = groupBy(recs, (o) => o.client_id);
      return g.size ? ([...g.values()].filter((v) => v.length > 1).length / g.size) * 100 : null;
    },
    plan: (ctx) => P(ctx).targets.repeat_pct,
    dims: {
      segment: { label: "Сегмент", key: (o, ctx) => segment(ctx, o.client_id) },
    },
    columns: orderColumns(),
  },
  {
    id: "sla",
    domain: "sales",
    title: "SLA поддержки",
    unit: "%",
    better: "up",
    formula: "Обращения, решённые не дольше норматива (7 дн.) / все обращения периода × 100%; нерешённые старше норматива считаются нарушением",
    sources: ["CRM · requests", "План/бюджет (норматив)"],
    records: requestRecs,
    value: (recs, ctx) => {
      if (!recs.length) return null;
      const norm = P(ctx).targets.sla_norm_days;
      return (recs.filter((r) => r.resolved_at && slaDays(ctx, r) <= norm).length / recs.length) * 100;
    },
    plan: (ctx) => P(ctx).targets.sla_pct,
    dims: {
      type: { label: "Тип обращения", key: (r) => r.type },
      status: { label: "Статус", key: (r) => r.status },
      segment: { label: "Сегмент клиента", key: (r, ctx) => segment(ctx, r.client_id) },
    },
    columns: [
      ["created_at", "Создано", (r) => r.created_at],
      ["type", "Тип", (r) => r.type],
      ["status", "Статус", (r) => r.status],
      ["days", "Дней в работе", (r, ctx) => slaDays(ctx, r)],
      ["breach", "Нарушение SLA", (r, ctx) => (r.resolved_at && slaDays(ctx, r) <= P(ctx).targets.sla_norm_days ? "нет" : "да")],
      ["order", "Заказ", (r, ctx) => (r.order_id ? orderLabel(ctx, r.order_id) : "—"), (r) => r.order_id],
      ["description", "Описание", (r) => r.description],
    ],
  },

  /* ===================== ПРОИЗВОДСТВО И КАЧЕСТВО ===================== */
  {
    id: "output",
    domain: "production",
    title: "Выпуск: план/факт",
    unit: "%",
    better: "up",
    formula: "Σ production_orders.produced_qty / Σ planned_qty × 100% (по дате запуска в периоде)",
    sources: ["ERP · production_orders"],
    records: prodRecs,
    value: (recs) => {
      const pl = sum(recs, (p) => p.planned_qty);
      return pl ? (sum(recs, (p) => p.produced_qty) / pl) * 100 : null;
    },
    plan: (ctx) => P(ctx).targets.output_pct,
    dims: prodDims(),
    columns: prodColumns(),
  },
  {
    id: "on_time",
    domain: "production",
    title: "Заказы в срок",
    unit: "%",
    better: "up",
    formula: "Завершённые производственные заказы с длительностью (end_date − start_date) ≤ 7 дн. / все завершённые × 100%",
    sources: ["ERP · production_orders", "План/бюджет (норматив)"],
    records: (ctx) => prodRecs(ctx).filter((p) => p.status === "завершён"),
    value: (recs, ctx) => (recs.length ? (recs.filter((p) => duration(p) <= P(ctx).targets.on_time_norm_days).length / recs.length) * 100 : null),
    plan: (ctx) => P(ctx).targets.on_time_pct,
    dims: prodDims(),
    columns: prodColumns(),
  },
  {
    id: "defect",
    domain: "production",
    title: "Брак / перепечатка",
    unit: "%",
    better: "down",
    formula: "Σ production_orders.defect_qty / Σ produced_qty × 100%",
    sources: ["ERP · production_orders", "ERP · defects"],
    records: prodRecs,
    value: (recs) => {
      const pr = sum(recs, (p) => p.produced_qty);
      return pr ? (sum(recs, (p) => p.defect_qty) / pr) * 100 : null;
    },
    plan: (ctx) => P(ctx).targets.defect_pct,
    dims: {
      ...prodDims(),
      reason: {
        label: "Причина брака (ERP · defects)",
        // Группировка по основной причине из журнала дефектов по этому производственному заказу
        key: (p, ctx) => {
          const list = ctx.db.t.defects.filter((d) => d.production_order_id === p.id);
          if (!list.length) return "без зарегистрированного дефекта";
          const g = groupBy(list, (d) => d.reason);
          return [...g.entries()].sort((a, b) => sum(b[1], (d) => d.qty) - sum(a[1], (d) => d.qty))[0][0];
        },
      },
    },
    columns: prodColumns(),
  },
  {
    id: "lead_time",
    domain: "production",
    title: "Lead time",
    unit: "дн.",
    better: "down",
    formula: "Среднее (end_date − start_date) по завершённым производственным заказам периода, дней",
    sources: ["ERP · production_orders"],
    records: (ctx) => prodRecs(ctx).filter((p) => p.status === "завершён"),
    value: (recs) => avg(recs, duration),
    plan: (ctx) => P(ctx).targets.lead_time_days,
    dims: prodDims(),
    columns: prodColumns(),
  },
  {
    id: "capacity",
    domain: "production",
    title: "Загрузка мощности",
    unit: "%",
    better: "up",
    formula: "Σ produced_qty / (работоспособные станки × норма ед./станко-день из plans.json × рабочие дни периода) × 100%",
    sources: ["ERP · production_orders", "ERP · machines", "План/бюджет (норма)"],
    records: prodRecs,
    value: (recs, ctx, scope) => {
      const cap = P(ctx).capacity;
      const days = ((ctx.t - ctx.f + 1) * cap.work_days_per_week) / 7;
      const machines = scope?.machines ?? operational(ctx).length;
      const denom = machines * cap.units_per_machine_day * days;
      return denom ? (sum(recs, (p) => p.produced_qty) / denom) * 100 : null;
    },
    scopeFor: (dim) => (dim === "machine" ? { machines: 1 } : null),
    plan: (ctx) => P(ctx).targets.capacity_load_pct,
    dims: { machine: prodDims().machine, product: prodDims().product },
    columns: prodColumns(),
  },

  /* ================================ ПЕРСОНАЛ ================================ */
  {
    id: "staffing",
    domain: "hr",
    title: "Обеспеченность персоналом",
    unit: "%",
    better: "up",
    formula: "(Сотрудники в штате − находящиеся на больничном в периоде) / плановая численность × 100%",
    sources: ["HR / ЗУП · employees", "HR / ЗУП · sick_leaves", "План/бюджет (штатное расписание)"],
    records: (ctx) => D(ctx).employees.map((e) => ({ ...e, _sick: onLeave(ctx, e.id) })),
    value: (recs, ctx, scope) => {
      const hp = P(ctx).headcount_plan;
      const plan = scope?.dept ? hp[scope.dept] || 0 : sum(Object.values(hp));
      return plan ? (recs.filter((e) => !e._sick).length / plan) * 100 : null;
    },
    scopeFor: (dim, key, ctx) => (dim === "department" ? { dept: String(ctx.db.t.departments.find((d) => d.name === key)?.id) } : null),
    plan: (ctx) => P(ctx).targets.staffing_pct,
    dims: { department: { label: "Подразделение", key: (e, ctx) => deptName(ctx, e.department_id) } },
    columns: empColumns(),
  },
  {
    id: "sick",
    domain: "hr",
    title: "Отсутствуют (больничные)",
    unit: "чел.",
    better: "down",
    scaleForecast: true,
    formula: "Число сотрудников, у которых больничный пересекается с периодом",
    sources: ["HR / ЗУП · sick_leaves", "HR / ЗУП · employees"],
    records: (ctx) => D(ctx).employees.filter((e) => onLeave(ctx, e.id)).map((e) => ({ ...e, _sick: true })),
    value: (recs) => recs.length,
    plan: (ctx) => P(ctx).targets.sick_max * Math.max(1, ctx.months),
    dims: { department: { label: "Подразделение", key: (e, ctx) => deptName(ctx, e.department_id) } },
    columns: empColumns(),
  },
];

function orderColumns() {
  return [
    ["order_date", "Дата", (o) => o.order_date],
    ["order", "Заказ", (o) => o.order_number, (o) => o.id],
    ["product", "Продукт", (o) => o.product_type],
    ["status", "Статус", (o) => o.status],
    ["segment", "Сегмент", (o, ctx) => segment(ctx, o.client_id)],
    ["amount", "Сумма, BYN", (o) => round(o.amount, 2)],
  ];
}
function clientColumns() {
  return [
    ["created_at", "Создан", (c) => c.created_at],
    ["id", "ID клиента", (c) => c.id],
    ["segment", "Сегмент", (c) => c.segment],
    ["city", "Город", (c) => c.city],
  ];
}
function prodDims() {
  return {
    machine: { label: "Станок", key: (p, ctx) => machineName(ctx, p.machine_id) },
    product: { label: "Продукт", key: (p, ctx) => ctx.order(p.order_id)?.product_type || "нет в CRM" },
    status: { label: "Статус", key: (p) => p.status },
    month: { label: "Месяц", key: (p) => p.start_date.slice(0, 7) },
  };
}
function prodColumns() {
  return [
    ["start_date", "Запуск", (p) => p.start_date],
    ["number", "Произв. заказ", (p) => p.production_order_number],
    ["order", "Заказ CRM", (p, ctx) => orderLabel(ctx, p.order_id), (p) => p.order_id],
    ["machine", "Станок", (p, ctx) => machineName(ctx, p.machine_id)],
    ["status", "Статус", (p) => p.status],
    ["planned", "План, шт.", (p) => p.planned_qty],
    ["produced", "Факт, шт.", (p) => p.produced_qty],
    ["defect", "Брак, шт.", (p) => p.defect_qty],
    ["defect_pct", "Брак, %", (p) => round(p.produced_qty ? (p.defect_qty / p.produced_qty) * 100 : 0, 1)],
    ["days", "Длит., дн.", (p) => duration(p)],
  ];
}
function empColumns() {
  return [
    ["id", "Таб. №", (e) => e.id],
    ["department", "Подразделение", (e, ctx) => deptName(ctx, e.department_id)],
    ["position", "Должность", (e) => e.position],
    ["sick", "На больничном", (e) => (e._sick ? "да" : "нет")],
  ];
}

/* --------------------------- Статус и расчёт --------------------------- */

function statusOf(kpi, value, plan) {
  if (value === null || plan === null || plan === undefined) return "gray";
  let ratio;
  if (kpi.better === "up") ratio = plan ? value / plan : 1;
  else ratio = value === 0 ? 1.5 : plan / value;
  if (ratio >= 0.98) return "green";
  if (ratio >= 0.9) return "yellow";
  return "red";
}

/** Разбивает период на ≤ 12 корзин (недели или месяцы) для графика и прогноза. */
function buckets(from, to) {
  const f = dayNum(from);
  const t = dayNum(to);
  const len = t - f + 1;
  const out = [];
  if (len > 92) {
    let d = new Date(from + "T00:00:00Z");
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    while (dayNum(d.toISOString().slice(0, 10)) <= t) {
      const s = d.toISOString().slice(0, 10);
      const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      out.push({ from: dayNum(s) < f ? from : s, to: dayNum(e) > t ? to : e, label: s.slice(0, 7) });
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out.slice(-12);
  }
  for (let s = f; s <= t; s += 7) {
    const e = Math.min(s + 6, t);
    out.push({ from: dayStr(s), to: dayStr(e), label: dayStr(s).slice(5) });
  }
  return out;
}

function compute(db, kpi, from, to, product) {
  const ctx = makeCtx(db, from, to, product);
  const recs = kpi.records(ctx);
  const value = kpi.value(recs, ctx);
  const plan = kpi.plan(ctx);
  return { ctx, recs, value, plan };
}

function evaluate(db, kpi, filters) {
  const { from, to, product } = filters;
  const { value, plan } = compute(db, kpi, from, to, product);
  const series = buckets(from, to).map((b) => {
    const r = compute(db, kpi, b.from, b.to, product);
    return { label: b.label, from: b.from, to: b.to, value: round(r.value, 2), plan: round(r.plan, 2) };
  });
  // Прогноз: линейный тренд по корзинам периода → значение следующей корзины;
  // для аддитивных KPI дополнительно — прогноз на весь следующий такой же период.
  const vals = series.map((s) => s.value);
  const nextBucket = linearForecast(vals, vals.length);
  let forecast = nextBucket;
  if (nextBucket !== null) {
    if (kpi.additive) forecast = Math.max(0, nextBucket) * series.length;
    else if (kpi.scaleForecast) {
      // Неаддитивные счётчики (уникальные клиенты, отсутствующие): масштабируем тренд к уровню периода
      const mean = vals.filter(Number.isFinite).reduce((a, b) => a + b, 0) / (vals.filter(Number.isFinite).length || 1);
      forecast = mean ? (value * Math.max(0, nextBucket)) / mean : value;
    } else forecast = Math.max(0, kpi.unit === "%" && kpi.id !== "capacity" ? Math.min(100, nextBucket) : nextBucket);
  }
  const status = statusOf(kpi, value, plan);
  const srcMeta = kpi.sources
    .map((s) => s.split(" · ")[1] || "plans")
    .map((t) => db.meta[t.split(" ")[0]] || db.meta.plans)
    .filter(Boolean);
  const updated = srcMeta.map((m) => m.file_updated_at).sort().pop();
  const lastData = srcMeta.map((m) => m.last_record_date).filter(Boolean).sort().pop();
  return {
    id: kpi.id,
    domain: kpi.domain,
    domain_label: DOMAIN_LABEL[kpi.domain],
    title: kpi.title,
    unit: kpi.unit,
    currency: kpi.unit === "BYN" ? "BYN" : null,
    better: kpi.better,
    additive: !!kpi.additive,
    value: round(value, 2),
    plan: round(plan, 2),
    deviation_pct: value !== null && plan ? round(((value - plan) / plan) * 100, 1) : null,
    forecast: round(forecast, 2),
    status,
    series,
    formula: kpi.formula,
    sources: kpi.sources,
    updated_at: updated,
    data_until: lastData,
    loaded_at: db.loaded_at,
    drill_dims: Object.entries(kpi.dims).map(([id, d]) => ({ id, label: d.label })),
  };
}

function drill(db, kpi, filters, dimId) {
  const dim = kpi.dims[dimId] || Object.values(kpi.dims)[0];
  const realDim = kpi.dims[dimId] ? dimId : Object.keys(kpi.dims)[0];
  const { ctx, recs, value, plan } = compute(db, kpi, filters.from, filters.to, filters.product);
  const groups = groupBy(recs, (r) => dim.key(r, ctx));
  const totalAdd = kpi.additive ? value : null;
  const rows = [...groups.entries()].map(([key, list]) => {
    const scope = kpi.scopeFor ? kpi.scopeFor(realDim, key, ctx) : null;
    const v = kpi.value(list, ctx, scope);
    const groupPlan = kpi.additive ? null : plan;
    return {
      key,
      count: list.length,
      value: round(v, 2),
      share_pct: totalAdd ? round((v / totalAdd) * 100, 1) : null,
      status: kpi.additive ? "gray" : statusOf(kpi, v, groupPlan),
    };
  });
  // Сначала самые проблемные группы: для «чем больше — тем лучше» — по возрастанию значения.
  rows.sort((a, b) => {
    if (kpi.additive) return (b.value || 0) - (a.value || 0);
    return kpi.better === "up" ? (a.value ?? Infinity) - (b.value ?? Infinity) : (b.value ?? -Infinity) - (a.value ?? -Infinity);
  });
  const worst = rows.find((r) => r.status === "red");
  let explanation = null;
  if (worst) {
    explanation = `Главный вклад в отклонение: «${worst.key}» (${dim.label.toLowerCase()}) — ${fmt(worst.value, kpi.unit)} при плане ${fmt(plan, kpi.unit)}, записей: ${worst.count}.`;
  } else if (kpi.additive && rows.length) {
    explanation = `Крупнейшая группа: «${rows[0].key}» — ${rows[0].share_pct}% от итога.`;
  }
  return {
    kpi: kpi.id,
    title: kpi.title,
    unit: kpi.unit,
    dim: realDim,
    dim_label: dim.label,
    total: round(value, 2),
    plan: round(plan, 2),
    status: statusOf(kpi, value, plan),
    explanation,
    rows,
    dims: Object.entries(kpi.dims).map(([id, d]) => ({ id, label: d.label })),
  };
}

function records(db, kpi, filters, dimId, key, limit = 300) {
  const { ctx, recs } = compute(db, kpi, filters.from, filters.to, filters.product);
  const dim = kpi.dims[dimId];
  const list = dim && key !== undefined && key !== null && key !== "" ? recs.filter((r) => String(dim.key(r, ctx)) === String(key)) : recs;
  const cols = kpi.columns;
  return {
    kpi: kpi.id,
    title: kpi.title,
    dim_label: dim?.label || null,
    key: key || null,
    total: list.length,
    columns: cols.map(([id, label]) => ({ id, label })),
    rows: list.slice(0, limit).map((r) => {
      const row = {};
      for (const [id, , get, link] of cols) {
        row[id] = get(r, ctx);
        if (link) row[id + "__order_id"] = link(r);
      }
      return row;
    }),
  };
}

function fmt(v, unit) {
  if (v === null || v === undefined) return "—";
  const n = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(v);
  return unit === "BYN" ? `${n} BYN` : unit === "%" ? `${n}%` : `${n} ${unit}`;
}

const byId = (id) => KPIS.find((k) => k.id === id);

module.exports = { KPIS, DOMAIN_LABEL, byId, evaluate, drill, records, makeCtx, statusOf };
