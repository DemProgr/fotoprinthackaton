"use strict";
/*
 * Аутентификация и ролевая модель. Права проверяются только на сервере:
 * клиент получает лишь те KPI/экраны/решения, которые разрешены роли.
 *
 * Тестовые учётные записи (пароли хранятся только в виде scrypt-хэшей):
 *   director / director2026 — директор, видит всё
 *   prod     / prod2026     — руководитель производства (производство и качество)
 *   sales    / sales2026    — руководитель отдела продаж (продажи и клиенты)
 *   analyst  / analyst2026  — аналитик/администратор данных
 */
const crypto = require("crypto");
const store = require("./store");

const ALL_DOMAINS = ["finance", "sales", "production", "hr"];
const SESSION_TTL_MS = 12 * 3600 * 1000;

const USERS = [
  {
    login: "director",
    name: "Анна Директорова",
    title: "Генеральный директор",
    role: "director",
    domains: ALL_DOMAINS,
    salt: "53e5df8b63805346156220604b685a39",
    hash: "3ccff42ff83b4ef5cbcfd9dbdabfa0a6d368ba00abe8c7372a6547cf32483f22",
  },
  {
    login: "prod",
    name: "Павел Цехов",
    title: "Руководитель производства",
    role: "head",
    department_id: 1,
    domains: ["production"],
    salt: "00efba6e46ca45cb0170be572fc0bff0",
    hash: "8472b6091b88bdca04453ca4d7f00f299f93dd24f02c3bd823a14ed00ad7a59f",
  },
  {
    login: "sales",
    name: "Светлана Продажина",
    title: "Руководитель отдела продаж",
    role: "head",
    department_id: 3,
    domains: ["sales"],
    salt: "8a7ee2546028bbaff77ec17660baa64b",
    hash: "89647860b635fe52f02e704e598b93c22e57140f6cc9a10ff2a4fbcd27d88191",
  },
  {
    login: "analyst",
    name: "Артём Данных",
    title: "Аналитик / администратор данных",
    role: "analyst",
    domains: ALL_DOMAINS,
    salt: "b61bba1b452f5975209075e7faca4fc9",
    hash: "6f6220af71b1013a5c9a54051bac4de729502c589573acc0b2e3a75316d312b5",
  },
];

const ROLE_LABEL = { director: "Директор", head: "Руководитель подразделения", analyst: "Аналитик / администратор" };

/** Что роль может делать (используется и сервером, и для отрисовки меню на клиенте). */
/*
 * Директор — управляет: принимает решения и видит результат (планы и качество данных — только чтение).
 * Аналитик — отвечает за данные и методику, решений не принимает, но:
 *   • ведёт планы и нормативы KPI (plans.edit) — от них зависят статусы и отклонения;
 *   • разбирает проблемы качества данных: статус, ответственный, комментарий (quality.manage);
 *   • перезагружает данные из источников (quality.reload);
 *   • сравнивает периоды по всем KPI (analysis.compare);
 *   • выгружает записи детализации и журнал в CSV (data.export).
 */
const PERMISSIONS = {
  director: ["kpi.view", "decision.create", "decision.edit", "decision.view", "audit.view", "quality.view", "forecast.view", "plans.view"],
  head: ["kpi.view", "decision.create", "decision.edit", "decision.view", "forecast.view"],
  analyst: ["kpi.view", "decision.view", "audit.view", "quality.view", "quality.reload", "quality.manage", "forecast.view", "plans.view", "plans.edit", "analysis.compare", "data.export"],
};

function publicUser(u) {
  return {
    login: u.login,
    name: u.name,
    title: u.title,
    role: u.role,
    role_label: ROLE_LABEL[u.role],
    domains: u.domains,
    permissions: PERMISSIONS[u.role],
  };
}

function verify(login, password) {
  const u = USERS.find((x) => x.login === String(login || "").trim().toLowerCase());
  if (!u || typeof password !== "string") return null;
  const calc = crypto.scryptSync(password, u.salt, 32);
  const ok = crypto.timingSafeEqual(calc, Buffer.from(u.hash, "hex"));
  return ok ? u : null;
}

/*
 * Сессии без состояния: токен = base64url(JSON{login, exp}) + "." + HMAC-SHA256.
 * Работает и на нескольких экземплярах бессерверных функций; выход — отзыв токена в хранилище.
 */
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (payload) => crypto.createHmac("sha256", store.sessionSecret()).update(payload).digest("base64url");

function createSession(u) {
  const payload = b64(JSON.stringify({ l: u.login, exp: Date.now() + SESSION_TTL_MS, n: crypto.randomBytes(6).toString("hex") }));
  return payload + "." + sign(payload);
}

function parseToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expected = sign(payload);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return { ...data, sig };
  } catch {
    return null;
  }
}

function destroySession(token) {
  const t = parseToken(token);
  if (!t) return;
  const now = Date.now();
  const revoked = store.state.revoked || (store.state.revoked = {});
  for (const [k, exp] of Object.entries(revoked)) if (exp < now) delete revoked[k];
  revoked[t.sig] = t.exp;
  store.markDirty();
}

function userByToken(token) {
  const t = parseToken(token);
  if (!t || (store.state.revoked && store.state.revoked[t.sig])) return null;
  return USERS.find((u) => u.login === t.l) || null;
}

const can = (u, perm) => !!u && PERMISSIONS[u.role].includes(perm);
const canDomain = (u, domain) => !!u && u.domains.includes(domain);

module.exports = { USERS, ALL_DOMAINS, publicUser, verify, createSession, destroySession, userByToken, can, canDomain };
