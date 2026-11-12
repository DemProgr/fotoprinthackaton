-- =============================================================================
-- «Пульс компании» — схема базы данных Supabase (PostgreSQL).
-- Шаг 1 из 3: таблицы. Затем: node tools/supabase-seed.js (данные),
-- затем supabase/constraints.sql (внешние ключи между системами).
--
-- Доступ: только сервер приложения по service_role-ключу. RLS включён на всех
-- таблицах без политик — anon/authenticated не видят ничего.
-- =============================================================================

-- ------------------------------- 1. CRM -------------------------------------
create table if not exists crm_clients (
  id          integer primary key,
  full_name   text,
  first_name  text,
  last_name   text,
  company     text,
  email       text,
  phone       text,
  city        text,
  segment     text,
  created_at  date
);

create table if not exists crm_orders (
  id            integer primary key,
  order_number  text unique,
  client_id     integer,            -- → crm_clients.id
  order_date    date,
  status        text,
  amount        double precision,
  product_type  text,
  print_run     integer,
  priority      text
);

create table if not exists crm_requests (
  id           integer primary key,
  order_id     integer,             -- → crm_orders.id
  client_id    integer,             -- → crm_clients.id
  type         text,
  status       text,
  created_at   date,
  resolved_at  date,
  description  text
);

-- ------------------------------- 2. ERP -------------------------------------
create table if not exists erp_machines (
  id            integer primary key,
  name          text,
  type          text,
  status        text,
  location      text,
  installed_at  date
);

create table if not exists erp_shifts (
  id            integer primary key,
  shift_date    date,
  shift_number  integer,
  start_time    text,
  end_time      text,
  operator_id   integer             -- → hr_employees.id
);

create table if not exists erp_production_orders (
  id                       integer primary key,
  production_order_number  text unique,
  order_id                 integer, -- → crm_orders.id
  machine_id               integer, -- → erp_machines.id
  shift_id                 integer, -- → erp_shifts.id
  planned_qty              integer,
  produced_qty             integer,
  defect_qty               integer default 0,
  start_date               date,
  end_date                 date,
  status                   text
);

create table if not exists erp_defects (
  id                   integer primary key,
  production_order_id  integer,     -- → erp_production_orders.id
  order_id             integer,     -- → crm_orders.id
  type                 text,
  qty                  integer,
  reason               text,
  detected_at          timestamp
);

-- ---------------------------- 3. Финансы ------------------------------------
create table if not exists finance_revenue (
  id         integer primary key,
  order_id   integer,               -- → crm_orders.id
  client_id  integer,               -- → crm_clients.id
  amount     double precision,
  date       date,
  source     text
);

create table if not exists finance_expenses (
  id           integer primary key,
  category     text,
  amount       double precision,
  date         date,
  description  text
);

create table if not exists finance_profit (
  id        integer primary key,
  month     text unique,
  revenue   double precision,
  expenses  double precision,
  profit    double precision
);

-- ---------------------------- 4. HR / ЗУП -----------------------------------
create table if not exists hr_departments (
  id       integer primary key,
  name     text,
  head_id  integer                  -- → hr_employees.id
);

create table if not exists hr_employees (
  id             integer primary key,
  full_name      text,
  first_name     text,
  last_name      text,
  department_id  integer,           -- → hr_departments.id
  position       text,
  hire_date      date,
  salary         double precision,
  phone          text
);

create table if not exists hr_schedules (
  id             integer primary key,
  employee_id    integer,           -- → hr_employees.id
  schedule_date  date,
  shift_type     text,
  hours_worked   double precision
);

create table if not exists hr_sick_leaves (
  id           integer primary key,
  employee_id  integer,             -- → hr_employees.id
  start_date   date,
  end_date     date,
  days         integer,
  reason       text
);

-- ------------------------- 5. Приложение «Пульс» ----------------------------
-- Пользователи системы (пароли — только scrypt-хэши в коде сервера).
create table if not exists app_users (
  login          text primary key,
  name           text not null,
  title          text,
  role           text not null check (role in ('director', 'head', 'analyst')),
  department_id  integer,           -- → hr_departments.id (для руководителей)
  domains        text[] not null default '{}'
);

insert into app_users (login, name, title, role, department_id, domains) values
  ('director', 'Анна Директорова',   'Генеральный директор',            'director', null, '{finance,sales,production,hr}'),
  ('prod',     'Павел Цехов',        'Руководитель производства',       'head',     1,    '{production}'),
  ('sales',    'Светлана Продажина', 'Руководитель отдела продаж',      'head',     3,    '{sales}'),
  ('analyst',  'Артём Данных',       'Аналитик / администратор данных', 'analyst',  null, '{finance,sales,production,hr}')
on conflict (login) do update set name = excluded.name, title = excluded.title, role = excluded.role,
  department_id = excluded.department_id, domains = excluded.domains;

-- Реестр управленческих решений.
create table if not exists decisions (
  id               integer primary key,
  number           text not null unique,               -- РЕШ-0001
  title            text not null,
  kpi_id           text,                               -- KPI, из которого создано решение
  domain           text not null check (domain in ('finance', 'sales', 'production', 'hr')),
  problem          text,
  impact           text,
  cause            text,
  action           text,
  owner            text,
  due_date         date,
  priority         text check (priority in ('низкий', 'средний', 'высокий', 'критический')),
  status           text not null default 'новое' check (status in ('новое', 'в работе', 'выполнено', 'отменено')),
  context          jsonb,                              -- срез KPI/фильтров в момент решения
  created_by       text not null references app_users (login),
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  history          jsonb not null default '[]'::jsonb  -- кто/когда/что изменил
);
create index if not exists idx_decisions_domain on decisions (domain);
create index if not exists idx_decisions_created_by on decisions (created_by);

-- Журнал действий пользователей (ОТ-04). Логин без FK: в журнал пишутся и неудачные входы.
create table if not exists audit_log (
  seq         bigint generated always as identity primary key,
  id          text not null unique,
  at          timestamptz not null default now(),
  user_login  text,
  user_name   text,
  role        text,
  action      text,
  object      text,
  result      text,
  details     jsonb,
  ip          text
);
create index if not exists idx_audit_at on audit_log (at desc);
create index if not exists idx_audit_user on audit_log (user_login);

-- Прочее состояние приложения: планы аналитика, статусы проблем качества, отозванные сессии.
create table if not exists app_state (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz not null default now()
);

-- RLS: включён везде, политик нет → доступ только у service_role (сервер).
do $$
declare t text;
begin
  foreach t in array array['crm_clients','crm_orders','crm_requests','erp_machines','erp_shifts',
    'erp_production_orders','erp_defects','finance_revenue','finance_expenses','finance_profit',
    'hr_departments','hr_employees','hr_schedules','hr_sick_leaves','app_users','decisions','audit_log','app_state']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
