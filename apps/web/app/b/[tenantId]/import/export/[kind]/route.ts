import { NextResponse, type NextRequest } from 'next/server';
import { apiText } from '@/lib/api';

const KINDS = new Set(['products', 'customers', 'suppliers']);

/** Proxies an export so the browser downloads it with the session cookie. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ tenantId: string; kind: string }> }) {
  const { tenantId, kind } = await params;
  if (!KINDS.has(kind)) return new NextResponse('Not found', { status: 404 });
  const qs = request.nextUrl.searchParams.toString();
  const { body, filename } = await apiText(`/exports/${kind}.csv${qs ? `?${qs}` : ''}`, { tenantId });
  return new NextResponse(body, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename ?? `${kind}.csv`}"` },
  });
}
