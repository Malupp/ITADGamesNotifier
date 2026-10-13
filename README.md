# ITADGamesNotifier

Bot Telegram italiano per giochi PC completi riscattabili gratis e ulteriori ribassi della wishlist, su Cloudflare Workers, D1 e Queues Free.

- [Apri il bot](https://t.me/ITADgamesnotifierbot): /start o /help spiega tutti i comandi.
- /wishlist mostra una pagina di massimo dieci giochi in **un unico messaggio**; i pulsanti aggiornano quel messaggio.
- Scansioni ogni 30 minuti; avviso wishlist soltanto con sconto effettivo e ulteriore ribasso almeno del 10% dal riferimento consegnato.
- Giveaway verificati ufficialmente su Epic/Steam per l'Italia, senza abbonamento obbligatorio. `/deals` mostra una scheda per gioco con foto, descrizione e navigazione nello stesso messaggio.
- News RSS italiane di videogiochi, film, anime e manga nella chat privata, con un toggle personale. Nei gruppi il bot non risponde.

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

## Prezzi key e affari generali

`/keys` mostra in un solo messaggio gli affari della selezione monitorata: listino autorizzato superiore a 30€ e key positiva almeno al 50% sotto listino, inferiore al miglior prezzo autorizzato corrente. La selezione giornaliera comprende fino a 100 giochi popolari ITAD e 30 giochi in offerta, uniti alla wishlist (massimo 200 giochi distinti). Non è una ricerca esaustiva dei cataloghi keyshop.

Le key compaiono anche nelle ricerche, nei confronti e nella wishlist, se esiste una corrispondenza Steam esatta verificata dai metadati ITAD. Fanatical, Humble e altri rivenditori autorizzati restano coperti da ITAD. [GG.deals](https://gg.deals/api/prices/) aggiunge un minimo aggregato dei keyshop per Italia/EUR; l’API gratuita non fornisce venditore, commissioni, garanzie di attivazione o link diretto d’acquisto. I messaggi attribuiscono i dati e conservano il link GG. GG aggiorna circa ogni ora, anche se il bot controlla ogni 30 minuti.

Gli avvisi key wishlist usano la stessa soglia globale/per gioco, con un riferimento indipendente dai prezzi autorizzati. Gli avvisi «Affare key» nella chat privata degli utenti che attivano **Affari giochi recenti** con `/notifiche` riguardano soltanto giochi con anno di uscita ITAD **2026 o 2027**, entrambi inclusi fin da ora; anni diversi, mancanti o non validi sono esclusi anche prima dell'invio. Il filtro non si applica ai ribassi personali della wishlist né alle consultazioni manuali. Gli affari generali notificano un nuovo affare o un ulteriore ribasso almeno del 10%, senza piccoli aggiornamenti ripetuti. La prima scansione registra lo stato in silenzio. Nessuna integrazione diretta, scraping o servizio a pagamento per Instant Gaming/Allkeyshop.

## News italiane e notifiche personali

Il bot risponde soltanto in chat privata. `/notifiche` mostra due toggle indipendenti, **News** e **Affari giochi recenti**, entrambi spenti per default. La wishlist conserva le proprie soglie e continua a notificare i giochi aggiunti anche quando questi toggle sono spenti. Gli utenti che avviano una conversazione privata vengono registrati; le chat bloccate sono escluse dagli invii. Non c’è una scadenza per inattività.

`/news` mostra stato e pulsante personale **Attiva news / Disattiva news**; `/news on` e `/news off` sono scorciatoie. Nessun comando o pulsante nei gruppi può abilitare news o affari. Nel canale `TELEGRAM_CHAT_ID` vengono pubblicati soltanto giochi gratis, ricontrollando che la destinazione sia effettivamente un canale. Il vecchio secret `TELEGRAM_CHAT_GROUP` non è più usato.

Fonti iniziali: Multiplayer.it, Everyeye videogiochi, ComingSoon.it, Everyeye Cinema, Cinefilos, MangaForever, Everyeye Anime e Akiba Gamers. Sono otto feed da sei testate italiane, con filtri sulle categorie e sui domini per escludere TV, tecnologia, merchandising e altre sezioni. I feed che dichiarano una lingua diversa dall’italiano vengono esclusi; per le testate italiane note è ammessa la lingua non dichiarata.

I filtri escludono anche rubriche, guide, recensioni, classifiche e offerte. Dove le categorie indicano soltanto il franchise, vengono usati percorso e indicatori espliciti del titolo per riconoscere merchandising e classifiche. È una selezione conservativa dei metadati RSS: può escludere un titolo ambiguo e richiede manutenzione se la testata cambia le categorie.

Il controllo avviene ogni 30 minuti e condivide la lettura delle fonti fra gli iscritti. Ogni notizia contiene categoria, titolo, un breve estratto RSS della fonte, immagine quando disponibile, testata, data italiana e link all’articolo. Le immagini vengono inviate come foto; se Telegram le rifiuta, il retry usa il testo con anteprima del link. Non vengono generati riassunti né copiati articoli completi. Il bot alterna aree e testate disponibili e limita ciascun iscritto a **tre tentativi di invio in una finestra mobile di 60 minuti**, inclusi errori e retry; gli altri avvisi e le risposte ai comandi hanno regole separate.

La prima lettura riuscita di ogni fonte registra i titoli in silenzio. Dopo ogni attivazione valgono solo le pubblicazioni successive, recenti entro 24 ore. L’identità testata + URL evita ripetizioni dello stesso articolo, anche fra feed della medesima testata; testate diverse possono riportare la stessa notizia. Lo spegnimento invalida la coda dell’utente; una richiesta Telegram già partita può completarsi. Il blocco del bot disattiva le news di quell’utente e lo esclude dagli affari recenti.

Il flag `NEWS_ENABLED=true` abilita il servizio globale; ogni utente deve comunque attivare il proprio toggle. `NEWS_ENABLED=false` o `SCANS_ENABLED=false` sospendono gli invii. Con zero iscritti attivi non vengono letti i feed. Il limite iniziale resta di 10 iscritti; vedere il [runbook](docs/cloudflare.md) prima del rilascio. Diagnostica pubblica senza invii: `npx tsx scripts/diagnostics/news-feeds.ts`.

Le migrazioni `0010_private_notifications.sql` e `0011_private_activity_revision.sql` archiviano le vecchie iscrizioni dei gruppi, annullano le loro news e gli affari generali pendenti, aggiungono preferenze private e metadati per descrizioni/copertine. Non abilitano nessuno automaticamente. Gli avvisi di giochi gratis hanno descrizione ufficiale, copertina quando disponibile, genere quando presente, negozio, scadenza italiana e link di riscatto. Una descrizione o immagine mancante non impedisce l’avviso.

Il listino degli affari key viene ricavato dai prezzi EUR ufficiali ITAD: si preferisce Steam; se non disponibile si usa il minimo listino valido degli altri negozi autorizzati. Un listino mancante o incoerente esclude l’avviso generale. Il prezzo storico GG non è un listino. La regola vale anche immediatamente prima dell’invio; nuovi affari o ulteriori ribassi di almeno il 10% evitano ripetizioni per piccoli cambiamenti. La wishlist personale conserva le proprie regole.
