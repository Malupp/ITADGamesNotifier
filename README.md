# ITADGamesNotifier

Bot Telegram italiano per giochi PC completi riscattabili gratis e ulteriori ribassi della wishlist, su Cloudflare Workers, D1 e Queues Free.

- [Apri il bot](https://t.me/ITADgamesnotifierbot): /start o /help spiega tutti i comandi.
- /wishlist mostra una pagina di massimo dieci giochi in **un unico messaggio**; i pulsanti aggiornano quel messaggio.
- Scansioni ogni 30 minuti; avviso wishlist soltanto con sconto effettivo e ulteriore ribasso almeno del 10% dal riferimento consegnato.
- Giveaway verificati ufficialmente su Epic/Steam per l'Italia, senza abbonamento obbligatorio.

Il codice attivo entra da [src/index.ts](src/index.ts). Parti dalla [mappa dell'architettura](docs/architecture.md) per trovare il modulo da modificare; il [runbook Cloudflare](docs/cloudflare.md) descrive quote, backup, rilascio e rollback. Il vecchio bot è archiviato in [legacy/python](legacy/python/README.md).

## Sviluppo

Node 22 o successivo:

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run db:local
npm run dev
```

Per il runtime locale configurare i secrets in un file privato .dev.vars ignorato da Git. Dev e db:local usano risorse locali; build è un dry run. Il deploy e db:remote modificano la produzione. I test Python dell'exporter sono indipendenti dal vecchio bot: `python -m unittest discover -s tests/migration -p test_export_legacy.py`.

Il file state.json eventualmente presente è uno storico legacy già tracciato: il runtime usa D1 e non lo legge. Non reimportarlo dopo l'attivazione. Credenziali, export e backup restano privati.
