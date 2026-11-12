# -*- coding: utf-8 -*-
"""
Генератор синтетических данных для четырёх логических источников:
CRM, ERP, Финансовая система, HR/ЗУП.

Все данные вымышленные, не содержат реальной информации PhotoPrint.
Таблицы связаны между собой по ID. Генерируются также заранее подготовленные
проблемные ситуации для демонстрации.
"""
import json
import os
import random
from datetime import date, datetime, timedelta

RANDOM_SEED = 42
random.seed(RANDOM_SEED)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

# ---------------------------- Справочники имён -------------------------------
FIRST_NAMES_M = [
    "Александр", "Дмитрий", "Максим", "Сергей", "Андрей", "Алексей", "Илья",
    "Никита", "Евгений", "Владислав", "Олег", "Иван", "Артем", "Денис",
    "Роман", "Кирилл", "Михаил", "Павел", "Виктор", "Антон",
]
FIRST_NAMES_F = [
    "Елена", "Ольга", "Анна", "Мария", "Наталья", "Ирина", "Татьяна",
    "Екатерина", "Светлана", "Юлия", "Виктория", "Анастасия", "Дарья",
    "Ксения", "Алиса", "София", "Полина", "Валерия", "Милана", "Алиса",
]
LAST_NAMES_M = [
    "Иванов", "Смирнов", "Кузнецов", "Попов", "Васильев", "Петров", "Соколов",
    "Михайлов", "Новиков", "Фёдоров", "Морозов", "Алексеев", "Лебедев",
    "Семёнов", "Егоров", "Павлов", "Козлов", "Степин", "Баранов", "Зайцев",
]
LAST_NAMES_F = [
    "Иванова", "Смирнова", "Кузнецова", "Попова", "Васильева", "Петрова",
    "Соколова", "Михайлова", "Новикова", "Фёдорова", "Морозова", "Алексеева",
    "Лебедева", "Семёнова", "Егорова", "Павлова", "Козлова", "Степанова",
    "Баранова", "Зайцева",
]
COMPANIES = [
    "ООО «Печатный двор»", "ЗАО «Типография Авангард»", "ИП Смирнов А.В.",
    "ООО «АртПринт»", "ООО «МедиаРеклама»", "ЗАО «ОфсетПлюс»",
    "ИП Кузнецова М.П.", "ООО «ДизайнПринт»", "ООО «Бумажный век»",
    "ЗАО «Полиграфия-24»", "ИП Орлов Д.С.", "ООО «ВизуалБренд»",
    "ООО «Широкоформат»", "ЗАО «Цветная печать»", "ИП Михайлов И.Н.",
]
CITIES = [
    "Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург",
    "Казань", "Нижний Новгород", "Самара", "Омск", "Челябинск",
    "Ростов-на-Дону", "Уфа", "Волгоград", "Пермь", "Красноярск",
]
SEGMENTS = ["Розница", "B2B", "Госсектор", "Агентство", "Франшиза"]
ORDER_STATUSES = ["новый", "в работе", "печать", "готов к отгрузке", "отгружен", "закрыт", "отменён"]
PRODUCT_TYPES = [
    "фотоальбом", "брошюра", "календарь", "открытка", "плакат",
    "баннер", "визитка", "каталог", "наклейка", "фотоотпечаток",
]
REQUEST_TYPES = ["жалоба", "вопрос", "изменение заказа", "техподдержка", "возврат"]
REQUEST_STATUSES = ["открыт", "в обработке", "решён", "закрыт", "отклонён"]
MACHINE_TYPES = ["цифровая печать", "офсет", "широкоформат", " post-обработка", "ламинация"]
MACHINE_STATUSES = ["активен", "на обслуживании", "простой", "выведен из эксплуатации"]
SHIFT_NUMBERS = [1, 2, 3]
DEFECT_TYPES = [
    "цветовое отклонение", "помятость бумаги", "дефект печати",
    "брак резки", "пятна", "перекос изображения", "дефект ламинации",
]
DEFECT_REASONS = [
    "износ оборудования", "ошибка оператора", "брак материала",
    "настройка оборудования", "загрязнение головы печати",
]
EXPENSE_CATEGORIES = [
    "сырьё и материалы", "зарплата", "аренда оборудования",
    "коммунальные услуги", "транспорт и логистика", "маркетинг",
    "ремонт оборудования", "прочее",
]

# ----------------------------- Вспомогательные ------------------------------
def rand_name():
    if random.random() < 0.5:
        first = random.choice(FIRST_NAMES_M)
        last = random.choice(LAST_NAMES_M)
    else:
        first = random.choice(FIRST_NAMES_F)
        last = random.choice(LAST_NAMES_F)
    return first, last

def rand_date(start, end):
    delta = (end - start).days
    return start + timedelta(days=random.randint(0, delta))

def rand_datetime(start, end):
    delta = (end - start).days * 24 * 3600 + (end - start).seconds
    return start + timedelta(seconds=random.randint(0, delta))

def iso(d):
    return d.isoformat() if isinstance(d, (date, datetime)) else str(d)

def jdump(name, obj):
    path = os.path.join(DATA_DIR, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return path

START_DATE = date(2025, 1, 1)
END_DATE = date(2026, 10, 31)

# ============================= 1. CRM =======================================
print("Генерация CRM...")
N_CLIENTS = 120
clients = []
for i in range(1, N_CLIENTS + 1):
    first, last = rand_name()
    clients.append({
        "id": i,
        "full_name": f"{last} {first}",
        "first_name": first,
        "last_name": last,
        "company": random.choice(COMPANIES),
        "email": f"{first.lower()}.{last.lower()}{i}@example.ru",
        "phone": f"+7{random.randint(9000000000, 9999999999)}",
        "city": random.choice(CITIES),
        "segment": random.choice(SEGMENTS),
        "created_at": iso(rand_date(START_DATE, END_DATE)),
    })

N_ORDERS = 620
orders = []
for i in range(1, N_ORDERS + 1):
    client_id = random.randint(1, N_CLIENTS)
    order_date = rand_date(START_DATE, END_DATE)
    status = random.choice(ORDER_STATUSES)
    product = random.choice(PRODUCT_TYPES)
    print_run = random.randint(10, 5000)
    amount = round(random.uniform(3000, 350000), 2)
    orders.append({
        "id": i,
        "order_number": f"ORD-{2025}{i:05d}",
        "client_id": client_id,
        "order_date": iso(order_date),
        "status": status,
        "amount": amount,
        "product_type": product,
        "print_run": print_run,
        "priority": random.choice(["низкий", "средний", "высокий"]),
    })

N_REQUESTS = 210
requests = []
for i in range(1, N_REQUESTS + 1):
    order_id = random.randint(1, N_ORDERS) if random.random() < 0.8 else None
    client_id = random.randint(1, N_CLIENTS)
    created = rand_date(START_DATE, END_DATE)
    status = random.choice(REQUEST_STATUSES)
    resolved = iso(rand_date(created, END_DATE)) if status in ("решён", "закрыт") else None
    requests.append({
        "id": i,
        "order_id": order_id,
        "client_id": client_id,
        "type": random.choice(REQUEST_TYPES),
        "status": status,
        "created_at": iso(created),
        "resolved_at": resolved,
        "description": random.choice([
            "Не пришёл заказ в срок", "Качество печати неудовлетворительное",
            "Требуется изменение макета", "Вопрос по оплате",
            "Повреждена упаковка", "Нужна консультация по материалам",
        ]),
    })

# ============================= 2. ERP =======================================
print("Генерация ERP...")
N_MACHINES = 18
machines = []
for i in range(1, N_MACHINES + 1):
    machines.append({
        "id": i,
        "name": f"Станок №{i:02d}",
        "type": random.choice(MACHINE_TYPES),
        "status": random.choice(MACHINE_STATUSES),
        "location": f"Цех {random.randint(1, 3)}",
        "installed_at": iso(rand_date(date(2020, 1, 1), date(2024, 12, 31))),
    })

# Смены: каждая привязана к сотруднику из HR (заполнится позже ID)
N_SHIFTS = 150
shifts = []
shift_start = datetime(2025, 1, 1, 6, 0, 0)
shift_end = datetime(2026, 10, 31, 23, 0, 0)
for i in range(1, N_SHIFTS + 1):
    sday = rand_date(START_DATE, END_DATE)
    shift_num = random.choice(SHIFT_NUMBERS)
    if shift_num == 1:
        st, en = "08:00", "16:00"
    elif shift_num == 2:
        st, en = "16:00", "00:00"
    else:
        st, en = "00:00", "08:00"
    shifts.append({
        "id": i,
        "shift_date": iso(sday),
        "shift_number": shift_num,
        "start_time": st,
        "end_time": en,
        "operator_id": None,  # будет заполнено после генерации сотрудников
    })

# Производственные заказы: у каждого есть order_id -> CRM.order
# Часть заказов CRM не уходит в производство (остаются только цифровая печать вне цеха)
N_PROD_ORDERS = 430
prod_orders = []
used_order_ids = random.sample(range(1, N_ORDERS + 1), N_PROD_ORDERS)
for idx, order_id in enumerate(used_order_ids, start=1):
    machine_id = random.randint(1, N_MACHINES)
    shift_id = random.randint(1, N_SHIFTS)
    planned_qty = random.randint(50, 5000)
    produced_qty = random.randint(int(planned_qty * 0.6), planned_qty)
    # обычно брак <= произведено, но для проблемных сценариев сделаем исключения отдельно
    defect_qty = random.randint(0, max(0, int(produced_qty * 0.08)))
    start_d = rand_date(START_DATE, END_DATE)
    end_d = rand_date(start_d, min(start_d + timedelta(days=10), END_DATE))
    prod_orders.append({
        "id": idx,
        "production_order_number": f"PROD-{2025}{idx:05d}",
        "order_id": order_id,          # <- связь с CRM заказом
        "machine_id": machine_id,
        "shift_id": shift_id,
        "planned_qty": planned_qty,
        "produced_qty": produced_qty,
        "defect_qty": defect_qty,
        "start_date": iso(start_d),
        "end_date": iso(end_d),
        "status": random.choice(["запланирован", "в работе", "завершён", "остановлен"]),
    })

N_DEFECTS = 95
defects = []
for i in range(1, N_DEFECTS + 1):
    po = random.choice(prod_orders)
    defects.append({
        "id": i,
        "production_order_id": po["id"],
        "order_id": po["order_id"],          # <- дублирующая связь для быстрого перехода
        "type": random.choice(DEFECT_TYPES),
        "qty": random.randint(1, max(1, int(po["produced_qty"] * 0.05))),
        "reason": random.choice(DEFECT_REASONS),
        "detected_at": iso(rand_datetime(
            datetime.fromisoformat(po["start_date"]),
            datetime.fromisoformat(po["end_date"]),
        )),
    })

# ============================= 3. HR/ЗУП ====================================
print("Генерация HR/ЗУП...")
N_DEPTS = 9
departments = []
dept_names = [
    "Производство", "Логистика", "Отдел продаж", "Бухгалтерия",
    "Отдел кадров", "ИТ", "Контроль качества", "Закупки", "Администрация",
]
for i in range(1, N_DEPTS + 1):
    departments.append({
        "id": i,
        "name": dept_names[i - 1],
        "head_id": None,  # заполним после сотрудников
    })

N_EMPLOYEES = 72
employees = []
for i in range(1, N_EMPLOYEES + 1):
    first, last = rand_name()
    dept_id = random.randint(1, N_DEPTS)
    employees.append({
        "id": i,
        "full_name": f"{last} {first}",
        "first_name": first,
        "last_name": last,
        "department_id": dept_id,
        "position": random.choice([
            "Оператор станка", "Мастер смены", "Менеджер по продажам",
            "Бухгалтер", "Специалист отдела кадров", "Системный администратор",
            "Инженер по качеству", "Менеджер по закупкам", "Водитель",
            "Кладовщик", "Дизайнер",
        ]),
        "hire_date": iso(rand_date(date(2018, 1, 1), date(2024, 12, 31))),
        "salary": round(random.uniform(35000, 180000), 2),
        "phone": f"+7{random.randint(9000000000, 9999999999)}",
    })

# Назначим руководителей отделов из сотрудников того же отдела
for dept in departments:
    dept_emps = [e["id"] for e in employees if e["department_id"] == dept["id"]]
    if dept_emps:
        dept["head_id"] = random.choice(dept_emps)

# Привяжем операторов к сменам (операторы станков)
operator_candidates = [e["id"] for e in employees if "станок" in e["position"] or "мастер" in e["position"]]
if not operator_candidates:
    operator_candidates = [e["id"] for e in employees]
for sh in shifts:
    sh["operator_id"] = random.choice(operator_candidates)

N_SCHEDULES = 520
schedules = []
for i in range(1, N_SCHEDULES + 1):
    emp = random.choice(employees)
    sday = rand_date(START_DATE, END_DATE)
    schedules.append({
        "id": i,
        "employee_id": emp["id"],
        "schedule_date": iso(sday),
        "shift_type": random.choice(["день", "ночь", "выходной"]),
        "hours_worked": round(random.uniform(0, 12), 2),
    })

N_SICK = 34
sick_leaves = []
for i in range(1, N_SICK + 1):
    emp = random.choice(employees)
    start = rand_date(START_DATE, END_DATE)
    days = random.randint(1, 14)
    end = start + timedelta(days=days - 1)
    sick_leaves.append({
        "id": i,
        "employee_id": emp["id"],
        "start_date": iso(start),
        "end_date": iso(end),
        "days": days,
        "reason": random.choice(["ОРВИ", "Травма", "Плановая операция", "Реабилитация", "Болезнь ребёнка"]),
    })

# ============================= 4. Финансы ===================================
print("Генерация Финансы...")
N_REVENUE = 470
revenue = []
for i in range(1, N_REVENUE + 1):
    order_id = random.randint(1, N_ORDERS)
    order = next(o for o in orders if o["id"] == order_id)
    rev_date = rand_date(
        datetime.fromisoformat(order["order_date"]).date(),
        min(datetime.fromisoformat(order["order_date"]).date() + timedelta(days=30), END_DATE),
    )
    # выручка может быть полной или частичной (частичная оплата)
    amount = round(order["amount"] * random.choice([0.5, 0.7, 1.0, 1.0, 1.0]), 2)
    revenue.append({
        "id": i,
        "order_id": order_id,
        "client_id": order["client_id"],
        "amount": amount,
        "date": iso(rev_date),
        "source": random.choice(["наличные", "безналичный расчёт", "онлайн-оплата"]),
    })

N_EXPENSES = 95
expenses = []
for i in range(1, N_EXPENSES + 1):
    ex_date = rand_date(START_DATE, END_DATE)
    expenses.append({
        "id": i,
        "category": random.choice(EXPENSE_CATEGORIES),
        "amount": round(random.uniform(5000, 250000), 2),
        "date": iso(ex_date),
        "description": random.choice([
            "Закупка бумаги", "Оплата электроэнергии", "Зарплата персонала",
            "Ремонт станка", "Доставка заказов", "Рекламная кампания",
            "Аренда помещения", "Канцелярия",
        ]),
    })

# Прибыль по месяцам (агрегировано)
profit = []
cur = date(2025, 1, 1)
while cur <= END_DATE:
    month_start = cur.replace(day=1)
    if month_start.month == 12:
        month_end = date(month_start.year + 1, 1, 1) - timedelta(days=1)
    else:
        month_end = date(month_start.year, month_start.month + 1, 1) - timedelta(days=1)
    rev_m = sum(r["amount"] for r in revenue if month_start <= datetime.fromisoformat(r["date"]).date() <= month_end)
    exp_m = sum(e["amount"] for e in expenses if month_start <= datetime.fromisoformat(e["date"]).date() <= month_end)
    profit.append({
        "id": len(profit) + 1,
        "month": month_start.strftime("%Y-%m"),
        "revenue": round(rev_m, 2),
        "expenses": round(exp_m, 2),
        "profit": round(rev_m - exp_m, 2),
    })
    cur = (month_end + timedelta(days=1))

# ===================== Проблемные сценарии (демонстрация) ===================
print("Добавление проблемных сценариев...")

# 1. Брак без производственного заказа (сирота)
defects.append({
    "id": N_DEFECTS + 1,
    "production_order_id": 999999,
    "order_id": None,
    "type": "дефект печати",
    "qty": 120,
    "reason": "износ оборудования",
    "detected_at": iso(rand_date(START_DATE, END_DATE)),
})

# 2. Производственный заказ со ссылкой на несуществующий CRM-заказ
prod_orders.append({
    "id": N_PROD_ORDERS + 1,
    "production_order_number": f"PROD-{2025}{N_PROD_ORDERS+1:05d}",
    "order_id": 999999,  # не существует в CRM
    "machine_id": 1,
    "shift_id": 1,
    "planned_qty": 1000,
    "produced_qty": 900,
    "defect_qty": 50,
    "start_date": iso(_po_start := rand_date(START_DATE, END_DATE)),
    "end_date": iso(rand_date(_po_start, END_DATE)),
    "status": "завершён",
})

# 3. Выручка по несуществующему заказу
revenue.append({
    "id": N_REVENUE + 1,
    "order_id": 999998,
    "client_id": 999997,
    "amount": 50000.00,
    "date": iso(rand_date(START_DATE, END_DATE)),
    "source": "безналичный расчёт",
})

# 4. Брак больше Released (невозможная ситуация)
bad_po = random.choice(prod_orders)
defects.append({
    "id": N_DEFECTS + 2,
    "production_order_id": bad_po["id"],
    "order_id": bad_po["order_id"],
    "type": "брак резки",
    "qty": bad_po["produced_qty"] + 100,
    "reason": "ошибка оператора",
    "detected_at": iso(rand_date(START_DATE, END_DATE)),
})

# 5. Сотрудник на больничном, но имеет смену в тот же день (конфликт графика)
sick_emp = random.choice(sick_leaves)
sick_start = datetime.fromisoformat(sick_emp["start_date"]).date()
schedules.append({
    "id": N_SCHEDULES + 1,
    "employee_id": sick_emp["employee_id"],
    "schedule_date": iso(sick_start),
    "shift_type": "день",
    "hours_worked": 8.0,
})

# 6. Заказ со статусом «отгружен», но без выручки (потеря денег)
shipped_without_rev = [o for o in orders if o["status"] == "отгружен"
                       and o["id"] not in {r["order_id"] for r in revenue}]
if shipped_without_rev:
    po = random.choice(shipped_without_rev)
    prod_orders.append({
        "id": N_PROD_ORDERS + 2,
        "production_order_number": f"PROD-{2025}{N_PROD_ORDERS+2:05d}",
        "order_id": po["id"],
        "machine_id": random.randint(1, N_MACHINES),
        "shift_id": random.randint(1, N_SHIFTS),
        "planned_qty": random.randint(100, 1000),
        "produced_qty": random.randint(100, 1000),
        "defect_qty": 0,
        "start_date": iso(rand_date(START_DATE, END_DATE)),
        "end_date": iso(rand_date(START_DATE, END_DATE)),
        "status": "завершён",
    })

# 7. Дефект, 발견ный после завершения производственного заказа
late_po = random.choice([p for p in prod_orders if p["status"] == "завершён"])
defects.append({
    "id": N_DEFECTS + 3,
    "production_order_id": late_po["id"],
    "order_id": late_po["order_id"],
    "type": "цветовое отклонение",
    "qty": random.randint(1, 30),
    "reason": "настройка оборудования",
    "detected_at": iso(
        datetime.fromisoformat(late_po["end_date"]) + timedelta(days=random.randint(1, 7))
    ),
})

# Пересчёт идентификаторов после вставок
for i, d in enumerate(defects, start=1):
    d["id"] = i
for i, p in enumerate(prod_orders, start=1):
    p["id"] = i
for i, s in enumerate(schedules, start=1):
    s["id"] = i
for i, r in enumerate(revenue, start=1):
    r["id"] = i

# ============================= Сохранение ===================================
print("Сохранение файлов...")
jdump("crm/clients.json", clients)
jdump("crm/orders.json", orders)
jdump("crm/requests.json", requests)

jdump("erp/machines.json", machines)
jdump("erp/shifts.json", shifts)
jdump("erp/production_orders.json", prod_orders)
jdump("erp/defects.json", defects)

jdump("finance/revenue.json", revenue)
jdump("finance/expenses.json", expenses)
jdump("finance/profit.json", profit)

jdump("hr/departments.json", departments)
jdump("hr/employees.json", employees)
jdump("hr/schedules.json", schedules)
jdump("hr/sick_leaves.json", sick_leaves)

# Индекс/манифест источников
manifest = {
    "generated_at": datetime.now().isoformat(),
    "seed": RANDOM_SEED,
    "sources": {
        "CRM": {
            "description": "Клиенты, заказы, обращения",
            "tables": ["clients", "orders", "requests"],
            "files": ["data/crm/clients.json", "data/crm/orders.json", "data/crm/requests.json"],
        },
        "ERP": {
            "description": "Производственные заказы, станки, смены, брак",
            "tables": ["machines", "shifts", "production_orders", "defects"],
            "files": ["data/erp/machines.json", "data/erp/shifts.json", "data/erp/production_orders.json", "data/erp/defects.json"],
        },
        "Финансовая система": {
            "description": "Выручка, расходы, прибыль",
            "tables": ["revenue", "expenses", "profit"],
            "files": ["data/finance/revenue.json", "data/finance/expenses.json", "data/finance/profit.json"],
        },
        "HR / ЗУП": {
            "description": "Сотрудники, отделы, графики, больничные",
            "tables": ["departments", "employees", "schedules", "sick_leaves"],
            "files": ["data/hr/departments.json", "data/hr/employees.json", "data/hr/schedules.json", "data/hr/sick_leaves.json"],
        },
    },
    "counts": {
        "clients": len(clients),
        "orders": len(orders),
        "requests": len(requests),
        "machines": len(machines),
        "shifts": len(shifts),
        "production_orders": len(prod_orders),
        "defects": len(defects),
        "departments": len(departments),
        "employees": len(employees),
        "schedules": len(schedules),
        "sick_leaves": len(sick_leaves),
        "revenue": len(revenue),
        "expenses": len(expenses),
        "profit": len(profit),
    },
    "key_links": [
        "orders.client_id -> clients.id",
        "requests.order_id -> orders.id",
        "production_orders.order_id -> orders.id",
        "production_orders.machine_id -> machines.id",
        "production_orders.shift_id -> shifts.id",
        "shifts.operator_id -> employees.id",
        "defects.production_order_id -> production_orders.id",
        "revenue.order_id -> orders.id",
        "employees.department_id -> departments.id",
        "schedules.employee_id -> employees.id",
        "sick_leaves.employee_id -> employees.id",
    ],
    "problem_scenarios": [
        "Брак с production_order_id=999999 без производственного заказа (сирота)",
        "Производственный заказ со ссылкой на несуществующий CRM-заказ order_id=999999",
        "Выручка по несуществующему заказу order_id=999998",
        "Бракованного больше, чем изготовлено (defeat_qty > produced_qty)",
        "Сотрудник на больничном, но имеющий смену в тот же день (конфликт графика)",
        "Заказ со статусом «отгружен», но без записи о выручке (потеря денег)",
        "Дефект, обнаруженный после завершения производственного заказа",
    ],
}
jdump("manifest.json", manifest)

print("Готово. Файлы:")
for k, v in manifest["counts"].items():
    print(f"  {k}: {v}")
