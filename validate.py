# -*- coding: utf-8 -*-
import json, os, sys
from datetime import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")

def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)

errors = []
warns = []

clients = load("crm/clients.json")
orders = load("crm/orders.json")
requests = load("crm/requests.json")
machines = load("erp/machines.json")
shifts = load("erp/shifts.json")
prod_orders = load("erp/production_orders.json")
defects = load("erp/defects.json")
departments = load("hr/departments.json")
employees = load("hr/employees.json")
schedules = load("hr/schedules.json")
sick_leaves = load("hr/sick_leaves.json")
revenue = load("finance/revenue.json")
expenses = load("finance/expenses.json")
profit = load("finance/profit.json")

client_ids = {c["id"] for c in clients}
order_ids = {o["id"] for o in orders}
machine_ids = {m["id"] for m in machines}
shift_ids = {s["id"] for s in shifts}
prod_ids = {p["id"] for p in prod_orders}
dept_ids = {d["id"] for d in departments}
emp_ids = {e["id"] for e in employees}

# CRM links
for o in orders:
    if o["client_id"] not in client_ids:
        errors.append(f"order {o['id']}: client_id {o['client_id']} not found")
for r in requests:
    if r["client_id"] not in client_ids:
        errors.append(f"request {r['id']}: client_id {r['client_id']} not found")
    if r["order_id"] is not None and r["order_id"] not in order_ids:
        errors.append(f"request {r['id']}: order_id {r['order_id']} not found")

# ERP links
for p in prod_orders:
    if p["order_id"] not in order_ids:
        errors.append(f"production_order {p['id']}: order_id {p['order_id']} not found in CRM")
    if p["machine_id"] not in machine_ids:
        errors.append(f"production_order {p['id']}: machine_id {p['machine_id']} not found")
    if p["shift_id"] not in shift_ids:
        errors.append(f"production_order {p['id']}: shift_id {p['shift_id']} not found")
    if p["defect_qty"] > p["produced_qty"]:
        warns.append(f"production_order {p['id']}: defect_qty {p['defect_qty']} > produced_qty {p['produced_qty']}")
    try:
        sd = datetime.fromisoformat(p["start_date"]); ed = datetime.fromisoformat(p["end_date"])
        if ed < sd:
            errors.append(f"production_order {p['id']}: end_date < start_date")
    except Exception as e:
        errors.append(f"production_order {p['id']}: date parse {e}")

for d in defects:
    if d["production_order_id"] not in prod_ids:
        errors.append(f"defect {d['id']}: production_order_id {d['production_order_id']} not found")
    elif d["order_id"] is not None and d["order_id"] not in order_ids:
        errors.append(f"defect {d['id']}: order_id {d['order_id']} not found")
    po = next((p for p in prod_orders if p["id"] == d["production_order_id"]), None)
    if po and d["qty"] > po["produced_qty"]:
        warns.append(f"defect {d['id']}: qty {d['qty']} > produced_qty {po['produced_qty']} of PO {po['id']}")
    if po:
        try:
            det = datetime.fromisoformat(d["detected_at"]); ed = datetime.fromisoformat(po["end_date"])
            if det > ed:
                warns.append(f"defect {d['id']}: detected after PO end_date")
        except Exception:
            pass

# HR links
for e in employees:
    if e["department_id"] not in dept_ids:
        errors.append(f"employee {e['id']}: department_id {e['department_id']} not found")
for d in departments:
    if d["head_id"] is not None and d["head_id"] not in emp_ids:
        errors.append(f"department {d['id']}: head_id {d['head_id']} not found")
for s in schedules:
    if s["employee_id"] not in emp_ids:
        errors.append(f"schedule {s['id']}: employee_id {s['employee_id']} not found")
for sl in sick_leaves:
    if sl["employee_id"] not in emp_ids:
        errors.append(f"sick_leave {sl['id']}: employee_id {sl['employee_id']} not found")

# Finance links
for r in revenue:
    if r["order_id"] not in order_ids:
        errors.append(f"revenue {r['id']}: order_id {r['order_id']} not found in CRM")
    if r["client_id"] not in client_ids:
        errors.append(f"revenue {r['id']}: client_id {r['client_id']} not found")

# Cross-check: order -> client -> ... path exists (defect -> po -> order -> client)
defect_paths = 0
for d in defects:
    po = next((p for p in prod_orders if p["id"] == d["production_order_id"]), None)
    if po and po["order_id"] in order_ids:
        order = next(o for o in orders if o["id"] == po["order_id"])
        if order["client_id"] in client_ids:
            defect_paths += 1
print(f"Defects with full path to client: {defect_paths}/{len(defects)}")

# Counts
print(f"orders: {len(orders)} (need >= 500)")
print(f"clients: {len(clients)}")
print(f"production_orders: {len(prod_orders)}")
print(f"defects: {len(defects)}")

if errors:
    print("\nERRORS:")
    for e in errors:
        print("  -", e)
    sys.exit(1)
else:
    print("\nВсе внешние ключи валидны (кроме заранее созданных проблемных сценариев с id=999999).")

if warns:
    print("\nWARNINGS (проблемные сценарии для демо):")
    for w in warns:
        print("  -", w)

print("\nВалидация пройдена.")
