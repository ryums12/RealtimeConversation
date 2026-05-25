import pg from "pg";

const { Pool } = pg;

let pool;

function getSslConfig(sslValue) {
  return sslValue === "false" ? false : { rejectUnauthorized: false };
}

function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: getSslConfig(process.env.DATABASE_SSL),
    };
  }

  if (!process.env.SUPABASE_DB_HOST) {
    return null;
  }

  return {
    host: process.env.SUPABASE_DB_HOST,
    port: Number(process.env.SUPABASE_DB_PORT || 6543),
    database: process.env.SUPABASE_DB_NAME || "postgres",
    user: process.env.SUPABASE_DB_USER,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: getSslConfig(process.env.SUPABASE_DB_SSL),
  };
}

export function getDatabasePool() {
  const databaseConfig = getDatabaseConfig();

  if (!databaseConfig) {
    return null;
  }

  if (!pool) {
    pool = new Pool(databaseConfig);
  }

  return pool;
}

export async function queryDatabase(text, params = []) {
  const databasePool = getDatabasePool();

  if (!databasePool) {
    const error = new Error("Database connection is not configured.");
    error.statusCode = 503;
    throw error;
  }

  return databasePool.query(text, params);
}

export async function withDatabaseTransaction(callback) {
  const databasePool = getDatabasePool();

  if (!databasePool) {
    const error = new Error("Database connection is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const client = await databasePool.connect();

  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
