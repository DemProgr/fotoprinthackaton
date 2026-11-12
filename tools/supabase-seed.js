"use strict";
/*
 * Заливка данных четырёх систем (CRM, ERP, Финансы, HR) из data/*.json в Supabase.
 * Порядок: supabase/schema.sql → node tools/supabase-seed.js → supabase/constraints.sql.
 * Повторный запуск безопасен (upsert по id).
 *
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=… node tools/supabase-seed.js
 * (или переменные в .env.local — подхватываются автоматически)
 */
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const sb = require("../server/supabase");
const { SOURCES, DATA_DIR, remoteTable } = require("../server/data");

(async () => {
  if (!sb.enabled) {
    console.error("Нужны SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  for (const src of SOURCES) {
    const rows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, src.file), "utf8"));
    await sb.upsert(remoteTable(src), rows, "id");
    console.log(`✔ ${remoteTable(src).padEnd(24)} ${rows.length} строк`);
  }
  console.log("Готово. Теперь выполните supabase/constraints.sql в SQL Editor.");
})().catch((err) => {
  console.error("✖", err.message);
  process.exit(1);
});
