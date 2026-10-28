import { NextResponse, type NextRequest } from 'next/server';
import { apiText } from '@/lib/api';

/** Proxies the sales CSV so the browser can download it with the session cookie. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const qs = request.nextUrl.searchParams.toString();
  const { body, filename } = await apiText(`/reports/sales.csv?${qs}`, { tenantId });
  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename ?? 'sales.csv'}"` },
  });
}
