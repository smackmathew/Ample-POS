import { setupDatabase } from './migrate';

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!adminUrl || !appPassword) {
    throw new Error('ADMIN_DATABASE_URL and APP_DB_PASSWORD must be set');
  }
  const ran = await setupDatabase(adminUrl, appPassword);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
