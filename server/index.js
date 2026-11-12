"use strict";
/*
 * Пульс компании — сервер MVP (Трек 1). Без внешних зависимостей: Node.js ≥ 18.
 * REST/JSON API + раздача статического SPA из /web.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const store = require("./store");
const data = require("./data");
const auth = require("./auth");
const kpi = require("./kpi");
const views = require("./views");
const decisions = require("./decisions");
const { isoNow, isDate, dayNum, dayStr } = require("./util");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const WEB_DIR = path.join(__dirname, "..", "web");
const MAX_BODY = 64 * 1024;

/* ------------------------------ Инфраструктура ------------------------------ */

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, "Слишком большой запрос (максимум 64 КБ)"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "Некорректный JSON в теле запроса"));
      }
    });
    req.on("error", reject);
  });
}

/** Журнал действий (ОТ-04): пользователь, время, действие, объект, результат. */
function audit(req, user, action, object, result = "успех", details) {
  store.addAudit({
    at: isoNow(),
    user: user?.login || "аноним",
    user_name: user?.name || null,
    role: user?.role || null,
    action,
    object: object || null,
    result,
    details: details || null,
    ip: String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim(),
  });
}

function token(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function requireUser(req) {
  const u = auth.userByToken(token(req));
  if (!u) throw new ApiError(401, "Сессия истекла или вы не вошли в систему. Войдите заново.");
  return u;
}

function requirePerm(req, u, perm, object) {
  if (!auth.can(u, perm)) {
    audit(req, u, "доступ запрещён", object || perm, "отказ");
    throw new ApiError(403, "Недостаточно прав для этого действия");
  }
}

function requireDomain(req, u, domain, object) {
  if (!auth.canDomain(u, domain)) {
    audit(req, u, "доступ запрещён", object || domain, "отказ", { domain });
    throw new ApiError(403, "Показатели этого подразделения закрыты для вашей роли");
  }
}

/** Разбор фильтров периода/продукта/подразделения из query-строки с проверкой. */
function filters(url, db) {
  const q = url.searchParams;
  const period = q.get("period") || "90d";
  let to = db.today;
  let from;
  const presets = { "30d": 30, "90d": 90, "180d": 180, "365d": 365 };
  if (period === "custom") {
    from = q.get("from");
    to = q.get("to");
    if (!isDate(from) || !isDate(to)) throw new ApiError(400, "Укажите даты периода в формате ГГГГ-ММ-ДД");
    if (from > to) throw new ApiError(400, "Дата начала периода позже даты окончания");
    if (dayNum(to) - dayNum(from) > 3 * 366) throw new ApiError(400, "Период не может превышать 3 лет");
  } else if (period === "all") {
    from = "2025-01-01";
  } else if (presets[period]) {
    from = dayStr(dayNum(to) - presets[period] + 1);
  } else throw new ApiError(400, "Неизвестный период");
  const product = q.get("product") || "";
  if (product && !db.productTypes.includes(product)) throw new ApiError(400, "Неизвестный тип продукта");
  const domain = q.get("domain") || "";
  if (domain && !auth.ALL_DOMAINS.includes(domain)) throw new ApiError(400, "Неизвестное подразделение");
  return { period, from, to, product, domain };
}

/* --------------------------------- Маршруты --------------------------------- */

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), handler });

route("POST", "/api/login", async (req) => {
  const body = await readBody(req);
  const u = auth.verify(body.login, body.password);
  if (!u) {
    audit(req, null, "вход", String(body.login || "").slice(0, 40), "отказ: неверный логин или пароль");
    throw new ApiError(401, "Неверный логин или пароль");
  }
  const t = auth.createSession(u);
  audit(req, u, "вход", u.login);
  return { token: t, user: auth.publicUser(u) };
});

route("POST", "/api/logout", async (req) => {
  const u = requireUser(req);
  auth.destroySession(token(req));
  audit(req, u, "выход", u.login);
  return { ok: true };
});

route("GET", "/api/me", async (req) => {
  const u = requireUser(req);
  const db = data.get();
  return {
    user: auth.publicUser(u),
    meta: { today: db.today, loaded_at: db.loaded_at, product_types: db.productTypes, domains: kpi.DOMAIN_LABEL, timezone: "+03:00", currency: "BYN" },
  };
});

route("GET", "/api/health", async () => ({ ok: true, at: isoNow() }));

route("GET", "/api/kpi", async (req, url) => {
  const u = requireUser(req);
  requirePerm(req, u, "kpi.view");
  const db = data.get();
  const f = filters(url, db);
  if (f.domain) requireDomain(req, u, f.domain, "Пульс компании");
  const list = kpi.KPIS.filter((k) => u.domains.includes(k.domain) && (!f.domain || k.domain === f.domain)).map((k) => kpi.evaluate(db, k, f));
  const critical = list.filter((k) => k.status === "red").map((k) => ({ id: k.id, title: k.title, value: k.value, plan: k.plan, unit: k.unit, deviation_pct: k.deviation_pct, domain: k.domain }));
  audit(req, u, "просмотр", "Пульс компании", "успех", { period: f.period, from: f.from, to: f.to, product: f.product || null, domain: f.domain || null });
  return {
    filters: f,
    kpis: list,
    critical,
    hidden_domains: auth.ALL_DOMAINS.filter((d) => !u.domains.includes(d)).map((d) => kpi.DOMAIN_LABEL[d]),
    generated_at: isoNow(),
  };
});

route("GET", "/api/kpi/:id/drill", async (req, url, p) => {
  const u = requireUser(req);
  const k = kpi.byId(p.id);
  if (!k) throw new ApiError(404, "Показатель не найден");
  requireDomain(req, u, k.domain, `KPI ${k.title}`);
  const db = data.get();
  const f = filters(url, db);
  const dim = url.searchParams.get("dim") || "";
  const res = kpi.drill(db, k, f, dim);
  audit(req, u, "детализация", `KPI ${k.title}`, "успех", { dim: res.dim });
  return res;
});

route("GET", "/api/kpi/:id/records", async (req, url, p) => {
  const u = requireUser(req);
  const k = kpi.byId(p.id);
  if (!k) throw new ApiError(404, "Показатель не найден");
  requireDomain(req, u, k.domain, `KPI ${k.title}`);
  const db = data.get();
  const f = filters(url, db);
  const res = kpi.records(db, k, f, url.searchParams.get("dim"), url.searchParams.get("key"));
  audit(req, u, "детализация: записи", `KPI ${k.title}`, "успех", { dim: url.searchParams.get("dim"), key: url.searchParams.get("key") });
  return res;
});

route("GET", "/api/orders/:id", async (req, url, p) => {
  const u = requireUser(req);
  if (!u.domains.includes("sales") && !u.domains.includes("production")) {
    audit(req, u, "доступ запрещён", `Заказ #${p.id}`, "отказ");
    throw new ApiError(403, "Карточка заказа недоступна для вашей роли");
  }
  const id = Number(p.id);
  if (!Number.isInteger(id)) throw new ApiError(400, "Некорректный номер заказа");
  const card = views.orderCard(data.get(), id);
  if (!card) throw new ApiError(404, `Заказ #${id} не найден в CRM — возможно, это разорванная связь между системами`);
  audit(req, u, "просмотр", `Заказ ${card.order.order_number}`);
  // Руководитель производства не видит финансовые поступления, руководитель продаж — детали смен/операторов.
  if (!u.domains.includes("finance")) card.payments = card.payments.map((x) => ({ id: x.id, date: x.date, amount: null, hidden: true }));
  if (!u.domains.includes("production")) card.production = card.production.map((x) => ({ id: x.id, production_order_number: x.production_order_number, status: x.status, hidden: true }));
  return card;
});

const screen = (name, domain, fn) => async (req, url) => {
  const u = requireUser(req);
  requireDomain(req, u, domain, name);
  const db = data.get();
  const f = filters(url, db);
  audit(req, u, "просмотр", name);
  return { filters: f, ...fn(db, f) };
};
route("GET", "/api/screens/sales", screen("Продажи и клиенты", "sales", views.sales));
route("GET", "/api/screens/production", screen("Производство и качество", "production", views.production));
route("GET", "/api/screens/finance", screen("Финансы и люди", "finance", views.financePeople));

route("GET", "/api/forecast", async (req) => {
  const u = requireUser(req);
  requirePerm(req, u, "forecast.view");
  if (!u.domains.includes("production") && u.role === "head") throw new ApiError(403, "Прогноз мощности доступен руководству производства");
  audit(req, u, "просмотр", "Прогноз спроса и мощности");
  return views.forecast(data.get());
});

/* ----- Реестр решений ----- */

route("GET", "/api/decisions", async (req, url) => {
  const u = requireUser(req);
  requirePerm(req, u, "decision.view");
  let list = decisions.list(u);
  const q = url.searchParams;
  if (q.get("status")) list = list.filter((d) => d.status === q.get("status"));
  if (q.get("priority")) list = list.filter((d) => d.priority === q.get("priority"));
  if (q.get("domain")) list = list.filter((d) => d.domain === q.get("domain"));
  if (q.get("q")) {
    const s = q.get("q").toLowerCase();
    list = list.filter((d) => [d.number, d.title, d.problem, d.owner, d.action].join(" ").toLowerCase().includes(s));
  }
  const today = data.get().today;
  return { decisions: list.map((d) => ({ ...d, overdue: !["выполнено", "отменено"].includes(d.status) && d.due_date < isoNow().slice(0, 10) })), statuses: decisions.STATUSES, priorities: decisions.PRIORITIES, data_today: today };
});

route("POST", "/api/decisions", async (req) => {
  const u = requireUser(req);
  requirePerm(req, u, "decision.create", "Реестр решений");
  const body = await readBody(req);
  const { value, errors } = decisions.validate(body, { today: isoNow().slice(0, 10) });
  if (Object.keys(errors).length) {
    audit(req, u, "создание решения", body?.title ? String(body.title).slice(0, 80) : "без названия", "ошибка валидации", errors);
    throw new ApiError(422, "Проверьте заполнение формы", errors);
  }
  requireDomain(req, u, value.domain, "Создание решения");
  const d = decisions.create(value, u);
  audit(req, u, "создание решения", `${d.number} ${d.title}`);
  return d;
});

route("PATCH", "/api/decisions/:id", async (req, url, p) => {
  const u = requireUser(req);
  requirePerm(req, u, "decision.edit", "Реестр решений");
  const d = decisions.get(Number(p.id));
  if (!d) throw new ApiError(404, "Решение не найдено");
  requireDomain(req, u, d.domain, d.number);
  const body = await readBody(req);
  const { value, errors } = decisions.validate(body, { partial: true, today: isoNow().slice(0, 10) });
  if (value && value.domain) requireDomain(req, u, value.domain, d.number);
  if (Object.keys(errors).length) {
    audit(req, u, "изменение решения", d.number, "ошибка валидации", errors);
    throw new ApiError(422, "Проверьте заполнение формы", errors);
  }
  const { decision, changes } = decisions.update(d, value, u);
  audit(req, u, "изменение решения", `${d.number} ${d.title}`, "успех", { fields: Object.keys(changes) });
  return decision;
});

/* ----- Аналитик: качество данных и журнал ----- */

route("GET", "/api/quality", async (req) => {
  const u = requireUser(req);
  requirePerm(req, u, "quality.view", "Кабинет аналитика");
  const db = data.get();
  audit(req, u, "просмотр", "Качество данных");
  return { ...db.quality, loaded_at: db.loaded_at, sources: data.SOURCES.length + 1, storage: store.backend };
});

route("POST", "/api/admin/reload", async (req) => {
  const u = requireUser(req);
  requirePerm(req, u, "quality.reload", "Перезагрузка данных");
  try {
    const db = data.load();
    audit(req, u, "перезагрузка данных", "data/*.json", "успех", { totals: db.quality.totals });
    return { ok: true, loaded_at: db.loaded_at, totals: db.quality.totals };
  } catch (err) {
    audit(req, u, "перезагрузка данных", "data/*.json", "ошибка: " + err.message);
    throw new ApiError(422, `Данные не загружены: ${err.message}. Система продолжает работать на предыдущей версии данных.`);
  }
});

route("GET", "/api/audit", async (req, url) => {
  const u = requireUser(req);
  requirePerm(req, u, "audit.view", "Журнал действий");
  const q = url.searchParams;
  let list = await store.listAudit();
  if (q.get("user")) list = list.filter((a) => a.user === q.get("user"));
  if (q.get("action")) list = list.filter((a) => a.action.includes(q.get("action")));
  if (q.get("result") === "fail") list = list.filter((a) => a.result !== "успех");
  return { total: list.length, entries: list.slice(0, 500) };
});

/* ------------------------------- Статика SPA ------------------------------- */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json" };

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || !path.extname(rel)) rel = "/index.html";
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Не найдено");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

/* --------------------------------- Сервер --------------------------------- */

/** Обработчик запроса: общий для локального сервера и бессерверной функции Vercel. */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  // Vercel: запросы /api/* перенаправляются в api/index.js с исходным путём в __path
  if (url.searchParams.has("__path")) {
    url.pathname = "/api/" + url.searchParams.get("__path");
    url.searchParams.delete("__path");
  }
  if (!url.pathname.startsWith("/api/")) return serveStatic(req, res, url);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: "Метод API не найден" });
  try {
    await store.refresh();
    const params = url.pathname.match(r.re).groups || {};
    const out = await r.handler(req, url, params);
    await store.commit();
    send(res, 200, out);
  } catch (err) {
    try {
      await store.commit(); // журнал отказов/ошибок валидации тоже сохраняем
    } catch (e) {
      console.error(e);
    }
    if (err instanceof ApiError) return send(res, err.status, { error: err.message, details: err.details || null });
    console.error(err);
    const storageDown = /Хранилище|хранилища/.test(err.message || "");
    send(res, storageDown ? 503 : 500, {
      error: storageDown ? "Хранилище данных временно недоступно. Повторите попытку через минуту." : "Внутренняя ошибка сервера. Попробуйте повторить действие; если ошибка повторится — обратитесь к администратору.",
    });
  }
}

function createServer() {
  return http.createServer(handle);
}

function start(port = PORT) {
  try {
    data.load();
  } catch (err) {
    console.error("[data] Ошибка загрузки данных:", err.message);
    process.exit(1);
  }
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      const addr = server.address();
      console.log(`Пульс компании запущен: http://localhost:${addr.port} (хранилище: ${store.backend})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, createServer, handle };
