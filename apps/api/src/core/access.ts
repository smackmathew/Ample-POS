import { ForbiddenException } from '@nestjs/common';
import { ALL_PERMISSIONS, hasPermission } from '@pos/modules';
import { currentTenant } from './request-context';

/**
 * Members may only hand out (or act on holders of) permissions they hold
 * themselves, so members.manage / roles.manage cannot be used to escalate.
 */
export function assertCanDelegate(permissions: readonly string[]): void {
  const mine = currentTenant().permissions;
  const exceeding = permissions.filter((p) =>
    p === ALL_PERMISSIONS ? !mine.includes(ALL_PERMISSIONS) : !hasPermission(mine, p),
  );
  if (exceeding.length) {
    throw new ForbiddenException(`You cannot grant permissions you do not hold: ${exceeding.join(', ')}`);
  }
}
