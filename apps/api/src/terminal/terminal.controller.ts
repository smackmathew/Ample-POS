import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Controller, Get, HttpCode, Inject, Post, ServiceUnavailableException } from '@nestjs/common';
import { schema } from '@pos/db';
import { eq } from 'drizzle-orm';
import { Db } from '../core/database';
import { RequireModule, RequirePermission } from '../core/decorators';
import { currentContext } from '../core/request-context';
import { CARD_PROVIDER, ProviderUnavailableError, type CardPaymentProvider } from '../payments/provider';
import { StripeApiError } from '../payments/stripe.provider';

/**
 * Card readers for the register app. The register's SDK asks for a connection
 * token through us (never holding a secret key itself), and readers are
 * registered to the store the register is paired to.
 */
@Controller('terminal')
@RequireModule('pos')
@RequirePermission('pos.sell')
export class TerminalController {
  constructor(
    private readonly db: Db,
    @Inject(CARD_PROVIDER) private readonly provider: CardPaymentProvider,
  ) {}

  /** What the register should show: an SDK reader, or the simulated approve/decline buttons. */
  @Get('config')
  async config() {
    const location = await this.deviceLocation();
    if (!this.provider.terminal) return { provider: this.provider.name, readers: 'simulated' as const, location: { ready: true, problem: null } };
    return {
      provider: this.provider.name,
      readers: 'sdk' as const,
      location: location.address
        ? { ready: true, problem: null }
        : { ready: false, problem: `Add ${location.name}’s street address in Locations to connect card readers.` },
    };
  }

  @Post('connection-token')
  @HttpCode(200)
  async connectionToken() {
    const terminal = this.provider.terminal;
    if (!terminal) throw new ConflictException({ code: 'no_card_readers', message: 'Card readers are not used with the simulated payment processor' });
    const locationRef = await this.ensureLocation();
    const secret = await this.guard(() => terminal.connectionToken(locationRef));
    return { secret, locationRef };
  }

  /** The processor's record of this register's store, created or updated to match our address. */
  private async ensureLocation(): Promise<string> {
    const { id } = await this.deviceLocation();
    const [loc] = await this.db.tx.select().from(schema.locations).where(eq(schema.locations.id, id)).for('update');
    if (!loc!.address) {
      throw new ConflictException({ code: 'address_required', message: `Add ${loc!.name}’s street address in Locations to connect card readers.` });
    }
    const addressHash = createHash('sha256').update(JSON.stringify([loc!.name, loc!.address])).digest('hex').slice(0, 32);
    const known = loc!.terminalLocation?.provider === this.provider.name ? loc!.terminalLocation : null;
    if (known && known.addressHash === addressHash) return known.ref;

    const ref = await this.guard(() =>
      this.provider.terminal!.saveLocation({ ref: known?.ref ?? null, displayName: loc!.name, address: loc!.address!, idempotencyKey: `terminal-location-${loc!.id}-${addressHash}` }),
    );
    await this.db.tx
      .update(schema.locations)
      .set({ terminalLocation: { provider: this.provider.name, ref, addressHash } })
      .where(eq(schema.locations.id, loc!.id));
    return ref;
  }

  private async deviceLocation() {
    const { device } = currentContext();
    if (!device) throw new BadRequestException('Card readers connect from a paired register');
    const [loc] = await this.db.tx
      .select({ id: schema.locations.id, name: schema.locations.name, address: schema.locations.address })
      .from(schema.locations)
      .where(eq(schema.locations.id, device.locationId));
    return loc!;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw new ServiceUnavailableException(err.message);
      if (err instanceof StripeApiError) throw new ConflictException({ code: 'processor_error', message: err.message });
      throw err;
    }
  }
}
