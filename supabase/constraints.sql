-- =============================================================================
-- Шаг 3 из 3: внешние ключи — связь всех ID между CRM, ERP, Финансами, HR и приложением.
-- NOT VALID: исходные выгрузки содержат единичные «битые» ссылки (их показывает раздел
-- «Качество данных»), поэтому старые строки не перепроверяются, а все новые — проверяются.
-- Скрипт идемпотентный: повторный запуск ничего не ломает.
-- =============================================================================
do $$
declare
  fk record;
begin
  for fk in
    select * from (values
      ('crm_orders',            'client_id',           'crm_clients'),
      ('crm_requests',          'client_id',           'crm_clients'),
      ('crm_requests',          'order_id',            'crm_orders'),
      ('erp_shifts',            'operator_id',         'hr_employees'),
      ('erp_production_orders', 'order_id',            'crm_orders'),
      ('erp_production_orders', 'machine_id',          'erp_machines'),
      ('erp_production_orders', 'shift_id',            'erp_shifts'),
      ('erp_defects',           'production_order_id', 'erp_production_orders'),
      ('erp_defects',           'order_id',            'crm_orders'),
      ('finance_revenue',       'order_id',            'crm_orders'),
      ('finance_revenue',       'client_id',           'crm_clients'),
      ('hr_departments',        'head_id',             'hr_employees'),
      ('hr_employees',          'department_id',       'hr_departments'),
      ('hr_schedules',          'employee_id',         'hr_employees'),
      ('hr_sick_leaves',        'employee_id',         'hr_employees'),
      ('app_users',             'department_id',       'hr_departments')
    ) as v(tbl, col, ref)
  loop
    if not exists (select 1 from pg_constraint where conname = format('fk_%s_%s', fk.tbl, fk.col)) then
      execute format('alter table %I add constraint %I foreign key (%I) references %I (id) not valid',
        fk.tbl, format('fk_%s_%s', fk.tbl, fk.col), fk.col, fk.ref);
    end if;
    execute format('create index if not exists %I on %I (%I)', format('idx_%s_%s', fk.tbl, fk.col), fk.tbl, fk.col);
  end loop;
end $$;

-- Проверка: сколько ссылок «битые» (то же, что видит раздел «Качество данных»).
select 'erp_production_orders.order_id' as link, count(*) as broken from erp_production_orders p
  where p.order_id is not null and not exists (select 1 from crm_orders o where o.id = p.order_id)
union all
select 'erp_defects.production_order_id', count(*) from erp_defects d
  where not exists (select 1 from erp_production_orders p where p.id = d.production_order_id)
union all
select 'finance_revenue.order_id', count(*) from finance_revenue r
  where not exists (select 1 from crm_orders o where o.id = r.order_id)
union all
select 'finance_revenue.client_id', count(*) from finance_revenue r
  where not exists (select 1 from crm_clients c where c.id = r.client_id);
