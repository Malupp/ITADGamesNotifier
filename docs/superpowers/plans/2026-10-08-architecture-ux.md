# Architettura e interazione Telegram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere il progetto leggibile e la wishlist compatta, separando le risposte Telegram dalle scansioni senza perdere stato o affidabilità.

**Architecture:** Un Worker TypeScript con composizione esplicita, casi d'uso e integrazioni separate; un D1 e due Queue sul piano Free. La wishlist usa una risposta persistente per pagina e modifica lo stesso messaggio tramite callback. Migrazioni additive e compatibilità con i lavori già accodati consentono il passaggio senza reimportare dati.

**Tech Stack:** Node 22, TypeScript, Cloudflare Workers/D1/Queues, Telegram Bot API, ITAD, SQLite per i test, Python 3.11+ per la migrazione legacy. Nessuna nuova dipendenza runtime.

**Spec:** [Specifica approvata](../specs/2026-10-08-architecture-ux-design.md).

## Global Constraints

- Servizi gratuiti; nessun upgrade o trial Paid. Un database D1, coda esistente conservata e nuova coda `itad-notifier-interactions`.
- Scansioni ogni 30 minuti; giochi PC completi riscattabili gratis; fonti ufficiali Epic/Steam verificate per Italia/EUR.
- Ulteriori ribassi wishlist almeno del 10%; riferimento aggiornato soltanto dopo consegna registrata. Zero valido, prezzi mancanti null, seed silenzioso.
- Retry con raro duplicato accettato; update persistito prima dell'ack, risposta persistita prima dell'invio.
- Massimo 200 giochi distinti; batch prezzi fino a dieci ID; consumer un lavoro per invocazione, timeout batch zero, concorrenza uno per coda.
- Nessun reset di database, seed, wishlist o preferenze. Migrazioni esistenti conservate nell'ordine originale.
- Segreti, backup e dati personali esclusi da Git e dai log. Tutti i percorsi di move devono essere verificati dentro il workspace su Windows.
- Preservare le modifiche locali principali a `bot.py`, `itad_api.py`, `.idea/workspace.xml`; no reset/checkout forzati. Pubblicazione PR già autorizzata; merge remoto non necessario.

## Review Focus

1. Navigazione dopo rimozioni dalla wishlist: pagina valida o stato vuoto, stesso messaggio, nessuna esposizione ad altri utenti (Task 3).
2. Titoli Unicode, HTML ostile e URL lunghi: messaggio valido entro limite, zero distinto dal prezzo mancante (Task 3).
3. Callback rapidi o replay: una modifica vecchia non deve sostituire una pagina più recente; «not modified» non deve diventare un errore definitivo (Task 2).
4. Passaggio fra code con lavori pendenti e fallimento della pubblicazione: recupero durabile senza perdita, messaggi legacy ancora elaborabili (Task 4).
5. Checkout principale sporco: nessuna perdita dei file locali, nessuna pubblicazione delle loro modifiche non revisionate e nessun ripristino dati involontario (Task 6).

## File e confini

| File o gruppo | Responsabilità |
| --- | --- |
| `src/index.ts` | Composizione dei tre handler Workers; nessuna regola di mercato |
| `src/runtime/{bindings,webhook,consumer,queues}.ts` | Env, HTTP autenticato, ack/retry Queue e pubblicazione |
| `src/application/{context,scheduler,scan-job,delivery,update}.ts` | Casi d'uso e dipendenze esplicite |
| `src/domain/{models,pricing,promotions}.ts` | Tipi e regole pure; nessun binding Cloudflare/Telegram |
| `src/telegram/{commands,callbacks,help,formatters,wishlist}.ts` | Parsing e risposte rivolte all'utente |
| `src/infrastructure/http.ts` | Richieste, timeout e errori sanitizzati |
| `src/infrastructure/itad/client.ts` | Ricerca, prezzi, giveaway e offerte ITAD |
| `src/infrastructure/stores/verification.ts` | Conferma ufficiale Epic/Steam |
| `src/infrastructure/telegram/client.ts` | sendMessage, editMessageText e answerCallbackQuery |
| `src/infrastructure/d1/{settings,preferences,wishlist,deliveries,updates,scans}.ts` | Repository D1 e lease, ognuno con il proprio confine |
| `tests/{domain,telegram,application,infrastructure,migration}/` | Test suddivisi come il codice |
| `tests/helpers/sqlite.ts` | Database SQLite reale con tutte le migrazioni |
| `scripts/{migration,diagnostics}/` | Tool esistenti spostati, senza cambiare i dati prodotti |
| `scripts/run-tests.mjs` | Scoperta ricorsiva ordinata dei file `*.test.ts`, lancio `tsx --test` senza glob della shell |
| `legacy/python/` | File Python storici, `requirements.txt`, `nixpacks.toml` e README archivio |
| `docs/architecture.md`, `README.md`, `docs/cloudflare.md` | Architettura, ingresso al progetto e gestione aggiornata |

## Task 1: Riorganizzazione verificabile senza cambiare comportamento

**Files:** Spostare/suddividere gli otto moduli attuali `src/{bot,clients,domain,scans,store,types,verification,worker}.ts` secondo la tabella; spostare test e script; aggiornare `wrangler.jsonc`, `package.json`, fixture, CI e documentazione. Archiviare i file Python pubblici, lasciando dati e dotenv privati fuori dalle cartelle pubblicate.

**Interfaces:** `createContext(env: Env, options?: {fetcher?: typeof fetch; now?: () => number}): ApplicationContext` in `application/context.ts` compone repository e client. Il contesto espone `settings`, `preferences`, `wishlist`, `deliveries`, `updates`, `scans`, `itad`, `telegram`, `queues`, `now`. Repository derivati da Store preservano firme e SQL attuali. `handleRequest(request: Request, context: ApplicationContext, now?: number): Promise<Response>`, `schedule(context: ApplicationContext, now: number, initialize?: boolean, part?: 'all'|'prices'|'giveaways'|'recover'): Promise<void>`, `processJob(job: QueueJob, context: ApplicationContext, now: number): Promise<number|null>`, `handleUpdate(context: ApplicationContext, update: TelegramUpdate): Promise<void>` sostituiscono i corrispondenti entrypoint interni. Env/QueueJob restano in `runtime/bindings.ts`; Game/Quote/Offer/Preferences/Delivery/WishlistItem in `domain/models.ts`.

- [ ] Eseguire baseline `npm test`, `npm run typecheck`, `npm run build` e unit test Python, registrando esiti prima del refactor.
- [ ] Aggiungere test `tests/application/context.test.ts`: due contesti con fetcher distinti devono usare soltanto il proprio client; `assert.deepEqual(callsA, ['A']); assert.deepEqual(callsB, ['B'])`, senza sostituire `globalThis.fetch`.
- [ ] Eseguire il test con `npx tsx --test tests/application/context.test.ts`: deve fallire perché la composizione esplicita manca.
- [ ] Estrarre moduli mantenendo SQL, timeout, ordini e regole; definire il contesto e aggiornare test ai client iniettati. Le funzioni di formato passano da dominio a presentazione; `safeUrl`/normalizzazione restano condivise solo dove necessari.
- [ ] Implementare scoperta ricorsiva test con `node scripts/run-tests.mjs`; in `package.json` impostare `test` a quel comando e `benchmark` al percorso diagnostics. Il runner passa percorsi come argomenti a `tsx`, propaga exit code e fallisce se non trova test.
- [ ] `tests/helpers/sqlite.ts` legge tutte le migrazioni SQL ordinate da `../../migrations/`; aggiornare percorsi degli strumenti in test migration e import Python. Per CI Python usare `python -m unittest discover -s tests/migration -p test_export_legacy.py`.
- [ ] Spostare soltanto codice legacy tracciato. `state.json`, se contiene esclusivamente marcatori già pubblici, documentarne la provenienza senza portarlo nel runtime; nessun export/dotenv/dato personale nuovo entra in Git.
- [ ] Eseguire suite, typecheck, build e test Python al nuovo percorso; richiedere zero regressioni e stessi 61 casi TypeScript iniziali individuati dal runner. Controllare import senza vecchi percorsi e dominio senza dipendenze runtime.
- [ ] Commit `refactor: organize notifier by responsibility`.

## Task 2: Modifiche Telegram durabili e idempotenti

**Files:** Creare `migrations/0004_message_edits.sql`; modificare `domain/models.ts`, repository deliveries, client Telegram, `application/delivery.ts`; test in `tests/infrastructure/{deliveries,telegram-client}.test.ts` e `tests/application/delivery.test.ts`.

**Interfaces:** Estendere Delivery con `operation: 'send'|'edit'`, `telegram_message_id: number|null`, `view_revision: number|null`. Migrazione con `operation TEXT NOT NULL DEFAULT 'send'`, altri due campi INTEGER nullable; indice sulle modifiche per chat/message/revision. `queueEdit(key: string, chatId: string, messageId: number, text: string, revision: number, replyMarkup?: unknown): Promise<string>` persiste una reply edit. `TelegramClient.editMessage(chatId: string, messageId: number, text: string, replyMarkup?: unknown): Promise<void>`. ApiError aggiunge motivo sanitizzato opzionale `'not_modified'|'message_missing'`, valorizzato solo da risposte Telegram riconosciute.

- [ ] Scrivere test: una riga legacy senza colonne nuove resta `operation='send'`; `queueEdit` replay mantiene una riga e `message_id=42`; send ed edit usano i metodi Telegram corretti. Assert sugli endpoint e sui campi JSON, mai su URL con token reali.
- [ ] Scrivere test: edit 429 resta pending con retry_after, edit not_modified diventa sent, messaggio eliminato produce una sola breve risposta «Riapri /wishlist» con chiave derivata dalla consegna fallita. Non bloccare la chat per questi 400; 403 mantiene quarantena destinatario.
- [ ] Scrivere test: edit con revision 8 viene scartato quando esiste edit revision 9 per stessa chat/message; replay della revision 8 non sovrascrive quella nuova. Query dell'outbox confronta le revisioni prima della chiamata Telegram; stesso consumer interattivo serializza le modifiche.
- [ ] Eseguire questi test, verificando fallimento prima dell'implementazione.
- [ ] Aggiungere migrazione, repository, riconoscimento dei due errori senza conservare descrizioni sensibili, ramo delivery edit e cancellazione delle revisioni obsolete. Conservare lease e completamento dopo Telegram.
- [ ] Eseguire test focalizzati e suite completa; SQLite applica vecchie migrazioni, inserisce una delivery legacy, poi applica 0004 e dimostra che la delivery è ancora inviabile.
- [ ] Commit `feat: persist Telegram message edits and retries`.

## Task 3: Wishlist in un solo messaggio navigabile

**Files:** `src/telegram/{wishlist,formatters,commands,callbacks,help}.ts`; test `tests/telegram/wishlist.test.ts`, `tests/application/update.test.ts`.

**Interfaces:** `buildWishlistPage(items: WishlistItem[], prices: Map<string, PriceQuote[]>, offset: number): {text: string; replyMarkup?: unknown; nextOffset: number|null}` crea pagina con massimo dieci elementi. Titoli massimo 100 caratteri, negozi 60, URL HTTPS massimo 2048; formattare unità complete e tenere HTML grezzo entro 3800 caratteri per margine rispetto ai 4096 Telegram. `showWishlist(context: ApplicationContext, userId: string, chatId: string, updateId: number, offset?: number, messageId?: number): Promise<void>` usa queueMessage iniziale o queueEdit con revision updateId. I callback `wishlistpage|offset` rimangono compatibili.

- [ ] Scrivere test con 16 giochi: `/wishlist` produce esattamente una reply, contiene giochi 1–10 e pulsante `wishlistpage|10`; API prezzi riceve una sola richiesta con al massimo dieci ID.
- [ ] Scrivere test callback pagina due su message_id 42: produce una edit verso 42, contiene giochi 11–16 e pulsante Indietro; stesso user e chat privata richiesti. Nessun gioco di altri utenti viene letto o modificato.
- [ ] Scrivere test con prezzo 0, prezzo assente, titolo `<&>` e Unicode, negozio lungo e URL 2048: HTML escapato, zero visibile come GRATIS, mancante distinto; testo ≤3800 e nessun tag spezzato. Se non entra tutto, nextOffset corrisponde al primo elemento non mostrato.
- [ ] Scrivere test wishlist vuota e navigazione dopo rimozione di tutti i giochi/ultima pagina: clamp dell'offset a pagina disponibile o edit dello stato vuoto, senza eccezioni o nuovi elenchi separati.
- [ ] Eseguire i test per mostrare il fallimento del comportamento attuale.
- [ ] Implementare formatter e caso d'uso, conservando prezzi live, scadenze italiane e link; per offset dinamico Indietro ricalcola una pagina valida fino a dieci elementi prima. Aggiornare guida alla navigazione nello stesso messaggio.
- [ ] Eseguire test focalizzati e suite completa; /remove e /setscontog continuano a usare le proprie selezioni, senza cambiamenti ai ribassi.
- [ ] Commit `feat: show wishlist in one paginated Telegram message`.

## Task 4: Separare interazioni e lavoro periodico

**Files:** `runtime/{bindings,queues,webhook,consumer}.ts`, `application/{scheduler,update,delivery}.ts`, repository deliveries, `wrangler.jsonc`; test `tests/runtime/queues.test.ts`, `tests/application/recovery.test.ts`.

**Interfaces:** Env aggiunge `INTERACTION_QUEUE?: Queue<QueueJob>`; WORK_QUEUE resta background. `publishJobs(context: ApplicationContext, jobs: QueueJob[], lane: 'interactive'|'background'): Promise<void>` usa la coda interattiva se configurata, altrimenti WORK_QUEUE per compatibilità. `pendingDeliveryJobs(now: number, limit?: number): Promise<Array<{id: string; kind: Delivery['kind']}>>` permette di separare reply e avvisi senza affidarsi al formato dell'ID. Il consumer continua a processare tutti i vecchi QueueJob indipendentemente dalla coda di origine.

- [ ] Scrivere test: webhook update e reply vanno alla coda interattiva; tick, probe, scan e delivery price/giveaway alla coda esistente. Un mix di outbox deve generare esattamente un dispatch per ID nello stesso flush.
- [ ] Scrivere test: una scansione bloccata su una Promise non impedisce l'elaborazione di un update sul consumer interattivo; messaggi già nella vecchia coda possono completare normalmente.
- [ ] Scrivere test pubblicazione interattiva fallita dopo commit: ack webhook 503 e update ancora recuperabile; recovery instrada update/reply sulla coda corretta, con stesso ID e lease. Replay delivery non produce secondo invio confermato.
- [ ] Eseguire i test, verificando fallimento prima del routing nuovo.
- [ ] Implementare routing esplicito e fallback. Configurare entrambe le code con batch size 1, timeout 0, concurrency 1, max retries 5 e retry delay 60; non creare risorse remote in questo task locale.
- [ ] Eseguire test, typecheck e build. Verificare che mantenere scansioni sospese non sospenda le risposte ai comandi.
- [ ] Commit `feat: isolate interactive replies from background scans`.

## Task 5: Misure della latenza e valutazione recensioni

**Files:** Creare `application/telemetry.ts` e `scripts/diagnostics/latency.ts`; aggiornare boundary HTTP/client/update/delivery e client ITAD; test `tests/application/telemetry.test.ts`, `tests/infrastructure/itad-client.test.ts`.

**Interfaces:** `measure<T>(stage: 'itad'|'update'|'delivery', action: () => Promise<T>, record: (sample: {stage: string;durationMs: number;outcome: 'ok'|'error'}) => void, clock?: () => number): Promise<T>` misura senza dati del messaggio. Il repository updates legge il timestamp created_at per attesa; delivery usa due_at per attesa al primo tentativo, distinguendo tentativi successivi. La diagnostica produce conteggi e durate aggregate, non record personali. `ItadClient` accetta opzione `reviewConcurrency?: 1|2`, default 1 fino alla prova comparativa.

- [ ] Scrivere test clock deterministico e errore: durata corretta, errore originale propagato, sample limitato ai tre campi autorizzati. Dati della fixture (token, testo e chat) non devono apparire nei log.
- [ ] Scrivere test recensioni con richieste controllate: picco ≤2, totale ≤10, ordinamento risultati uguale al modo seriale; 429/timeout non restituiscono risultati parziali silenziosamente e mantengono retry.
- [ ] Eseguire test in rosso, poi implementare strumentazione e modalità comparativa. Risultati paralleli vengono raccolti e filtrati nell'ordine originale della lista, senza cambiare ranking o filtri.
- [ ] Eseguire confronto locale deterministico con ritardo simulato: due chiamate indipendenti possono sovrapporsi, senza test temporali fragili basati su sleep; utilizzare contatori e promise controllate.
- [ ] Confrontare remotamente seriale/parallelo soltanto dopo autenticazione valida e senza inviare messaggi artificiali. Attivare default 2 solo se API, 429, CPU e risultati restano entro i vincoli; altrimenti mantenere 1 e riportare le misure.
- [ ] Commit `perf: measure command stages and bound review requests`.

## Task 6: Documentazione, rilascio Free e progetto visibile nel checkout principale

**Files:** `README.md`, `docs/{architecture,cloudflare}.md`, `legacy/python/README.md`, CI; prove private in `migration-private/`, escluse da Git. Aggiornamento della PR #10, configurazione Cloudflare e checkout principale dopo verifica.

**Interfaces:** README identifica `src/index.ts` come ingresso attivo; architecture documenta HTTP → D1 → Queue interattiva → comando → outbox → Telegram e cron → Queue background → scansioni → outbox. Runbook elenca entrambe le Queue e ordine di deploy/migrazioni/rollback.

- [ ] Completare docs con albero, responsabilità, diagramma Mermaid e tabella «dove modificare cosa», comandi test/dev e distinzione codice storico/produzione. Non presentare come implementate prestazioni non misurate.
- [ ] Eseguire suite completa, unit test Python al nuovo percorso, typecheck, build, diff check e ricerca di credenziali reali nei soli file pubblicabili. Revisione indipendente dell'intero diff prima del rilascio.
- [ ] Verificare login Cloudflare e account/piano Free. Se persiste 7403, diagnosticarne account/scopes e chiedere un nuovo login solo se necessario; non chiedere token in chat. Nessun deploy senza migrazioni verificabili e backup privato.
- [ ] Esportare D1 in nuovo file privato protetto; provare localmente ripristino più migrazione 0004. Non sovrascrivere backup precedenti né reimportare stato legacy.
- [ ] Creare solo `itad-notifier-interactions` se assente, sul piano Free, conservando la coda esistente. Applicare migrazione additive remota, deploy del consumer compatibile e nuovo routing; webhook URL e secret restano invariati. Se la quota non consente il nuovo asset, fermare il rilascio delle due code e spiegare il vincolo, senza upgrade.
- [ ] Verificare /health, /admin/status, webhook, code e scan-job. Campionare tempi di comandi reali prima/dopo e durante un ciclo di scansione; richiedere al proprietario una prova /wishlist se manca traffico reale, senza impersonarlo o trasmettere dati personali nella chat di lavoro.
- [ ] Verificare CPU, errors/exceededCpu, operazioni aggregate delle due code e scansioni completate; nessuna raffica, riferimenti e conteggi wishlist invariati. Mantenere cron */30 e non dichiarare beneficio temporale finché non misurato.
- [ ] Pubblicare il diff finale nella PR #10 con lease sullo SHA attuale, comprese rimozioni dei vecchi percorsi; aggiornare titolo/body al risultato finale e attendere CI. Nessun merge remoto automatico.
- [ ] Integrare nel checkout principale in modo reversibile: backup privato dei tre file locali e patch tracciata, stash limitato a quei percorsi, nuovo ramo locale `workspace/cloudflare-ux` dal commit verificato del worktree. Riapplicare contenuto di bot.py/itad_api.py ai rispettivi percorsi `legacy/python/`, workspace.xml al percorso originale; confrontare byte/hash con il backup. Conservare stash e backup finché il controllo non è concluso. Non commettere/pubblicare queste modifiche locali automaticamente.
- [ ] Eseguire controllo percorso/hash sulle copie locali e verificare che la root mostri `src/`, `docs/architecture.md` e gli script aggiornati. Riportare dove sono le modifiche locali e l'eventuale verifica remota ancora bloccata.
- [ ] Commit della documentazione pubblica; riepilogo finale con link PR, architettura e risultati effettivi. Se rollback necessario, mantenere consumer che supporta edit e completare/sospendere i job nuovi prima di tornare al vecchio codice.

## Autoverifica del piano

- Ogni sezione della specifica ha un task: confini/legacy (1), edit affidabili (2), wishlist (3), isolamento (4), misure e recensioni (5), Free/docs/checkout/rilascio (6).
- Ogni classe del Review Focus ha test o confronto esplicito nel task proprietario. La riorganizzazione conserva le prove di dominio e migrazione esistenti.
- I task consumano firme definite sopra; publisher usa lane esplicita, l'outbox distingue operazione e tipo funzionale, il formato pagina restituisce offset effettivo.
- Nessuna risorsa remota viene cambiata prima dei controlli locali e della revisione del piano; nessuna garanzia di latenza derivata dal solo endpoint health.

## Handoff

Piano pronto per revisione dell'utente. Consiglio esecuzione **Native**: implementazione nella sessione attuale, task in ordine e revisione indipendente finale. I task condividono contesto/repository/outbox e parallelizzarli aggiungerebbe coordinamento durante il refactor. L'alternativa Subagent-driven assegna implementazione e revisione di ogni task a nuovi agenti ed è più costosa.
