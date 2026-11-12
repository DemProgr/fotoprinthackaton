# -*- coding: utf-8 -*-
"""Сборка SQLite БД из JSON-файлов по schema.sql."""
import json, os, sqlite3, sys

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")
DB_PATH = os.path.join(BASE, "data", "mock.db")

TABLE_FILES = {
    "crm_clients": "crm/clients.json",
    "crm_orders": "crm/orders.json",
    "crm_requests": "crm/requests.json",
    "erp_machines": "erp/machines.json",
    "erp_shifts": "erp/shifts.json",
    "erp_production_orders": "erp/production_orders.json",
    "erp_defects": "erp/defects.json",
    "finance_revenue": "finance/revenue.json",
    "finance_expenses": "finance/expenses.json",
    "finance_profit": "finance/profit.json",
    "hr_departments": "hr/departments.json",
    "hr_employees": "hr/employees.json",
    "hr_schedules": "hr/schedules.json",
    "hr_sick_leaves": "hr/sick_leaves.json",
}

def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)

def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    with open(os.path.join(BASE, "schema.sql"), encoding="utf-8") as f:
        cur.executescript(f.read())

    cur.execute("PRAGMA foreign_keys = OFF")

    # Вставка в порядке зависимостей (родители primero)
    order = [
        "crm_clients", "crm_orders", "crm_requests",
        "erp_machines", "erp_shifts",
        "hr_departments", "hr_employees",
        "erp_production_orders", "erp_defects",
        "finance_revenue", "finance_expenses", "finance_profit",
        "hr_schedules", "hr_sick_leaves",
    ]
    for table in order:
        rows = load(TABLE_FILES[table])
        if not rows:
            continue
        cols = list(rows[0].keys())
        placeholders = ",".join("?" for _ in cols)
        colspec = ",".join(cols)
        sql = f"INSERT OR IGNORE INTO {table} ({colspec}) VALUES ({placeholders})"
        for r in rows:
            cur.execute(sql, [r[c] for c in cols])
    conn.commit()

    # Включаем enforce для финальной проверки
    cur.execute("PRAGMA foreign_keys = ON")

    # Проверка целостности
    bad = 0
    for table, fk_col in [
        ("crm_orders", "client_id"),
        ("erp_production_orders", "order_id"),
        ("erp_defects", "production_order_id"),
        ("finance_revenue", "order_id"),
        ("hr_employees", "department_id"),
        ("hr_schedules", "employee_id"),
    ]:
        cur.execute(f"SELECT COUNT(*) FROM {table} WHERE {fk_col} IS NOT NULL")
        total = cur.fetchone()[0]
        print(f"{table}.{fk_col}: {total} строк с FK")

    cur.execute("PRAGMA foreign_key_check")
    fk_issues = cur.fetchall()
    print("\nFK violations (кроме намеренных 999999/999998):")
    for row in fk_issues:
        print("  ", row)
    if not fk_issues:
        print("  なし — все связи целы")

    conn.close()
    print(f"\nБД собрана: {DB_PATH}")

if __name__ == "__main__":
    main()
