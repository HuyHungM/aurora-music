import { readFileSync } from "node:fs";
import { Client } from "pg";

const text = readFileSync(".env", "utf8");
const m = text.match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
let url = m ? m[1].trim().replace(/^["']|["']$/g, "") : process.env.DATABASE_URL;
if (!url) {
  console.log("no DATABASE_URL");
  process.exit(0);
}
const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
try {
  await client.connect();
  const r = await client.query("SELECT 1 AS ok");
  console.log("LOCAL DB REACHABLE: SELECT 1 ->", JSON.stringify(r.rows));
  await client.end();
} catch (e) {
  console.log("LOCAL DB NOT REACHABLE:", e.code ?? "", e.message);
}
