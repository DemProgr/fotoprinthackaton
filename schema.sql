-- Схема согласованной базы данных четырёх логических источников:
-- CRM, ERP, Финансовая система, HR/ЗУП.
-- Все данные синтетические, вымышленные, не содержат реальной информации PhotoPrint.
-- Связи между таблицами реализованы по ID (внешние ключи).

PRAGMA foreign_keys = ON;

-- ============================= 1. CRM ======================================
CREATE TABLE crm_clients (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    phone TEXT,
    city TEXT,
    segment TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE crm_orders (
    id INTEGER PRIMARY KEY,
    order_number TEXT NOT NULL UNIQUE,
    client_id INTEGER NOT NULL REFERENCES crm_clients(id),
    order_date TEXT NOT NULL,
    status TEXT NOT NULL,
    amount REAL NOT NULL,
    product_type TEXT NOT NULL,
    print_run INTEGER NOT NULL,
    priority TEXT NOT NULL
);

CREATE TABLE crm_requests (
    id INTEGER PRIMARY KEY,
    order_id INTEGER REFERENCES crm_orders(id),
    client_id INTEGER NOT NULL REFERENCES crm_clients(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    description TEXT
);

-- ============================= 2. ERP ======================================
CREATE TABLE erp_machines (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    location TEXT,
    installed_at TEXT NOT NULL
);

CREATE TABLE erp_shifts (
    id INTEGER PRIMARY KEY,
    shift_date TEXT NOT NULL,
    shift_number INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    operator_id INTEGER REFERENCES hr_employees(id)
);

CREATE TABLE erp_production_orders (
    id INTEGER PRIMARY KEY,
    production_order_number TEXT NOT NULL UNIQUE,
    order_id INTEGER NOT NULL REFERENCES crm_orders(id),
    machine_id INTEGER NOT NULL REFERENCES erp_machines(id),
    shift_id INTEGER NOT NULL REFERENCES erp_shifts(id),
    planned_qty INTEGER NOT NULL,
    produced_qty INTEGER NOT NULL,
    defect_qty INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    status TEXT NOT NULL
);

CREATE TABLE erp_defects (
    id INTEGER PRIMARY KEY,
    production_order_id INTEGER NOT NULL REFERENCES erp_production_orders(id),
    order_id INTEGER REFERENCES crm_orders(id),
    type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    reason TEXT NOT NULL,
    detected_at TEXT NOT NULL
);

-- ============================= 3. Финансовая система =======================
CREATE TABLE finance_revenue (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES crm_orders(id),
    client_id INTEGER NOT NULL REFERENCES crm_clients(id),
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    source TEXT NOT NULL
);

CREATE TABLE finance_expenses (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    description TEXT
);

CREATE TABLE finance_profit (
    id INTEGER PRIMARY KEY,
    month TEXT NOT NULL UNIQUE,
    revenue REAL NOT NULL,
    expenses REAL NOT NULL,
    profit REAL NOT NULL
);

-- ============================= 4. HR / ЗУП =================================
CREATE TABLE hr_departments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    head_id INTEGER REFERENCES hr_employees(id)
);

CREATE TABLE hr_employees (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    department_id INTEGER NOT NULL REFERENCES hr_departments(id),
    position TEXT NOT NULL,
    hire_date TEXT NOT NULL,
    salary REAL NOT NULL,
    phone TEXT NOT NULL
);

CREATE TABLE hr_schedules (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES hr_employees(id),
    schedule_date TEXT NOT NULL,
    shift_type TEXT NOT NULL,
    hours_worked REAL NOT NULL
);

CREATE TABLE hr_sick_leaves (
    id INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES hr_employees(id),
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days INTEGER NOT NULL,
    reason TEXT NOT NULL
);

-- ============================= Индексы =====================================
CREATE INDEX idx_crm_orders_client ON crm_orders(client_id);
CREATE INDEX idx_crm_requests_order ON crm_requests(order_id);
CREATE INDEX idx_crm_requests_client ON crm_requests(client_id);
CREATE INDEX idx_erp_prod_order_order ON erp_production_orders(order_id);
CREATE INDEX idx_erp_prod_order_machine ON erp_production_orders(machine_id);
CREATE INDEX idx_erp_prod_order_shift ON erp_production_orders(shift_id);
CREATE INDEX idx_erp_defects_prod_order ON erp_defects(production_order_id);
CREATE INDEX idx_erp_defects_order ON erp_defects(order_id);
CREATE INDEX idx_erp_shifts_operator ON erp_shifts(operator_id);
CREATE INDEX idx_finance_revenue_order ON finance_revenue(order_id);
CREATE INDEX idx_hr_employees_dept ON hr_employees(department_id);
CREATE INDEX idx_hr_schedules_employee ON hr_schedules(employee_id);
CREATE INDEX idx_hr_sick_leaves_employee ON hr_sick_leaves(employee_id);
