"use strict";
/*
 * Данные для тематических экранов (продажи, производство, финансы и люди),
 * прогноз спроса/мощности и сквозная карточка заказа (CRM → ERP → Финансы → HR).
 */
const { dayNum, dayStr, round, sum, groupBy } = require("./util");
const { makeCtx } = require("./kpi");

const FUNNEL = ["новый", "в работе", "печать", "готов к отгрузке", "отгружен", "закрыт"];

function sales(db, f) {
  const ctx = makeCtx(db, f.from, f.to, f.product);
  const orders = db.t.orders.filter((o) => ctx.inRange(o.order_date) && (!f.product || o.product_type === f.product));
  const live = orders.filter((o) => o.status !== "отменён");
  // Воронка: заказ «дошёл» до этапа, если его текущий статус на этом этапе или дальше.
  const funnel = FUNNEL.map((stage, i) => ({
    stage,
    count: live.filter((o) => FUNNEL.indexOf(o.status) >= i).length,
  }));
  funnel.forEach((s, i) => (s.conversion_pct = i === 0 ? 100 : round(funnel[0].count ? (s.count / funnel[0].count) * 100 : 0, 1)));
  const cancelled = orders.length - live.length;

  const revenue = db.t.revenue.filter((r) => ctx.inRange(r.date) && ctx.productOk(r.order_id));
  const byChannel = [...groupBy(revenue, (r) => r.source).entries()].map(([k, v]) => ({ key: k, value: round(sum(v, (r) => r.amount), 2), count: v.length }));
  const seg = (id) => db.idx.clients.get(id)?.segment || "нет в CRM";
  const bySegment = [...groupBy(live, (o) => seg(o.client_id)).entries()].map(([k, v]) => ({
    key: k,
    orders: v.length,
    amount: round(sum(v, (o) => o.amount), 2),
    avg_check: round(sum(v, (o) => o.amount) / v.length, 2),
    clients: new Set(v.map((o) => o.client_id)).size,
  }));
  bySegment.sort((a, b) => b.amount - a.amount);

  // Отток: клиенты, заказывавшие в предыдущем периоде той же длины, но не в текущем.
  const len = ctx.t - ctx.f + 1;
  const prevCtx = makeCtx(db, dayStr(ctx.f - len), dayStr(ctx.f - 1), f.product);
  const prevClients = new Set(db.t.orders.filter((o) => o.status !== "отменён" && prevCtx.inRange(o.order_date) && (!f.product || o.product_type === f.product)).map((o) => o.client_id));
  const curClients = new Set(live.map((o) => o.client_id));
  const churned = [...prevClients].filter((c) => !curClients.has(c)).length;

  const byProduct = [...groupBy(live, (o) => o.product_type).entries()]
    .map(([k, v]) => ({ key: k, orders: v.length, amount: round(sum(v, (o) => o.amount), 2), qty: sum(v, (o) => o.print_run) }))
    .sort((a, b) => b.amount - a.amount);

  return {
    funnel,
    cancelled,
    by_channel: byChannel,
    by_segment: bySegment,
    by_product: byProduct,
    churn: { prev_clients: prevClients.size, churned, churn_pct: prevClients.size ? round((churned / prevClients.size) * 100, 1) : null },
  };
}

function production(db, f) {
  const ctx = makeCtx(db, f.from, f.to, f.product);
  const prod = db.t.production_orders.filter((p) => ctx.inRange(p.start_date) && ctx.productOk(p.order_id));
  const byMonth = [...groupBy(prod, (p) => p.start_date.slice(0, 7)).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ label: k, planned: sum(v, (p) => p.planned_qty), produced: sum(v, (p) => p.produced_qty), defect: sum(v, (p) => p.defect_qty) }));
  const queue = ["запланирован", "в работе", "остановлен", "завершён"].map((s) => ({ status: s, count: prod.filter((p) => p.status === s).length }));
  const cap = db.plans.capacity;
  const days = ((ctx.t - ctx.f + 1) * cap.work_days_per_week) / 7;
  const machines = db.t.machines.map((m) => {
    const list = prod.filter((p) => p.machine_id === m.id);
    const produced = sum(list, (p) => p.produced_qty);
    const defect = sum(list, (p) => p.defect_qty);
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      location: m.location,
      status: m.status,
      orders: list.length,
      produced,
      load_pct: m.status === "выведен из эксплуатации" ? null : round((produced / (cap.units_per_machine_day * days)) * 100, 1),
      defect_pct: produced ? round((defect / produced) * 100, 1) : null,
      downtime: ["простой", "на обслуживании"].includes(m.status),
      stopped_orders: list.filter((p) => p.status === "остановлен").length,
    };
  });
  const defectReasons = [...groupBy(db.t.defects.filter((d) => ctx.inRange(d.detected_at) && (!f.product || ctx.productOk(d.order_id))), (d) => d.reason).entries()]
    .map(([k, v]) => ({ key: k, qty: sum(v, (d) => d.qty), count: v.length }))
    .sort((a, b) => b.qty - a.qty);
  return {
    by_month: byMonth,
    queue,
    machines,
    defect_reasons: defectReasons,
    downtime_machines: machines.filter((m) => m.downtime).length,
  };
}

function financePeople(db, f) {
  const ctx = makeCtx(db, f.from, f.to, f.product);
  const months = [];
  let d = new Date(f.from.slice(0, 7) + "-01T00:00:00Z");
  while (dayNum(d.toISOString().slice(0, 10)) <= ctx.t) {
    months.push(d.toISOString().slice(0, 7));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  const P = db.plans.monthly;
  const totalRevAll = (m) => sum(db.t.revenue.filter((r) => r.date.startsWith(m)), (r) => r.amount);
  const bdr = months.slice(-12).map((m) => {
    const rev = sum(db.t.revenue.filter((r) => r.date.startsWith(m) && ctx.productOk(r.order_id)), (r) => r.amount);
    let exp = sum(db.t.expenses.filter((e) => e.date.startsWith(m)), (e) => e.amount);
    if (f.product) exp *= totalRevAll(m) ? rev / totalRevAll(m) : 0;
    return {
      month: m,
      revenue_plan: P.revenue,
      revenue_fact: round(rev, 2),
      expenses_plan: P.expenses,
      expenses_fact: round(exp, 2),
      profit_plan: P.revenue - P.expenses,
      profit_fact: round(rev - exp, 2),
    };
  });
  const rev = db.t.revenue.filter((r) => ctx.inRange(r.date) && ctx.productOk(r.order_id));
  const exp = db.t.expenses.filter((e) => ctx.inRange(e.date));
  const bdds = {
    inflow: [...groupBy(rev, (r) => r.source).entries()].map(([k, v]) => ({ key: k, value: round(sum(v, (r) => r.amount), 2) })),
    outflow: [...groupBy(exp, (e) => e.category).entries()].map(([k, v]) => ({ key: k, value: round(sum(v, (e) => e.amount), 2) })).sort((a, b) => b.value - a.value),
  };
  bdds.net = round(sum(bdds.inflow, (x) => x.value) - sum(bdds.outflow, (x) => x.value), 2);

  const hp = db.plans.headcount_plan;
  const staff = db.t.departments.map((dep) => {
    const emps = db.t.employees.filter((e) => e.department_id === dep.id);
    const sick = emps.filter((e) => db.t.sick_leaves.some((s) => s.employee_id === e.id && dayNum(s.start_date) <= ctx.t && dayNum(s.end_date) >= ctx.f)).length;
    const plan = hp[dep.id] || emps.length;
    return { id: dep.id, name: dep.name, plan, fact: emps.length, vacancies: Math.max(0, plan - emps.length), absent: sick, available: emps.length - sick, staffing_pct: round(((emps.length - sick) / plan) * 100, 1) };
  });
  return { bdr, bdds, staff, currency: "RUB" };
}

/** Прогноз спроса (плановая загрузка ERP) и доступной мощности на 8 недель вперёд. */
function forecast(db) {
  const cap = db.plans.capacity;
  const today = dayNum(db.today);
  // Начало текущей недели (понедельник)
  const dow = (new Date(db.today + "T00:00:00Z").getUTCDay() + 6) % 7;
  const weekStart = today - dow;
  const HIST = 26;
  const hist = [];
  for (let i = HIST; i >= 1; i--) {
    const s = weekStart - i * 7;
    const list = db.t.production_orders.filter((p) => {
      const n = dayNum(p.start_date);
      return n >= s && n < s + 7;
    });
    hist.push({ week: dayStr(s), demand: sum(list, (p) => p.planned_qty) });
  }
  const ys = hist.map((h) => h.demand);
  const avg8 = sum(ys.slice(-8)) / 8; // краткосрочный уровень
  const avg26 = sum(ys) / ys.length; // долгосрочный уровень
  const machines = db.t.machines.filter((m) => m.status !== "выведен из эксплуатации");
  const sickShare = db.t.employees.length ? db.t.sick_leaves.filter((s) => dayNum(s.end_date) >= today - 30).length / db.t.employees.length : 0;
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const s = weekStart + 7 + i * 7;
    // Спрос: 50% среднее за 8 недель + 50% среднее за 26 недель; сезонный коэффициент ноября–декабря (календари, фотоальбомы)
    const month = new Date(s * 864e5).getUTCMonth();
    const season = month === 10 ? 1.12 : month === 11 ? 1.25 : 1;
    const demand = Math.max(0, (0.5 * avg8 + 0.5 * avg26) * season);
    let machineDays = 0;
    const maint = [];
    for (const m of machines) {
      for (let dd = 0; dd < cap.work_days_per_week; dd++) {
        const day = s + dd;
        const w = db.plans.maintenance.find((x) => x.machine_id === m.id && dayNum(x.from) <= day && dayNum(x.to) >= day);
        if (w) {
          if (!maint.find((x) => x.machine_id === m.id)) maint.push({ machine_id: m.id, name: m.name, reason: w.reason });
        } else machineDays++;
      }
    }
    const capacity = machineDays * cap.units_per_machine_day * (1 - sickShare * 0.5);
    weeks.push({
      week: dayStr(s),
      week_end: dayStr(s + 6),
      demand: Math.round(demand),
      capacity: Math.round(capacity),
      gap: Math.round(capacity - demand),
      deficit: demand > capacity,
      maintenance: maint,
    });
  }
  const firstDeficit = weeks.find((w) => w.deficit) || null;
  return {
    history: hist,
    weeks,
    first_deficit_week: firstDeficit ? firstDeficit.week : null,
    method:
      "Спрос = (0,5 × среднее за 8 недель + 0,5 × среднее за 26 недель) по плановому объёму запусков ERP × сезонный коэффициент (ноябрь 1,12; декабрь 1,25). " +
      "Мощность = доступные станко-дни (без выведенных из эксплуатации и плановых ремонтов) × норма ед./станко-день (plans.json) × (1 − ½ доли сотрудников на больничном).",
    unit: "ед. продукции",
  };
}

/** Сквозная карточка заказа: связь всех систем по общим идентификаторам. */
function orderCard(db, id) {
  const o = db.idx.orders.get(id);
  if (!o) return null;
  const client = db.idx.clients.get(o.client_id) || null;
  const prod = db.t.production_orders
    .filter((p) => p.order_id === id)
    .map((p) => {
      const shift = db.idx.shifts.get(p.shift_id);
      const op = shift ? db.idx.employees.get(shift.operator_id) : null;
      return {
        ...p,
        machine: db.idx.machines.get(p.machine_id) || null,
        shift: shift ? { id: shift.id, date: shift.shift_date, number: shift.shift_number, operator_id: shift.operator_id, operator_position: op?.position || null, operator_department: op ? db.idx.departments.get(op.department_id)?.name : null } : null,
      };
    });
  return {
    order: o,
    client: client ? { id: client.id, segment: client.segment, city: client.city, company: client.company, created_at: client.created_at } : null,
    production: prod,
    defects: db.t.defects.filter((d) => d.order_id === id || prod.some((p) => p.id === d.production_order_id)),
    requests: db.t.requests.filter((r) => r.order_id === id),
    payments: db.t.revenue.filter((r) => r.order_id === id),
    links: [
      "CRM orders.id = ERP production_orders.order_id",
      "CRM orders.id = Финансы revenue.order_id",
      "CRM orders.client_id = CRM clients.id",
      "ERP production_orders.shift_id → ERP shifts.operator_id = HR employees.id",
    ],
  };
}

module.exports = { sales, production, financePeople, forecast, orderCard };
