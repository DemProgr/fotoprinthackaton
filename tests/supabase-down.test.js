"use strict";
/* Supabase недоступен: понятная ошибка 503 вместо падения сервера. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fake = require("./fake-supabase");

fake.env();
const db = fake.create({ fail: true });
const { start } = require("../server/index.js");

let srv;
let base;
before(async () => {
  srv = await start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  srv.close();
  db.restore();
});

test("при недоступной БД API отвечает 503 с понятным текстом", async () => {
  const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ login: "director", password: "director2026" }) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /Хранилище данных временно недоступно/);
});

test("статика интерфейса отдаётся и без БД", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Пульс компании/);
});
