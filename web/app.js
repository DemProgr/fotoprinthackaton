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

  /** Выгрузка CSV: сервер проверяет право data.export, формирует файл и пишет в журнал. */
  async function exportCsv(path, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api(path, { timeout: 30000 });
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Выгружено строк: ${r.rows} (${r.filename})`, "ok");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
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
    compare: '<path d="M8 3v18M16 3v18"/><path d="m4 7 4-4 4 4M12 17l4 4 4-4"/>',
    plans: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
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
    { id: "compare", title: "Сравнение периодов", show: () => can("analysis.compare") },
    { id: "plans", title: "Планы и нормативы", show: () => can("plans.view") },
    { id: "audit", title: "Журнал действий", show: () => can("audit.view") },
  ];

  /** Кабинет под роль: название, стартовый экран, заголовок главной. */
  function cabinet(u = S.user) {
    if (u.role === "director") return { name: "Кабинет директора", home: "pulse", pulseTitle: "Пульс компании" };
    if (u.role === "analyst") return { name: "Кабинет аналитика", home: "analyst", pulseTitle: "Обзор KPI" };
    const area = { production: "Производство", sales: "Продажи", finance: "Финансы", hr: "Персонал" }[u.domains[0]] || "Подразделение";
    return { name: `Кабинет руководителя: ${area.toLowerCase()}`, home: "pulse", pulseTitle: `Мой участок: ${area}` };
  }
  const svgIcon = (id) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id]}</svg>`;
  ICONS.logout = '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>';
  ICONS.theme = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>';
  ICONS.keys = '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>';

  function renderShell() {
    const cab = cabinet();
    const nav = PAGES.filter((p) => p.sep || p.show())
      .map((p) =>
        p.sep
          ? '<div class="nav-sep" role="separator"></div>'
          : `<a href="#/${p.id}" data-page="${p.id}">${svgIcon(p.id)}<span>${p.id === "pulse" ? esc(cab.pulseTitle) : p.title}</span>${p.id === "decisions" ? '<span class="badge pink hidden" id="decBadge"></span>' : ""}${p.id === "pulse" ? '<span class="badge hidden" id="critBadge"></span>' : ""}</a>`
      )
      .join("");
    app.innerHTML = `
      <a class="skip-link" href="#main" id="skipLink">Перейти к содержимому</a>
      <div class="app-shell">
        <aside class="sidebar">
          <div class="brand"><span class="brand-logo">${svgIcon("pulse")}</span>Пульс компании</div>
          <div class="cabinet"><small>ООО «Фотопринт»</small><b>${esc(cab.name)}</b></div>
          <nav class="nav" aria-label="Разделы">${nav}</nav>
          <div class="side-bottom">
            <button type="button" id="themeBtn" aria-label="Переключить тему">${svgIcon("theme")}<span>${document.documentElement.dataset.theme === "dark" ? "Светлая" : "Тёмная"}</span></button>
            <button type="button" id="kbdBtn" aria-keyshortcuts="Shift+?" aria-label="Горячие клавиши">${svgIcon("keys")}<span>Клавиши</span></button>
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
      $("span", e.currentTarget).textContent = t === "dark" ? "Светлая" : "Тёмная";
      route();
    });
  }
  // Кнопка «Выйти» живёт в шапке каждой страницы — обрабатываем делегированием.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-logout]")) logout();
  });

  function userBox() {
    const u = S.user;
    return `<div class="userbox"><div class="avatar ${esc(u.role)}" aria-hidden="true">${esc(u.name[0])}</div><div class="u-txt"><div class="u-n">${esc(u.name)}</div><div class="u-r">${esc(u.title)}</div></div><button type="button" class="logout-btn" data-logout aria-label="Выйти из системы">${svgIcon("logout")}<span>Выйти</span></button></div>`;
  }

  function topbar(title, { filters = true, chips = "" } = {}) {
    return `
      <div class="topbar">
        <h1>${esc(title)}</h1>${chips}
        ${filters ? filterBar() : ""}
        <span class="grow"></span>
        <div class="conn ${S.online ? "" : "off"}" id="conn"><i class="dot"></i><span>${S.online ? "Онлайн" : "Нет связи с сервером"}</span></div>
        ${userBox()}
      </div>
      <div id="pageErr"></div>`;
  }

  function filterBar() {
    const f = S.filters;
    return `
      <form class="filters" id="filters" aria-label="Фильтры">
        <div class="f"><label for="fPeriod" class="sr-only">Период</label>
          <select id="fPeriod" title="Период">${[
            ["30d", "30 дней"],
            ["90d", "Квартал"],
            ["180d", "Полгода"],
            ["365d", "Год"],
            ["all", "Всё время"],
            ["custom", "Свой период…"],
          ]
            .map(([v, l]) => `<option value="${v}" ${f.period === v ? "selected" : ""}>${l}</option>`)
            .join("")}</select></div>
        <div class="f ${f.period === "custom" ? "" : "hidden"}" id="fCustom1"><label for="fFrom">с</label><input type="date" id="fFrom" value="${esc(f.from)}"></div>
        <div class="f ${f.period === "custom" ? "" : "hidden"}" id="fCustom2"><label for="fTo">по</label><input type="date" id="fTo" value="${esc(f.to)}"></div>
        <div class="f"><label for="fProduct" class="sr-only">Продукт</label><select id="fProduct" title="Продукт"><option value="">Все продукты</option>${S.meta.product_types
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
    if (el && f) el.textContent = `${fmtD(f.from)} — ${fmtD(f.to)}`;
  }

  function showPageError(err, retry) {
    const box = $("#pageErr");
    if (!box) return toast(err.message, "error");
    box.innerHTML = `<div class="banner error" role="alert"><span style="flex:1">${esc(err.message)}</span>${retry ? '<button class="btn btn-sm" type="button" id="retryBtn">Повторить</button>' : ""}</div>`;
    if (retry) $("#retryBtn").addEventListener("click", retry);
  }

  /* ------------------------------ Вкладки ------------------------------ */
  // onShow — отрисовка содержимого вкладки при первом показе (графикам нужен реальный размер).
  const tabHooks = new Map();
  let tabSeq = 0;
  /** tabs: [{label, html, onShow?}]; title — заголовок карточки в одной строке с вкладками; fill — растянуть на высоту. */
  function tabBlock(tabs, { title = "", fill = false, extra = "" } = {}) {
    const id = "tb" + tabSeq++;
    tabs.forEach((t, i) => t.onShow && tabHooks.set(`${id}:${i}`, t.onShow));
    return `
      <div class="tabblock${fill ? " fill" : ""}" data-tb="${id}">
        <div class="card-tabs">${title ? `<h2>${title}</h2>` : ""}<div class="tabs" role="tablist">${tabs.map((t, i) => `<button type="button" role="tab" aria-selected="${i === 0}" class="${i === 0 ? "active" : ""}" data-tab="${i}">${t.label}</button>`).join("")}</div>${extra}</div>
        ${tabs.map((t, i) => `<div class="tabpanel${i === 0 ? " active" : ""}" data-tab="${i}" role="tabpanel">${t.html}</div>`).join("")}
      </div>`;
  }
  function bindTabs(el) {
    $$(".tabblock", el).forEach((block) => {
      const id = block.dataset.tb;
      const tabs = $$(".card-tabs .tabs button[data-tab]", block);
      const panels = $$(":scope > .tabpanel", block);
      const show = (i) => {
        const panel = panels[i];
        const hook = tabHooks.get(`${id}:${i}`);
        if (hook && !panel.dataset.rendered) {
          panel.dataset.rendered = "1";
          hook(panel);
        }
      };
      tabs.forEach((b, i) => {
        b.addEventListener("click", () => {
          tabs.forEach((x) => {
            x.classList.toggle("active", x === b);
            x.setAttribute("aria-selected", x === b);
          });
          panels.forEach((p) => p.classList.toggle("active", p.dataset.tab === b.dataset.tab));
          show(i);
        });
      });
      show(0);
    });
  }

  /* --------------------------------- Роутер --------------------------------- */
  function route() {
    if (!S.user) return;
    const id = (location.hash.replace(/^#\//, "") || cabinet().home).split("?")[0];
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
    main.classList.toggle("fit", FIT_PAGES.has(id));
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
  // Вкладки «Пульса»: сначала то, что требует внимания; остальное — по подразделениям.
  const DOMAIN_TABS = [
    ["finance", "Финансы"],
    ["sales", "Продажи"],
    ["production", "Производство"],
    ["hr", "Персонал"],
  ];
  async function renderPulse(main) {
    const cab = cabinet();
    main.innerHTML =
      topbar(cab.pulseTitle) +
      `<div class="page">
        <div class="domain-tabs" id="domTabs" role="tablist" aria-label="Группы показателей"><div class="skeleton" style="min-height:62px"></div></div>
        <div class="grid grid-32 grow-row">
          <div class="card fill"><h2 id="kpiHead">Показатели</h2><div class="body"><div class="kpi-grid" id="kpiGrid">${'<div class="skeleton"></div>'.repeat(4)}</div></div></div>
          <div class="card fill" id="sideCard"></div>
        </div>
      </div>`;
    bindFilters(() => renderPulse(main));
    renderPulseSide();
    let data;
    try {
      data = await api("/api/kpi?" + qs());
    } catch (err) {
      $("#kpiGrid").innerHTML = "";
      $("#domTabs").innerHTML = "";
      return showPageError(err, () => renderPulse(main));
    }
    setPeriodInfo(data.filters);
    const crit = data.critical;
    const cb = $("#critBadge");
    if (cb) {
      cb.textContent = crit.length;
      cb.classList.toggle("hidden", !crit.length);
    }
    const attention = data.kpis.filter((k) => k.status === "red" || k.status === "yellow").sort((a, b) => (a.status === "red" ? 0 : 1) - (b.status === "red" ? 0 : 1));
    const groups = [{ id: "attention", label: "Требуют внимания", kpis: attention }].concat(
      DOMAIN_TABS.map(([id, label]) => ({ id, label, kpis: data.kpis.filter((k) => k.domain === id) })).filter((g) => g.kpis.length)
    );
    const count = (ks, s) => ks.filter((k) => k.status === s).length;
    let active = store.get("pulse-tab", "attention");
    if (!groups.some((g) => g.id === active) || (active === "attention" && !attention.length)) active = attention.length ? "attention" : groups[1]?.id;
    const show = (id) => {
      active = id;
      store.set("pulse-tab", id);
      const g = groups.find((x) => x.id === id);
      $$(".dtab", main).forEach((b) => {
        b.classList.toggle("active", b.dataset.g === id);
        b.setAttribute("aria-selected", b.dataset.g === id);
      });
      $("#kpiHead").innerHTML =
        id === "attention"
          ? `Требуют внимания <span class="hint">${attention.length ? "нажмите на показатель, чтобы найти причину и создать решение" : ""}</span>`
          : `${esc(g.label)} <span class="hint">${g.kpis.length} показателей</span>`;
      const grid = $("#kpiGrid");
      grid.innerHTML = g.kpis.length ? "" : '<div class="empty">✅ Все показатели в норме</div>';
      g.kpis.forEach((k) => grid.appendChild(kpiCard(k, { domain: id === "attention" })));
    };
    $("#domTabs").innerHTML = groups
      .map((g) =>
        g.id === "attention"
          ? `<button type="button" role="tab" class="dtab" data-g="attention"><span class="dt-name">⚠ Требуют внимания${attention.length ? `<span class="badge">${attention.length}</span>` : ""}</span><span class="dt-counts"><span><i class="dot red"></i>${count(attention, "red")} критично</span><span><i class="dot yellow"></i>${count(attention, "yellow")} внимание</span></span></button>`
          : `<button type="button" role="tab" class="dtab" data-g="${g.id}"><span class="dt-name">${esc(g.label)}</span><span class="dt-counts" aria-label="в норме ${count(g.kpis, "green")}, внимание ${count(g.kpis, "yellow")}, критично ${count(g.kpis, "red")}"><span><i class="dot green"></i>${count(g.kpis, "green")}</span><span><i class="dot yellow"></i>${count(g.kpis, "yellow")}</span><span><i class="dot red"></i>${count(g.kpis, "red")}</span></span></button>`
      )
      .join("");
    $$(".dtab", main).forEach((b) => b.addEventListener("click", () => show(b.dataset.g)));
    show(active);
  }

  /** Правая колонка «Пульса»: последние решения и прогноз мощности — во вкладках. */
  function renderPulseSide() {
    const card = $("#sideCard");
    const tabs = [{ label: "Решения", html: '<div id="decList" class="body"><div class="skeleton"></div></div>', onShow: () => loadDecisionsMini() }];
    if (can("forecast.view") && (hasDomain("production") || S.user.role !== "head"))
      tabs.push({ label: "Прогноз мощности", html: '<div id="fcNote" style="margin-bottom:8px"></div><div id="fcChart" class="chart-fill"></div>', onShow: (p) => loadForecastMini(p) });
    card.innerHTML = tabBlock(tabs, { fill: true, extra: '<span class="spacer" style="flex:1"></span><a class="btn btn-sm" href="#/decisions">Реестр →</a>' });
    bindTabs(card);
  }

  function kpiCard(k, { domain = false } = {}) {
    const el = document.createElement("div");
    el.className = `kpi s-${k.status}`;
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${k.title}: ${fmt(k.value, k.unit)}, план ${fmt(k.plan, k.unit)}, ${STATUS_LABEL[k.status]}. Открыть детализацию`);
    const dev = k.deviation_pct;
    const good = dev === null ? null : k.better === "up" ? dev >= 0 : dev <= 0;
    el.innerHTML = `
      <div class="kpi-head"><span class="kpi-title">${esc(k.title)}${domain ? `<small class="kpi-dom">${esc(k.domain_label)}</small>` : ""}</span><button type="button" class="icon-btn info-btn" title="Как считается" aria-label="Как считается показатель «${esc(k.title)}»">?</button></div>
      <div class="kpi-value" title="${esc(fmt(k.value, k.unit))}">${fmt(k.value, k.unit)}</div>
      <div class="kpi-foot"><span>план <b>${fmtShort(k.plan, k.unit)}</b></span>${dev === null ? `<span class="pill ${k.status}">${STATUS_LABEL[k.status]}</span>` : `<span class="delta ${good ? "good" : "bad"}" title="отклонение от плана">${dev > 0 ? "▲ +" : dev < 0 ? "▼ −" : ""}${nf.format(Math.abs(dev))}%</span>`}</div>`;
    // Прогноз и динамика — в детализации, чтобы карточка читалась за секунду.
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
    const x = k.explain || {};
    // Формула — крупно и наглядно: дробь «что / из чего» или одна строка-сумма.
    const formula = x.num
      ? `<span class="frac"><span>${esc(x.num)}</span><span>${esc(x.den)}</span></span>${x.pct ? '<span class="mult">× 100%</span>' : ""}`
      : `<span>${esc(x.sum || k.formula)}</span>`;
    const up = k.better !== "down";
    pop.innerHTML = `
      <div class="pop-head"><h3>${esc(k.title)}</h3><button class="close" type="button" aria-label="Закрыть подсказку">×</button></div>
      ${x.what ? `<p class="pop-what">${esc(x.what)}</p>` : ""}
      <div class="pop-label">Как считается</div>
      <div class="formula">${formula}</div>
      <div class="pop-now">
        <div><small>Сейчас</small><b>${fmtShort(k.value, k.unit)}</b></div>
        <div><small>План</small><b>${fmtShort(k.plan, k.unit)}</b></div>
        <div><small>Статус</small><b><span class="pill ${k.status}">${STATUS_LABEL[k.status]}</span></b></div>
      </div>
      ${x.note ? `<p class="pop-note">${esc(x.note)}</p>` : ""}
      <div class="pop-label">Цвет статуса ${up ? "(чем больше — тем лучше)" : "(чем меньше — тем лучше)"}</div>
      <div class="pop-scale">
        <span><i class="dot green"></i>${up ? "98% плана и выше" : "в пределах плана (допуск +2%)"}</span>
        <span><i class="dot yellow"></i>${up ? "от 90 до 98% плана" : "выше плана на 2–11%"}</span>
        <span><i class="dot red"></i>${up ? "меньше 90% плана" : "выше плана больше чем на 11%"}</span>
      </div>
      <details><summary>Подробнее для аналитика</summary>
        <p><b>Техническая формула:</b> ${esc(k.formula)}</p>
        <p><b>Источники:</b> ${k.sources.map(esc).join("; ")}</p>
        <p><b>Данные по дату:</b> ${fmtD(k.data_until)} · <b>загружено:</b> ${fmtDT(k.loaded_at)}</p>
        <p><b>Прогноз:</b> линейный тренд по ${k.series.length} точкам периода.</p>
      </details>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.scrollX + r.left - 10, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 16);
    pop.style.left = Math.max(16, left) + "px";
    // Если снизу не помещается — открываем над кнопкой.
    const below = r.bottom + 8 + pop.offsetHeight <= window.innerHeight;
    pop.style.top = window.scrollY + (below ? r.bottom + 8 : Math.max(8, r.top - pop.offsetHeight - 8)) + "px";
    const close = () => {
      pop.remove();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDoc, true);
      anchor.focus();
    };
    const onKey = (e) => e.key === "Escape" && close();
    const onDoc = (e) => !pop.contains(e.target) && e.target !== anchor && close();
    $(".close", pop).addEventListener("click", close);
    $(".close", pop).focus();
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
        ? `<div class="dec-list">${r.decisions
            .slice(0, 6)
            .map((d) => `<button type="button" class="dec-item" data-id="${d.id}"><span class="d-t">${esc(d.title)}</span><span class="pill ${statusColor(d.status)}">${esc(d.status)}</span><span class="d-m">${esc(d.number)} · ${esc(d.owner)} · до ${fmtD(d.due_date)}</span>${d.overdue ? '<span class="pill red">просрочено</span>' : "<span></span>"}</button>`)
            .join("")}</div>`
        : '<div class="empty">Решений пока нет.<br>Откройте красный KPI и нажмите «Создать решение».</div>';
      $$(".dec-item", box).forEach((b) => b.addEventListener("click", () => openDecisionCard(r.decisions.find((d) => d.id === Number(b.dataset.id)))));
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
    if (!$("#fcChart")) return;
    try {
      const f = await api("/api/forecast");
      $("#fcNote").innerHTML = f.first_deficit_week
        ? `<span class="pill red">⚠ Дефицит с ${fmtD(f.first_deficit_week)}</span> <span class="hint">недель с дефицитом: ${f.weeks.filter((w) => w.deficit).length} из ${f.weeks.length}</span>`
        : '<span class="pill green">Дефицита мощности не ожидается</span>';
      drawForecast($("#fcChart"), f, "auto");
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
          <div class="card"><h2>${key ? `Записи: ${esc(r.dim_label)} = «${esc(key)}»` : "Все записи показателя"} <span class="hint">${r.total} шт.${r.total > r.rows.length ? `, показаны первые ${r.rows.length}` : ""}</span><span class="spacer"></span>${can("data.export") ? '<button type="button" class="btn btn-sm" id="recCsv">⬇ CSV</button>' : ""}${canCreateFor(k) ? '<button type="button" class="btn btn-primary btn-sm" id="mkDecision2">＋ Создать решение</button>' : ""}</h2>
          ${recordsTable(r)}</div>`;
        bindOrderLinks(box);
        $("#recCsv", box)?.addEventListener("click", (e) => exportCsv(`/api/kpi/${k.id}/records?` + qs({ dim, key, domain: false, format: "csv" }), e.currentTarget));
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
          ${v.context ? `<div class="field field-static"><label>Контекст</label><div class="hint">KPI: ${esc(v.context.kpi || v.kpi_id || "—")}${v.context.key ? ` · ${esc(v.context.dim)} = «${esc(v.context.key)}»` : ""}</div></div>` : ""}
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
        const err = $(".err", f);
        if (err) err.textContent = "";
      });
      $("#formErr", ov.body).classList.add("hidden");
      const body = collect();
      // Клиентская проверка (дублирует серверную, сервер — источник истины)
      const errs = {};
      for (const [f, l] of [["title", "Название"], ["problem", "Проблема"], ["cause", "Причина"], ["action", "Действие"], ["owner", "Ответственный"], ["due_date", "Срок"]]) if (!body[f]?.trim()) errs[f] = `Поле «${l}» обязательно`;
      if (Object.keys(errs).length) {
        const box = $("#formErr", ov.body);
        box.textContent = `Заполните обязательные поля: ${Object.values(errs).map((m) => m.replace(/^Поле «(.+)» обязательно$/, "$1")).join(", ")}`;
        box.classList.remove("hidden");
        return showFieldErrors(form, ov, errs);
      }
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
        box.textContent = err.message + (err.details ? ": " + Object.values(err.details).join("; ") : "");
        box.classList.remove("hidden");
        box.scrollIntoView({ block: "nearest" });
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
        const err = $(".err", box);
        if (err) err.textContent = msg;
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
      `<form class="filters panel" id="decFilters" style="margin-bottom:14px">
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
  const kpiRow = (box, kpis, ids) => ids.map((id) => kpis.find((x) => x.id === id)).filter(Boolean).forEach((x) => box.appendChild(kpiCard(x)));
  const simpleTable = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map(([l, num]) => `<th class="${num ? "num" : ""}">${l}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;

  async function renderSales(main) {
    main.innerHTML = topbar("Продажи и клиенты") + '<div class="page" id="pg"><div class="skeleton"></div></div>';
    bindFilters(() => renderSales(main));
    try {
      const [s, k] = await Promise.all([api("/api/screens/sales?" + qs({ domain: false })), api("/api/kpi?" + qs({ domain: "sales" }))]);
      setPeriodInfo(s.filters);
      const totalCh = s.by_channel.reduce((a, x) => a + x.value, 0);
      $("#pg").innerHTML = `
        <div class="kpi-row" id="sk"></div>
        <div class="grid grid-2 grow-row">
          <div class="card fill"><h2>Воронка заказов <span class="hint">отменено: ${s.cancelled}</span></h2><div class="body"><div class="funnel">${s.funnel
            .map((f) => `<div class="funnel-step"><span>${esc(f.stage)}</span><div><div class="funnel-bar" style="width:${Math.max(6, f.conversion_pct)}%">${f.count}</div></div><span class="hint">${nf.format(f.conversion_pct)}%</span></div>`)
            .join("")}</div>
            <p class="hint" style="margin-top:14px">Отток: <b>${s.churn.churned}</b> из ${s.churn.prev_clients} клиентов прошлого периода не вернулись (${s.churn.churn_pct ?? "—"}%).</p></div></div>
          <div class="card fill">${tabBlock(
            [
              { label: "Каналы оплаты", html: '<div id="chDonut"></div>', onShow: () => drawDonut() },
              { label: "Сегменты", html: simpleTable([["Сегмент"], ["Клиенты", 1], ["Заказы", 1], ["Сумма", 1], ["Ср. чек", 1]], s.by_segment.map((x) => `<tr><td>${esc(x.key)}</td><td class="num">${x.clients}</td><td class="num">${x.orders}</td><td class="num">${fmt(x.amount, "BYN")}</td><td class="num">${fmt(x.avg_check, "BYN")}</td></tr>`)) },
              { label: "Продукты", html: simpleTable([["Продукт"], ["Заказы", 1], ["Тираж", 1], ["Сумма", 1]], s.by_product.map((x) => `<tr><td>${esc(x.key)}</td><td class="num">${x.orders}</td><td class="num">${nf0.format(x.qty)}</td><td class="num">${fmt(x.amount, "BYN")}</td></tr>`)) },
            ],
            { fill: true }
          )}</div>
        </div>`;
      kpiRow($("#sk"), k.kpis, ["orders", "avg_check", "conversion", "repeat", "new_clients", "sla"]);
      const cols = [Charts.COLORS.purple, Charts.COLORS.pink, Charts.COLORS.blue, Charts.COLORS.gray];
      const drawDonut = () => {
        if (!totalCh) return ($("#chDonut").innerHTML = '<div class="empty">Нет поступлений</div>');
        Charts.donut($("#chDonut"), s.by_channel.map((c, i) => ({ label: c.key, value: c.value, color: cols[i % 4] })), { format: (v) => Charts.compact(v) + " BYN" });
      };
      bindTabs($("#pg"));
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderSales(main));
    }
  }

  /* ------------------------------ Производство ------------------------------ */
  async function renderProduction(main) {
    main.innerHTML = topbar("Производство и качество") + '<div class="page" id="pg"><div class="skeleton"></div></div>';
    bindFilters(() => renderProduction(main));
    try {
      const [s, k] = await Promise.all([api("/api/screens/production?" + qs({ domain: false })), api("/api/kpi?" + qs({ domain: "production" }))]);
      setPeriodInfo(s.filters);
      const maxR = Math.max(1, ...s.defect_reasons.map((r) => r.qty));
      const maxQ = Math.max(1, ...s.queue.map((x) => x.count));
      const active = s.machines.filter((m) => m.status === "активен").length;
      const loads = s.machines.map((m) => m.load_pct).filter((v) => v !== null);
      const avgLoad = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : null;
      const worst = s.machines.filter((m) => m.defect_pct !== null).sort((a, b) => b.defect_pct - a.defect_pct).slice(0, 4);
      $("#pg").innerHTML = `
        <div class="kpi-row" id="pk"></div>
        <div class="grid grid-3 grow-row">
          <div class="card fill"><h2>Очередь производства</h2><div class="body"><div class="bars">${s.queue
            .map((q) => `<div class="bar-row"><span class="lbl">${esc(q.status)}</span><span class="bar-track"><span class="bar-fill ${q.status === "остановлен" ? "red" : ""}" style="width:${(q.count / maxQ) * 100}%"></span></span><span class="val">${q.count}</span></div>`)
            .join("")}</div></div></div>
          <div class="card fill"><h2>Причины брака <span class="hint">топ-5</span></h2><div class="body"><div class="bars">${s.defect_reasons
            .slice(0, 5)
            .map((r) => `<div class="bar-row"><span class="lbl" title="${esc(r.key)}">${esc(r.key)}</span><span class="bar-track"><span class="bar-fill red" style="width:${(r.qty / maxR) * 100}%"></span></span><span class="val">${nf0.format(r.qty)} шт.</span></div>`)
            .join("") || '<div class="hint">Нет дефектов</div>'}</div></div></div>
          <div class="card fill"><h2>Станки <span class="spacer"></span><button class="btn btn-sm" type="button" id="machinesBtn">Все станки →</button></h2><div class="body">
            <div class="mini-stats">
              <div class="mini-stat"><div class="l">Работают</div><div class="v">${active}<span class="hint"> / ${s.machines.length}</span></div></div>
              <div class="mini-stat"><div class="l">Простой / ремонт</div><div class="v" style="color:${s.downtime_machines ? "var(--yellow)" : "inherit"}">${s.downtime_machines}</div></div>
              <div class="mini-stat"><div class="l">Ср. загрузка</div><div class="v">${avgLoad === null ? "—" : nf.format(avgLoad) + "%"}</div></div>
            </div>
            <div class="section-title">Больше всего брака</div>
            <div class="bars">${worst.map((m) => `<div class="bar-row"><span class="lbl">${esc(m.name)}</span><span class="bar-track"><span class="bar-fill ${m.defect_pct > 3 ? "red" : "green"}" style="width:${Math.min(100, m.defect_pct * 10)}%"></span></span><span class="val">${nf.format(m.defect_pct)}%</span></div>`).join("") || '<div class="hint">Нет данных</div>'}</div>
          </div></div>
        </div>`;
      kpiRow($("#pk"), k.kpis, ["output", "on_time", "defect", "lead_time", "capacity"]);
      $("#machinesBtn")?.addEventListener("click", () => openMachinesPopup(s));
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderProduction(main));
    }
  }

  /* ------------------------------ Финансы и люди ------------------------------ */
  async function renderFinance(main) {
    main.innerHTML = topbar("Финансы и люди") + '<div class="page" id="pg"><div class="skeleton"></div></div>';
    bindFilters(() => renderFinance(main));
    try {
      const reqs = [api("/api/screens/finance?" + qs({ domain: false })), api("/api/kpi?" + qs({ domain: "finance" }))];
      if (hasDomain("hr")) reqs.push(api("/api/kpi?" + qs({ domain: "hr" })));
      const [s, k, h] = await Promise.all(reqs);
      setPeriodInfo(s.filters);
      const inSum = s.bdds.inflow.reduce((a, x) => a + x.value, 0);
      const outSum = s.bdds.outflow.reduce((a, x) => a + x.value, 0);
      const maxFlow = Math.max(inSum, outSum, 1);
      const flowBars = (list, cls) => `<div class="bars">${list.map((x) => `<div class="bar-row"><span class="lbl" title="${esc(x.key)}">${esc(x.key)}</span><span class="bar-track"><span class="bar-fill ${cls}" style="width:${(x.value / maxFlow) * 100}%"></span></span><span class="val">${fmtShort(x.value, "BYN")}</span></div>`).join("")}</div>`;
      const bdr = s.bdr.slice(-12); // на графике — последние 12 месяцев, полная таблица — во вкладке
      const right = [
        {
          label: "Деньги (БДДС)",
          html: `<div style="margin-bottom:8px"><span class="pill ${s.bdds.net >= 0 ? "green" : "red"}">сальдо ${fmt(s.bdds.net, "BYN")}</span></div>
            <div class="section-title" style="margin-top:4px">Поступления · ${fmtShort(inSum, "BYN")}</div>${flowBars(s.bdds.inflow, "green")}
            <div class="section-title">Выплаты · ${fmtShort(outSum, "BYN")}</div>${flowBars(s.bdds.outflow.slice().sort((a, b) => b.value - a.value).slice(0, 5), "red")}`,
        },
      ];
      if (hasDomain("hr"))
        right.push({
          label: "Персонал",
          html: simpleTable(
            [["Подразделение"], ["Штат", 1], ["Факт", 1], ["Вакансии", 1], ["Обеспеч.", 1]],
            s.staff.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${d.plan}</td><td class="num">${d.fact}</td><td class="num">${d.vacancies}</td><td class="num"><span class="pill ${d.staffing_pct >= 95 ? "green" : d.staffing_pct >= 85 ? "yellow" : "red"}">${nf.format(d.staffing_pct)}%</span></td></tr>`)
          ),
        });
      $("#pg").innerHTML = `
        <div class="kpi-row" id="fk"></div>
        <div class="grid grid-21 grow-row">
          <div class="card fill">${tabBlock(
            [
              { label: "График", html: '<div id="bdrChart" class="chart-fill"></div>', onShow: () => drawBdr() },
              {
                label: "Таблица по месяцам",
                html: simpleTable(
                  [["Месяц"], ["Выручка план", 1], ["Выручка факт", 1], ["Расходы факт", 1], ["Прибыль факт", 1]],
                  s.bdr.map((r) => `<tr><td>${esc(r.month)}</td><td class="num">${fmt(r.revenue_plan, "BYN")}</td><td class="num">${fmt(r.revenue_fact, "BYN")}</td><td class="num">${fmt(r.expenses_fact, "BYN")}</td><td class="num"><span class="pill ${r.profit_fact >= r.profit_plan ? "green" : "red"}">${fmt(r.profit_fact, "BYN")}</span></td></tr>`)
                ),
              },
            ],
            { title: "Доходы и расходы (БДР)", fill: true }
          )}</div>
          <div class="card fill">${tabBlock(right, { fill: true })}</div>
        </div>`;
      const box = $("#fk");
      kpiRow(box, k.kpis, ["revenue", "margin", "expenses"]);
      if (h) kpiRow(box, h.kpis, ["staffing", "sick"]);
      const drawBdr = () => {
        if (!bdr.length) return ($("#bdrChart").innerHTML = '<div class="empty">Нет данных за период</div>');
        Charts.chart($("#bdrChart"), {
          labels: bdr.map((r) => r.month),
          height: "auto",
          format: (v) => Charts.compact(v),
          series: [
            { name: "Выручка факт", values: bdr.map((r) => r.revenue_fact), color: Charts.COLORS.purple, type: "bar" },
            { name: "Расходы факт", values: bdr.map((r) => r.expenses_fact), color: Charts.COLORS.pink, type: "bar" },
            { name: "Выручка план", values: bdr.map((r) => r.revenue_plan), color: Charts.COLORS.gray, type: "dash" },
          ],
        });
      };
      bindTabs($("#pg"));
    } catch (err) {
      $("#pg").innerHTML = "";
      showPageError(err, () => renderFinance(main));
    }
  }

  /* ------------------------------ Прогноз ------------------------------ */
  async function renderForecast(main) {
    main.innerHTML = topbar("Прогноз спроса и мощности", { filters: false }) + '<div class="page" id="pg"><div class="skeleton"></div></div>';
    try {
      const f = await api("/api/forecast");
      const def = f.weeks.filter((w) => w.deficit);
      const gapSum = nf0.format(-def.reduce((a, w) => a + w.gap, 0));
      const canDec = can("decision.create") && hasDomain("production") && f.first_deficit_week;
      $("#pg").innerHTML = `
        ${f.first_deficit_week ? `<div class="banner error" role="alert">⚠ Дефицит мощности с недели ${fmtD(f.first_deficit_week)}: ${def.length} из ${f.weeks.length} недель, не хватает ${gapSum} ед.<span style="flex:1"></span>${canDec ? '<button class="btn btn-primary btn-sm" type="button" id="fcDec">＋ Создать решение</button>' : ""}</div>` : '<div class="banner info">Дефицита мощности на горизонте 8 недель не ожидается.</div>'}
        <div class="grid grid-21 grow-row">
          <div class="card fill">${tabBlock(
            [
              { label: "Ближайшие 8 недель", html: '<div id="fc" class="chart-fill"></div>', onShow: () => drawForecast($("#fc"), f, "auto") },
              { label: "История за 26 недель", html: '<div id="fh" class="chart-fill"></div>', onShow: () => Charts.chart($("#fh"), { labels: f.history.map((x) => fmtD(x.week).slice(0, 5)), series: [{ name: "Плановый объём запусков, ед.", values: f.history.map((x) => x.demand), color: Charts.COLORS.purple, type: "area" }], height: "auto" }) },
            ],
            { title: "Спрос и мощность", fill: true }
          )}<p class="hint" style="margin:8px 0 0">${esc(f.method)}</p></div>
          <div class="card fill"><h2>По неделям</h2><div class="body">${simpleTable(
            [["Неделя"], ["Спрос", 1], ["Мощность", 1], ["Запас", 1]],
            f.weeks.map((w) => `<tr title="${esc(w.maintenance.map((m) => `${m.name}: ${m.reason}`).join("; ") || "Плановых ремонтов нет")}"><td>${fmtD(w.week).slice(0, 5)}–${fmtD(w.week_end).slice(0, 5)}${w.maintenance.length ? ' <span class="hint">🔧' + w.maintenance.length + "</span>" : ""}</td><td class="num">${nf0.format(w.demand)}</td><td class="num">${nf0.format(w.capacity)}</td><td class="num"><span class="pill ${w.deficit ? "red" : "green"}">${w.gap > 0 ? "+" : ""}${nf0.format(w.gap)}</span></td></tr>`)
          )}<p class="hint">🔧 — плановые ремонты станков (наведите на строку).</p></div></div>
        </div>`;
      bindTabs($("#pg"));
      $("#fcDec")?.addEventListener("click", () =>
        openDecisionForm({
          title: `Дефицит мощности с недели ${fmtD(f.first_deficit_week)}`,
          domain: "production",
          kpi_id: "capacity",
          problem: `Прогноз спроса превышает доступную мощность в ${def.length} из 8 недель; суммарная нехватка ${gapSum} ед.`,
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
          <div class="stat"><div class="l">Открытых проблем</div><div class="v">${q.open_issues}/${q.issues.length}</div></div>
          <div class="stat"><div class="l">Сверка финансов</div><div class="v">${q.reconciliation.filter((r) => r.ok).length}/${q.reconciliation.length} мес.</div></div>
        </div>
        <div class="card"><h2>Свежесть источников<span class="spacer"></span>${can("quality.reload") ? '<button type="button" class="btn btn-sm" id="reload">⟳ Перезагрузить данные</button>' : ""}</h2>
          ${tabBlock([
            { label: "Свежесть файлов", html: `<div class="table-wrap"><table><thead><tr><th>Система</th><th>Таблица</th><th>Файл</th><th class="num">Строк</th><th>Файл обновлён</th><th>Статус</th></tr></thead><tbody>${q.freshness.map((f) => `<tr><td>${esc(f.system)}</td><td>${esc(f.table)}</td><td class="hint">${esc(f.file)}</td><td class="num">${nf0.format(f.rows)}</td><td>${fmtDT(f.file_updated_at)}</td><td><span class="pill ${f.status === "ok" ? "green" : f.status === "warning" ? "yellow" : "red"}">${f.status === "ok" ? "свежие" : f.status === "warning" ? "устаревают" : "устарели"}</span></td></tr>`).join("")}</tbody></table></div>` },
            { label: "Актуальность записей", html: `<div class="table-wrap"><table><thead><tr><th>Система</th><th>Таблица</th><th>Последняя запись</th><th class="num">Отставание</th><th>Статус</th></tr></thead><tbody>${q.freshness.map((f) => `<tr><td>${esc(f.system)}</td><td>${esc(f.table)}</td><td>${fmtD(f.last_record_date)}</td><td class="num">${f.lag_days === null ? "—" : f.lag_days + " дн."}</td><td><span class="pill ${f.status === "ok" ? "green" : f.status === "warning" ? "yellow" : "red"}">${f.status === "ok" ? "свежие" : f.status === "warning" ? "устаревают" : "устарели"}</span></td></tr>`).join("")}</tbody></table></div>` },
          ])}
        </div>
        <div class="card" style="margin-top:16px"><h2>Пропуски, дубли и разорванные связи <span class="hint">открыто: ${q.open_issues} из ${q.issues.length}${q.can_manage ? "" : " · статусы разбора ведёт аналитик"}</span></h2>
          ${
            q.issues.length
              ? `<div class="table-wrap"><table><thead><tr><th>Уровень</th><th>Источник</th><th>Проверка</th><th class="num">Записей</th><th>Описание</th><th>Примеры ID</th><th>Разбор</th></tr></thead><tbody>${q.issues
                  .map(
                    (i, n) => `<tr><td><span class="pill ${sev[i.severity]}">${sevL[i.severity]}</span></td><td>${esc(i.source)}</td><td>${esc(i.check)}</td><td class="num">${i.count}</td><td>${esc(i.details)}</td><td class="hint">${i.sample.map(esc).join(", ")}${i.count > i.sample.length ? "…" : ""}</td>
                    <td><span class="pill ${issueColor(i.workflow.status)}">${esc(i.workflow.status)}</span>${i.workflow.assignee ? `<br><span class="hint">${esc(i.workflow.assignee)}</span>` : ""}${i.workflow.comment ? `<br><span class="hint">${esc(i.workflow.comment)}</span>` : ""}${q.can_manage ? `<br><button type="button" class="btn btn-sm" data-issue="${n}" style="margin-top:6px">Разобрать</button>` : ""}</td></tr>`
                  )
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
      $$("[data-issue]", main).forEach((b) => b.addEventListener("click", () => openIssueForm(q.issues[Number(b.dataset.issue)], q.issue_statuses, () => renderAnalyst(main))));
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

  const issueColor = (s) => ({ новая: "red", "в работе": "yellow", "исправлена в источнике": "green", "ложное срабатывание": "gray" })[s] || "gray";

  function openIssueForm(issue, statuses, done) {
    const ov = overlay("modal", `Разбор: ${issue.check}`);
    const w = issue.workflow;
    ov.body.innerHTML = `
      <div class="callout neutral">${esc(issue.source)} · записей: ${issue.count} · ${esc(issue.details)}<br><span class="hint">Примеры ID: ${issue.sample.map(esc).join(", ")}</span></div>
      <div class="banner error hidden" id="isErr" role="alert"></div>
      <form id="isForm" novalidate>
        <div class="form-grid">
          <div class="field"><label for="isS">Статус</label><select id="isS">${statuses.map((s) => `<option ${w.status === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
          <div class="field"><label for="isA">Кто исправляет в источнике</label><input id="isA" value="${esc(w.assignee || "")}" placeholder="Например: администратор CRM"></div>
          <div class="field full"><label for="isC">Комментарий аналитика</label><textarea id="isC" rows="3" placeholder="Причина, что сделано, ссылка на заявку">${esc(w.comment || "")}</textarea></div>
        </div>
        ${w.history?.length ? `<h3 class="section-title">История разбора</h3><ul class="history">${w.history.slice().reverse().map((h) => `<li><b>${esc(h.status)}</b> — ${esc(h.by_name)} <span class="at">· ${fmtDT(h.at)}</span>${h.comment ? `<br>${esc(h.comment)}` : ""}</li>`).join("")}</ul>` : ""}
        <div class="form-actions"><button type="button" class="btn" id="isCancel">Отмена</button><button type="submit" class="btn btn-primary" id="isSave">Сохранить</button></div>
      </form>`;
    $("#isCancel", ov.body).addEventListener("click", () => ov.close());
    $("#isForm", ov.body).addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#isSave", ov.body);
      btn.disabled = true;
      try {
        await api("/api/quality/issues", { method: "PATCH", body: { key: issue.key, status: $("#isS").value, assignee: $("#isA").value, comment: $("#isC").value } });
        ov.close(true);
        toast("Статус проблемы сохранён", "ok");
        done();
      } catch (err) {
        const box = $("#isErr", ov.body);
        box.textContent = err.message;
        box.classList.remove("hidden");
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------ Сравнение периодов ------------------------------ */
  async function renderCompare(main) {
    const mode = store.get("pulse-compare-mode", "prev");
    main.innerHTML =
      topbar("Сравнение периодов") +
      `<div class="filters panel" style="margin-bottom:14px"><div class="f"><label for="cmpMode">Сравнить с</label><select id="cmpMode"><option value="prev" ${mode === "prev" ? "selected" : ""}>предыдущим периодом той же длины</option><option value="yoy" ${mode === "yoy" ? "selected" : ""}>тем же периодом год назад</option></select></div>
       <div class="f"><label for="cmpDom">Подразделение</label><select id="cmpDom"><option value="">Все</option>${S.user.domains.map((d) => `<option value="${d}">${esc(S.meta.domains[d])}</option>`).join("")}</select></div>
       ${can("data.export") ? '<button type="button" class="btn" id="cmpCsv">⬇ CSV</button>' : ""}</div>
       <div id="pg"><div class="skeleton"></div></div>`;
    bindFilters(() => renderCompare(main));
    let last = null;
    const load = async () => {
      const m = $("#cmpMode").value;
      store.set("pulse-compare-mode", m);
      const dom = $("#cmpDom").value;
      try {
        const r = await api("/api/analysis/compare?" + qs({ mode: m, domain: false }) + (dom ? "&domain=" + dom : ""));
        last = r;
        setPeriodInfo({ ...S.filters, from: r.current.from, to: r.current.to });
        const tr = { better: ["green", "▲ лучше"], worse: ["red", "▼ хуже"], flat: ["gray", "≈ без изменений"] };
        const sorted = r.rows.slice().sort((a, b) => ({ worse: 0, flat: 1, better: 2 })[a.trend] - ({ worse: 0, flat: 1, better: 2 })[b.trend] || Math.abs(b.delta_pct || 0) - Math.abs(a.delta_pct || 0));
        $("#pg").innerHTML = `
          <div class="stat-row">
            <div class="stat"><div class="l">Текущий период</div><div class="v" style="font-size:14px">${fmtD(r.current.from)} — ${fmtD(r.current.to)}</div></div>
            <div class="stat"><div class="l">База сравнения</div><div class="v" style="font-size:14px">${fmtD(r.previous.from)} — ${fmtD(r.previous.to)}</div></div>
            <div class="stat"><div class="l">Улучшились</div><div class="v" style="color:var(--green)">${r.summary.better}</div></div>
            <div class="stat"><div class="l">Ухудшились</div><div class="v" style="color:var(--red)">${r.summary.worse}</div></div>
            <div class="stat"><div class="l">Без изменений</div><div class="v">${r.summary.flat}</div></div>
          </div>
          <div class="card"><h2>Динамика KPI <span class="hint">сначала ухудшившиеся; «лучше/хуже» учитывает направление показателя</span></h2>
          <div class="table-wrap"><table class="stack-table"><thead><tr><th>Показатель</th><th>Подразделение</th><th class="num">Текущий</th><th class="num">База</th><th class="num">Δ</th><th class="num">Δ, %</th><th>Оценка</th><th>Статус: база → текущий</th></tr></thead><tbody>${sorted
            .map(
              (x) => `<tr class="clickable" tabindex="0" data-kpi="${x.id}"><td data-l="Показатель"><b>${esc(x.title)}</b></td><td data-l="Подразделение">${esc(x.domain_label)}</td><td class="num" data-l="Текущий">${fmt(x.current.value, x.unit)}</td><td class="num" data-l="База">${fmt(x.previous.value, x.unit)}</td><td class="num" data-l="Δ">${x.delta === null ? "—" : (x.delta > 0 ? "+" : "") + fmt(x.delta, x.unit)}</td><td class="num" data-l="Δ, %">${x.delta_pct === null ? "—" : (x.delta_pct > 0 ? "+" : "") + nf.format(x.delta_pct) + "%"}</td><td data-l="Оценка"><span class="pill ${tr[x.trend][0]}">${tr[x.trend][1]}</span></td><td data-l="Статус"><span class="pill ${x.previous.status}">${STATUS_LABEL[x.previous.status]}</span> → <span class="pill ${x.current.status}">${STATUS_LABEL[x.current.status]}</span></td></tr>`
            )
            .join("")}</tbody></table></div><p class="hint">Нажмите на строку, чтобы открыть детализацию показателя за текущий период.</p></div>`;
        $$("tr[data-kpi]", main).forEach((row) => {
          const open = async () => {
            try {
              const k = await api("/api/kpi?" + qs());
              const kk = k.kpis.find((x) => x.id === row.dataset.kpi);
              if (kk) openDrill(kk);
            } catch (err) {
              toast(err.message, "error");
            }
          };
          row.addEventListener("click", open);
          row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
        });
      } catch (err) {
        $("#pg").innerHTML = "";
        showPageError(err, load);
      }
    };
    $("#cmpMode").addEventListener("change", load);
    $("#cmpDom").addEventListener("change", load);
    $("#cmpCsv")?.addEventListener("click", () => {
      if (!last) return;
      const head = ["Показатель", "Подразделение", "Ед.", "Текущий", "База", "Δ", "Δ %", "Оценка", "Статус база", "Статус текущий"];
      const cell = (v) => (v === null || v === undefined ? "" : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v).replace(/^(-?\d+)\.(\d+)$/, "$1,$2"));
      const lines = [head, ...last.rows.map((x) => [x.title, x.domain_label, x.unit, x.current.value, x.previous.value, x.delta, x.delta_pct, x.trend, STATUS_LABEL[x.previous.status], STATUS_LABEL[x.current.status]])].map((l) => l.map(cell).join(";"));
      const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `compare_${last.current.from}_${last.current.to}_vs_${last.previous.from}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    load();
  }

  /* ------------------------------ Планы и нормативы ------------------------------ */
  async function renderPlans(main) {
    main.innerHTML = topbar("Планы и нормативы KPI", { filters: false }) + '<div id="pg"><div class="skeleton"></div></div>';
    let r;
    try {
      r = await api("/api/plans");
    } catch (err) {
      $("#pg").innerHTML = "";
      return showPageError(err, () => renderPlans(main));
    }
    const ed = r.editable;
    const val = (v) => (v === null || v === undefined ? "" : String(v));
    $("#pg").innerHTML = `
      <div class="banner info">${
        ed
          ? "Плановые значения определяют статус KPI (зелёный / жёлтый / красный) и отклонения на всех экранах. Изменения применяются сразу, сохраняются с обоснованием и пишутся в журнал. Пустое поле — вернуть значение из plans.json."
          : "🔒 Только просмотр. Планы и нормативы ведёт аналитик; каждое изменение фиксируется с обоснованием."
      }</div>
      <form id="plForm" novalidate>
      <div class="card"><h2>Параметры <span class="hint">базовые значения из plans.json от ${fmtDT(r.base_updated_at)}</span></h2>
        <div class="table-wrap"><table class="stack-table"><thead><tr><th>Параметр</th><th>Влияет на KPI</th><th class="num">plans.json</th><th class="num">Действует</th><th>Последнее изменение</th></tr></thead><tbody>${r.fields
          .map(
            (f) => `<tr data-f="${f.id}"><td data-l="Параметр"><b>${esc(f.label)}</b> <span class="hint">${esc(f.unit)}</span></td><td data-l="KPI" class="hint">${f.kpis.map(esc).join(", ")}</td><td class="num" data-l="plans.json">${nf.format(f.base)}</td>
            <td class="num" data-l="Действует">${ed ? `<input class="plan-input" type="number" step="any" min="0" name="${f.id}" value="${esc(val(f.value))}" data-orig="${esc(val(f.value))}" aria-label="${esc(f.label)}"><div class="err"></div>` : `<b>${nf.format(f.value)}</b>`}${f.override ? ' <span class="pill purple">изменено</span>' : ""}</td>
            <td data-l="Изменение" class="hint">${f.override ? `${esc(f.override.by_name)} · ${fmtDT(f.override.at)}<br>${esc(f.override.reason)}` : "—"}</td></tr>`
          )
          .join("")}</tbody></table></div>
        ${
          ed
            ? `<div class="banner error hidden" id="plErr" role="alert" style="margin-top:12px"></div>
          <div class="plan-save"><div class="field" style="flex:1;margin:0"><label for="plReason">Обоснование изменения *</label><input id="plReason" placeholder="Например: утверждён бюджет на IV квартал"></div>
          <button type="submit" class="btn btn-primary" id="plSave">Сохранить изменения</button></div>`
            : ""
        }
      </div></form>
      <div class="card" style="margin-top:16px"><h2>История изменений планов</h2>${
        r.history.length
          ? `<ul class="history">${r.history.map((h) => `<li><b>${esc(h.by_name)}</b> <span class="at">· ${fmtDT(h.at)}</span> — ${esc(h.reason)}<br>${h.changes.map((c) => `${esc(c.label)}: ${nf.format(c.from)} → <b>${nf.format(c.to)}</b> ${esc(c.unit)}`).join("<br>")}</li>`).join("")}</ul>`
          : '<div class="empty">Планы не менялись — действуют значения из plans.json</div>'
      }</div>`;
    if (!ed) return;
    $("#plForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const changes = {};
      $$(".plan-input", main).forEach((x) => {
        if (x.value === x.dataset.orig) return;
        changes[x.name] = x.value.trim() === "" ? null : Number(x.value.replace(",", "."));
      });
      const box = $("#plErr");
      box.classList.add("hidden");
      $$(".plan-input", main).forEach((x) => (x.nextElementSibling.textContent = ""));
      if (!Object.keys(changes).length) {
        box.textContent = "Вы не изменили ни одного значения";
        return box.classList.remove("hidden");
      }
      const btn = $("#plSave");
      btn.disabled = true;
      try {
        const res = await api("/api/plans", { method: "PUT", body: { changes, reason: $("#plReason").value } });
        toast(res.applied.length ? `Планы обновлены: ${res.applied.map((c) => c.label).join(", ")}` : "Значения совпадают с действующими", "ok");
        renderPlans(main);
      } catch (err) {
        box.textContent = err.message + (err.details ? ": " + Object.entries(err.details).map(([k, v]) => (k === "reason" || k === "_" ? v : `${r.fields.find((f) => f.id === k)?.label || k} — ${v}`)).join("; ") : "");
        box.classList.remove("hidden");
        for (const [k, v] of Object.entries(err.details || {})) {
          const inp = $(`.plan-input[name="${k}"]`, main);
          if (inp) inp.nextElementSibling.textContent = v;
        }
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------ Журнал ------------------------------ */
  async function renderAudit(main) {
    main.innerHTML =
      topbar("Журнал действий", { filters: false }) +
      `<form class="filters panel" id="auF" style="margin-bottom:14px"><div class="f"><label for="auU">Пользователь</label><select id="auU"><option value="">Все</option>${DEMO.map(([l]) => `<option>${l}</option>`).join("")}<option value="аноним">аноним</option></select></div>
       <div class="f"><label for="auR">Результат</label><select id="auR"><option value="">Все</option><option value="fail">Только отказы и ошибки</option></select></div>
       <button type="button" class="btn" id="auRef">Обновить</button>
       ${can("data.export") ? '<button type="button" class="btn" id="auCsv">⬇ Выгрузить CSV</button>' : ""}</form>
       <div class="card"><div id="auT"><div class="skeleton"></div></div></div>`;
    const params = () => {
      const p = new URLSearchParams();
      if ($("#auU").value) p.set("user", $("#auU").value);
      if ($("#auR").value) p.set("result", $("#auR").value);
      return p;
    };
    // Объект хранится как путь «Раздел › KPI › Детализация › Запись» — показываем сегменты, последний выделен.
    const pathHtml = (o) => {
      if (!o) return "—";
      const parts = String(o).split(" › ");
      return `<span class="obj-path">${parts.map((x, i) => (i === parts.length - 1 ? `<b>${esc(x)}</b>` : `<span>${esc(x)}</span>`)).join('<i aria-hidden="true">›</i>')}</span>`;
    };
    const load = async () => {
      try {
        const r = await api("/api/audit?" + params());
        $("#auT").innerHTML = r.entries.length
          ? `<p class="hint">Всего записей: ${r.total}${r.total > r.entries.length ? `, показаны последние ${r.entries.length}` : ""}</p><div class="table-wrap"><table class="audit-table"><thead><tr><th>Время</th><th>Пользователь</th><th>Роль</th><th>Действие</th><th>Объект (путь)</th><th>Результат</th></tr></thead><tbody>${r.entries
              .map((a) => `<tr><td class="hint" data-l="Время" style="white-space:nowrap">${fmtDT(a.at)}</td><td data-l="Пользователь">${esc(a.user)}</td><td data-l="Роль">${esc(a.role || "—")}</td><td data-l="Действие">${esc(a.action)}</td><td data-l="Объект">${pathHtml(a.object)}</td><td data-l="Результат"><span class="pill ${a.result === "успех" ? "green" : "red"}">${esc(a.result)}</span></td></tr>`)
              .join("")}</tbody></table></div>`
          : '<div class="empty">Записей нет</div>';
      } catch (err) {
        showPageError(err, load);
      }
    };
    $$("#auF select").forEach((s) => s.addEventListener("change", load));
    $("#auRef").addEventListener("click", load);
    $("#auCsv")?.addEventListener("click", (e) => exportCsv("/api/audit?" + params() + "&format=csv", e.currentTarget));
    load();
  }

  const FIT_PAGES = new Set(["pulse", "sales", "production", "finance", "forecast"]);
  const RENDER = { pulse: renderPulse, sales: renderSales, production: renderProduction, finance: renderFinance, forecast: renderForecast, decisions: renderDecisions, analyst: renderAnalyst, compare: renderCompare, plans: renderPlans, audit: renderAudit };

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
    if (!location.hash) location.hash = "#/" + cabinet().home;
    route();
  }

  window.addEventListener("offline", () => setOnline(false));
  window.addEventListener("online", () => fetch("/api/health").then(() => setOnline(true)).catch(() => {}));
  boot();
})();
