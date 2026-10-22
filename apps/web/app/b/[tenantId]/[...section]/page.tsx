import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import type { ModuleSummary, NavSection } from '@/lib/types';

/** Placeholder for module pages that later build phases fill in. */
export default async function ModuleSection({ params }: { params: Promise<{ tenantId: string; section: string[] }> }) {
  const { tenantId, section } = await params;
  const path = `/${section.join('/')}`;
  const [nav, modules] = await Promise.all([
    api<{ sections: NavSection[] }>('/navigation', { tenantId }),
    api<ModuleSummary[]>('/modules', { tenantId }),
  ]);
  const owner = nav.sections.find((s) => s.moduleId && s.items.some((i) => i.path === path));
  const mod = owner && modules.find((m) => m.id === owner.moduleId);
  if (!mod) notFound();

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold">{owner!.items.find((i) => i.path === path)!.label}</h1>
      <p className="mt-2 text-stone-600">
        {mod.name} is turned on for this business. Its screens arrive in build phase {mod.phase}.
      </p>
    </div>
  );
}
