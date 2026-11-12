"use strict";
/* Интерфейс и подсказки KPI: скрипты корректны, у каждого KPI есть понятная подсказка. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WEB = path.join(__dirname, "..", "web");

test("скрипты интерфейса без синтаксических ошибок", () => {
  for (const f of ["app.js", "charts.js"]) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(WEB, f), "utf8"), { filename: f }), f);
});

test("у каждого KPI есть понятная подсказка: смысл и формула (дробь или сумма)", () => {
  const data = require("../server/data");
  const kpi = require("../server/kpi");
  const db = data.get();
  const f = { from: "2026-08-03", to: "2026-10-31" };
  for (const k of kpi.KPIS) {
    const x = kpi.evaluate(db, k, f).explain;
    assert.ok(x, `нет подсказки для ${k.id}`);
    assert.ok(x.what && x.what.length >= 10, `нет описания смысла для ${k.id}`);
    assert.ok(x.sum || (x.num && x.den), `нет формулы для ${k.id}`);
    assert.ok((x.sum || x.num).length <= 60, `формула ${k.id} слишком длинная для подсказки`);
  }
});

test("в интерфейсе есть видимая кнопка выхода и кабинеты под роли", () => {
  const js = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  assert.match(js, /class="logout-btn" data-logout/);
  for (const name of ["Кабинет директора", "Кабинет аналитика", "Кабинет руководителя"]) assert.ok(js.includes(name), name);
});

test("экраны-дашборды помечены как «без прокрутки»", () => {
  const js = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  const m = js.match(/FIT_PAGES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m);
  for (const p of ["pulse", "sales", "production", "finance", "forecast"]) assert.ok(m[1].includes(`"${p}"`), p);
  assert.match(fs.readFileSync(path.join(WEB, "app.css"), "utf8"), /\.main\.fit \{[^}]*overflow: hidden/);
});

test("проект настроен только под Vercel", () => {
  const root = path.join(__dirname, "..");
  assert.ok(!fs.existsSync(path.join(root, "netlify.toml")));
  const v = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(v.rewrites[0].destination, "/api/index?__path=:path*");
  assert.match(v.functions["api/index.js"].includeFiles, /server/);
});
