"use strict";
/* Мини-библиотека SVG-графиков без внешних зависимостей (работает офлайн). */
window.Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const COLORS = { purple: "#8b5cf6", pink: "#ec4899", blue: "#4f46e5", gray: "#a49bb0", red: "#e11d48", green: "#16a34a", yellow: "#d69e2e" };
  const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return nf.format(v / 1e6) + " млн";
    if (a >= 1e3) return nf.format(v / 1e3) + " тыс";
    return nf.format(v);
  };
  let uid = 0;

  function niceMax(v) {
    if (v <= 0) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  function smoothPath(pts) {
    if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : "";
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const cx = (x0 + x1) / 2;
      d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    return d;
  }

  /** Спарклайн для карточки KPI. */
  function sparkline(container, values, { color = COLORS.purple, plan = null } = {}) {
    container.innerHTML = "";
    const w = 220;
    const h = 38;
    const vals = values.map((v) => (Number.isFinite(v) ? v : null));
    const nums = vals.filter((v) => v !== null);
    if (nums.length < 2) return;
    const all = plan !== null ? nums.concat([plan]) : nums;
    const min = Math.min(...all);
    const max = Math.max(...all);
    const span = max - min || 1;
    const x = (i) => (i / (vals.length - 1)) * w;
    const y = (v) => h - 3 - ((v - min) / span) * (h - 6);
    const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", height: h, "aria-hidden": "true" }, container);
    const id = "sg" + uid++;
    const g = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, el("defs", {}, svg));
    el("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.28 }, g);
    el("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0 }, g);
    const pts = vals.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean);
    const line = smoothPath(pts);
    el("path", { d: `${line} L${pts[pts.length - 1][0]},${h} L${pts[0][0]},${h} Z`, fill: `url(#${id})` }, svg);
    if (plan !== null) el("line", { x1: 0, x2: w, y1: y(plan), y2: y(plan), stroke: COLORS.gray, "stroke-dasharray": "3 3", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }, svg);
    el("path", { d: line, fill: "none", stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linecap": "round" }, svg);
  }

  /**
   * Линейный/столбчатый график.
   * series: [{ name, values, color, type: 'line'|'area'|'bar'|'dash' }]
   */
  function chart(container, { labels, series, height = 240, format = compact, highlight = null }) {
    container.innerHTML = "";
    container.classList.add("chart");
    const legend = document.createElement("div");
    legend.className = "legend";
    legend.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("");
    container.appendChild(legend);
    const W = Math.max(320, container.clientWidth || 600);
    const H = height;
    const m = { l: 52, r: 10, t: 10, b: 26 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    const max = niceMax(Math.max(0, ...all) * 1.05);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": series.map((s) => s.name).join(", ") }, container);
    const gAxis = el("g", { class: "axis" }, svg);
    for (let i = 0; i <= 4; i++) {
      const yy = m.t + ih - (ih * i) / 4;
      el("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: "gridline" }, gAxis);
      const t = el("text", { x: m.l - 8, y: yy + 3, "text-anchor": "end" }, gAxis);
      t.textContent = format((max * i) / 4);
    }
    const n = labels.length;
    const band = iw / Math.max(1, n);
    const cx = (i) => m.l + band * i + band / 2;
    const y = (v) => m.t + ih - (Math.max(0, v) / max) * ih;
    const step = Math.ceil(n / Math.floor(iw / 58));
    labels.forEach((lb, i) => {
      if (i % step) return;
      const t = el("text", { x: cx(i), y: H - 8, "text-anchor": "middle" }, gAxis);
      t.textContent = lb;
    });
    if (highlight) {
      highlight.forEach((i) => el("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: COLORS.red, opacity: 0.07 }, svg));
    }
    const bars = series.filter((s) => s.type === "bar");
    const bw = Math.min(26, (band * 0.7) / Math.max(1, bars.length));
    bars.forEach((s, bi) => {
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x0 = cx(i) - (bw * bars.length) / 2 + bi * bw;
        el("rect", { x: x0 + 1, y: y(v), width: Math.max(2, bw - 2), height: Math.max(0, m.t + ih - y(v)), rx: 3, fill: (s.colorAt && s.colorAt(i)) || s.color }, svg);
      });
    });
    series
      .filter((s) => s.type !== "bar")
      .forEach((s) => {
        const pts = s.values.map((v, i) => (Number.isFinite(v) ? [cx(i), y(v)] : null)).filter(Boolean);
        if (!pts.length) return;
        const d = s.type === "dash" ? "M" + pts.map((p) => p.join(",")).join(" L") : smoothPath(pts);
        if (s.type === "area") {
          const id = "ag" + uid++;
          const g = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, el("defs", {}, svg));
          el("stop", { offset: "0%", "stop-color": s.color, "stop-opacity": 0.3 }, g);
          el("stop", { offset: "100%", "stop-color": s.color, "stop-opacity": 0.02 }, g);
          el("path", { d: `${d} L${pts[pts.length - 1][0]},${m.t + ih} L${pts[0][0]},${m.t + ih} Z`, fill: `url(#${id})` }, svg);
        }
        el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.type === "dash" ? 2 : 2.5, "stroke-dasharray": s.type === "dash" ? "6 5" : "", "stroke-linecap": "round" }, svg);
      });

    // Тултип
    const tip = document.createElement("div");
    tip.className = "tooltip hidden";
    container.appendChild(tip);
    const hover = el("rect", { x: 0, y: m.t, width: band, height: ih, fill: "rgba(139,92,246,0.07)", visibility: "hidden" }, svg);
    svg.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const i = Math.floor((px - m.l) / band);
      if (i < 0 || i >= n) {
        tip.classList.add("hidden");
        hover.setAttribute("visibility", "hidden");
        return;
      }
      hover.setAttribute("x", m.l + band * i);
      hover.setAttribute("visibility", "visible");
      tip.innerHTML = `<b>${labels[i]}</b><br>` + series.map((s) => `<span style="color:${s.color}">●</span> ${s.name}: <b>${Number.isFinite(s.values[i]) ? format(s.values[i]) : "—"}</b>`).join("<br>");
      tip.classList.remove("hidden");
      const cr = container.getBoundingClientRect();
      let left = e.clientX - cr.left + 12;
      if (left + tip.offsetWidth > cr.width) left = e.clientX - cr.left - tip.offsetWidth - 12;
      tip.style.left = left + "px";
      tip.style.top = e.clientY - cr.top - 10 + "px";
    });
    svg.addEventListener("mouseleave", () => {
      tip.classList.add("hidden");
      hover.setAttribute("visibility", "hidden");
    });
  }

  /** Кольцевая диаграмма. items: [{label, value, color}] */
  function donut(container, items, { format = compact } = {}) {
    container.innerHTML = "";
    const total = items.reduce((a, x) => a + x.value, 0) || 1;
    const S = 180;
    const R = 78;
    const r = 50;
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:18px;align-items:center;flex-wrap:wrap";
    const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, width: S, height: S, role: "img" });
    let a0 = -Math.PI / 2;
    items.forEach((it) => {
      const a1 = a0 + (it.value / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, a) => [S / 2 + rad * Math.cos(a), S / 2 + rad * Math.sin(a)];
      const [x0, y0] = p(R, a0);
      const [x1, y1] = p(R, a1 - 0.0001);
      const [x2, y2] = p(r, a1 - 0.0001);
      const [x3, y3] = p(r, a0);
      const path = el("path", { d: `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`, fill: it.color }, svg);
      const t = el("title", {}, path);
      t.textContent = `${it.label}: ${format(it.value)}`;
      a0 = a1;
    });
    wrap.appendChild(svg);
    const lg = document.createElement("div");
    lg.className = "legend";
    lg.style.flexDirection = "column";
    lg.innerHTML = items.map((it) => `<span><i style="background:${it.color}"></i>${it.label} — <b>${nf.format((it.value / total) * 100)}%</b> <span style="color:var(--text-muted)">(${format(it.value)})</span></span>`).join("");
    wrap.appendChild(lg);
    container.appendChild(wrap);
  }

  return { sparkline, chart, donut, COLORS, compact };
})();
