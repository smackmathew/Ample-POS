import type { ApiClient } from './api-client';

export interface CatalogVariant {
  id: string;
  productId: string;
  productName: string;
  name: string;
  sku: string | null;
  priceMinor: number;
  trackInventory: boolean;
  barcodes: string[];
}

/** Downloads every active variant, page by page. */
export async function downloadCatalog(api: ApiClient, pageSize = 2000): Promise<CatalogVariant[]> {
  const all: CatalogVariant[] = [];
  let after: string | null = null;
  do {
    const query: string = `?limit=${pageSize}${after ? `&after=${after}` : ''}`;
    const page: { variants: CatalogVariant[]; next: string | null } = await api.get(`/catalog/variants${query}`);
    all.push(...page.variants);
    after = page.next;
  } while (after);
  return all;
}

export function variantLabel(v: { productName: string; name: string }): string {
  return v.name === 'Default' ? v.productName : `${v.productName} — ${v.name}`;
}

/** In-memory scan lookup: exact barcode first, then case-insensitive SKU. */
export class CatalogIndex {
  private readonly byBarcode = new Map<string, CatalogVariant>();
  private readonly bySku = new Map<string, CatalogVariant>();
  readonly size: number;

  constructor(variants: CatalogVariant[]) {
    this.size = variants.length;
    for (const v of variants) {
      for (const code of v.barcodes) this.byBarcode.set(code, v);
      if (v.sku) this.bySku.set(v.sku.toLowerCase(), v);
    }
  }

  find(code: string): CatalogVariant | null {
    const trimmed = code.trim();
    return this.byBarcode.get(trimmed) ?? this.bySku.get(trimmed.toLowerCase()) ?? null;
  }
}
