# fotoprinthackaton

MVP for Space Hackaton with Fotoprint.

## Веб-дашборд

KPI-дашборд по макету из `public/photo_2026-11-11_17-42-52.jpg`:

- `index.html`, `styles.css`, `app.js` — статическая страница без сборки;
- интерактивные графики с тултипами, таблица с поиском, донат-диаграмма;
- переключение светлой/тёмной темы;
- адаптивная вёрстка для планшетов и телефонов.

Запуск: открыть `index.html` в браузере или выполнить `python -m http.server 8000` в корне проекта и перейти на `http://127.0.0.1:8000/`.

## Синтетические данные четырёх логических источников

Проект содержит вымышленные синтетические данные для имитации четырёх систем компании:
**CRM**, **ERP**, **Финансовая система**, **HR / ЗУП**. Реальные CRM, ERP и 1С не подключаются —
используются Mock API и синтетические данные (JSON-файлы), согласованные между собой по ID.

## Структура каталогов

```
data/
├── crm/          # clients.json, orders.json, requests.json
├── erp/          # machines.json, shifts.json, production_orders.json, defects.json
├── finance/      # revenue.json, expenses.json, profit.json
└── hr/           # departments.json, employees.json, schedules.json, sick_leaves.json
schema.sql        # Согласованная структура базы (таблицы + внешние ключи)
manifest.json     # Манифест источников, количества строк, связи, проблемные сценарии
generate.py       # Генератор данных (воспроизводимо, seed=42)
validate.py       # Проверка целостности внешних ключей
build_db.py       # Сборка SQLite БД (data/mock.db) из JSON по schema.sql
data/mock.db      # Готовая SQLite база с загруженными данными
```

## Источники данных

| Источник | Таблицы | Описание |
|----------|---------|----------|
| CRM | `clients`, `orders`, `requests` | Клиенты, заказы, обращения |
| ERP | `machines`, `shifts`, `production_orders`, `defects` | Станки, смены, производственные заказы, брак |
| Финансовая система | `revenue`, `expenses`, `profit` | Выручка, расходы, прибыль |
| HR / ЗУП | `departments`, `employees`, `schedules`, `sick_leaves` | Сотрудники, отделы, графики, больничные |

## Объёмы данных

| Таблица | Строк |
|---------|-------|
| clients | 120 |
| orders | 620 (>= 500, как требуется) |
| requests | 210 |
| machines | 18 |
| shifts | 150 |
| production_orders | 432 |
| defects | 98 |
| departments | 9 |
| employees | 72 |
| schedules | 521 |
| sick_leaves | 34 |
| revenue | 471 |
| expenses | 95 |
| profit | 22 (по месяцам) |

## Связи между таблицами (по ID)

- `orders.client_id` → `clients.id`
- `requests.order_id` → `orders.id` (опционально)
- `requests.client_id` → `clients.id`
- `production_orders.order_id` → `orders.id` (CRM)
- `production_orders.machine_id` → `machines.id`
- `production_orders.shift_id` → `shifts.id`
- `shifts.operator_id` → `employees.id` (HR)
- `defects.production_order_id` → `production_orders.id`
- `defects.order_id` → `orders.id` (дублирующая связь для быстрого перехода)
- `revenue.order_id` → `orders.id` (CRM)
- `revenue.client_id` → `clients.id`
- `employees.department_id` → `departments.id`
- `schedules.employee_id` → `employees.id`
- `sick_leaves.employee_id` → `employees.id`

Пример сквозного перехода: **брак → производственный заказ → заказ CRM → клиент → производственная смена**:
`defects.production_order_id` → `erp_production_orders.id` → `erp_production_orders.order_id`
→ `crm_orders.id` → `crm_orders.client_id` → `crm_clients.id` и
`erp_production_orders.shift_id` → `erp_shifts.id`.

## Проблемные сценарии для демонстрации

Готово 7 заранее подготовленных проблемных ситуаций (см. `manifest.json` → `problem_scenarios`):

1. Брак с `production_order_id = 999999`, к которому нет производственного заказа (сирота).
2. Производственный заказ со ссылкой на несуществующий CRM-заказ `order_id = 999999` (разорванная связь).
3. Выручка по несуществующему заказу `order_id = 999998` и клиенту `client_id = 999997`.
4. Брак больше, чем изготовлено (`defect_qty > produced_qty`) — невозможная ситуация.
5. Сотрудник на больничном, но имеет смену в тот же день (конфликт графика).
6. Заказ со статусом «отгружен», но без записи о выручке (потеря денег).
7. Дефект, обнаруженный после завершения производственного заказа.

## Как использовать

```bash
# Перегенерировать данные (seed=42, результат воспроизводим)
python generate.py

# Проверить целостность связей
python validate.py
```

Все JSON-файлы можно отдавать как Mock API эндпоинты respective систем.

## Валидация

При корректной генерации `validate.py` сообщает об отсутствии ошибок, за исключением заранее
созданных проблемных сценариев с несуществующими ID (999999, 999998) — они нужны для демонстрации.
