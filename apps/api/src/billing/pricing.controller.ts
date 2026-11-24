import { Controller, Get } from '@nestjs/common';
import { INCLUDED_TOOLS, MODULES, WEBSITE_TOOL } from '@pos/modules';
import { Public } from '../core/decorators';
import { planSettings, websiteAddonSettings } from '../core/plan-settings';
import { PlatformDb } from '../core/platform-db';
import { toolSettings } from '../core/tool-settings';

/** Prices for the public website, with any changes the super admin made. */
@Controller('public')
export class PricingController {
  constructor(private readonly platform: PlatformDb) {}

  @Public()
  @Get('pricing')
  pricing() {
    return this.platform.run(async (tx) => {
      const [plans, addons, tools] = await Promise.all([planSettings(tx), websiteAddonSettings(tx), toolSettings(tx)]);
      return {
        trialDays: 14,
        plans: [...plans.values()],
        websiteAddons: [...addons.values()],
        tools: MODULES.filter((m) => tools.get(m.id)!.available).map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          included: INCLUDED_TOOLS.includes(m.id) || tools.get(m.id)!.priceMinor === 0,
          withOnlineStore: m.id === WEBSITE_TOOL,
          monthlyPriceMinor: tools.get(m.id)!.priceMinor,
        })),
      };
    });
  }
}
