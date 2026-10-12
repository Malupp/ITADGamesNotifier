# News nei gruppi Telegram — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** News italiane da otto feed, soltanto nei gruppi abilitati dagli amministratori, massimo tre tentativi di invio in sessanta minuti per gruppo.

**Architecture:** Nuovi moduli news e tabelle D1 separate dall'outbox dei giochi. Il cron e la Queue background esistenti avviano lavori persistiti per feed e consegna; la Queue interattiva gestisce i comandi.

**Tech Stack:** TypeScript, Cloudflare Workers/D1/Queues, SQLite reale nei test, fast-xml-parser 5.11.2 come dipendenza runtime.

**Spec:** `docs/superpowers/specs/2026-10-11-group-news-design.md` (approvata).

## Global Constraints

- Solo fonti e notizie in italiano; titolo, testata, categoria e link, senza copia di articoli o riassunti AI.
- Otto feed della specifica; massimo cinquanta articoli per feed/ciclo, dieci gruppi attivi.
- Toggle unico per gruppo, spento per default, controllato dagli amministratori.
- Solo group/supergroup; controllo corrente di presenza e permessi del bot prima di ogni invio.
- Massimo tre tentativi per gruppo nella finestra mobile di sessanta minuti, anche con retry e concorrenza.
- Seed fonte silenzioso; ogni riattivazione parte dalle nuove pubblicazioni, senza recupero dello storico; TTL ventiquattro ore.
- Flag globale NEWS_ENABLED=false iniziale e flag SCANS_ENABLED; nessun fetch se nessun gruppo è attivo.
- Le modifiche key 2026/2027 già presenti restano conservate; i file legacy e IDE dell'utente restano intatti.

## Review Focus

- Un vecchio pulsante e un update ritentato non devono riattivare un gruppo dopo uno spegnimento più recente: Task 3 testa revisione/generazione.
- Feed Everyeye con link di altre sezioni e titoli italiani con nomi inglesi: Task 1 testa whitelist di dominio/area e lingua del feed.
- Off durante un lavoro in coda, o bot rimosso/demesso: Task 4 testa invalidazione prima dell'invio.
- Tre consumer concorrenti e retry 429 vicino al limite: Task 2/4 testano prenotazione atomica dei tentativi.
- Un feed guasto o due feed della stessa testata: Task 1/4 testano identità articolo e selezione dopo il primo tentativo di tutte le fonti.

## Task 1: Feed e normalizzazione

**Files:** Create `src/domain/news.ts`, `src/infrastructure/news/sources.ts`, `src/infrastructure/news/client.ts`, `tests/news/feeds.test.ts`; modify package files.

**Interfaces:** `NewsTopic = games | cinema | anime_manga`; `NewsArticle` contiene id, publisher, sourceName, topic, title, url, publishedAt. `NEWS_FEEDS` conserva id/publisher/name/url. `NewsFeedClient.load(feed, now, cache?)` restituisce articoli e validatori HTTP, oppure notModified. `selectNews(articles, count, cursor, publishers)` restituisce articoli e nuovi cursori.

- [x] Scrivere test per gli otto feed, CDATA/entità, categorie multiple, lingua italiana o mancante per testata italiana, rifiuto lingua straniera, date mancanti/future/scadute, URL estranei/non HTTPS, feed invalidi/DOCTYPE/oversize, 304, dedup URL e alternanza aree/testate.
- [x] Eseguire `node --import tsx --test tests/news/feeds.test.ts`; atteso RED per funzione mancante o filtro assente.
- [x] Installare la versione verificata del parser; usare validazione XML, limite stream 512 KiB, timeout 10 secondi, rifiuto DTD; filtrare solo metadati RSS.
- [x] Implementare le interfacce; usare SHA-256 di testata+URL canonico come identità.
- [x] Ripetere il test; atteso GREEN.

## Task 2: Stato D1 e lavoro durevole

**Files:** Create `migrations/0007_news.sql`, `src/infrastructure/d1/news.ts`, `src/infrastructure/d1/news-jobs.ts`, `tests/news/state.test.ts`.

**Interfaces:** `NewsRepository` espone group/setEnabled/activeGroups, feed/ingest, queueForGroups, claimDelivery, reserveAttempt, finishDelivery/retryDelivery/disable/prune. `NewsJobs` espone startCycle/dispatch/claim/complete/retry/releaseDispatch/cycleSettled. Le righe hanno token di lease e generazione di gruppo; i metodi di conferma aggiornano solo il token acquisito.

- [x] Scrivere test su SQLite per toggle/idempotenza/cap dieci gruppi, seed silenzioso, off e riattivazione, TTL e identità articolo, replay/lease, scadenza, cap atomico tre tentativi con retry e finestra mobile.
- [x] Eseguire `node --import tsx --test tests/news/state.test.ts`; atteso RED.
- [x] Migrazione additiva: gruppi, feed, articoli, lavori feed, consegne news e tentativi; tabelle giochi invariate.
- [x] Implementare query condizionali e prenotazione atomica, cursori per area/testata, job per feed/ciclo. Un ciclo seleziona news dopo il primo tentativo di tutti i feed; gli errori di un feed non bloccano le altre fonti.
- [x] Ripetere i test; atteso GREEN.

## Task 3: Permessi e toggle Telegram

**Files:** Modify `src/infrastructure/telegram/client.ts`, `src/application/context.ts`, `src/telegram/commands.ts`, `src/telegram/callbacks.ts`, `src/telegram/options.ts`; create `src/telegram/news.ts`, `tests/news/ui.test.ts`.

**Interfaces:** Telegram `getGroupAccess(chatId, userId?)` restituisce isGroup/botCanSend/userIsAdmin, ricavando ID bot da getMe e stato corrente da getChat/getChatMember. `handleNews(session, args)` gestisce comando e toggle; callback `news|on/off|generation` protetto da generazione e update_id.

- [x] Scrivere test per privato, canale, group/supergroup, admin/proprietario/member/anonymous sender, bot senza permessi, API indisponibile, pulsanti stale, off dopo on, replay e isolamento dei gruppi.
- [x] Eseguire `node --import tsx --test tests/news/ui.test.ts`; atteso RED.
- [x] Implementare il controllo dei permessi senza cambiare le impostazioni se non verificabile. Separare risposta persistita e preferenza idempotente. `/news` mostra stato; `/news on/off` e pulsante condividono la logica.
- [x] Ripetere i test; atteso GREEN.

## Task 4: Orchestrazione e consegne

**Files:** Create `src/application/news.ts`, `tests/news/runtime.test.ts`; modify `src/runtime/bindings.ts`, `queues.ts`, `consumer.ts`, `src/application/scheduler.ts`, `src/application/context.ts`, `src/runtime/webhook.ts`, `wrangler.jsonc`.

**Interfaces:** `newsEnabled(c)`, `scheduleNews(c, now)`, `publishNews(c, now)`, `processNewsFeed(id,c,now)` e `processNewsDelivery(id,c,now)` restituiscono eventuale ritardo in secondi; QueueJob aggiunge `newsfeed` e `newsdelivery`, tick aggiunge parte `news`.

- [x] Scrivere test end-to-end con SQLite e trasporti simulati per fonti isolate, zero fetch da spento, seed/ciclo successivo, cap per gruppo, global pause, off mentre pending, bot rimosso, retry 429, errore di un feed e recupero dopo pubblicazione Queue fallita.
- [x] Eseguire `node --import tsx --test tests/news/runtime.test.ts`; atteso RED.
- [x] Collegare scheduler e recovery, senza nuove risorse Cloudflare. Rileggere il gruppo prima della prenotazione e dopo la verifica Telegram; il database controlla la generazione al momento della prenotazione.
- [x] Attivare il flag di configurazione soltanto come `NEWS_ENABLED=false`; nessun gruppo abilitato automaticamente.
- [x] Ripetere i test; atteso GREEN.

## Task 5: Guida, verifica e revisione

**Files:** Modify `README.md`, `docs/architecture.md`, `docs/cloudflare.md`, `src/telegram/help.ts`; add `scripts/diagnostics/news-feeds.ts`.

- [x] Documentare /news, fonti e filtri, limite complessivo, permessi, fase silenziosa, rollback e flag globale; aggiornare guida entro limiti e formato delle pagine esistenti.
- [x] Script di diagnostica read-only: usa il vero parser sui feed approvati e stampa solo testata, conteggio, area ed eventuale errore sanitizzato.
- [x] Eseguire suite completa, typecheck, build dry run, migrazioni D1 locali e diagnostica feed; atteso successo con eventuali feed indisponibili dichiarati.
- [x] Revisione indipendente delle modifiche news e dei punti di integrazione; correggere problemi sostanziali con test RED→GREEN.
- [x] Consegnare modifiche verificabili, distinguendo codice locale da stato remoto. Prima di un rilascio remoto: backup D1 e verifica del ripristino; non inviare messaggi di prova senza autorizzazione della destinazione.

## Registro di esecuzione

Metodo: implementazione inline nella sessione corrente, con una revisione indipendente finale. L'approvazione della proposta autorizza l'implementazione; nessuna ulteriore richiesta di autorizzazione per i passaggi locali e reversibili.

Esito finale: 158/158 test, typecheck, build dry run, migrazioni locali definitive e diagnostica di tutti gli otto feed riusciti. Revisione indipendente completata; tre problemi importanti corretti, dedup query riclassificato e corretto, un caso raro di lease rinviato. Dettagli nel registro di revisione.
