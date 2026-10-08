# ITADGamesNotifier

Bot Telegram per giveaway PC verificati e ribassi wishlist, su Cloudflare Workers + D1 + Queues Free.

- [Apri il bot](https://t.me/ITADgamesnotifierbot): usa /status, /deals o /help.
- Scansioni ogni 30 minuti; soglia wishlist almeno 10% rispetto all'ultimo avviso consegnato.
- Giveaway confermati sulle fonti ufficiali Epic/Steam per l'Italia; condizioni non verificabili escluse.
- [Gestione, migrazione, quote e rollback](docs/cloudflare.md).

Node 22: `npm ci`, `npm test`, `npm run typecheck`, `npm run build`. Le credenziali restano nei secrets Cloudflare. I file Python sono conservati come implementazione legacy.
