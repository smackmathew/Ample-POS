import { CatalogIndex, downloadCatalog, type ApiClient, type CatalogVariant } from '@pos/sync';
import { database, getMeta, setMeta } from './db';

/** Downloads the catalog and replaces the local copy in one transaction. */
export async function refreshCatalog(api: ApiClient): Promise<CatalogIndex> {
  const variants = await downloadCatalog(api);
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync('delete from catalog');
    for (const v of variants) await db.runAsync('insert into catalog (id, json) values (?, ?)', v.id, JSON.stringify(v));
  });
  await setMeta('catalogSyncedAt', new Date().toISOString());
  return new CatalogIndex(variants);
}

export async function loadCatalog(): Promise<{ index: CatalogIndex; syncedAt: string | null }> {
  const rows = await (await database()).getAllAsync<{ json: string }>('select json from catalog');
  return {
    index: new CatalogIndex(rows.map((r) => JSON.parse(r.json) as CatalogVariant)),
    syncedAt: await getMeta('catalogSyncedAt'),
  };
}
