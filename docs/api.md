# REST API

Базовый адрес: `http://localhost:3000/api`. Формат — JSON (UTF-8). Все методы, кроме `/login` и `/health`,
требуют заголовок `Authorization: Bearer <token>`. Ошибки: `{ "error": "текст на русском", "details": {...} }`
с кодами 400 (некорректный запрос), 401 (нет входа), 403 (нет прав), 404, 413, 422 (ошибка валидации), 500.

Время — ISO 8601 с часовым поясом (`2026-11-11T18:40:00+03:00`); денежные значения — в белорусских рублях BYN (`unit: "BYN"`).

## Фильтры (query-параметры для KPI и экранов)

| Параметр | Значения |
|---|---|
| `period` | `30d`, `90d` (по умолчанию), `180d`, `365d`, `all`, `custom` |
| `from`, `to` | `ГГГГ-ММ-ДД`, обязательны при `period=custom` |
| `product` | тип продукта (`календарь`, `фотоальбом`, …) |
| `domain` | `finance`, `sales`, `production`, `hr` |

## Методы

| Метод | Путь | Права | Описание |
|---|---|---|---|
| POST | `/login` | — | `{login, password}` → `{token, user}` |
| POST | `/logout` | вход | завершить сессию |
| GET | `/me` | вход | пользователь, права, справочники (продукты, домены, «сегодня») |
| GET | `/health` | — | проверка доступности |
| GET | `/kpi` | kpi.view | KPI доступных доменов: `value, plan, forecast, status, deviation_pct, series[], formula, sources[], updated_at, data_until`; `critical[]`; `hidden_domains[]` |
| GET | `/kpi/:id/drill?dim=` | домен KPI | группы разреза: `rows[{key, value, count, share_pct, status}]`, `explanation` |
| GET | `/kpi/:id/records?dim=&key=` | домен KPI | первичные записи группы (до 300), ссылки на заказы |
| GET | `/orders/:id` | sales или production | сквозная карточка: CRM-заказ, клиент, производство + станок + смена/оператор, дефекты, обращения, оплаты |
| GET | `/screens/sales` | sales | воронка, каналы, сегменты, продукты, отток |
| GET | `/screens/production` | production | план/факт по месяцам, очередь, станки, причины брака |
| GET | `/screens/finance` | finance | БДР план/факт, БДДС, штат/факт по подразделениям |
| GET | `/forecast` | forecast.view | 26 недель истории, 8 недель прогноза спроса и мощности, `first_deficit_week` |
| GET | `/decisions?status=&priority=&domain=&q=` | decision.view | решения своих доменов (`overdue` — просрочено) |
| POST | `/decisions` | decision.create + домен | создать решение |
| PATCH | `/decisions/:id` | decision.edit + домен | изменить поля/статус, запись в `history` |
| GET | `/quality` | quality.view | свежесть источников, проблемы качества, сверка финансов |
| POST | `/admin/reload` | quality.reload | перечитать `data/*.json` |
| PATCH | `/quality/issues` | quality.manage | разбор проблемы данных: `{key, status, assignee, comment}` |
| GET | `/plans` | plans.view | планы и нормативы KPI: база из plans.json, действующее значение, история |
| PUT | `/plans` | plans.edit | `{changes: {"targets.defect_pct": 2.5, ...}, reason}`; `null` — вернуть значение plans.json |
| GET | `/analysis/compare?period=&mode=prev|yoy` | analysis.compare | все KPI: текущий период vs предыдущий / год назад |
| GET | `/kpi/:id/records?...&format=csv` | data.export | выгрузка записей детализации в CSV |
| GET | `/audit?user=&action=&result=fail` | audit.view | журнал действий (последние 500); объект — путь «Раздел › KPI › …»; `&format=csv` — выгрузка (data.export) |

## Решение (decision)

```json
{
  "title": "Снизить брак на станке №14",
  "domain": "production",
  "kpi_id": "defect",
  "problem": "Брак 5,7% при плане 3% на станке №14",
  "impact": "Перепечатка, срыв сроков",
  "cause": "Износ печатной головки",
  "action": "Заменить головку, перепроверить калибровку",
  "owner": "Главный инженер",
  "due_date": "2026-11-25",
  "priority": "низкий | средний | высокий | критический",
  "status": "новое | в работе | выполнено | отменено",
  "context": { "kpi": "defect", "dim": "machine", "key": "Станок №14", "filters": { "period": "90d" } }
}
```

Пример:

```bash
TOKEN=$(curl -s -X POST localhost:3000/api/login -H 'Content-Type: application/json' \
  -d '{"login":"director","password":"director2026"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s "localhost:3000/api/kpi?period=90d" -H "Authorization: Bearer $TOKEN"
curl -s "localhost:3000/api/kpi/defect/drill?period=90d&dim=machine" -H "Authorization: Bearer $TOKEN"
```
