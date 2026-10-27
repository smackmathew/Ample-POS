import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CatalogController } from './catalog/catalog.controller';
import { AuthGuard } from './core/auth.guard';
import { AuthService } from './core/auth.service';
import { APP_CONFIG, type AppConfig } from './core/config';
import { Db, DB_HANDLE, dbHandleFactory } from './core/database';
import { Events } from './core/events';
import { TenantContextInterceptor } from './core/tenant-context.interceptor';
import { CountsController } from './inventory/counts.controller';
import { InventoryController } from './inventory/inventory.controller';
import { LedgerService } from './inventory/ledger.service';
import { SECRET_BOX, SecretBox } from './core/secrets';
import { SHOPIFY_FETCH } from './integrations/shopify/client';
import { ShopifyController, ShopifyWebhookController } from './integrations/shopify/shopify.controller';
import { ShopifyJobs } from './integrations/shopify/shopify.jobs';
import { ShopifySyncService } from './integrations/shopify/shopify-sync.service';
import { CARD_PROVIDER } from './payments/provider';
import { SimulatedCardProvider } from './payments/simulated.provider';
import { StripeCardProvider } from './payments/stripe.provider';
import { WebhooksController } from './payments/webhooks.controller';
import { RegistersController, SalesController } from './sales/sales.controller';
import { SalesService } from './sales/sales.service';
import { OutboxWorker } from './worker/outbox.worker';
import { AuditController } from './platform/audit.controller';
import { DeviceSessionController } from './platform/device-session.controller';
import { DevicesController } from './platform/devices.controller';
import { IdentityController } from './platform/identity.controller';
import { InvitationsController } from './platform/invitations.controller';
import { LocationsController } from './platform/locations.controller';
import { MembersController } from './platform/members.controller';
import { ModulesController } from './platform/modules.controller';
import { RolesController } from './platform/roles.controller';
import { TenantController } from './platform/tenant.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        IdentityController,
        TenantController,
        ModulesController,
        LocationsController,
        RolesController,
        MembersController,
        InvitationsController,
        DevicesController,
        DeviceSessionController,
        AuditController,
        CatalogController,
        InventoryController,
        CountsController,
        RegistersController,
        SalesController,
        WebhooksController,
        ShopifyController,
        ShopifyWebhookController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DB_HANDLE, useFactory: () => dbHandleFactory(config.DATABASE_URL) },
        Db,
        AuthService,
        Events,
        LedgerService,
        SalesService,
        OutboxWorker,
        ShopifySyncService,
        ShopifyJobs,
        { provide: SECRET_BOX, useFactory: () => (config.SECRETS_KEY ? new SecretBox(config.SECRETS_KEY) : null) },
        { provide: SHOPIFY_FETCH, useValue: ((url, init) => fetch(url, init)) satisfies typeof fetch },
        {
          provide: CARD_PROVIDER,
          useFactory: () =>
            config.PAYMENTS_PROVIDER === 'stripe'
              ? new StripeCardProvider(config.STRIPE_SECRET_KEY!, { account: config.STRIPE_ACCOUNT })
              : new SimulatedCardProvider(),
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    };
  }
}
