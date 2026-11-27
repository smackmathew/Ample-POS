import { NextResponse } from 'next/server';
import { apiText } from '@/lib/api';

/** The reconciliation report as CSV, downloaded with the session cookie. */
export async function GET(_: Request, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const { body, filename } = await apiText('/migration/reconciliation.csv', { tenantId });
  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename ?? 'reconciliation.csv'}"` },
  });
}
