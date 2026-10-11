const { Pool } = require('pg');
const { selectList, assignments } = require('../../libs/pg-utils');

/**
 * Which backend the DB-backed suites run on: `TEST_DB=pg npm test` for
 * postgres, mongo by default. Every test file gets a database of its own.
 */
const TEST_DB = process.env.TEST_DB || 'mongo';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://root:password@localhost:27017/?authSource=admin';
const PG_URL = process.env.PG_URL || 'postgres://postgres:password@localhost:5432/postgres';

/** The same server as `base`, database `dbName`. */
function urlFor(base, dbName) {
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  return url.toString();
}

const mongoUrlFor = (dbName) => urlFor(MONGO_URL, dbName);
const pgUrlFor = (dbName) => urlFor(PG_URL, dbName);

/** Run one statement on the server's maintenance database. */
async function onServer(sql) {
  const pool = new Pool({ connectionString: PG_URL, max: 1 });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

/** An empty postgres database for one test file. */
async function freshPgDatabase(dbName) {
  await onServer(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await onServer(`CREATE DATABASE "${dbName}"`);
}

const dropPgDatabase = (dbName) => onServer(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);

/**
 * The flags that put a service's stores on this run's backend, database `dbName`.
 * @param {string} dbName
 * @param {string[]} selectors e.g. `['profile-db', 'auth-db']`
 */
function dbFlags(dbName, selectors) {
  const url = TEST_DB === 'pg' ? `--pg-url=${pgUrlFor(dbName)}` : `--mongo-url=${mongoUrlFor(dbName)}`;
  return [url, ...selectors.map((selector) => `--${selector}=${TEST_DB}`)];
}

/**
 * The two mongo `Db` calls the tests make to poke rows directly,
 * `collection(name).findOne(filter)` and `.updateOne(filter, {$set})`, over
 * the postgres table of the same name. Equality filters only.
 * @param {Pool} pool
 * @param {{[table: string]: string[]}} tables each table's fields
 */
function pgDb(pool, tables) {
  return {
    collection(table) {
      const fields = tables[table];
      const where = (filter, first) => assignments(fields, filter, first, ' AND ');
      return {
        async findOne(filter) {
          const { rows } = await pool.query(
            `SELECT ${selectList(fields)} FROM ${table} WHERE ${where(filter, 1)}`,
            Object.values(filter)
          );
          return rows[0] || null;
        },
        async updateOne(filter, { $set }) {
          const values = Object.values($set);
          await pool.query(
            `UPDATE ${table} SET ${assignments(fields, $set)} WHERE ${where(filter, values.length + 1)}`,
            [...values, ...Object.values(filter)]
          );
        }
      };
    }
  };
}

module.exports = {
  TEST_DB,
  MONGO_URL,
  PG_URL,
  mongoUrlFor,
  pgUrlFor,
  freshPgDatabase,
  dropPgDatabase,
  dbFlags,
  pgDb
};
