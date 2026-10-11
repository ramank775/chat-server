const { Pool, types } = require('pg');

// bigint columns hold ms-since-epoch times and queue ids; both fit a JS number
types.setTypeParser(types.builtins.INT8, Number);

function addPgOptions(cmd) {
  return cmd.option(
    '--pg-url <pg-url>',
    'PostgreSQL connection string postgres://user:password@host:port/db'
  );
}

/**
 * One pool per context, the `initMongoClient` of postgres: the monolith's
 * services all share it.
 */
function initPgPool(context) {
  if (!context.pgPool) {
    const pool = new Pool({ connectionString: context.options.pgUrl });
    // an idle client losing its server emits here; unhandled, it kills the process
    pool.on('error', (error) => context.log?.error(`postgres pool: ${error.message}`));
    // every store sharing the pool ends it on dispose, and a second `end`
    // throws. One end, everyone awaits it.
    const end = pool.end.bind(pool);
    let ending = null;
    pool.end = () => {
      ending = ending || end();
      return ending;
    };
    context.pgPool = pool;
  }
  return context.pgPool;
}

/**
 * Boot-time `CREATE ... IF NOT EXISTS`, the postgres `createIndex`. Two
 * services booting at once can still collide on the same new name, so the DDL
 * runs as one transaction behind a database-wide advisory lock.
 * @param {import('pg').Pool} pool
 * @param {string} ddl one or more statements, no parameters
 */
async function ensureSchema(pool, ddl) {
  await pool.query(`SELECT pg_advisory_xact_lock(hashtext('vartalap.schema'), 0); ${ddl}`);
}

/**
 * The column a document field lives in: `phoneHash` -> `phone_hash`,
 * `user_id` as is. Rows read back under the field names, so the pg stores
 * return the same objects the mongo stores do.
 * @param {string} field
 */
function column(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** `phone_hash AS "phoneHash", ...` for a select or a RETURNING. */
function selectList(fields) {
  return fields.map((field) => `${column(field)} AS "${field}"`).join(', ');
}

/**
 * `phone_hash = $3, ...` over the keys of `values`, numbered from `first`.
 * A key outside `fields` throws, so only known columns reach the SQL text.
 * The parameters are `Object.values(values)`, in the same order.
 * @param {string[]} fields
 * @param {object} values
 * @param {number} [first]
 * @param {string} [separator] `' AND '` makes it a filter
 */
function assignments(fields, values, first = 1, separator = ', ') {
  return Object.keys(values)
    .map((field, index) => {
      if (!fields.includes(field)) throw new Error(`unknown field ${field}`);
      return `${column(field)} = $${first + index}`;
    })
    .join(separator);
}

/** `INSERT INTO table (cols) VALUES ($1, ...)`; parameters are `fields.map(f => row[f])`. */
function insertSql(table, fields) {
  const placeholders = fields.map((_, index) => `$${index + 1}`).join(', ');
  return `INSERT INTO ${table} (${fields.map(column).join(', ')}) VALUES (${placeholders})`;
}

module.exports = {
  addPgOptions,
  initPgPool,
  ensureSchema,
  column,
  selectList,
  assignments,
  insertSql
};
