import * as SQLite from 'expo-sqlite';

let db: Promise<SQLite.SQLiteDatabase> | null = null;

/** The app's local database: queued count entries and the cached catalog. */
export function database(): Promise<SQLite.SQLiteDatabase> {
  db ??= SQLite.openDatabaseAsync('ample-pos.db').then(async (conn) => {
    await conn.execAsync(`
      pragma journal_mode = wal;
      create table if not exists entries (
        id text primary key,
        count_id text not null,
        variant_id text not null,
        label text not null,
        quantity integer not null,
        counted_at text not null,
        state text not null,
        voided integer not null default 0,
        void_state text not null default 'none',
        error text
      );
      create index if not exists entries_count on entries (count_id, counted_at);
      create index if not exists entries_state on entries (state, voided);
      create table if not exists catalog (
        id text primary key,
        json text not null
      );
      create table if not exists meta (
        key text primary key,
        value text not null
      );
    `);
    return conn;
  });
  return db;
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await (await database()).getFirstAsync<{ value: string }>('select value from meta where key = ?', key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await (await database()).runAsync('insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value', key, value);
}

/** Wipes local data, e.g. when switching business or unpairing. */
export async function clearLocalData(): Promise<void> {
  await (await database()).execAsync('delete from entries; delete from catalog; delete from meta;');
}
