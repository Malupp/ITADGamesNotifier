import { SettingsRepository } from "./settings.js";
import { PreferencesRepository } from "./preferences.js";
import { WishlistRepository } from "./wishlist.js";
import { GiveawaysRepository } from "./giveaways.js";
import { DeliveriesRepository } from "./deliveries.js";
import { UpdatesRepository } from "./updates.js";

/** Compatibility facade for migration tools and integration fixtures. Runtime uses focused repositories. */
export class Store {
  readonly getSetting: SettingsRepository["getSetting"];
  readonly setSetting: SettingsRepository["setSetting"];
  readonly status: SettingsRepository["status"];
  readonly getPrefs: PreferencesRepository["getPrefs"];
  readonly setPrefs: PreferencesRepository["setPrefs"];
  readonly getWishlist: WishlistRepository["getWishlist"];
  readonly addWishlist: WishlistRepository["addWishlist"];
  readonly removeWishlist: WishlistRepository["removeWishlist"];
  readonly setWishlistDiscount: WishlistRepository["setWishlistDiscount"];
  readonly gameIds: WishlistRepository["gameIds"];
  readonly ingestPrices: WishlistRepository["ingestPrices"];
  readonly invalidateMissingPrices: WishlistRepository["invalidateMissingPrices"];
  readonly getGiveaways: GiveawaysRepository["getGiveaways"];
  readonly ingestGiveaways: GiveawaysRepository["ingestGiveaways"];
  readonly finishGiveawayScan: GiveawaysRepository["finishGiveawayScan"];
  readonly queueMessage: DeliveriesRepository["queueMessage"];
  readonly deliveryOffer: DeliveriesRepository["deliveryOffer"];
  readonly expireDelivery: DeliveriesRepository["expireDelivery"];
  readonly cancelInvalidPending: DeliveriesRepository["cancelInvalidPending"];
  readonly pendingDeliveries: DeliveriesRepository["pendingDeliveries"];
  readonly claimDelivery: DeliveriesRepository["claimDelivery"];
  readonly completeDelivery: DeliveriesRepository["completeDelivery"];
  readonly retryDelivery: DeliveriesRepository["retryDelivery"];
  readonly blockDelivery: DeliveriesRepository["blockDelivery"];
  readonly unblockChat: DeliveriesRepository["unblockChat"];
  readonly acceptUpdate: UpdatesRepository["acceptUpdate"];
  readonly claimUpdate: UpdatesRepository["claimUpdate"];
  readonly completeUpdate: UpdatesRepository["completeUpdate"];
  readonly retryUpdate: UpdatesRepository["retryUpdate"];
  readonly pendingUpdates: UpdatesRepository["pendingUpdates"];
  constructor(readonly db: D1Database) {
    const settings = new SettingsRepository(db);
    const preferences = new PreferencesRepository(db);
    const wishlist = new WishlistRepository(db);
    const giveaways = new GiveawaysRepository(db);
    const deliveries = new DeliveriesRepository(db);
    const updates = new UpdatesRepository(db);
    this.getSetting = settings.getSetting.bind(settings);
    this.setSetting = settings.setSetting.bind(settings);
    this.status = settings.status.bind(settings);
    this.getPrefs = preferences.getPrefs.bind(preferences);
    this.setPrefs = preferences.setPrefs.bind(preferences);
    this.getWishlist = wishlist.getWishlist.bind(wishlist);
    this.addWishlist = wishlist.addWishlist.bind(wishlist);
    this.removeWishlist = wishlist.removeWishlist.bind(wishlist);
    this.setWishlistDiscount = wishlist.setWishlistDiscount.bind(wishlist);
    this.gameIds = wishlist.gameIds.bind(wishlist);
    this.ingestPrices = wishlist.ingestPrices.bind(wishlist);
    this.invalidateMissingPrices =
      wishlist.invalidateMissingPrices.bind(wishlist);
    this.getGiveaways = giveaways.getGiveaways.bind(giveaways);
    this.ingestGiveaways = giveaways.ingestGiveaways.bind(giveaways);
    this.finishGiveawayScan = giveaways.finishGiveawayScan.bind(giveaways);
    this.queueMessage = deliveries.queueMessage.bind(deliveries);
    this.deliveryOffer = deliveries.deliveryOffer.bind(deliveries);
    this.expireDelivery = deliveries.expireDelivery.bind(deliveries);
    this.cancelInvalidPending =
      deliveries.cancelInvalidPending.bind(deliveries);
    this.pendingDeliveries = deliveries.pendingDeliveries.bind(deliveries);
    this.claimDelivery = deliveries.claimDelivery.bind(deliveries);
    this.completeDelivery = deliveries.completeDelivery.bind(deliveries);
    this.retryDelivery = deliveries.retryDelivery.bind(deliveries);
    this.blockDelivery = deliveries.blockDelivery.bind(deliveries);
    this.unblockChat = deliveries.unblockChat.bind(deliveries);
    this.acceptUpdate = updates.acceptUpdate.bind(updates);
    this.claimUpdate = updates.claimUpdate.bind(updates);
    this.completeUpdate = updates.completeUpdate.bind(updates);
    this.retryUpdate = updates.retryUpdate.bind(updates);
    this.pendingUpdates = updates.pendingUpdates.bind(updates);
  }
}
