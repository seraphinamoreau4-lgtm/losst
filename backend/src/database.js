const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// SQLite3 is optional - only load if available and not in production
let sqlite3;
try {
  if (process.env.NODE_ENV !== 'production') {
    sqlite3 = require('sqlite3').verbose();
  }
} catch (err) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn('⚠️  SQLite3 not available for development fallback');
  }
  sqlite3 = null;
}

// Database connection
let db = null;
let pool = null;

// Initialize database connection
async function initDatabase() {
  let databaseUrl = process.env.DATABASE_URL;

  // In production, construct DATABASE_URL from Render's PostgreSQL env vars if needed
  if (process.env.NODE_ENV === 'production') {
    if (!databaseUrl) {
      // Try to construct from individual Postgres environment variables (Render provides these)
      const pgHost = process.env.PGHOST;
      const pgPort = process.env.PGPORT || 5432;
      const pgUser = process.env.PGUSER;
      const pgPassword = process.env.PGPASSWORD;
      const pgDatabase = process.env.PGDATABASE;

      if (pgHost && pgUser && pgPassword && pgDatabase) {
        databaseUrl = `postgresql://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDatabase}`;
        console.log('🔄 Constructed DATABASE_URL from PostgreSQL environment variables');
      } else {
        console.error('❌ DATABASE_URL or PostgreSQL environment variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE) are required in production');
        throw new Error('Database configuration missing');
      }
    }

    console.log('🔄 Initializing PostgreSQL connection...');

    pool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    // Test connection
    try {
      const client = await pool.connect();
      console.log('✅ PostgreSQL database connected successfully');
      client.release();
      return true;
    } catch (err) {
      console.error('❌ PostgreSQL connection failed:', err.message);
      throw err;
    }
  } else {
    // Development: Try PostgreSQL first if DATABASE_URL is set
    if (databaseUrl && databaseUrl.startsWith('postgresql://')) {
      console.log('🔄 Initializing PostgreSQL connection...');

      pool = new Pool({
        connectionString: databaseUrl,
        ssl: false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });

      try {
        const client = await pool.connect();
        console.log('✅ PostgreSQL database connected successfully');
        client.release();
        return true;
      } catch (err) {
        console.error('❌ PostgreSQL connection failed:', err.message);
        throw err;
      }
    } else if (sqlite3) {
      // Development: SQLite fallback
      console.log('🔄 Initializing SQLite database...');

      const dbPath = path.join(__dirname, '..', 'database', 'laikipia_lost_found.db');

      // Ensure database directory exists
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      return new Promise((resolve, reject) => {
        db = new sqlite3.Database(dbPath, (err) => {
          if (err) {
            console.error('❌ SQLite connection failed:', err.message);
            reject(err);
          } else {
            console.log('✅ SQLite database connected successfully');
            resolve(true);
          }
        });
      });
    } else {
      throw new Error('No database available: Set DATABASE_URL or install sqlite3 for development');
    }
  }
}

// Generic query function (replaces ? with positional parameters for PostgreSQL)
function normalizeSqlParams(sql, params = []) {
  if (!sql.includes('?')) return { sql, params };

  let index = 0;
  const normalizedSql = sql.replace(/\?/g, () => {
    index += 1;
    return pool ? `$${index}` : `?`; // $n for PostgreSQL, ? for SQLite
  });
  return { sql: normalizedSql, params };
}

// Helper query function for SELECT, INSERT, UPDATE, DELETE
async function query(sql, params = []) {
  if (!pool && !db) {
    await initDatabase();
  }

  const trimmed = sql.trim();
  const upper = trimmed.split(' ')[0].toUpperCase();

  try {
    const { sql: normalizedSql, params: normalizedParams } = normalizeSqlParams(sql, params);

    if (pool) {
      // PostgreSQL
      const result = await pool.query(normalizedSql, normalizedParams);

      // For SELECT queries, return rows
      if (upper === 'SELECT' || upper === 'SHOW' || upper === 'DESCRIBE') {
        return result.rows;
      }

      // For INSERT/UPDATE/DELETE, return info about the operation
      return {
        rows: result.rows,
        changes: result.rowCount || 0,
        insertId: result.rows?.[0]?.id || null
      };
    } else {
      // SQLite
      return new Promise((resolve, reject) => {
        if (upper === 'SELECT' || upper === 'SHOW' || upper === 'DESCRIBE') {
          db.all(normalizedSql, normalizedParams, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        } else {
          db.run(normalizedSql, normalizedParams, function(err) {
            if (err) reject(err);
            else resolve({
              rows: [],
              changes: this.changes || 0,
              insertId: this.lastID || null
            });
          });
        }
      });
    }
  } catch (err) {
    console.error('❌ Query error:', err);
    console.error('SQL:', sql);
    console.error('Params:', params);
    throw err;
  }
}

// Helper for single row
async function queryOne(sql, params = []) {
  const result = await query(sql, params);
  return result && result.length > 0 ? result[0] : null;
}

// Transaction helper
async function transaction(callback) {
  if (pool) {
    // PostgreSQL transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('❌ Transaction failed:', err);
      throw err;
    } finally {
      client.release();
    }
  } else if (db && sqlite3) {
    // SQLite transaction
    return new Promise((resolve, reject) => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) return reject(err);

        callback(db).then(result => {
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else resolve(result);
          });
        }).catch(err => {
          db.run('ROLLBACK', () => reject(err));
        });
      });
    });
  } else {
    throw new Error('No database connection available for transaction');
  }
}

// Close database connection
async function closeDatabase() {
  if (pool) {
    await pool.end();
    console.log('📴 PostgreSQL connection closed');
  } else if (db) {
    db.close((err) => {
      if (err) console.error('❌ Error closing SQLite database:', err);
      else console.log('📴 SQLite database connection closed');
    });
  }
}

// Initialize on module load
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});

module.exports = { 
  query, 
  queryOne, 
  transaction, 
  closeDatabase,
  initDatabase,
  get pool() { return pool; }
};