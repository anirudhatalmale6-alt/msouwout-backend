const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'msouwout.db');

const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function sqliteUuid() { return uuidv4(); }

db.function('uuid_generate_v4', sqliteUuid);
db.function('NOW', () => new Date().toISOString());

function convertPgToSqlite(sql) {
  let s = sql;
  s = s.replace(/UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+uuid_generate_v4\(\)/gi, 'TEXT PRIMARY KEY');
  s = s.replace(/SERIAL\s+PRIMARY\s+KEY/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
  s = s.replace(/TIMESTAMP\s+WITH\s+TIME\s+ZONE/gi, 'TEXT');
  s = s.replace(/DOUBLE\s+PRECISION/gi, 'REAL');
  s = s.replace(/VARCHAR\(\d+\)/gi, 'TEXT');
  s = s.replace(/BOOLEAN/gi, 'INTEGER');
  s = s.replace(/JSONB/gi, 'TEXT');
  s = s.replace(/TEXT\[\]/gi, 'TEXT');
  s = s.replace(/NUMERIC\(\d+,\d+\)/gi, 'REAL');
  s = s.replace(/DEFAULT\s+NOW\(\)/gi, "DEFAULT (datetime('now'))");
  s = s.replace(/DEFAULT\s+uuid_generate_v4\(\)/gi, '');
  s = s.replace(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS[^;]+;/gi, '');
  s = s.replace(/UUID\s+NOT\s+NULL/gi, 'TEXT NOT NULL');
  s = s.replace(/UUID\s+REFERENCES/gi, 'TEXT REFERENCES');
  s = s.replace(/UUID,/gi, 'TEXT,');
  s = s.replace(/UUID\)/gi, 'TEXT)');
  return s;
}

function convertParams(sql, params) {
  if (!params || params.length === 0) return { sql, params: [] };
  const newSql = sql.replace(/\$(\d+)/g, () => '?');
  // better-sqlite3 can only bind numbers/strings/bigints/buffers/null — coerce
  // JS booleans to 0/1 (Postgres binds them natively, so this is local-only).
  const p = params.map(v => (v === true ? 1 : v === false ? 0 : v));
  return { sql: newSql, params: p };
}

class SqliteClient {
  query(text, params) {
    let { sql, params: p } = convertParams(text, params);
    sql = convertPgToSqlite(sql);

    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
    let lastResult = { rows: [], rowCount: 0 };

    for (const stmt of statements) {
      try {
        if (/^\s*(SELECT|SHOW|PRAGMA|WITH\s)/i.test(stmt)) {
          const rows = db.prepare(stmt).all(...(statements.length === 1 ? (p || []) : []));
          lastResult = { rows, rowCount: rows.length };
        } else if (/^\s*(INSERT)/i.test(stmt) && /RETURNING/i.test(stmt)) {
          const returning = stmt.match(/RETURNING\s+(.+)$/i);
          const insertSql = stmt.replace(/\s*RETURNING\s+.+$/i, '');
          const info = db.prepare(insertSql).run(...(statements.length === 1 ? (p || []) : []));
          if (returning) {
            const cols = returning[1].split(',').map(c => c.trim());
            if (cols.includes('*')) {
              lastResult = { rows: [{ id: info.lastInsertRowid }], rowCount: 1 };
            } else {
              lastResult = { rows: [{ [cols[0]]: info.lastInsertRowid }], rowCount: 1 };
            }
          }
        } else {
          try {
            const info = db.prepare(stmt).run(...(statements.length === 1 ? (p || []) : []));
            lastResult = { rows: [], rowCount: info.changes };
          } catch (e) {
            if (e.message.includes('duplicate column name') || e.message.includes('already exists')) {
              continue;
            }
            throw e;
          }
        }
      } catch (e) {
        if (e.message.includes('duplicate column name') || e.message.includes('already exists') || e.message.includes('no such function: uuid_generate_v4')) {
          continue;
        }
        if (/ALTER\s+TABLE/i.test(stmt) && e.message.includes('duplicate column')) {
          continue;
        }
        console.error('SQLite error on:', stmt.substring(0, 80), e.message);
      }
    }
    return lastResult;
  }

  release() {}
}

const pool = {
  connect() {
    return Promise.resolve(new SqliteClient());
  },
  query(text, params) {
    const client = new SqliteClient();
    return Promise.resolve(client.query(text, params));
  },
  on(event, cb) {},
  end() { db.close(); }
};

module.exports = pool;
