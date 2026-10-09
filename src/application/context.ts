import { measure, type TimingSample } from "./telemetry.js";
import type { Env } from "../runtime/bindings.js";
import { ItadClient } from "../infrastructure/itad/client.js";
import { TelegramClient } from "../infrastructure/telegram/client.js";
import { SettingsRepository } from "../infrastructure/d1/settings.js";
import { PreferencesRepository } from "../infrastructure/d1/preferences.js";
import { WishlistRepository } from "../infrastructure/d1/wishlist.js";
import { GiveawaysRepository } from "../infrastructure/d1/giveaways.js";
import { DeliveriesRepository } from "../infrastructure/d1/deliveries.js";
import { UpdatesRepository } from "../infrastructure/d1/updates.js";
import { Scans } from "../infrastructure/d1/scans.js";
import { ViewsRepository } from "../infrastructure/d1/views.js";
import { KeysRepository } from "../infrastructure/d1/keys.js";
import { KeyScans } from "../infrastructure/d1/key-scans.js";
import { GgClient } from "../infrastructure/gg/client.js";

export function createContext(
  env: Env,
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    recordTiming?: (sample: TimingSample) => void;
  } = {},
) {
  const fetcher = options.fetcher ?? fetch;
  const sink =
    options.recordTiming ??
    ((sample: TimingSample) => console.log("timing", sample));
  const recordTiming = (sample: TimingSample) => {
    try {
      sink(sample);
    } catch {
      /* Diagnostics never change delivery semantics. */
    }
  };
  return {
    env,
    recordTiming,
    fetcher,
    now: options.now ?? Date.now,
    settings: new SettingsRepository(env.DB),
    views: new ViewsRepository(env.DB),
    preferences: new PreferencesRepository(env.DB),
    wishlist: new WishlistRepository(env.DB),
    giveaways: new GiveawaysRepository(env.DB),
    deliveries: new DeliveriesRepository(env.DB),
    updates: new UpdatesRepository(env.DB),
    scans: new Scans(env.DB),
    keys: new KeysRepository(env.DB),
    keyScans: new KeyScans(env.DB),
    gg: new GgClient(env.GGDEALS_API_KEY ?? "", fetcher),
    itad: new ItadClient(env.ITAD_API_KEY, fetcher, {
      reviewConcurrency: env.REVIEW_CONCURRENCY === "2" ? 2 : 1,
      measureRequest: (action) => measure("itad", action, recordTiming),
    }),
    telegram: new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetcher),
    queues: env.WORK_QUEUE,
  };
}
export type ApplicationContext = ReturnType<typeof createContext>;
