import { SetMetadata } from '@nestjs/common';
import type { ModuleId } from '@pos/modules';

export const PUBLIC_KEY = 'pos:public';
export const NO_TENANT_KEY = 'pos:no-tenant';
export const PERMISSION_KEY = 'pos:permission';
export const MODULE_KEY = 'pos:module';

/** No authentication and no database transaction. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Authenticated, but not scoped to a business (no X-Tenant-Id required). */
export const NoTenant = () => SetMetadata(NO_TENANT_KEY, true);

/** Member must hold this permission in the selected business. */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

/** Business must have this module enabled. */
export const RequireModule = (moduleId: ModuleId) => SetMetadata(MODULE_KEY, moduleId);
