"use strict";

(() => {
  const $ = (selector, ctx = document) => ctx.querySelector(selector);
  const $$ = (selector, ctx = document) => Array.from(ctx.querySelectorAll(selector));
  const SVG_NS = "http://www.w3.org/2000/svg";
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const ru = new Intl.NumberFormat("ru-RU");
  const WEEKDAYS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
  const weekday = (day) => WEEKDAYS[new Date(2026, 0, day).getDay()];

  /* ---------- Theme ---------- */

  const root = document.documentElement;
  const themeToggle = $("#themeToggle");
  const themeLabel = $("#themeLabel");

  function setTheme(theme) {
    const dark = theme === "dark";
    root.dataset.theme = dark ? "dark" : "light";
    themeToggle.setAttribute("aria-checked", String(dark));
    themeLabel.textContent = dark ? "Тёмная тема" : "Светлая тема";
    try {
      localStorage.setItem("kpilab-theme", theme);
    } catch (err) {
      /* storage unavailable */
    }
  }

  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem("kpilab-theme") === "dark" ? "dark" : "light";
  } catch (err) {
    /* storage unavailable */
  }
  setTheme(savedTheme);

  themeToggle.addEventListener("click", () => {
    setTheme(root.dataset.theme === "dark" ? "light" : "dark");
  });

  /* ---------- Dropdowns ---------- */

  function closeDropdowns(except) {
    $$(".dropdown.open").forEach((dropdown) => {
      if (dropdown === except) return;
      dropdown.classList.remove("open");
      $(".dropdown-btn", dropdown)?.setAttribute("aria-expanded", "false");
    });
  }

  $$(".dropdown").forEach((dropdown) => {
    const button = $(".dropdown-btn", dropdown);
    const label = $(".dropdown-label", dropdown);
    const items = $$(".dropdown-item", dropdown);

    items.forEach((item) => {
      if (label && item.textContent.trim() === label.textContent.trim()) {
        item.classList.add("selected");
      }
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        if (label) label.textContent = item.textContent.trim();
        items.forEach((entry) => entry.classList.toggle("selected", entry === item));
        dropdown.classList.remove("open");
        button.setAttribute("aria-expanded", "false");
      });
    });

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = !dropdown.classList.contains("open");
      closeDropdowns();
      dropdown.classList.toggle("open", willOpen);
      button.setAttribute("aria-expanded", String(willOpen));
    });
  });

  document.addEventListener("click", () => closeDropdowns());

  /* ---------- Mobile sidebar ---------- */

  const sidebar = $("#sidebar");
  const menuButton = $("#menuBtn");
  const scrim = $("#scrim");

  function closeSidebar() {
    sidebar.classList.remove("open");
    document.body.classList.remove("sidebar-open");
  }

  menuButton.addEventListener("click", () => {
    sidebar.classList.toggle("open");
    document.body.classList.toggle("sidebar-open", sidebar.classList.contains("open"));
  });
  scrim.addEventListener("click", closeSidebar);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDropdowns();
      closeSidebar();
    }
  });

  /* ---------- Navigation ---------- */

  $$(".nav-item").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      $$(".nav-item").forEach((entry) => {
        entry.classList.remove("active");
        entry.removeAttribute("aria-current");
      });
      item.classList.add("active");
      item.setAttribute("aria-current", "page");
      if (window.matchMedia("(max-width: 760px)").matches) closeSidebar();
    });
  });

  /* ---------- Search ---------- */

  const searchInput = $("#searchInput");
  const productRows = $$("#productsTable tbody tr");

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    productRows.forEach((row) => {
      row.style.display = !query || row.textContent.toLowerCase().includes(query) ? "" : "none";
    });
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    searchInput.value = "";
    searchInput.dispatchEvent(new Event("input"));
    searchInput.blur();
  });

  /* ---------- Path helpers ---------- */

  function smoothPath(points, tension = 1) {
    if (points.length < 2) return "";
    let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const cp1x = p1[0] + ((p2[0] - p0[0]) / 6) * tension;
      const cp1y = p1[1] + ((p2[1] - p0[1]) / 6) * tension;
      const cp2x = p2[0] - ((p3[0] - p1[0]) / 6) * tension;
      const cp2y = p2[1] - ((p3[1] - p1[1]) / 6) * tension;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    return d;
  }

  function barPath(x, y, width, height, radius = 2.2) {
    const r = Math.min(radius, width / 2, height);
    return [
      `M ${x} ${y + height}`,
      `V ${y + r}`,
      `Q ${x} ${y} ${x + r} ${y}`,
      `H ${x + width - r}`,
      `Q ${x + width} ${y} ${x + width} ${y + r}`,
      `V ${y + height}`,
      "Z"
    ].join(" ");
  }

  /* ---------- Sparklines ---------- */

  const sparks = [
    {
      el: "#sparkRevenue",
      color: "#9b7bf7",
      data: [22, 40, 30, 52, 44, 66, 58, 84, 72, 98]
    },
    {
      el: "#sparkProfit",
      color: "#5b6cf9",
      data: [28, 22, 38, 30, 46, 40, 56, 48, 70, 88]
    },
    {
      el: "#sparkOrders",
      color: "#f43f5e",
      data: [22, 36, 28, 46, 36, 52, 44, 64, 56, 84]
    },
    {
      el: "#sparkConversion",
      color: "#8b5cf6",
      data: [36, 46, 38, 52, 42, 58, 48, 62, 54, 68]
    }
  ];

  function renderSparkline({ el, color, data }) {
    const node = $(el);
    if (!node) return;

    const width = 120;
    const height = 64;
    const padTop = 6;
    const padBottom = 4;
    const padSide = 2;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;

    const points = data.map((value, index) => [
      padSide + (index * (width - padSide * 2)) / (data.length - 1),
      height - padBottom - ((value - min) / span) * (height - padTop - padBottom)
    ]);

    const line = smoothPath(points);
    const area = `${line} L ${points[points.length - 1][0].toFixed(2)} ${height} L ${points[0][0].toFixed(2)} ${height} Z`;
    const gradientId = `spark-${el.replace("#", "")}`;

    node.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#${gradientId})"/>
        <path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>`;
  }

  sparks.forEach(renderSparkline);

  /* ---------- Data ---------- */

  const sales = {
    purchases: [168, 192, 158, 176, 205, 192, 214, 230, 198, 120, 138, 172, 196, 225, 242, 258, 246, 232, 255, 240, 262, 284, 272, 296, 310, 330, 338, 300, 246, 302],
    sales: [128, 150, 178, 194, 188, 203, 220, 236, 208, 168, 190, 214, 240, 228, 246, 262, 286, 302, 264, 240, 270, 292, 276, 304, 322, 344, 364, 372, 356, 330]
  };

  const returns = {
    cancel: [52, 35, 60, 45, 70, 30, 25, 86, 40, 55, 65, 35, 30, 45],
    defect: [18, 25, 30, 15, 25, 35, 20, 29, 22, 28, 18, 25, 30, 20],
    return: [30, 45, 38, 50, 42, 30, 25, 38, 35, 50, 42, 30, 28, 40]
  };

  const returnsColors = {
    cancel: "#ef476f",
    defect: "#6f5be7",
    return: "#b9a1ff"
  };

  /* ---------- Sales chart ---------- */

  const salesWrap = $("#salesChart");
  const salesTip = $(".chart-tooltip", salesWrap);

  function renderSales() {
    const width = salesWrap.clientWidth;
    const height = salesWrap.clientHeight;
    if (!width || !height) return;

    const pad = { l: 34, r: 12, t: 10, b: 24 };
    const plotWidth = width - pad.l - pad.r;
    const plotHeight = height - pad.t - pad.b;
    const count = sales.purchases.length;
    const yMax = 500;

    const x = (index) => pad.l + (plotWidth * index) / (count - 1);
    const y = (value) => pad.t + plotHeight * (1 - value / yMax);

    const grid = [];
    for (let value = 0; value <= yMax; value += 100) {
      const lineY = y(value);
      grid.push(`<line class="grid-line" x1="${pad.l}" y1="${lineY}" x2="${width - pad.r}" y2="${lineY}"/>`);
      grid.push(`<text class="chart-axis-label" x="${pad.l - 8}" y="${lineY + 3}" text-anchor="end">${value}</text>`);
    }

    [0, 4, 9, 14, 19, 24, 29].forEach((index) => {
      grid.push(`<text class="chart-axis-label" x="${x(index)}" y="${height - 6}" text-anchor="middle">${index + 1}</text>`);
    });

    const series = [
      {
        key: "purchases",
        values: sales.purchases,
        color: "#f43f5e",
        fillTop: "rgba(244, 63, 94, 0.22)",
        fillBottom: "rgba(244, 63, 94, 0)",
        gradientId: "gradPurchases"
      },
      {
        key: "sales",
        values: sales.sales,
        color: "#8b5cf6",
        fillTop: "rgba(139, 92, 246, 0.2)",
        fillBottom: "rgba(139, 92, 246, 0)",
        gradientId: "gradSales"
      }
    ];

    let seriesMarkup = "";
    const allPoints = {};

    series.forEach((line) => {
      const points = line.values.map((value, index) => [x(index), y(value)]);
      allPoints[line.key] = points;
      const linePath = smoothPath(points);
      const areaPath = `${linePath} L ${points[points.length - 1][0].toFixed(2)} ${y(0)} L ${points[0][0].toFixed(2)} ${y(0)} Z`;

      seriesMarkup += `
        <defs>
          <linearGradient id="${line.gradientId}" x1="0" y1="${pad.t}" x2="0" y2="${y(0)}" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="${line.fillTop}"/>
            <stop offset="100%" stop-color="${line.fillBottom}"/>
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#${line.gradientId})"/>
        <path d="${linePath}" fill="none" stroke="${line.color}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`;
    });

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "График продаж и выкупов за 30 дней");
    svg.innerHTML = `
      ${grid.join("")}
      ${seriesMarkup}
      <line class="guide-line" x1="0" y1="${pad.t}" x2="0" y2="${y(0)}" opacity="0"/>
      ${series
        .map(
          (line, index) =>
            `<circle class="hover-dot" data-dot="${index}" r="3.6" cx="0" cy="0" stroke="${line.color}" opacity="0"/>`
        )
        .join("")}`;

    salesWrap.querySelector("svg")?.remove();
    salesWrap.insertBefore(svg, salesTip);
    salesTip.classList.remove("visible");

    const guide = $(".guide-line", svg);
    const dots = $$(".hover-dot", svg);

    function hide() {
      guide.setAttribute("opacity", "0");
      dots.forEach((dot) => dot.setAttribute("opacity", "0"));
      salesTip.classList.remove("visible");
    }

    salesWrap.onpointermove = (event) => {
      const rect = salesWrap.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      if (pointerX < pad.l - 8 || pointerX > width - pad.r + 8) {
        hide();
        return;
      }

      const index = clamp(Math.round(((pointerX - pad.l) / plotWidth) * (count - 1)), 0, count - 1);
      const pointX = x(index);
      const purchasesY = y(sales.purchases[index]);
      const salesY = y(sales.sales[index]);

      guide.setAttribute("x1", pointX);
      guide.setAttribute("x2", pointX);
      guide.setAttribute("opacity", "1");

      dots[0].setAttribute("cx", pointX);
      dots[0].setAttribute("cy", purchasesY);
      dots[0].setAttribute("opacity", "1");
      dots[1].setAttribute("cx", pointX);
      dots[1].setAttribute("cy", salesY);
      dots[1].setAttribute("opacity", "1");

      const day = index + 1;
      salesTip.innerHTML = `
        <div class="tt-date"><span>${day} января</span><span class="tt-weekday">${weekday(day)}</span></div>
        <div class="tt-row"><span class="tt-dot" style="background:#f43f5e"></span>Выкупы <b>${ru.format(sales.purchases[index])}</b></div>
        <div class="tt-row"><span class="tt-dot" style="background:#8b5cf6"></span>Продажи <b>${ru.format(sales.sales[index])}</b></div>`;
      salesTip.classList.add("visible");

      const tipWidth = salesTip.offsetWidth || 130;
      const tipHeight = salesTip.offsetHeight || 68;
      const anchorY = Math.min(purchasesY, salesY);
      const left = clamp(pointX, tipWidth / 2 + 6, width - tipWidth / 2 - 6);
      let top = anchorY - 12;
      let transform = "translate(-50%, -100%)";

      if (top - tipHeight < 2) {
        top = anchorY + 14;
        transform = "translate(-50%, 0)";
      }

      salesTip.style.left = `${left}px`;
      salesTip.style.top = `${Math.max(4, top)}px`;
      salesTip.style.transform = transform;
    };

    salesWrap.onpointerleave = hide;
  }

  /* ---------- Returns chart ---------- */

  const returnsWrap = $("#returnsChart");
  const returnsTip = $(".chart-tooltip", returnsWrap);

  function renderReturns() {
    const width = returnsWrap.clientWidth;
    const height = returnsWrap.clientHeight;
    if (!width || !height) return;

    const pad = { l: 30, r: 10, t: 10, b: 26 };
    const plotWidth = width - pad.l - pad.r;
    const plotHeight = height - pad.t - pad.b;
    const groups = returns.cancel.length;
    const groupWidth = plotWidth / groups;
    const yMax = 100;

    const y = (value) => pad.t + plotHeight * (1 - value / yMax);

    const grid = [];
    for (let i = 1; i < groups; i++) {
      const lineX = pad.l + groupWidth * i;
      grid.push(`<line class="grid-line-v" x1="${lineX}" y1="${pad.t}" x2="${lineX}" y2="${y(0)}"/>`);
    }
    for (let value = 0; value <= yMax; value += 20) {
      const lineY = y(value);
      grid.push(`<line class="grid-line" x1="${pad.l}" y1="${lineY}" x2="${width - pad.r}" y2="${lineY}"/>`);
      grid.push(`<text class="chart-axis-label" x="${pad.l - 7}" y="${lineY + 3}" text-anchor="end">${value}</text>`);
    }

    const barWidth = clamp(groupWidth * 0.16, 2.8, 6.5);
    const barGap = Math.max(1.8, barWidth * 0.5);
    const keys = ["cancel", "defect", "return"];
    let bars = "";

    for (let i = 0; i < groups; i++) {
      const center = pad.l + groupWidth * i + groupWidth / 2;
      const totalWidth = barWidth * 3 + barGap * 2;
      const startX = center - totalWidth / 2;

      keys.forEach((key, j) => {
        const value = returns[key][i];
        const barHeight = (plotHeight * value) / yMax;
        if (barHeight <= 0) return;
        bars += `<path d="${barPath(startX + j * (barWidth + barGap), y(0) - barHeight, barWidth, barHeight)}" fill="${returnsColors[key]}"/>`;
      });
    }

    const labels = [];
    for (let i = 0; i < groups; i++) {
      const day = 5 + i;
      const center = pad.l + groupWidth * i + groupWidth / 2;
      labels.push(`<text class="chart-axis-label" x="${center}" y="${height - 8}" text-anchor="middle">${weekday(day)}</text>`);
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "График возвратов за 14 дней");
    svg.innerHTML = `
      ${grid.join("")}
      <rect class="hover-col" x="0" y="${pad.t}" width="${groupWidth}" height="${plotHeight}" rx="7" opacity="0"/>
      ${bars}
      ${labels.join("")}`;

    returnsWrap.querySelector("svg")?.remove();
    returnsWrap.insertBefore(svg, returnsTip);
    returnsTip.classList.remove("visible");

    const hoverColumn = $(".hover-col", svg);

    function hide() {
      hoverColumn.setAttribute("opacity", "0");
      returnsTip.classList.remove("visible");
    }

    returnsWrap.onpointermove = (event) => {
      const rect = returnsWrap.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      if (pointerX < pad.l || pointerX > width - pad.r) {
        hide();
        return;
      }

      const index = clamp(Math.floor((pointerX - pad.l) / groupWidth), 0, groups - 1);
      const center = pad.l + groupWidth * index + groupWidth / 2;
      const day = 5 + index;

      hoverColumn.setAttribute("x", pad.l + groupWidth * index + 2);
      hoverColumn.setAttribute("width", groupWidth - 4);
      hoverColumn.setAttribute("opacity", "1");

      returnsTip.innerHTML = `
        <div class="tt-date"><span>${day} января</span><span class="tt-weekday">${weekday(day)}</span></div>
        <div class="tt-row"><span class="tt-dot" style="background:${returnsColors.cancel}"></span>Отмена <b>${returns.cancel[index]}</b></div>
        <div class="tt-row"><span class="tt-dot" style="background:${returnsColors.defect}"></span>Брак <b>${returns.defect[index]}</b></div>
        <div class="tt-row"><span class="tt-dot" style="background:${returnsColors.return}"></span>Возврат <b>${returns.return[index]}</b></div>`;
      returnsTip.classList.add("visible");

      const tipWidth = returnsTip.offsetWidth || 120;
      const tipHeight = returnsTip.offsetHeight || 80;
      const topBar = Math.min(
        y(returns.cancel[index]),
        y(returns.defect[index]),
        y(returns.return[index])
      );
      const left = clamp(center, tipWidth / 2 + 6, width - tipWidth / 2 - 6);
      let top = topBar - 10;
      let transform = "translate(-50%, -100%)";

      if (top - tipHeight < 2) {
        top = 6;
        transform = "translate(-50%, 0)";
      }

      returnsTip.style.left = `${left}px`;
      returnsTip.style.top = `${Math.max(4, top)}px`;
      returnsTip.style.transform = transform;
    };

    returnsWrap.onpointerleave = hide;
  }

  /* ---------- Donut ---------- */

  function renderDonut() {
    const node = $("#donutChart");
    if (!node) return;

    const size = 190;
    const center = size / 2;
    const radius = 66;
    const stroke = 30;
    const gap = 30;
    const circumference = 2 * Math.PI * radius;

    const segments = [
      { label: "Сайт", value: 10.1, from: "#f3e8ff", to: "#dfc9fb" },
      { label: "Wildberries", value: 58.8, from: "#fbc7d9", to: "#f28fb4" },
      { label: "Ozon", value: 31.1, from: "#e2d4ff", to: "#c7acfb" }
    ];

    let offset = 0;
    let markup = "";

    segments.forEach((segment, index) => {
      const arc = (segment.value / 100) * circumference;
      const dash = Math.max(arc - gap, 1);
      const start = offset + gap / 2;
      markup += `
        <defs>
          <linearGradient id="donutGrad${index}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${segment.from}"/>
            <stop offset="100%" stop-color="${segment.to}"/>
          </linearGradient>
        </defs>
        <circle class="donut-segment" cx="${center}" cy="${center}" r="${radius}" fill="none"
          stroke="url(#donutGrad${index})" stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}"
          stroke-dashoffset="${(-start).toFixed(2)}">
          <title>${segment.label}: ${segment.value.toString().replace(".", ",")}%</title>
        </circle>`;
      offset += arc;
    });

    node.innerHTML = `
      <svg viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">
        <g transform="rotate(-90 ${center} ${center})">${markup}</g>
      </svg>`;
  }

  /* ---------- Resize handling ---------- */

  renderSales();
  renderReturns();
  renderDonut();

  let resizeFrame = 0;
  const rerenderCharts = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      renderSales();
      renderReturns();
    });
  };

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(rerenderCharts);
    observer.observe(salesWrap);
    observer.observe(returnsWrap);
  } else {
    window.addEventListener("resize", rerenderCharts);
  }

  if (document.fonts?.ready) {
    document.fonts.ready.then(rerenderCharts);
  }
})();
