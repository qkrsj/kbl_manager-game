import { Pool } from "pg";

export const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "kbl_app",
  password: process.env.PGPASSWORD ?? "devpassword",
  database: process.env.PGDATABASE ?? "kbl_manager",
});
