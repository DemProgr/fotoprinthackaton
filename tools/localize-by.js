#!/usr/bin/env node
"use strict";
/*
 * Локализация синтетических данных под ООО «Фотопринт» (Беларусь), ОТ-03 / ОТ-07.
 *
 * generate.py создаёт базовый набор (seed 42) в «российском» масштабе. Этот скрипт
 * детерминированно переводит его в белорусский контекст:
 *   • денежные поля → белорусские рубли (BYN): делятся на коэффициент масштаба SCALE
 *     (условный коэффициент синтетических данных, не биржевой курс);
 *   • города клиентов → города Беларуси (тот же индекс в справочнике generate.py);
 *   • телефоны +7XXXXXXXXXX → +375 (25|29|33|44) XXXXXXX, домен почты → example.by;
 *   • отчёт о прибыли пересчитывается из переведённых платежей и расходов, а заложенные
 *     для демонстрации расхождения (платёж по несуществующему заказу) сохраняются;
 *   • data/mock.db пересобирается из JSON по schema.sql (как build_db.py, через node:sqlite).
 *
 * Повторный запуск безопасен: признак "currency": "BYN" в data/manifest.json не даёт
 * пересчитать суммы дважды.
 *
 * Полная перегенерация: python generate.py && node tools/localize-by.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const SCALE = 28; // 1 BYN ≈ 28 единиц базового набора
const ORPHAN_PAYMENT_BYN = 1800; // демонстрационный платёж по несуществующему заказу (ID 999998)

const CITIES_BY = {
  Москва: "Минск",
  "Санкт-Петербург": "Гомель",
  Новосибирск: "Могилёв",
  Екатеринбург: "Витебск",
  Казань: "Гродно",
  "Нижний Новгород": "Брест",
  Самара: "Бобруйск",
  Омск: "Барановичи",
  Челябинск: "Борисов",
  "Ростов-на-Дону": "Пинск",
  Уфа: "Орша",
  Волгоград: "Мозырь",
  Пермь: "Солигорск",
  Красноярск: "Новополоцк",
};
const OPERATORS = ["25", "29", "33", "44"];

const read = (rel) => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8"));
const write = (rel, v) => fs.writeFileSync(path.join(DATA, rel), JSON.stringify(v, null, 2) + "\n", "utf8");
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const byn = (x) => r2(x / SCALE);
const month = (d) => String(d).slice(0, 7);

function phoneBY(p) {
  const m = /^\+7(\d{10})$/.exec(String(p || ""));
  if (!m) return p;
  const n = Number(m[1]);
  return `+375${OPERATORS[n % 4]}${String(n % 1e7).padStart(7, "0")}`;
}

function localize() {
  const manifest = read("manifest.json");
  const plans = read("plans.json");
  const alreadyMoney = manifest.currency === "BYN";

  // --- CRM: клиенты ---
  const clients = read("crm/clients.json").map((c) => ({
    ...c,
    city: CITIES_BY[c.city] || c.city,
    phone: phoneBY(c.phone),
    email: typeof c.email === "string" ? c.email.replace(/@example\.ru$/, "@example.by") : c.email,
  }));
  write("crm/clients.json", clients);

  // --- HR: сотрудники ---
  let employees = read("hr/employees.json").map((e) => ({ ...e, phone: phoneBY(e.phone) }));

  if (!alreadyMoney) {
    employees = employees.map((e) => ({ ...e, salary: byn(e.salary) }));

    // --- CRM: заказы ---
    const ordersRub = read("crm/orders.json");
    const rubById = new Map(ordersRub.map((o) => [o.id, o.amount]));
    const orders = ordersRub.map((o) => ({ ...o, amount: byn(o.amount) }));
    const bynById = new Map(orders.map((o) => [o.id, o.amount]));
    write("crm/orders.json", orders);

    // --- Финансы: платежи (полная/частичная оплата сохраняет долю от суммы заказа) ---
    const revenue = read("finance/revenue.json").map((r) => {
      if (r.order_id === 999998) return { ...r, amount: ORPHAN_PAYMENT_BYN };
      const rub = rubById.get(r.order_id);
      if (rub) {
        const share = Math.round((r.amount / rub) * 10) / 10;
        if ([0.5, 0.7, 1].includes(share)) return { ...r, amount: r2(bynById.get(r.order_id) * share) };
      }
      return { ...r, amount: byn(r.amount) };
    });
    write("finance/revenue.json", revenue);

    // --- Финансы: расходы ---
    const expenses = read("finance/expenses.json").map((e) => ({ ...e, amount: byn(e.amount) }));
    write("finance/expenses.json", expenses);

    // --- Финансы: месячный отчёт. В generate.py он строится до добавления платежа-сироты
    //     (заказ 999998) — это и есть заложенное расхождение сверки; остальное сходится. ---
    const profitRub = read("finance/profit.json");
    const baseRevenue = revenue.filter((r) => r.order_id !== 999998);
    const profit = profitRub.map((p) => {
      const rv = r2(baseRevenue.filter((r) => month(r.date) === p.month).reduce((a, r) => a + r.amount, 0));
      const ex = r2(expenses.filter((e) => month(e.date) === p.month).reduce((a, e) => a + e.amount, 0));
      return { ...p, revenue: rv, expenses: ex, profit: r2(rv - ex) };
    });
    write("finance/profit.json", profit);

    // --- План / бюджет ---
    plans.monthly.revenue = Math.round(plans.monthly.revenue / SCALE / 1000) * 1000;
    plans.monthly.expenses = Math.round(plans.monthly.expenses / SCALE / 1000) * 1000;
    plans.targets.avg_check = Math.round(plans.targets.avg_check / SCALE / 100) * 100;
  }
  write("hr/employees.json", employees);

  plans.currency = "BYN";
  write("plans.json", plans);
  manifest.currency = "BYN";
  manifest.region = "Республика Беларусь";
  manifest.localized_by = "tools/localize-by.js";
  manifest.money_scale = SCALE;
  write("manifest.json", manifest);

  console.log(alreadyMoney ? "Суммы уже в BYN — обновлены только справочные поля." : `Суммы переведены в BYN (÷${SCALE}).`);
}

/** Пересборка data/mock.db — то же, что build_db.py. */
function rebuildDb() {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    console.log("node:sqlite недоступен — mock.db не пересобрана (запустите python build_db.py).");
    return;
  }
  const files = {
    crm_clients: "crm/clients.json",
    crm_orders: "crm/orders.json",
    crm_requests: "crm/requests.json",
    erp_machines: "erp/machines.json",
    erp_shifts: "erp/shifts.json",
    hr_departments: "hr/departments.json",
    hr_employees: "hr/employees.json",
    erp_production_orders: "erp/production_orders.json",
    erp_defects: "erp/defects.json",
    finance_revenue: "finance/revenue.json",
    finance_expenses: "finance/expenses.json",
    finance_profit: "finance/profit.json",
    hr_schedules: "hr/schedules.json",
    hr_sick_leaves: "hr/sick_leaves.json",
  };
  const dbPath = path.join(DATA, "mock.db");
  fs.rmSync(dbPath, { force: true });
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  for (const [table, rel] of Object.entries(files)) {
    const rows = read(rel);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const st = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const r of rows) st.run(...cols.map((c) => (r[c] === undefined ? null : typeof r[c] === "boolean" ? Number(r[c]) : r[c])));
  }
  db.exec("COMMIT");
  db.close();
  console.log("mock.db пересобрана.");
}

localize();
rebuildDb();
