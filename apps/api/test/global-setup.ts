import { setupDatabase } from '@pos/db';
import postgres from 'postgres';

export const TEST_DB = 'pos_hub_test';
// Postgres roles are cluster-wide, so tests reuse the dev password instead of
// resetting it and breaking a locally running API.
export const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? 'pos_app_dev';

/** Recreates the test database and applies every migration before the suite runs. */
export default async function setup() {
  const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres');
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
  await admin.unsafe(`create database ${TEST_DB}`);
  await admin.end();

  adminUrl.pathname = `/${TEST_DB}`;
  await setupDatabase(adminUrl.toString(), APP_PASSWORD);
}
