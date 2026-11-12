"use strict";
/* Пульс компании — клиентское SPA (vanilla JS, без сборки и внешних зависимостей). */
(() => {
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));
  const app = $("#app");
  const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(k, d = null) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* хранилище недоступно — не критично */
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* */
      }
    },
  };

  const S = {
    token: store.get("pulse-token"),
    user: null,
    meta: null,
    // Фильтр подразделений убран из интерфейса: каждый экран сам показывает своё подразделение.
    filters: { period: "90d", from: "", to: "", product: "", ...store.get("pulse-filters", {}), domain: "" },
    online: true,
    openDecisions: 0,
  };

  /* ------------------------------ Форматирование ------------------------------ */
  function fmt(v, unit) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (unit === "BYN") return nf0.format(v) + " BYN";
    if (unit === "%") return nf.format(v) + "%";
    return nf.format(v) + (unit ? " " + unit : "");
  }
  const fmtShort = (v, unit) => (unit === "BYN" ? Charts.compact(v) + " BYN" : fmt(v, unit));
  const STATUS_LABEL = { green: "в норме", yellow: "внимание", red: "критично", gray: "нет данных" };
  const fmtDT = (s) => {
    if (!s) return "—";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString("ru-RU", { timeZone: "Europe/Minsk", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " (UTC+3)";
  };
  const fmtD = (s) => (s ? new Date(s + "T00:00:00").toLocaleDateString("ru-RU") : "—");

  /* ---------------------------------- API ---------------------------------- */
  class ApiError extends Error {
    constructor(message, status, details) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }

  async function api(path, { method = "GET", body, timeout = 10000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: "Bearer " + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      setOnline(false);
      throw new ApiError(
        err.name === "AbortError" ? "Сервер не ответил за 10 секунд. Проверьте подключение и повторите попытку." : "Нет связи с сервером. Проверьте подключение к сети — введённые данные сохранены, можно повторить позже.",
        0
      );
    } finally {
      clearTimeout(timer);
    }
    setOnline(true);
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(`Сервер вернул некорректный ответ (код ${res.status})`, res.status);
    }
    if (res.status === 401 && path !== "/api/login") {
      logoutLocal("Сессия завершена. Войдите снова.");
      throw new ApiError(data.error || "Требуется вход", 401);
    }
    if (!res.ok) throw new ApiError(data.error || `Ошибка ${res.status}`, res.status, data.details);
    return data;
  }

  let pingTimer = null;
  function setOnline(v) {
    if (S.online === v) return;
    S.online = v;
    const c = $("#conn");
    if (c) {
      c.classList.toggle("off", !v);
      $("span", c).textContent = v ? "Онлайн" : "Нет связи с сервером";
    }
    if (!v && !pingTimer) {
      pingTimer = setInterval(async () => {
        try {
          const r = await fetch("/api/health", { cache: "no-store" });
          if (r.ok) {
            setOnline(true);
            clearInterval(pingTimer);
            pingTimer = null;
            toast("Связь с сервером восстановлена", "ok");
          }
        } catch {
          /* всё ещё офлайн */
        }
      }, 5000);
    }
  }

  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.remove(), kind === "error" ? 7000 : 4000);
  }

  const qs = (extra = {}) => {
    const f = { ...S.filters, ...extra };
    const p = new URLSearchParams();
    p.set("period", f.period);
    if (f.period === "custom") {
      p.set("from", f.from);
      p.set("to", f.to);
    }
    if (f.product) p.set("product", f.product);
    if (f.domain && extra.domain !== false) p.set("domain", f.domain);
    for (const [k, v] of Object.entries(extra)) if (!["period", "from", "to", "product", "domain"].includes(k) && v !== undefined && v !== null) p.set(k, v);
    return p.toString();
  };
  const can = (perm) => S.user?.permissions.includes(perm);
  const hasDomain = (d) => S.user?.domains.includes(d);

  /* ---------------------------------- Тема ---------------------------------- */
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    store.set("pulse-theme", t);
  }
  applyTheme(store.get("pulse-theme", window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

  /* ---------------------------------- Вход ---------------------------------- */
  const DEMO = [
    ["director", "director2026", "Директор — видит всё"],
    ["prod", "prod2026", "Руководитель производства"],
    ["sales", "sales2026", "Руководитель продаж"],
    ["analyst", "analyst2026", "Аналитик / администратор"],
  ];

  function renderLogin(message) {
    app.innerHTML = `
      <div class="login-wrap"><form class="login-card" id="loginForm" novalidate>
        <h1>Пульс компании</h1>
        <p class="sub">Единая система управления ООО «Фотопринт» · MVP хакатона</p>
        ${message ? `<div class="banner warn" role="alert">${esc(message)}</div>` : ""}
        <div class="banner error hidden" id="loginErr" role="alert"></div>
        <div class="field"><label for="lg">Логин</label><input id="lg" name="login" autocomplete="username" required></div>
        <div class="field"><label for="pw">Пароль</label><input id="pw" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-primary btn-block" type="submit" id="loginBtn">Войти</button>
        <div class="demo-accounts"><h2>Тестовые учётные записи</h2>
          ${DEMO.map(([l, p, t]) => `<button type="button" class="acc" data-l="${l}" data-p="${p}"><span>${t}</span><code>${l} / ${p}</code></button>`).join("")}
        </div>
      </form></div>`;
    $$(".acc").forEach((b) =>
      b.addEventListener("click", () => {
        $("#lg").value = b.dataset.l;
        $("#pw").value = b.dataset.p;
        $("#loginBtn").focus();
      })
    );
    $("#lg").focus();
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#loginErr");
      err.classList.add("hidden");
      const login = $("#lg").value.trim();
      const password = $("#pw").value;
      if (!login || !password) {
        err.textContent = "Введите логин и пароль";
        err.classList.remove("hidden");
        return;
      }
      $("#loginBtn").disabled = true;
      try {
        const r = await api("/api/login", { method: "POST", body: { login, password } });
        S.token = r.token;
        store.set("pulse-token", r.token);
        await boot();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove("hidden");
      } finally {
        const b = $("#loginBtn");
        if (b) b.disabled = false;
      }
    });
  }

  function logoutLocal(msg) {
    S.token = null;
    S.user = null;
    store.del("pulse-token");
    closeAllOverlays();
    renderLogin(msg);
  }

  async function logout() {
    try {
      await api("/api/logout", { method: "POST" });
    } catch {
      /* даже без сети выходим локально */
    }
    logoutLocal();
  }

  /* --------------------------------- Оболочка -------------------------------- */
  const ICONS = {
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    sales: '<path d="M6 8h12l1.1 11.2a1 1 0 0 1-1 1.1H5.9a1 1 0 0 1-1-1.1L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    production: '<rect x="3" y="10" width="18" height="10" rx="1.5"/><path d="M7 10V5h10v5M7 15h4"/>',
    finance: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
    forecast: '<path d="M4 20V4M4 20h16"/><path d="m7 15 4-4.5 3 2.5 5-7"/>',
    decisions: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    analyst: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    audit: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  };
  const PAGES = [
    { id: "pulse", title: "Пульс компании", show: () => can("kpi.view") },
    { id: "sales", title: "Продажи и клиенты", show: () => hasDomain("sales") },
    { id: "production", title: "Производство и качество", show: () => hasDomain("production") },
    { id: "finance", title: "Финансы и люди", show: () => hasDomain("finance") },
    { id: "forecast", title: "Прогноз спроса и мощности", show: () => can("forecast.view") && (hasDomain("production") || S.user.role !== "head") },
    { sep: true },
    { id: "decisions", title: "Реестр решений", show: () => can("decision.view") },
    { id: "analyst", title: "Кабинет аналитика", show: () => can("quality.view") },
    { id: "audit", title: "Журнал действий", show: () => can("audit.view") },
  ];

  function renderShell() {
    const u = S.user;
    const nav = PAGES.filter((p) => p.sep || p.show())
      .map((p) =>
        p.sep
          ? '<div class="nav-sep" role="separator"></div>'
          : `<a href="#/${p.id}" data-page="${p.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[p.id]}</svg><span>${p.title}</span>${p.id === "decisions" ? '<span class="badge pink hidden" id="decBadge"></span>' : ""}${p.id === "pulse" ? '<span class="badge hidden" id="critBadge"></span>' : ""}</a>`
      )
      .join("");
    app.innerHTML = `
      <a class="skip-link" href="#main" id="skipLink">Перейти к содержимому</a>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand">Пульс компании<small>ООО «Фотопринт» · MVP</small></div>
          <nav class="nav" aria-label="Разделы">${nav}</nav>
          <div class="side-bottom">
            <div class="side-user"><div class="avatar" aria-hidden="true">${esc(u.name[0])}</div><div><div class="n">${esc(u.name)}</div><div class="r">${esc(u.title)}</div></div></div>
            <div class="side-actions">
              <button type="button" id="themeBtn" aria-label="Переключить тему">${document.documentElement.dataset.theme === "dark" ? "☀ Светлая" : "☾ Тёмная"}</button>
              <button type="button" id="logoutBtn">Выйти</button>
            </div>
            <button type="button" class="kbd-help-btn" id="kbdBtn" aria-keyshortcuts="Shift+?">⌨ Горячие клавиши <kbd>?</kbd></button>
          </div>
        </aside>
        <main class="main" id="main" tabindex="-1"></main>
      </div>`;
    $("#skipLink").addEventListener("click", (e) => {
      e.preventDefault();
      $("#main").focus();
    });
    $("#kbdBtn").addEventListener("click", showShortcuts);
    $$(".nav a").forEach((a, i) => i < 9 && a.setAttribute("aria-keyshortcuts", `Alt+${i + 1}`));
    $("#themeBtn").addEventListener("click", (e) => {
      const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(t);
      e.currentTarget.textContent = t === "dark" ? "☀ Светлая" : "☾ Тёмная";
      route();
    });
    $("#logoutBtn").addEventListener("click", logout);
  }

  function topbar(title, { filters = true, chips = "" } = {}) {
    return `
      <div class="topbar">
        <h1>${esc(title)}</h1>${chips}
        <div class="conn ${S.online ? "" : "off"}" id="conn"><i class="dot"></i><span>${S.online ? "Онлайн" : "Нет связи с сервером"}</span></div>
      </div>
      ${filters ? filterBar() : ""}
      <div id="pageErr"></div>`;
  }

  function filterBar() {
    const f = S.filters;
    return `
      <form class="filters" id="filters" aria-label="Фильтры">
        <div class="f"><label for="fPeriod">Период</label>
          <select id="fPeriod">${[
            ["30d", "30 дней"],
            ["90d", "Квартал (90 дней)"],
            ["180d", "Полгода"],
            ["365d", "Год"],
            ["all", "Всё время"],
            ["custom", "Произвольный…"],
          ]
            .map(([v, l]) => `<option value="${v}" ${f.period === v ? "selected" : ""}>${l}</option>`)
            .join("")}</select></div>
        <div class="f ${f.period === "custom" ? "" : "hidden"}" id="fCustom1"><label for="fFrom">С</label><input type="date" id="fFrom" value="${esc(f.from)}"></div>
        <div class="f ${f.period === "custom" ? "" : "hidden"}" id="fCustom2"><label for="fTo">По</label><input type="date" id="fTo" value="${esc(f.to)}"></div>
        <div class="f"><label for="fProduct">Продукт</label><select id="fProduct"><option value="">Все продукты</option>${S.meta.product_types
          .map((p) => `<option value="${esc(p)}" ${f.product === p ? "selected" : ""}>${esc(p)}</option>`)
          .join("")}</select></div>
        <div class="period-info" id="periodInfo"></div>
      </form>`;
  }

  function bindFilters(reload) {
    const form = $("#filters");
    if (!form) return;
    const apply = () => {
      const period = $("#fPeriod").value;
      $("#fCustom1").classList.toggle("hidden", period !== "custom");
      $("#fCustom2").classList.toggle("hidden", period !== "custom");
      const next = { period, from: $("#fFrom").value, to: $("#fTo").value, product: $("#fProduct").value, domain: "" };
      if (period === "custom") {
        if (!next.from || !next.to) {
          if (!next.from) next.from = S.meta.today.slice(0, 8) + "01";
          if (!next.to) next.to = S.meta.today;
          $("#fFrom").value = next.from;
          $("#fTo").value = next.to;
        }
        if (next.from > next.to) {
          toast("Дата начала периода позже даты окончания", "error");
          return;
        }
      }
      S.filters = next;
      store.set("pulse-filters", next);
      reload();
    };
    $$("select, input", form).forEach((x) => x.addEventListener("change", apply));
    form.addEventListener("submit", (e) => e.preventDefault());
  }

  function setPeriodInfo(f) {
    if (f) S.range = f;
    const el = $("#periodInfo");
    if (el && f) el.textContent = `Период: ${fmtD(f.from)} — ${fmtD(f.to)}${f.product ? " · " + f.product : ""}`;
  }

  function showPageError(err, retry) {
    const box = $("#pageErr");
    if (!box) return toast(err.message, "error");
    box.innerHTML = `<div class="banner error" role="alert"><span style="flex:1">${esc(err.message)}</span>${retry ? '<button class="btn btn-sm" type="button" id="retryBtn">Повторить</button>' : ""}</div>`;
    if (retry) $("#retryBtn").addEventListener("click", retry);
  }

  /* ------------------------------ Вкладки ------------------------------ */
  function tabBlock(tabs) {
    return `
      <div class="tabblock">
        <div class="tabs" role="tablist">${tabs.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" class="${i === 0 ? "active" : ""}" data-tab="${i}">${esc(t.label)}</button>`).join("")}</div>
        ${tabs.map((t, i) => `<div class="tabpanel${i === 0 ? " active" : ""}" data-tab="${i}">${t.html}</div>`).join("")}
      </div>`;
  }
  function bindTabs(el) {
    $$(".tabblock", el).forEach((block) => {
      const tabs = $$(".tabs button[data-tab]", block);
      const panels = $$(".tabpanel", block);
      tabs.forEach((b) => {
        b.addEventListener("click", () => {
          tabs.forEach((x) => {
            x.classList.toggle("active", x === b);
            x.setAttribute("aria-selected", x === b);
          });
          panels.forEach((p) => p.classList.toggle("active", p.dataset.tab === b.dataset.tab));
        });
      });
    });
  }

  /* --------------------------------- Роутер --------------------------------- */
  function route() {
    if (!S.user) return;
    const id = (location.hash.replace(/^#\//, "") || "pulse").split("?")[0];
    const page = PAGES.find((p) => p.id === id && !p.sep);
    $$(".nav a").forEach((a) => {
      a.classList.toggle("active", a.dataset.page === id);
      if (a.dataset.page === id) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    const main = $("#main");
    if (!page || !page.show()) {
      main.innerHTML = topbar("Раздел недоступен", { filters: false }) + `<div class="card"><p>Этот раздел закрыт для вашей роли (${esc(S.user.role_label)}). Права проверяются на сервере.</p><a class="btn" href="#/pulse">На главную</a></div>`;
      return;
    }
    closeAllOverlays();
    RENDER[id](main);
    document.title = `${page.title} — Пульс компании`;
  }
  window.addEventListener("hashchange", () => {
    route();
    // После перехода фокус — в начало содержимого, чтобы Tab шёл по новой странице, а не по меню.
    $("#main")?.focus({ preventScroll: true });
  });

  /* --------------------------- Навигация с клавиатуры --------------------------- */
  const SHORTCUTS = [
    ["Alt + 1…9", "Перейти в раздел меню по порядку"],
    ["/", "Фокус на первый фильтр или поиск страницы"],
    ["N", "Новое управленческое решение (если доступно роли)"],
    ["Tab / Shift + Tab", "Переход между элементами"],
    ["Enter / Пробел", "Открыть KPI, строку таблицы, нажать кнопку"],
    ["← / →", "Переключение вкладок детализации"],
    ["Esc", "Закрыть окно, панель или подсказку"],
    ["?", "Эта справка"],
  ];
  function showShortcuts() {
    if ($(".kbd-help")) return;
    const ov = overlay("modal", "Горячие клавиши");
    ov.body.innerHTML = `<table class="kbd-help"><tbody>${SHORTCUTS.map(([k, d]) => `<tr><td>${k
      .split(" / ")
      .map((x) => x.split(" + ").map((y) => `<kbd>${esc(y)}</kbd>`).join(" + "))
      .join(" / ")}</td><td>${esc(d)}</td></tr>`).join("")}</tbody></table>
      <p class="hint">Клавиши-буквы не срабатывают, пока курсор находится в поле ввода.</p>`;
  }
  const isTyping = (el) => el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
  document.addEventListener("keydown", (e) => {
    if (!S.user || e.ctrlKey || e.metaKey) return;
    if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
      const link = $$(".nav a")[Number(e.code.slice(5)) - 1];
      if (link) {
        e.preventDefault();
        location.hash = link.getAttribute("href");
      }
      return;
    }
    if (e.altKey || isTyping(e.target)) return;
    if (e.key === "?") {
      e.preventDefault();
      showShortcuts();
    } else if (e.key === "/" && !overlays.length) {
      const f = $("#main .filters select, #main .filters input");
      if (f) {
        e.preventDefault();
        f.focus();
      }
    } else if ((e.key === "n" || e.key === "т" || e.key === "N" || e.key === "Т") && !overlays.length && can("decision.create")) {
      e.preventDefault();
      openDecisionForm({ domain: S.user.domains[0] });
    }
  });

  /* ------------------------------ Пульс компании ----------------------------- */
  async function renderPulse(main) {
    const hello = `Здравствуйте, ${S.user.name.split(" ")[0]}!`;
    main.innerHTML =
      topbar(hello, { chips: `<span class="chip">${esc(S.user.role_label)}</span>` }) +
      `<div id="hiddenInfo"></div>
       <div class="card" id="critCard" style="margin-bottom:16px"><h2>Критические отклонения <span class="hint" id="critHint"></span></h2><div class="critical-list" id="critList"><div class="skeleton" style="min-height:34px;width:100%"></div></div></div>
       <div class="kpi-grid" id="kpiGrid">${'<div class="skeleton"></div>'.repeat(8)}</div>
       <div class="grid grid-32" style="margin-top:16px">
         <div class="card hidden" id="fcCard"><h2>Спрос и мощность на 8 недель <span class="spacer"></span><a class="btn btn-sm" href="#/forecast">Подробнее</a></h2><div id="fcChart"></div><div id="fcNote" class="hint"></div></div>
         <div class="card" id="decCard"><h2>Последние решения <span class="spacer"></span><a class="btn btn-sm" href="#/decisions">Реестр</a></h2><div id="decList"></div></div>
       </div>`;
    bindFilters(() => renderPulse(main));
    loadDecisionsMini();
    if (can("forecast.view") && (hasDomain("production") || S.user.role !== "head")) loadForecastMini();
    let data;
    try {
      data = await api("/api/kpi?" + qs());
    } catch (err) {
      $("#kpiGrid").innerHTML = "";
      $("#critList").innerHTML = '<span class="hint">Данные недоступны</span>';
      return showPageError(err, () => renderPulse(main));
    }
    setPeriodInfo(data.filters);
    if (data.hidden_domains.length) {
      $("#hiddenInfo").innerHTML = `<div class="banner info">🔒 Показатели подразделений «${data.hidden_domains.map(esc).join("», «")}» скрыты для вашей роли.</div>`;
    }
    const crit = data.critical;
    const cb = $("#critBadge");
    if (cb) {
      cb.textContent = crit.length;
      cb.classList.toggle("hidden", !crit.length);
    }
    $("#critHint").textContent = crit.length ? `${crit.length} из ${data.kpis.length} KPI в красной зоне — нажмите, чтобы найти причину` : "";
    $("#critList").innerHTML = crit.length
      ? crit.map((c) => `<button type="button" data-kpi="${c.id}">⚠ ${esc(c.title)}: ${fmt(c.value, c.unit)} (план ${fmt(c.plan, c.unit)})</button>`).join("")
      : '<span class="chip green">Все показатели в норме</span>';
    $$("#critList button").forEach((b) => b.addEventListener("click", () => openDrill(data.kpis.find((k) => k.id === b.dataset.kpi))));

    const grid = $("#kpiGrid");
    grid.innerHTML = "";
    for (const k of data.kpis) grid.appendChild(kpiCard(k));
  }

  function kpiCard(k) {
    const el = document.createElement("div");
    el.className = `kpi s-${k.status}`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${k.title}: ${fmt(k.value, k.unit)}, план ${fmt(k.plan, k.unit)}, ${STATUS_LABEL[k.status]}. Открыть детализацию`);
    const dev = k.deviation_pct;
    const good = dev === null ? null : k.better === "up" ? dev >= 0 : dev <= 0;
    el.innerHTML = `
      <div class="kpi-head"><span class="kpi-title">${esc(k.title)}</span><span class="pill ${k.status}">${STATUS_LABEL[k.status]}</span><button type="button" class="icon-btn info-btn" aria-label="Как считается показатель «${esc(k.title)}»">i</button></div>
      <div class="kpi-domain">${esc(k.domain_label)}</div>
      <div class="kpi-value">${fmt(k.value, k.unit)}</div>
      <div class="kpi-meta"><span>План: <b>${fmtShort(k.plan, k.unit)}</b></span><span>${dev === null ? "" : `<span style="color:${good ? "var(--green)" : "var(--red)"}">${dev > 0 ? "+" : ""}${nf.format(dev)}%</span>`}</span></div>
      <div class="kpi-meta"><span>Прогноз: <b>${fmtShort(k.forecast, k.unit)}</b></span></div>`;
    // График динамики не показывается в карточке при первом просмотре — он открывается в детализации.
    $(".info-btn", el).addEventListener("click", (e) => {
      e.stopPropagation();
      showInfo(k, e.currentTarget);
    });
    el.addEventListener("click", () => openDrill(k));
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDrill(k);
      }
    });
    return el;
  }

  function showInfo(k, anchor) {
    $$(".popover").forEach((p) => p.remove());
    const pop = document.createElement("div");
    pop.className = "popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Описание показателя");
    pop.innerHTML = `
      <h3>${esc(k.title)}</h3>
      <p><b>Формула</b></p><code>${esc(k.formula)}</code>
      <p><b>Источники:</b> ${k.sources.map(esc).join("; ")}</p>
      <p><b>Файл источника обновлён:</b> ${fmtDT(k.updated_at)}</p>
      <p><b>Данные по дату:</b> ${fmtD(k.data_until)}</p>
      <p><b>Загружено в систему:</b> ${fmtDT(k.loaded_at)}</p>
      <p><b>Статус:</b> зелёный ≥ 98% плана, жёлтый ≥ 90%, красный &lt; 90% (для «чем меньше — тем лучше» — обратное отношение). Прогноз — линейный тренд по ${k.series.length} точкам периода.</p>
      <button class="btn btn-sm" type="button">Закрыть</button>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.scrollX + r.left - 10, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 16);
    pop.style.left = Math.max(16, left) + "px";
    pop.style.top = window.scrollY + r.bottom + 8 + "px";
    const close = () => {
      pop.remove();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDoc, true);
      anchor.focus();
    };
    const onKey = (e) => e.key === "Escape" && close();
    const onDoc = (e) => !pop.contains(e.target) && e.target !== anchor && close();
    $("button", pop).addEventListener("click", close);
    $("button", pop).focus();
    document.addEventListener("keydown", onKey);
    setTimeout(() => document.addEventListener("click", onDoc, true));
  }

  async function loadDecisionsMini() {
    const box = $("#decList");
    try {
      const r = await api("/api/decisions");
      S.openDecisions = r.decisions.filter((d) => !["выполнено", "отменено"].includes(d.status)).length;
      updateDecBadge();
      if (!box) return;
      box.innerHTML = r.decisions.length
        ? `<div class="table-wrap"><table><tbody>${r.decisions
            .slice(0, 6)
            .map((d) => `<tr class="clickable" tabindex="0" data-id="${d.id}"><td><b>${esc(d.number)}</b><br><span class="hint">${esc(d.owner)}</span></td><td>${esc(d.title)}</td><td><span class="pill ${statusColor(d.status)}">${esc(d.status)}</span>${d.overdue ? '<br><span class="pill red">просрочено</span>' : ""}</td></tr>`)
            .join("")}</tbody></table></div>`
        : '<div class="empty">Решений пока нет. Откройте красный KPI и нажмите «Создать решение».</div>';
      $$("tr[data-id]", box).forEach((tr) => {
        const open = () => openDecisionCard(r.decisions.find((d) => d.id === Number(tr.dataset.id)));
        tr.addEventListener("click", open);
        tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
      });
    } catch (err) {
      if (box) box.innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  }
  function updateDecBadge() {
    const b = $("#decBadge");
    if (b) {
      b.textContent = S.openDecisions;
      b.classList.toggle("hidden", !S.openDecisions);
    }
  }
  const statusColor = (s) => ({ новое: "purple", "в работе": "yellow", выполнено: "green", отменено: "gray" })[s] || "gray";

  async function loadForecastMini() {
    const card = $("#fcCard");
    if (!card) return;
    card.classList.remove("hidden");
    try {
      const f = await api("/api/forecast");
      drawForecast($("#fcChart"), f, 200);
      $("#fcNote").innerHTML = f.first_deficit_week
        ? `<span class="pill red">Дефицит мощности с недели ${fmtD(f.first_deficit_week)}</span> · недель с дефицитом: ${f.weeks.filter((w) => w.deficit).length} из ${f.weeks.length}`
        : '<span class="pill green">Дефицита мощности не ожидается</span>';
    } catch (err) {
      $("#fcChart").innerHTML = `<div class="banner error">${esc(err.message)}</div>`;
    }
  }
  function drawForecast(el, f, height = 260) {
    Charts.chart(el, {
      labels: f.weeks.map((w) => fmtD(w.week).slice(0, 5)),
      height,
      highlight: f.weeks.map((w, i) => (w.deficit ? i : -1)).filter((i) => i >= 0),
      series: [
        { name: "Спрос (прогноз), ед.", values: f.weeks.map((w) => w.demand), color: Charts.COLORS.pink, type: "bar", colorAt: (i) => (f.weeks[i].deficit ? Charts.COLORS.red : Charts.COLORS.pink) },
        { name: "Доступная мощность, ед.", values: f.weeks.map((w) => w.capacity), color: Charts.COLORS.purple, type: "dash" },
      ],
    });
  }

  /* --------------------------- Drill-down (детализация) --------------------------- */
  let drillState = null;

  function openDrill(k) {
    drillState = { kpi: k, dim: k.drill_dims[0]?.id, key: null };
    const ov = overlay("drawer", `Детализация: ${k.title}`);
    renderDrill(ov.body);
  }

  async function renderDrill(body) {
    const { kpi: k, dim, key } = drillState;
    body.innerHTML = `
      <div class="crumbs" aria-label="Путь детализации">
        <button type="button" data-lvl="0">${esc(k.title)}</button>${key !== null ? ` › <button type="button" data-lvl="1">${esc(k.drill_dims.find((d) => d.id === dim)?.label || "")}</button> › <span>${esc(key)}</span>` : dim ? ` › <span>${esc(k.drill_dims.find((d) => d.id === dim)?.label || "")}</span>` : ""}
      </div>
      <div class="stat-row">
        <div class="stat"><div class="l">Факт</div><div class="v">${fmt(k.value, k.unit)}</div></div>
        <div class="stat"><div class="l">План</div><div class="v">${fmt(k.plan, k.unit)}</div></div>
        <div class="stat"><div class="l">Прогноз</div><div class="v">${fmt(k.forecast, k.unit)}</div></div>
        <div class="stat"><div class="l">Статус</div><div class="v"><span class="pill ${k.status}">${STATUS_LABEL[k.status]}</span></div></div>
      </div>
      <div class="card" style="margin-bottom:14px"><h2>Динамика <span class="hint">${k.series[0]?.label.length === 7 ? "по месяцам" : "по неделям"}</span></h2><div id="drillChart"></div></div>
      <div id="drillBody"><div class="skeleton"></div></div>`;
    $$(".crumbs button", body).forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.lvl === "0") drillState.key = null;
        if (b.dataset.lvl === "1") drillState.key = null;
        renderDrill(body);
      })
    );
    const series = [{ name: "Факт", values: k.series.map((s) => s.value), color: Charts.COLORS.purple, type: k.additive ? "bar" : "area" }];
    if (k.series.some((s) => s.plan !== null)) series.push({ name: "План", values: k.series.map((s) => s.plan), color: Charts.COLORS.gray, type: "dash" });
    Charts.chart($("#drillChart"), { labels: k.series.map((s) => s.label), series, height: 200, format: (v) => (k.unit === "BYN" ? Charts.compact(v) : nf.format(v)) });

    const box = $("#drillBody", body);
    try {
      if (key === null) {
        const d = await api(`/api/kpi/${k.id}/drill?` + qs({ dim, domain: false }));
        const max = Math.max(...d.rows.map((r) => Math.abs(r.value || 0)), 1);
        box.innerHTML = `
          <div class="tabs" role="tablist">${d.dims.map((x) => `<button type="button" role="tab" aria-selected="${x.id === d.dim}" class="${x.id === d.dim ? "active" : ""}" data-dim="${x.id}">${esc(x.label)}</button>`).join("")}</div>
          ${d.explanation ? `<div class="callout ${d.rows.some((r) => r.status === "red") ? "" : "neutral"}">🔎 ${esc(d.explanation)}</div>` : ""}
          <div class="card"><h2>${esc(d.dim_label)} <span class="hint">нажмите на строку, чтобы увидеть записи</span><span class="spacer"></span>${canCreateFor(k) ? '<button type="button" class="btn btn-primary btn-sm" id="mkDecision">＋ Создать решение</button>' : ""}<button type="button" class="btn btn-sm" id="allRecs">Все записи</button></h2>
          <div class="bars">${d.rows
            .map(
              (r) => `<button type="button" class="bar-row" data-key="${esc(r.key)}"><span class="lbl" title="${esc(r.key)}">${esc(r.key)}</span><span class="bar-track"><span class="bar-fill ${r.status === "gray" ? "" : r.status}" style="width:${Math.max(2, (Math.abs(r.value || 0) / max) * 100)}%"></span></span><span class="val">${fmt(r.value, k.unit)}${r.share_pct !== null ? ` · ${nf.format(r.share_pct)}%` : ""} <span class="hint">(${r.count})</span></span></button>`
            )
            .join("") || '<div class="empty">Нет данных за выбранный период</div>'}</div></div>`;
        const tabs = $$(".tabs button", box);
        tabs.forEach((b, i) => {
          b.tabIndex = b.classList.contains("active") ? 0 : -1;
          b.addEventListener("click", () => {
            drillState.dim = b.dataset.dim;
            drillState.focusTab = true;
            renderDrill(body);
          });
          b.addEventListener("keydown", (e) => {
            const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            tabs[(i + step + tabs.length) % tabs.length].click();
          });
        });
        if (drillState.focusTab) {
          drillState.focusTab = false;
          $(".tabs button.active", box)?.focus();
        }
        $$(".bar-row", box).forEach((b) =>
          b.addEventListener("click", () => {
            drillState.key = b.dataset.key;
            renderDrill(body);
          })
        );
        $("#allRecs", box).addEventListener("click", () => {
          drillState.key = "";
          renderDrill(body);
        });
        $("#mkDecision", box)?.addEventListener("click", () => {
          const worst = d.rows.find((r) => r.status === "red") || d.rows[0];
          openDecisionForm({
            title: `${k.title}: устранить отклонение${worst ? " — " + worst.key : ""}`,
            kpi_id: k.id,
            domain: k.domain,
            problem: `${k.title} = ${fmt(k.value, k.unit)} при плане ${fmt(k.plan, k.unit)} (${k.deviation_pct > 0 ? "+" : ""}${k.deviation_pct === null ? "—" : nf.format(k.deviation_pct)}%) за период ${S.range ? fmtD(S.range.from) + " — " + fmtD(S.range.to) : ""}.`,
            cause: d.explanation || "",
            context: { kpi: k.id, dim: d.dim, key: worst?.key || null, filters: { ...S.filters } },
          });
        });
      } else {
        const r = await api(`/api/kpi/${k.id}/records?` + qs({ dim, key, domain: false }));
        box.innerHTML = `
          <div class="card"><h2>${key ? `Записи: ${esc(r.dim_label)} = «${esc(key)}»` : "Все записи показателя"} <span class="hint">${r.total} шт.${r.total > r.rows.length ? `, показаны первые ${r.rows.length}` : ""}</span><span class="spacer"></span>${canCreateFor(k) ? '<button type="button" class="btn btn-primary btn-sm" id="mkDecision2">＋ Создать решение</button>' : ""}</h2>
          ${recordsTable(r)}</div>`;
        bindOrderLinks(box);
        $("#mkDecision2", box)?.addEventListener("click", () =>
          openDecisionForm({
            title: `${k.title}: разобрать «${key || "все записи"}»`,
            kpi_id: k.id,
            domain: k.domain,
            problem: `${k.title} = ${fmt(k.value, k.unit)} при плане ${fmt(k.plan, k.unit)}. Проблемная группа: ${r.dim_label || ""} «${key}» (${r.total} записей).`,
            context: { kpi: k.id, dim, key, filters: { ...S.filters } },
          })
        );
      }
    } catch (err) {
      box.innerHTML = `<div class="banner error" role="alert">${esc(err.message)}</div>`;
    }
  }
  const canCreateFor = (k) => can("decision.create") && hasDomain(k.domain);

  function recordsTable(r) {
    if (!r.rows.length) return '<div class="empty">Нет записей</div>';
    const numeric = (v) => typeof v === "number";
    return `<div class="table-wrap"><table><thead><tr>${r.columns.map((c) => `<th class="${numeric(r.rows[0][c.id]) ? "num" : ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${r.rows
      .map(
        (row) =>
          `<tr>${r.columns
            .map((c) => {
              const v = row[c.id];
              const oid = row[c.id + "__order_id"];
              if (oid) return `<td><button type="button" class="link order-link" data-order="${oid}">${esc(v)}</button></td>`;
              return `<td class="${numeric(v) ? "num" : ""}">${numeric(v) ? nf.format(v) : esc(v)}</td>`;
            })
            .join("")}</tr>`
      )
      .join("")}</tbody></table></div>`;
  }

  function bindOrderLinks(root) {
    $$(".order-link", root).forEach((b) => b.addEventListener("click", () => openOrder(Number(b.dataset.order))));
  }

  async function openOrder(id) {
    const ov = overlay("modal", `Заказ #${id}: сквозная карточка`);
    ov.body.innerHTML = '<div class="skeleton"></div>';
    try {
      const c = await api(`/api/orders/${id}`);
      const o = c.order;
      ov.setTitle(`Заказ ${o.order_number}`);
      const crm = `
        <div class="callout neutral">Связь систем по общим ID: ${c.links.map(esc).join(" · ")}</div>
        <h3 class="section-title">Заказ и клиент</h3>
        <dl class="kv">
          <dt>Дата заказа</dt><dd>${fmtD(o.order_date)}</dd><dt>Статус</dt><dd>${esc(o.status)}</dd>
          <dt>Продукт / тираж</dt><dd>${esc(o.product_type)} · ${nf0.format(o.print_run)} шт.</dd><dt>Сумма</dt><dd>${fmt(o.amount, "BYN")}</dd>
          <dt>Приоритет</dt><dd>${esc(o.priority)}</dd>
          <dt>Клиент</dt><dd>${c.client ? `ID ${c.client.id} · ${esc(c.client.segment)} · ${esc(c.client.city)} · клиент с ${fmtD(c.client.created_at)}` : '<span class="pill red">клиент не найден в CRM</span>'}</dd>
        </dl>
        <h3 class="section-title">Обращения клиента по заказу (${c.requests.length})</h3>
        ${c.requests.length ? `<ul class="history">${c.requests.map((r) => `<li><b>${esc(r.type)}</b> · ${esc(r.status)} — ${esc(r.description)} <span class="at">· ${fmtD(r.created_at)}</span></li>`).join("")}</ul>` : '<div class="hint">Обращений нет</div>'}`;
      const prod = `
        <h3 class="section-title">Производство (${c.production.length})</h3>
        ${
          c.production.length
            ? `<div class="table-wrap"><table><thead><tr><th>Произв. заказ</th><th>Статус</th><th>Станок</th><th class="num">План</th><th class="num">Факт</th><th class="num">Брак</th><th>Смена / оператор (HR)</th></tr></thead><tbody>${c.production
                .map((p) =>
                  p.hidden
                    ? `<tr><td>${esc(p.production_order_number)}</td><td>${esc(p.status)}</td><td colspan="5" class="hint">🔒 детали производства скрыты для вашей роли</td></tr>`
                    : `<tr><td>${esc(p.production_order_number)}</td><td>${esc(p.status)}</td><td>${esc(p.machine?.name || "—")} <span class="hint">${esc(p.machine?.status || "")}</span></td><td class="num">${nf0.format(p.planned_qty)}</td><td class="num">${nf0.format(p.produced_qty)}</td><td class="num">${nf0.format(p.defect_qty)}</td><td>${p.shift ? `${fmtD(p.shift.date)}, смена ${p.shift.number} · таб. № ${p.shift.operator_id} (${esc(p.shift.operator_position || "—")}, ${esc(p.shift.operator_department || "—")})` : "—"}</td></tr>`
                )
                .join("")}</tbody></table></div>`
            : '<div class="hint">Производственных заказов нет</div>'
        }`;
      const defects = `
        <h3 class="section-title">Дефекты (${c.defects.length})</h3>
        ${c.defects.length ? `<ul class="history">${c.defects.map((d) => `<li><b>${esc(d.type)}</b> — ${nf0.format(d.qty)} шт., причина: ${esc(d.reason)} <span class="at">· ${fmtDT(d.detected_at + "+03:00")}</span></li>`).join("")}</ul>` : '<div class="hint">Дефектов нет</div>'}`;
      const payments = `
        <h3 class="section-title">Поступления (${c.payments.length})</h3>
        ${c.payments.length ? `<ul class="history">${c.payments.map((p) => `<li>${fmtD(p.date)} — ${p.hidden ? "🔒 сумма скрыта для вашей роли" : `${fmt(p.amount, "BYN")} · ${esc(p.source)}`}</li>`).join("")}</ul>` : '<div class="hint">Поступлений нет</div>'}`;
      ov.body.innerHTML = tabBlock([
        { label: "Заказ и клиент (CRM)", html: crm },
        { label: "Производство (ERP)", html: prod },
        { label: "Дефекты (ERP)", html: defects },
        { label: "Финансы", html: payments },
      ]);
      bindTabs(ov.body);
    } catch (err) {
      ov.body.innerHTML = `<div class="banner error" role="alert">${esc(err.message)}</div>`;
    }
  }

  /* ------------------------------ Оверлеи / модалки ------------------------------ */
  const overlays = [];
  function overlay(kind, title) {
    const prevFocus = document.activeElement;
    const ov = document.createElement("div");
    ov.className = "overlay" + (kind === "modal" ? " center" : "");
    ov.innerHTML = `<div class="${kind}" role="dialog" aria-modal="true" aria-labelledby="ovt${overlays.length}"><div class="${kind}-head"><h2 id="ovt${overlays.length}"></h2><button type="button" class="close" aria-label="Закрыть">×</button></div><div class="ov-body"></div></div>`;
    $("h2", ov).textContent = title;
    document.body.appendChild(ov);
    const api_ = {
      el: ov,
      body: $(".ov-body", ov),
      setTitle: (t) => ($("h2", ov).textContent = t),
      close: (force) => {
        if (!force && api_.beforeClose && api_.beforeClose() === false) return;
        ov.remove();
        const i = overlays.indexOf(api_);
        if (i >= 0) overlays.splice(i, 1);
        prevFocus?.focus?.();
      },
    };
    $(".close", ov).addEventListener("click", () => api_.close());
    ov.addEventListener("mousedown", (e) => e.target === ov && api_.close());
    overlays.push(api_);
    setTimeout(() => $(".close", ov).focus());
    return api_;
  }
  function openMachinesPopup(data) {
    const ov = overlay("modal", "Станки: загрузка, простои, брак");
    ov.body.innerHTML = `
      <h3 class="section-title" style="margin-top:0">Загрузка и выпуск</h3>
      <div class="table-wrap"><table><thead><tr><th>Станок</th><th>Тип</th><th>Цех</th><th>Статус</th><th class="num">Заказы</th><th class="num">Выпуск</th><th class="num">Загрузка</th></tr></thead><tbody>${data.machines.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.type)}</td><td>${esc(m.location)}</td><td><span class="pill ${m.status === "активен" ? "green" : m.downtime ? "yellow" : "gray"}">${esc(m.status)}</span></td><td class="num">${m.orders}</td><td class="num">${nf0.format(m.produced)}</td><td class="num">${m.load_pct === null ? "—" : nf.format(m.load_pct) + "%"}</td></tr>`).join("")}</tbody></table></div>
      <h3 class="section-title">Брак и простои</h3>
      <div class="table-wrap"><table><thead><tr><th>Станок</th><th>Тип</th><th>Цех</th><th>Статус</th><th class="num">Брак</th><th class="num">Остановлено</th></tr></thead><tbody>${data.machines.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.type)}</td><td>${esc(m.location)}</td><td><span class="pill ${m.status === "активен" ? "green" : m.downtime ? "yellow" : "gray"}">${esc(m.status)}</span></td><td class="num"><span class="pill ${m.defect_pct === null ? "gray" : m.defect_pct > 3 ? "red" : "green"}">${m.defect_pct === null ? "—" : nf.format(m.defect_pct) + "%"}</span></td><td class="num">${m.stopped_orders}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function closeAllOverlays() {
    while (overlays.length) overlays[overlays.length - 1].close(true);
    $$(".popover").forEach((p) => p.remove());
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlays.length && !$(".popover")) overlays[overlays.length - 1].close();
  });

  /* ------------------------------ Решения ------------------------------ */
  const DRAFT_KEY = "pulse-decision-draft";

  function openDecisionForm(prefill = {}, existing = null) {
    const draft = !existing ? store.get(DRAFT_KEY) : null;
    let v = existing ? { ...existing } : { priority: "высокий", status: "новое", due_date: addDays(14), ...prefill };
    let restored = false;
    if (draft && !existing && draft.kpi_id === (prefill.kpi_id || draft.kpi_id) && Object.keys(prefill).length === 0) {
      v = { ...v, ...draft };
      restored = true;
    }
    const ov = overlay("modal", existing ? `Изменить решение ${existing.number}` : "Новое управленческое решение");
    const domains = S.user.domains.filter((d) => can("decision.create"));
    ov.body.innerHTML = `
      ${restored ? '<div class="banner warn">Восстановлен несохранённый черновик.</div>' : ""}
      <div class="banner error hidden" id="formErr" role="alert"></div>
      <form id="decForm" novalidate>
        <div class="form-grid">
          ${fieldHtml("title", "Название *", "input", v.title, "full")}
          ${fieldHtml("problem", "В чём проблема *", "textarea", v.problem, "full")}
          ${fieldHtml("impact", "На что влияет", "textarea", v.impact, "full")}
          ${fieldHtml("cause", "Причина *", "textarea", v.cause, "full")}
          ${fieldHtml("action", "Что сделать (действие) *", "textarea", v.action, "full")}
          ${fieldHtml("owner", "Ответственный *", "input", v.owner)}
          ${fieldHtml("due_date", "Срок *", "date", v.due_date)}
          <div class="field" data-f="priority"><label for="d_priority">Приоритет *</label><select id="d_priority" name="priority">${["низкий", "средний", "высокий", "критический"].map((p) => `<option ${v.priority === p ? "selected" : ""}>${p}</option>`).join("")}</select><div class="err"></div></div>
          <div class="field" data-f="status"><label for="d_status">Статус</label><select id="d_status" name="status">${["новое", "в работе", "выполнено", "отменено"].map((p) => `<option ${v.status === p ? "selected" : ""}>${p}</option>`).join("")}</select><div class="err"></div></div>
          <div class="field" data-f="domain"><label for="d_domain">Подразделение *</label><select id="d_domain" name="domain">${domains.map((d) => `<option value="${d}" ${v.domain === d ? "selected" : ""}>${esc(S.meta.domains[d])}</option>`).join("")}</select><div class="err"></div></div>
          ${v.context ? `<div class="field"><label>Контекст</label><div class="hint">KPI: ${esc(v.context.kpi || v.kpi_id || "—")}${v.context.key ? ` · ${esc(v.context.dim)} = «${esc(v.context.key)}»` : ""}</div></div>` : ""}
        </div>
        <div class="form-actions">
          <button type="button" class="btn" id="cancelDec">Отмена</button>
          <button type="submit" class="btn btn-primary" id="saveDec">${existing ? "Сохранить изменения" : "Создать решение"}</button>
        </div>
      </form>`;
    const form = $("#decForm", ov.body);
    let dirty = restored;
    const collect = () => {
      const o = { kpi_id: v.kpi_id || null, context: v.context || undefined };
      $$("[name]", form).forEach((x) => (o[x.name] = x.value));
      return o;
    };
    form.addEventListener("input", () => {
      dirty = true;
      if (!existing) store.set(DRAFT_KEY, collect());
    });
    ov.beforeClose = () => !dirty || confirmInline(ov);
    $("#cancelDec", ov.body).addEventListener("click", () => ov.close());
    $("[name=title]", form).focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      $$(".field", form).forEach((f) => {
        f.classList.remove("invalid");
        $(".err", f).textContent = "";
      });
      $("#formErr", ov.body).classList.add("hidden");
      const body = collect();
      // Клиентская проверка (дублирует серверную, сервер — источник истины)
      const errs = {};
      for (const [f, l] of [["title", "Название"], ["problem", "Проблема"], ["cause", "Причина"], ["action", "Действие"], ["owner", "Ответственный"], ["due_date", "Срок"]]) if (!body[f]?.trim()) errs[f] = `Поле «${l}» обязательно`;
      if (Object.keys(errs).length) return showFieldErrors(form, ov, errs);
      const btn = $("#saveDec", ov.body);
      btn.disabled = true;
      btn.textContent = "Сохранение…";
      try {
        const saved = existing ? await api(`/api/decisions/${existing.id}`, { method: "PATCH", body }) : await api("/api/decisions", { method: "POST", body });
        if (!existing) store.del(DRAFT_KEY);
        dirty = false;
        ov.close(true);
        toast(existing ? `Решение ${saved.number} обновлено` : `Решение ${saved.number} создано и сохранено в реестре`, "ok");
        if (location.hash.startsWith("#/decisions")) route();
        else loadDecisionsMini();
      } catch (err) {
        if (err.details) showFieldErrors(form, ov, err.details);
        const box = $("#formErr", ov.body);
        box.textContent = err.message + (err.status === 0 ? "" : "");
        box.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = existing ? "Сохранить изменения" : "Создать решение";
      }
    });
  }

  function confirmInline(ov) {
    if ($(".confirm-bar", ov.el)) return false;
    const bar = document.createElement("div");
    bar.className = "banner warn confirm-bar";
    bar.innerHTML = '<span style="flex:1">Есть несохранённые изменения. Закрыть форму? Черновик останется в браузере.</span><button type="button" class="btn btn-sm" data-a="stay">Остаться</button><button type="button" class="btn btn-sm btn-danger" data-a="close">Закрыть</button>';
    ov.body.prepend(bar);
    $("[data-a=stay]", bar).addEventListener("click", () => bar.remove());
    $("[data-a=close]", bar).addEventListener("click", () => ov.close(true));
    $("[data-a=stay]", bar).focus();
    return false;
  }

  function showFieldErrors(form, ov, errs) {
    let first = null;
    for (const [f, msg] of Object.entries(errs)) {
      const box = $(`.field[data-f="${f}"]`, form);
      if (box) {
        box.classList.add("invalid");
        $(".err", box).textContent = msg;
        first = first || $("[name]", box);
      }
    }
    first?.focus();
  }

  function fieldHtml(name, label, type, value, cls = "") {
    const id = "d_" + name;
    const input = type === "textarea" ? `<textarea id="${id}" name="${name}" rows="2">${esc(value)}</textarea>` : `<input id="${id}" name="${name}" type="${type === "date" ? "date" : "text"}" value="${esc(value)}">`;
    return `<div class="field ${cls}" data-f="${name}"><label for="${id}">${label}</label>${input}<div class="err"></div></div>`;
  }
  function addDays(n) {
    const d = new Date(Date.now() + n * 864e5);
    return d.toISOString().slice(0, 10);
  }

  function openDecisionCard(d) {
    const ov = overlay("modal", `${d.number} · ${d.title}`);
    const editable = can("decision.edit") && hasDomain(d.domain);
    ov.body.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><span class="pill ${statusColor(d.status)}">${esc(d.status)}</span><span class="pill ${d.priority === "критический" || d.priority === "высокий" ? "red" : "gray"}">приоритет: ${esc(d.priority)}</span><span class="pill gray">${esc(S.meta.domains[d.domain])}</span>${d.overdue ? '<span class="pill red">просрочено</span>' : ""}</div>
      <dl class="kv">
        <dt>Проблема</dt><dd>${esc(d.problem)}</dd>
        <dt>Влияние</dt><dd>${esc(d.impact) || "—"}</dd>
        <dt>Причина</dt><dd>${esc(d.cause)}</dd>
        <dt>Действие</dt><dd>${esc(d.action)}</dd>
        <dt>Ответственный</dt><dd>${esc(d.owner)}</dd>
        <dt>Срок</dt><dd>${fmtD(d.due_date)}</dd>
        <dt>KPI</dt><dd>${esc(d.kpi_id || "—")}${d.context?.key ? ` · ${esc(d.context.dim)} = «${esc(d.context.key)}»` : ""}</dd>
        <dt>Создал</dt><dd>${esc(d.created_by_name)} · ${fmtDT(d.created_at)}</dd>
      </dl>
      ${
        editable
          ? `<div class="form-actions" style="justify-content:flex-start">
          ${["в работе", "выполнено", "отменено"].filter((s) => s !== d.status).map((s) => `<button type="button" class="btn btn-sm" data-st="${s}">→ ${s}</button>`).join("")}
          <span style="flex:1"></span><button type="button" class="btn btn-primary btn-sm" id="editDec">Редактировать</button></div>`
          : '<div class="hint" style="margin-top:10px">Только просмотр для вашей роли.</div>'
      }
      <h3 class="section-title">История изменений</h3>
      <ul class="history">${d.history
        .slice()
        .reverse()
        .map((h) => `<li><b>${esc(h.action)}</b> — ${esc(h.by_name)} <span class="at">· ${fmtDT(h.at)}</span>${Object.keys(h.changes || {}).length ? "<br>" + Object.entries(h.changes).map(([f, c]) => `${esc(f)}: «${esc(c.from)}» → «${esc(c.to)}»`).join("<br>") : ""}</li>`)
        .join("")}</ul>`;
    $$("[data-st]", ov.body).forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          const saved = await api(`/api/decisions/${d.id}`, { method: "PATCH", body: { status: b.dataset.st } });
          toast(`Статус ${saved.number}: ${saved.status}`, "ok");
          ov.close(true);
          if (location.hash.startsWith("#/decisions")) route();
          else loadDecisionsMini();
        } catch (err) {
          toast(err.message, "error");
          b.disabled = false;
        }
      })
    );
    $("#editDec", ov.body)?.addEventListener("click", () => {
      ov.close(true);
      openDecisionForm({}, d);
    });
  }

  async function renderDecisions(main) {
    const f = store.get("pulse-dec-filters", { status: "", priority: "", q: "" });
    main.innerHTML =
      topbar("Реестр управленческих решений", { filters: false }) +
      `<form class="filters" id="decFilters">
        <div class="f"><label for="dfS">Статус</label><select id="dfS"><option value="">Все</option>${["новое", "в работе", "выполнено", "отменено"].map((s) => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="f"><label for="dfP">Приоритет</label><select id="dfP"><option value="">Все</option>${["низкий", "средний", "высокий", "критический"].map((s) => `<option ${f.priority === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="f" style="flex:1;min-width:180px"><label for="dfQ">Поиск</label><input id="dfQ" type="search" placeholder="Номер, название, ответственный…" value="${esc(f.q)}"></div>
        ${can("decision.create") ? '<button type="button" class="btn btn-primary" id="newDec">＋ Новое решение</button>' : ""}
      </form>
      <div class="card"><div id="decTable"><div class="skeleton"></div></div></div>`;
    const load = async () => {
      const p = new URLSearchParams();
      const ff = { status: $("#dfS").value, priority: $("#dfP").value, q: $("#dfQ").value.trim() };
      store.set("pulse-dec-filters", ff);
      Object.entries(ff).forEach(([k, v]) => v && p.set(k, v));
      const box = $("#decTable");
      try {
        const r = await api("/api/decisions?" + p);
        box.innerHTML = r.decisions.length
          ? `<div class="table-wrap"><table><thead><tr><th>№</th><th>Решение</th><th>Подразделение</th><th>Ответственный</th><th>Срок</th><th>Приоритет</th><th>Статус</th><th>Изменено</th></tr></thead><tbody>${r.decisions
              .map(
                (d) => `<tr class="clickable" tabindex="0" data-id="${d.id}"><td><b>${esc(d.number)}</b></td><td>${esc(d.title)}<br><span class="hint">${esc(d.problem.slice(0, 110))}</span></td><td>${esc(S.meta.domains[d.domain])}</td><td>${esc(d.owner)}</td><td>${fmtD(d.due_date)}${d.overdue ? '<br><span class="pill red">просрочено</span>' : ""}</td><td>${esc(d.priority)}</td><td><span class="pill ${statusColor(d.status)}">${esc(d.status)}</span></td><td class="hint">${fmtDT(d.updated_at)}</td></tr>`
              )
              .join("")}</tbody></table></div>`
          : '<div class="empty">Решений не найдено. Создайте решение из детализации красного KPI на «Пульсе компании».</div>';
        $$("tr[data-id]", box).forEach((tr) => {
          const open = () => openDecisionCard(r.decisions.find((d) => d.id === Number(tr.dataset.id)));
          tr.addEventListener("click", open);
          tr.addEventListener("keydown", (e) => e.key === "Enter" && open());
        });
        S.openDecisions = r.decisions.filter((d) => !["выполнено", "отменено"].includes(d.status)).length;
        updateDecBadge();
      } catch (err) {
        box.innerHTML = "";
        showPageError(err, load);
      }
    };
    $$("#decFilters select").forEach((s) => s.addEventListener("change", load));
    let t;
    $("#dfQ").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(load, 300);
    });
    $("#decFilters").addEventListener("submit", (e) => e.preventDefault());
    $("#newDec")?.addEventListener("click", () => openDecisionForm({ domain: S.user.domains[0] }));
    load();
  }

  /* ------------------------------ Продажи ------------------------------ */
  async function renderSales(main) {
    main.innerHTML = topbar("Продажи и клиенты") + '<div id="pg"><div class="skeleton"></div></div>';
    bindFilters(() => renderSales(main));
    try {
      const [s, k] = await Promise.all([api("/api/screens/sales?" + qs({ domain: false })), api("/api/kpi?" + qs({ domain: "sales" }))]);
      setPeriodInfo(s.filters);
      const pick = (id) => k.kpis.find((x) => x.id === id);
      const totalCh = s.by_channel.reduce((a, x) => a + x.value, 0);
      $("#pg").innerHTML = `
        <div class="kpi-grid" id="sk"></div>
        <div class="grid grid-2" style="margin-top:16px">
          <div class="card"><h2>Воронка заказов <span class="hint">отменено: ${s.cancelled}</span></h2><div class="funnel">${s.funnel
            .map((f) => `<div class="funnel-step"><span>${esc(f.stage)}</span><div><div class="funnel-bar" style="width:${Math.max(6, f.conversion_pct)}%">${f.count}</div></div><span class="hint">${nf.format(f.conversion_pct)}%</span></div>`)
            .join("")}</div></div>
          <div class="card"><h2>Выручка по каналам оплаты</h2><div id="chDonut"></div>
            <p class="hint">Отток: ${s.churn.churned} из ${s.churn.prev_clients} клиентов прошлого периода не вернулись (${s.churn.churn_pct ?? "—"}%).</p></div>
        </div>
        <div class="grid grid-2" style="margin-top:16px">
          <div class="card"><h2>Сегменты клиентов</h2><div class="table-wrap"><table><thead><tr><th>Сегмент</th><th class="num">Клиенты</th><th class="num">Заказы</th><th class="num">Сумма</th><th class="num">Ср. чек</th></tr></thead><tbody>${s.by_segment
            .map((x) => `<tr><td>${esc(x.key)}</td><td class="num">${x.clients}</td><td class="num">${x.orders}</td><td class="num">${fmt(x.amount, "BYN")}</td><td class="num">${fmt(x.avg_check, "BYN")}</td></tr>`)
            .join("")}</tbody></table></div></div>
          <div class="card"><h2>Продукты</h2><div class="table-wrap"><table><thead><tr><th>Продукт</th><th class="num">Заказы</th><th class="num">Тираж</th><th class="num">Сумма</th></tr></thead><tbody>${s.by_product
            .map((x) => `<tr><td>${esc(x.key)}</td><td class="num">${x.orders}</td><td class="num">${nf0.format(x.qty)}</td><td class="num">${fmt(x.amount, "BYN")}</td></tr>`)
            .join("")}</tbody></table></div></div>
        </div>`;
      ["orders", "avg_check", "conversion", "repeat", "new_clients", "sla"].map(pick).filter(Boolean).forEach((x) => $("#sk").appendChild(kpiCard(x)));
      const cols = [Charts.COLORS.purple, Charts.COLORS.pink, Charts.COLORS.blue, Charts.COLORS.gray];
      Charts.donut($("#chDonut"), s.by_channel.map((c, i) => ({ label: c.key, value: c.value, color: cols[i % 4] })), { format: (v) => Charts.compact(v) + " BYN" });
      if (!totalCh) $("#chDonut").innerHTML = '<div class="empty">Нет поступлений</div>';
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderSales(main));
    }
  }

  /* ------------------------------ Производство ------------------------------ */
  async function renderProduction(main) {
    main.innerHTML = topbar("Производство и качество") + '<div id="pg"><div class="skeleton"></div></div>';
    bindFilters(() => renderProduction(main));
    try {
      const [s, k] = await Promise.all([api("/api/screens/production?" + qs({ domain: false })), api("/api/kpi?" + qs({ domain: "production" }))]);
      setPeriodInfo(s.filters);
      const maxR = Math.max(1, ...s.defect_reasons.map((r) => r.qty));
      $("#pg").innerHTML = `
        <div class="kpi-grid" id="pk"></div>
        <div class="grid grid-32" style="margin-top:16px">
          <div class="card"><h2>Выпуск: план / факт / брак</h2><div id="outChart"></div></div>
          <div class="card"><h2>Очередь производства</h2><div class="bars">${s.queue
            .map((q) => `<div class="bar-row"><span class="lbl">${esc(q.status)}</span><span class="bar-track"><span class="bar-fill ${q.status === "остановлен" ? "red" : ""}" style="width:${(q.count / Math.max(1, ...s.queue.map((x) => x.count))) * 100}%"></span></span><span class="val">${q.count}</span></div>`)
            .join("")}</div>
          <h2 style="margin-top:18px">Причины брака</h2><div class="bars">${s.defect_reasons
            .map((r) => `<div class="bar-row"><span class="lbl">${esc(r.key)}</span><span class="bar-track"><span class="bar-fill red" style="width:${(r.qty / maxR) * 100}%"></span></span><span class="val">${nf0.format(r.qty)} шт.</span></div>`)
            .join("") || '<div class="hint">Нет дефектов</div>'}</div></div>
        </div>`;
      ["output", "on_time", "defect", "lead_time", "capacity"].map((id) => k.kpis.find((x) => x.id === id)).filter(Boolean).forEach((x) => $("#pk").appendChild(kpiCard(x)));
      const machCard = document.createElement("div");
      machCard.className = "kpi";
      machCard.style.cursor = "default";
      machCard.innerHTML = `<div class="kpi-head"><span class="kpi-title">Станки: загрузка, простои, брак</span></div><div class="kpi-domain">производство</div><div class="kpi-meta"><span>Простой / обслуживание: <b>${s.downtime_machines}</b></span></div><button class="btn btn-sm" type="button" style="margin-top:auto">Просмотреть</button>`;
      $("button", machCard).addEventListener("click", () => openMachinesPopup(s));
      $("#pk").appendChild(machCard);
      Charts.chart($("#outChart"), {
        labels: s.by_month.map((m) => m.label),
        series: [
          { name: "План", values: s.by_month.map((m) => m.planned), color: "#c4b5fd", type: "bar" },
          { name: "Факт", values: s.by_month.map((m) => m.produced), color: Charts.COLORS.purple, type: "bar" },
          { name: "Брак", values: s.by_month.map((m) => m.defect), color: Charts.COLORS.pink, type: "line" },
        ],
      });
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderProduction(main));
    }
  }

  /* ------------------------------ Финансы и люди ------------------------------ */
  async function renderFinance(main) {
    main.innerHTML = topbar("Финансы и люди") + '<div id="pg"><div class="skeleton"></div></div>';
    bindFilters(() => renderFinance(main));
    try {
      const reqs = [api("/api/screens/finance?" + qs({ domain: false })), api("/api/kpi?" + qs({ domain: "finance" }))];
      if (hasDomain("hr")) reqs.push(api("/api/kpi?" + qs({ domain: "hr" })));
      const [s, k, h] = await Promise.all(reqs);
      setPeriodInfo(s.filters);
      const inSum = s.bdds.inflow.reduce((a, x) => a + x.value, 0);
      const outSum = s.bdds.outflow.reduce((a, x) => a + x.value, 0);
      const staffHtml = hasDomain("hr")
        ? tabBlock([
            { label: "Штат и факт", html: `<div class="table-wrap"><table><thead><tr><th>Подразделение</th><th class="num">Штат (план)</th><th class="num">Факт</th></tr></thead><tbody>${s.staff.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${d.plan}</td><td class="num">${d.fact}</td></tr>`).join("")}</tbody></table></div>` },
            { label: "Вакансии и отсутствие", html: `<div class="table-wrap"><table><thead><tr><th>Подразделение</th><th class="num">Вакансии</th><th class="num">Отсутствуют</th><th class="num">Обеспеченность</th></tr></thead><tbody>${s.staff.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${d.vacancies}</td><td class="num">${d.absent}</td><td class="num"><span class="pill ${d.staffing_pct >= 95 ? "green" : d.staffing_pct >= 85 ? "yellow" : "red"}">${nf.format(d.staffing_pct)}%</span></td></tr>`).join("")}</tbody></table></div>` },
                                        ])
        : '<div class="hint">🔒 Кадровые данные скрыты для вашей роли</div>';      $("#pg").innerHTML = `
        <div class="kpi-grid" id="fk"></div>
        <div class="card" style="margin-top:16px"><h2>БДР: план / факт по месяцам</h2><div id="bdrChart"></div>
          ${tabBlock([
            { label: "Выручка", html: `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th class="num">Выручка план</th><th class="num">Выручка факт</th></tr></thead><tbody>${s.bdr.map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${fmt(r.revenue_plan, "BYN")}</td><td class="num">${fmt(r.revenue_fact, "BYN")}</td></tr>`).join("")}</tbody></table></div>` },
            { label: "Расходы", html: `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th class="num">Расходы план</th><th class="num">Расходы факт</th></tr></thead><tbody>${s.bdr.map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${fmt(r.expenses_plan, "BYN")}</td><td class="num">${fmt(r.expenses_fact, "BYN")}</td></tr>`).join("")}</tbody></table></div>` },
            { label: "Прибыль", html: `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th class="num">Прибыль план</th><th class="num">Прибыль факт</th></tr></thead><tbody>${s.bdr.map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${fmt(r.profit_plan, "BYN")}</td><td class="num"><span class="pill ${r.profit_fact >= r.profit_plan ? "green" : "red"}">${fmt(r.profit_fact, "BYN")}</span></td></tr>`).join("")}</tbody></table></div>` },
          ])}
        </div>
        <div class="grid grid-2" style="margin-top:16px">
          <div class="card"><h2>БДДС: движение денег <span class="spacer"></span><span class="pill ${s.bdds.net >= 0 ? "green" : "red"}">сальдо ${fmt(s.bdds.net, "BYN")}</span></h2>
            <h3 class="section-title" style="margin-top:0">Поступления · ${fmt(inSum, "BYN")}</h3><div class="bars">${s.bdds.inflow.map((x) => `<div class="bar-row"><span class="lbl">${esc(x.key)}</span><span class="bar-track"><span class="bar-fill green" style="width:${(x.value / Math.max(inSum, outSum, 1)) * 100}%"></span></span><span class="val">${fmt(x.value, "BYN")}</span></div>`).join("")}</div>
            <h3 class="section-title">Выплаты · ${fmt(outSum, "BYN")}</h3><div class="bars">${s.bdds.outflow.map((x) => `<div class="bar-row"><span class="lbl">${esc(x.key)}</span><span class="bar-track"><span class="bar-fill red" style="width:${(x.value / Math.max(inSum, outSum, 1)) * 100}%"></span></span><span class="val">${fmt(x.value, "BYN")}</span></div>`).join("")}</div></div>
          <div class="card"><h2>Штат / факт, вакансии и отсутствие</h2>${staffHtml}</div>
        </div>`;
      bindTabs($("#pg"));
      [...k.kpis, ...(h ? h.kpis : [])].forEach((x) => $("#fk").appendChild(kpiCard(x)));
      Charts.chart($("#bdrChart"), {
        labels: s.bdr.map((r) => r.month),
        format: (v) => Charts.compact(v),
        series: [
          { name: "Выручка факт", values: s.bdr.map((r) => r.revenue_fact), color: Charts.COLORS.purple, type: "bar" },
          { name: "Расходы факт", values: s.bdr.map((r) => r.expenses_fact), color: Charts.COLORS.pink, type: "bar" },
          { name: "Выручка план", values: s.bdr.map((r) => r.revenue_plan), color: Charts.COLORS.gray, type: "dash" },
        ],
      });
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderFinance(main));
    }
  }

  /* ------------------------------ Прогноз ------------------------------ */
  async function renderForecast(main) {
    main.innerHTML = topbar("Прогноз спроса и мощности", { filters: false }) + '<div id="pg"><div class="skeleton"></div></div>';
    try {
      const f = await api("/api/forecast");
      const def = f.weeks.filter((w) => w.deficit);
      $("#pg").innerHTML = `
        ${f.first_deficit_week ? `<div class="banner error" role="alert">⚠ Ожидаемый дефицит мощности: неделя с ${fmtD(f.first_deficit_week)}. Недель с дефицитом: ${def.length} из ${f.weeks.length}, суммарная нехватка ${nf0.format(-def.reduce((a, w) => a + w.gap, 0))} ед.</div>` : '<div class="banner info">Дефицита мощности на горизонте 8 недель не ожидается.</div>'}
        <div class="card"><h2>Спрос vs доступная мощность (8 недель)${can("decision.create") && hasDomain("production") && f.first_deficit_week ? '<span class="spacer"></span><button class="btn btn-primary btn-sm" type="button" id="fcDec">＋ Создать решение по дефициту</button>' : ""}</h2><div id="fc"></div><p class="hint">${esc(f.method)}</p></div>
        <div class="card" style="margin-top:16px"><h2>По неделям</h2><div class="table-wrap"><table><thead><tr><th>Неделя</th><th class="num">Спрос, ед.</th><th class="num">Мощность, ед.</th><th class="num">Запас / дефицит</th><th>Плановые ремонты</th></tr></thead><tbody>${f.weeks
          .map((w) => `<tr><td>${fmtD(w.week)} — ${fmtD(w.week_end)}</td><td class="num">${nf0.format(w.demand)}</td><td class="num">${nf0.format(w.capacity)}</td><td class="num"><span class="pill ${w.deficit ? "red" : "green"}">${w.gap > 0 ? "+" : ""}${nf0.format(w.gap)}</span></td><td>${w.maintenance.map((m) => `${esc(m.name)}: ${esc(m.reason)}`).join("<br>") || "—"}</td></tr>`)
          .join("")}</tbody></table></div></div>
        <div class="card" style="margin-top:16px"><h2>История спроса (26 недель)</h2><div id="fh"></div></div>`;
      drawForecast($("#fc"), f);
      Charts.chart($("#fh"), { labels: f.history.map((h) => fmtD(h.week).slice(0, 5)), series: [{ name: "Плановый объём запусков, ед.", values: f.history.map((h) => h.demand), color: Charts.COLORS.purple, type: "area" }], height: 200 });
      $("#fcDec")?.addEventListener("click", () =>
        openDecisionForm({
          title: `Дефицит мощности с недели ${fmtD(f.first_deficit_week)}`,
          domain: "production",
          kpi_id: "capacity",
          problem: `Прогноз спроса превышает доступную мощность в ${def.length} из 8 недель; суммарная нехватка ${nf0.format(-def.reduce((a, w) => a + w.gap, 0))} ед.`,
          impact: "Срыв сроков заказов, рост lead time, снижение доли заказов в срок в сезон календарей и фотоальбомов.",
          cause: [...new Set(def.flatMap((w) => w.maintenance.map((m) => `${m.name}: ${m.reason}`)))].join("; ") || "Сезонный рост спроса",
          action: "Перенести плановые ремонты, ввести дополнительную смену, перераспределить заказы между станками.",
          context: { kpi: "capacity", forecast_week: f.first_deficit_week },
        })
      );
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderForecast(main));
    }
  }

  /* ------------------------------ Кабинет аналитика ------------------------------ */
  async function renderAnalyst(main) {
    main.innerHTML = topbar("Кабинет аналитика: качество данных", { filters: false }) + '<div id="pg"><div class="skeleton"></div></div>';
    try {
      const q = await api("/api/quality");
      const sev = { critical: "red", warning: "yellow", info: "gray" };
      const sevL = { critical: "критично", warning: "предупреждение", info: "инфо" };
      $("#pg").innerHTML = `
        <div class="stat-row">
          <div class="stat"><div class="l">Источников</div><div class="v">${q.sources}</div></div>
          <div class="stat"><div class="l">Данные загружены</div><div class="v" style="font-size:14px">${fmtDT(q.loaded_at)}</div></div>
          <div class="stat"><div class="l">Критичных проблем</div><div class="v" style="color:var(--red)">${q.totals.critical}</div></div>
          <div class="stat"><div class="l">Предупреждений</div><div class="v" style="color:var(--yellow)">${q.totals.warning}</div></div>
          <div class="stat"><div class="l">Сверка финансов</div><div class="v">${q.reconciliation.filter((r) => r.ok).length}/${q.reconciliation.length} мес.</div></div>
        </div>
        <div class="card"><h2>Свежесть источников<span class="spacer"></span>${can("quality.reload") ? '<button type="button" class="btn btn-sm" id="reload">⟳ Перезагрузить данные</button>' : ""}</h2>
          ${tabBlock([
            { label: "Свежесть файлов", html: `<div class="table-wrap"><table><thead><tr><th>Система</th><th>Таблица</th><th>Файл</th><th class="num">Строк</th><th>Файл обновлён</th><th>Статус</th></tr></thead><tbody>${q.freshness.map((f) => `<tr><td>${esc(f.system)}</td><td>${esc(f.table)}</td><td class="hint">${esc(f.file)}</td><td class="num">${nf0.format(f.rows)}</td><td>${fmtDT(f.file_updated_at)}</td><td><span class="pill ${f.status === "ok" ? "green" : f.status === "warning" ? "yellow" : "red"}">${f.status === "ok" ? "свежие" : f.status === "warning" ? "устаревают" : "устарели"}</span></td></tr>`).join("")}</tbody></table></div>` },
            { label: "Актуальность записей", html: `<div class="table-wrap"><table><thead><tr><th>Система</th><th>Таблица</th><th>Последняя запись</th><th class="num">Отставание</th><th>Статус</th></tr></thead><tbody>${q.freshness.map((f) => `<tr><td>${esc(f.system)}</td><td>${esc(f.table)}</td><td>${fmtD(f.last_record_date)}</td><td class="num">${f.lag_days === null ? "—" : f.lag_days + " дн."}</td><td><span class="pill ${f.status === "ok" ? "green" : f.status === "warning" ? "yellow" : "red"}">${f.status === "ok" ? "свежие" : f.status === "warning" ? "устаревают" : "устарели"}</span></td></tr>`).join("")}</tbody></table></div>` },
          ])}
        </div>
        <div class="card" style="margin-top:16px"><h2>Пропуски, дубли и разорванные связи</h2>
          ${
            q.issues.length
              ? `<div class="table-wrap"><table><thead><tr><th>Уровень</th><th>Источник</th><th>Проверка</th><th class="num">Записей</th><th>Описание</th><th>Примеры ID</th></tr></thead><tbody>${q.issues
                  .map((i) => `<tr><td><span class="pill ${sev[i.severity]}">${sevL[i.severity]}</span></td><td>${esc(i.source)}</td><td>${esc(i.check)}</td><td class="num">${i.count}</td><td>${esc(i.details)}</td><td class="hint">${i.sample.map(esc).join(", ")}${i.count > i.sample.length ? "…" : ""}</td></tr>`)
                  .join("")}</tbody></table></div>`
              : '<div class="empty">Проблем не найдено</div>'
          }</div>
        <div class="card" style="margin-top:16px"><h2>Сверка финансовых итогов <span class="hint">месячная отчётность (profit.json) vs первичные платежи и расходы</span></h2>
          ${tabBlock([
            { label: "Выручка", html: `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th class="num">Выручка (отчёт)</th><th class="num">Выручка (платежи)</th><th class="num">Δ выручки</th></tr></thead><tbody>${q.reconciliation.map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${fmt(r.report_revenue, "BYN")}</td><td class="num">${fmt(r.payments_revenue, "BYN")}</td><td class="num">${fmt(r.diff_revenue, "BYN")}</td></tr>`).join("")}</tbody></table></div>` },
            { label: "Расходы", html: `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th class="num">Расходы (отчёт)</th><th class="num">Расходы (учёт)</th><th class="num">Δ расходов</th></tr></thead><tbody>${q.reconciliation.map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${fmt(r.report_expenses, "BYN")}</td><td class="num">${fmt(r.ledger_expenses, "BYN")}</td><td class="num">${fmt(r.diff_expenses, "BYN")}</td></tr>`).join("")}</tbody></table></div>` },
            { label: "Результат", html: `<div class="table-wrap"><table><thead><tr><th>Месяц</th><th>Результат</th></tr></thead><tbody>${q.reconciliation.map((r) => `<tr><td>${esc(r.month)}</td><td><span class="pill ${r.ok ? "green" : "red"}">${r.ok ? "сходится" : "расхождение"}</span></td></tr>`).join("")}</tbody></table></div>` },
          ])}
        </div>`;
      bindTabs($("#pg"));
      $("#reload")?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await api("/api/admin/reload", { method: "POST" });
          toast(`Данные перезагружены: критичных ${r.totals.critical}, предупреждений ${r.totals.warning}`, "ok");
          renderAnalyst(main);
        } catch (err) {
          showPageError(err);
          e.currentTarget.disabled = false;
        }
      });
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderAnalyst(main));
    }
  }

  /* ------------------------------ Журнал ------------------------------ */
  async function renderAudit(main) {
    main.innerHTML =
      topbar("Журнал действий", { filters: false }) +
      `<form class="filters" id="auF"><div class="f"><label for="auU">Пользователь</label><select id="auU"><option value="">Все</option>${DEMO.map(([l]) => `<option>${l}</option>`).join("")}<option value="аноним">аноним</option></select></div>
       <div class="f"><label for="auR">Результат</label><select id="auR"><option value="">Все</option><option value="fail">Только отказы и ошибки</option></select></div>
       <button type="button" class="btn" id="auRef">Обновить</button></form>
       <div class="card"><div id="auT"><div class="skeleton"></div></div></div>`;
    const load = async () => {
      const p = new URLSearchParams();
      if ($("#auU").value) p.set("user", $("#auU").value);
      if ($("#auR").value) p.set("result", $("#auR").value);
      try {
        const r = await api("/api/audit?" + p);
        $("#auT").innerHTML = r.entries.length
          ? `<p class="hint">Всего записей: ${r.total}${r.total > r.entries.length ? `, показаны последние ${r.entries.length}` : ""}</p><div class="table-wrap"><table><thead><tr><th>Время</th><th>Пользователь</th><th>Роль</th><th>Действие</th><th>Объект</th><th>Результат</th><th>Детали</th></tr></thead><tbody>${r.entries
              .map((a) => `<tr><td class="hint" style="white-space:nowrap">${fmtDT(a.at)}</td><td>${esc(a.user)}</td><td>${esc(a.role || "—")}</td><td>${esc(a.action)}</td><td>${esc(a.object || "—")}</td><td><span class="pill ${a.result === "успех" ? "green" : "red"}">${esc(a.result)}</span></td><td class="hint">${a.details ? esc(JSON.stringify(a.details)).slice(0, 160) : ""}</td></tr>`)
              .join("")}</tbody></table></div>`
          : '<div class="empty">Записей нет</div>';
      } catch (err) {
        showPageError(err, load);
      }
    };
    $$("#auF select").forEach((s) => s.addEventListener("change", load));
    $("#auRef").addEventListener("click", load);
    load();
  }

  const RENDER = { pulse: renderPulse, sales: renderSales, production: renderProduction, finance: renderFinance, forecast: renderForecast, decisions: renderDecisions, analyst: renderAnalyst, audit: renderAudit };

  /* ---------------------------------- Старт ---------------------------------- */
  async function boot() {
    if (!S.token) return renderLogin();
    try {
      const r = await api("/api/me");
      S.user = r.user;
      S.meta = r.meta;
    } catch (err) {
      if (err.status === 401) return;
      app.innerHTML = `<div class="login-wrap"><div class="login-card"><h1>Пульс компании</h1><div class="banner error" role="alert">${esc(err.message)}</div><button class="btn btn-primary" id="retry">Повторить</button></div></div>`;
      $("#retry").addEventListener("click", boot);
      return;
    }
    renderShell();
    if (!location.hash) location.hash = "#/pulse";
    route();
  }

  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("online", () => fetch("/api/health").then(() => setOnline(true)).catch(() => {}));
  boot();
})();
