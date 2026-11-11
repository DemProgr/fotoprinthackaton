"use strict";
/* Общие утилиты: даты с часовым поясом, округление, группировка. */

const TZ_OFFSET = "+03:00"; // Europe/Minsk — все отметки времени хранятся с явным смещением
const TZ_MS = 3 * 3600 * 1000;

/** Текущее время в ISO 8601 с часовым поясом компании, например 2026-11-11T18:40:00+03:00 */
function isoNow(date = new Date()) {
  const local = new Date(date.getTime() + TZ_MS);
  return local.toISOString().slice(0, 19) + TZ_OFFSET;
}

/** День (целое число суток от эпохи) для строки YYYY-MM-DD или ISO-даты. */
function dayNum(s) {
  if (!s) return NaN;
  return Math.floor(Date.parse(String(s).slice(0, 10) + "T00:00:00Z") / 864e5);
}

function dayStr(n) {
  return new Date(n * 864e5).toISOString().slice(0, 10);
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(dayNum(s));
}

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const avg = (arr, f = (x) => x) => (arr.length ? sum(arr, f) / arr.length : null);

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/** Линейная регрессия по точкам y[0..n-1]; возвращает значение в точке x. */
function linearForecast(ys, x) {
  const pts = ys.map((y, i) => [i, y]).filter(([, y]) => Number.isFinite(y));
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0][1];
  const n = pts.length;
  const mx = sum(pts, (p) => p[0]) / n;
  const my = sum(pts, (p) => p[1]) / n;
  let num = 0;
  let den = 0;
  for (const [px, py] of pts) {
    num += (px - mx) * (py - my);
    den += (px - mx) ** 2;
  }
  const k = den ? num / den : 0;
  return my + k * (x - mx);
}

module.exports = { TZ_OFFSET, isoNow, dayNum, dayStr, isDate, round, sum, avg, groupBy, linearForecast };
