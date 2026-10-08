# Gestione del notifier su Cloudflare Free

## Stato verificato l'8 ottobre 2026

Il Worker risponde su [itad-games-notifier.luppinomanuel.workers.dev](https://itad-games-notifier.luppinomanuel.workers.dev/health). L'account Free è stato confermato dall'utente. `SCANS_ENABLED=true`: scansioni di produzione attive e webhook Telegram registrato senza cancellare gli aggiornamenti pendenti. Telegram ha inizialmente restituito un errore DNS temporaneo, superato con un IP verificato. La registrazione senza IP fisso è poi riuscita: il webhook usa di nuovo la risoluzione DNS ordinaria. Il controllo dopo l'attivazione ha confermato zero update pendenti, nessun errore webhook, aggiornamenti salvati e processati in D1, prima scansione ordinaria completata e nessuna raffica di avvisi.

| Risorsa | Configurazione verificata |
| --- | --- |
| Worker | `itad-games-notifier` |
| D1 | `itad-notifier`, ID `e9f9123a-a8a7-43a0-8116-05d5a7d56db9` |
| Queue | `itad-notifier-jobs`, giurisdizione predefinita |
| Frequenza | `*/30 * * * *`, ogni 30 minuti; scansioni sospese finché il flag è false |
| Dati migrati | 16 righe wishlist, 2 preferenze utente, 10 marcatori storici |
| Primo seed silenzioso | 5 scan-job completati, 2 giveaway verificati, 0 notifiche |

La creazione della Queue con giurisdizione `eu` è stata rifiutata dalla richiesta CLI; è riuscita con il valore predefinito. Questa installazione non dichiara una residenza esclusivamente UE dei messaggi.

Il vecchio workflow operativo GitHub è stato disattivato sul ramo remoto `main` dal commit `dd543ebcb8614559877f995c44e45a46c4c1ccd6`. Il nuovo `.github/workflows/main.yml` esegue soltanto CI, senza credenziali di produzione, deploy o scansioni periodiche.

## Comportamento e copertura delle fonti

Il notifier cerca giochi PC completi riscattabili dall'Italia e conservabili senza abbonamento obbligatorio. Esclude DLC, demo, prove temporanee, offerte scadute e giochi permanentemente free-to-play. La scoperta usa i giveaway ITAD; l'invio richiede anche un prezzo EUR zero, prezzo regolare positivo, sconto effettivo del 100% nello stesso negozio e conferma ufficiale.

La conferma ufficiale implementata copre **Epic Games Store e Steam**. Gli altri negozi sono esclusi quando manca una conferma sufficiente: una lista vuota può indicare copertura limitata. Epic viene verificato per slug esatto, gioco base, regione Italia e promozione attiva; Steam per app ID, tipo gioco, regione Italia e prezzo effettivo. La verifica viene ripetuta prima della consegna.

`/start` e `/help` mostrano la guida italiana completa: comandi, esempi, configurazione wishlist, soglie di ribasso, fonti e modalità di riscatto. La guida resta in un unico messaggio HTML entro il limite Telegram. Il menu Telegram dell'installazione è stato aggiornato e riletto con tutti i 14 comandi; è configurazione del bot, indipendente dal deploy del Worker. Per altre installazioni registrare le descrizioni con [setMyCommands](https://core.telegram.org/bots/api#setmycommands). Gli avvisi gratuiti vengono inviati soltanto alle destinazioni configurate nei secrets; `/start` non aggiunge automaticamente l'utente a una distribuzione globale. Gli avvisi wishlist sono personali.

L'ispirazione GetFree riguarda la distinzione fra negozio, piattaforma di riscatto, eventuale abbonamento e disponibilità attuale. GetFree e le sue API interne non costituiscono una fonte di verità o un contratto usato dal runtime. Non viene eseguito un confronto fuzzy per titolo su GG.deals; i confronti disponibili restano quelli ITAD associati all'ID esatto.

I prezzi wishlist sono interi in centesimi: zero è distinto dal prezzo mancante. La soglia minima è un ulteriore ribasso del 10%, senza arrotondare la percentuale, rispetto all'ultima notifica consegnata con successo. Prima della prima consegna si usa una baseline silenziosa. Un aumento non alza il riferimento; `100 → 90 → 89 → 81` notifica a 90 e poi a 81. Un override per gioco nullo eredita la preferenza globale. I valori legacy inferiori al 10% vengono adeguati, conservando gli originali nel backup privato.

## Credenziali e backup privati

Conservare dotenv, token, export PostgreSQL, SQL d'importazione, backup D1 e prove contenenti dati personali in percorsi privati ignorati da Git. `migration-private/`, `.env` e `.dev.vars` sono ignorati. Non aggiungerli con `git add -f`, negli artifact CI, nelle issue o nei log. Le credenziali Cloudflare restano nel login locale Wrangler o nell'ambiente privato; quelle runtime sono secrets del Worker.

L'exporter e il generatore SQL creano file nuovi, rifiutano sovrascritture, completano la scrittura atomicamente e applicano ACL Windows o permessi Unix riservati all'utente corrente. Usare nomi distinti per ogni backup. I file prodotti direttamente da Wrangler richiedono un'analoga protezione del percorso e dei permessi: essere ignorati da Git non protegge il contenuto sul disco.

L'exporter non importa `config.py`, che può stampare configurazione sensibile. Legge `DATABASE_URL` dall'ambiente oppure da un dotenv esplicito, senza stamparlo. Passare lo `state.json` della cartella **ROOT legacy**, che può essere assente nel worktree.

Prima di modificare schema o ripristinare dati, usare una directory privata già protetta e un nuovo nome:

```powershell
npx wrangler d1 export itad-notifier --remote --output migration-private/d1-before-change.sql
```

Verificare il backup provandone il ripristino su SQLite/D1 locale. D1 Free offre anche Time Travel per 7 giorni; mantenere backup indipendenti. Riferimenti: [comandi Wrangler D1](https://developers.cloudflare.com/d1/wrangler-commands/) e [limiti D1](https://developers.cloudflare.com/d1/platform/limits/).

## Verifiche locali e deploy sospeso

Occorrono Node 22 e Python 3.11 o successivi. Gli unit test Python non richiedono PostgreSQL, rete o credenziali. Per un export reale installare `python-dotenv` e `psycopg2-binary` in un ambiente Python locale.

```powershell
npm ci
npm test
npm run typecheck
python -m unittest discover -s tests -p test_export_legacy.py
npm run db:local
npm run build
npm run benchmark
```

`build` esegue `wrangler deploy --dry-run`; `db:local` applica lo schema solo al database locale. Il benchmark usa dati sintetici e CPU Node: aiuta a localizzare il costo, ma non misura la CPU fatturata da Cloudflare né D1 e Telegram. La verifica remota resta necessaria.

I test coprono ribassi successivi e 9,6% rispetto al 10%, null e zero, vendite reali, idempotenza import, callback stabili, autenticazione/replay webhook, retry senza anticipo del riferimento, isolamento dei destinatari bloccati, cancellazione delle offerte obsolete e seed incompleto. La CI esegue `npm ci`, test, typecheck, build e unit test dell'exporter con Python 3.11. Non carica secrets, non avvia il runtime PostgreSQL e non modifica servizi remoti.

Per un nuovo account Free, autenticarsi con `npx wrangler login`, verificare piano e quote nel dashboard, creare D1 con `npx wrangler d1 create itad-notifier` e Queue con `npx wrangler queues create itad-notifier-jobs`. Aggiornare gli ID in `wrangler.jsonc`. Sull'installazione esistente non ricreare queste risorse. Non selezionare upgrade o trial a pagamento.

Caricare i secrets interattivamente, mantenere `SCANS_ENABLED=false`, quindi applicare schema e deploy:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ITAD_API_KEY
npx wrangler secret put TELEGRAM_CHAT_ID
# Solo se è prevista una destinazione di gruppo:
npx wrangler secret put TELEGRAM_CHAT_GROUP
npm run db:remote
npm run deploy
```

Usare un secret webhook casuale e distinto dal token del bot. `/health` è pubblico; `/telegram`, `/admin/status` e `/admin/scan` richiedono l'header `X-Telegram-Bot-Api-Secret-Token`. La sospensione blocca scansioni ordinarie e notifiche automatiche; le risposte ai comandi possono ancora essere consegnate.

## Migrazione silenziosa e attivazione

1. Arrestare polling/scheduler Python e il vecchio workflow operativo prima di assegnare la produzione al Worker. Conservare PostgreSQL e il codice legacy. Per uno snapshot finale coerente, fermare anche altri writer legacy durante l'export.
2. Esportare PostgreSQL con transazione read-only `REPEATABLE READ` e fondere i marcatori dello `state.json` ROOT. Sostituire i percorsi dell'esempio senza inserire password o DSN nei comandi:

```powershell
python scripts/export_legacy.py --env-file "C:/percorso/legacy/.env" --state "C:/percorso/legacy/state.json" --output migration-private/legacy-final.json
npx tsx scripts/import_legacy.ts --input migration-private/legacy-final.json --output migration-private/import-final.sql
npx wrangler d1 execute itad-notifier --remote --file migration-private/import-final.sql
```

3. Riconciliare i conteggi con il riepilogo dell'exporter usando query aggregate, senza stampare nomi, chat ID o righe personali. Nell'import iniziale verificato erano 16/2/10. `ON CONFLICT DO NOTHING` preserva preferenze, wishlist già presenti e consegne nuove; un import interrotto si completa rieseguendo lo stesso SQL. Non equivale a sincronizzare modifiche successive del database legacy.

```powershell
npx wrangler d1 execute itad-notifier --remote --command "SELECT (SELECT COUNT(*) FROM wishlist) AS wishlist, (SELECT COUNT(*) FROM user_prefs) AS preferences, (SELECT COUNT(*) FROM legacy_sent_slugs) AS legacy_slugs;"
```

4. Eseguire `POST /admin/scan` autenticato mentre `SCANS_ENABLED=false`. Questa modalità aggiorna silenziosamente i prezzi correnti, anche quando quelli legacy erano vecchi, e registra le promozioni attuali senza raffica iniziale. I campi legacy `last_notified_price` sono osservazioni, non prove di consegna. I timestamp PostgreSQL senza fuso sono interpretati come UTC, dichiarato nell'export.
5. Attendere entrambe le scansioni complete: `/admin/status` deve indicare `pricesSeeded=true`, `giveawaysSeeded=true`, timestamp aggiornati e nessuna notifica automatica generata dal seed. Un errore API o una pagina incompleta non autorizzano a completare il seed. Gli slug storici sono marcatori separati; nuove campagne sullo stesso gioco possono notificare in futuro.
6. Verificare CPU, errori, righe D1 e operazioni Queue sul piano Free effettivo. Completare le prove rappresentative prima dell'attivazione. Impostare il webhook Telegram a `https://itad-games-notifier.luppinomanuel.workers.dev/telegram` con il secret configurato, preservando gli update pendenti (`drop_pending_updates=false`). Non pubblicare il token o la sua URL API completa nei log.
7. Dopo aver confermato un unico writer, impostare `SCANS_ENABLED=true` in `wrangler.jsonc`, eseguire `npm run deploy`, verificare `/health`, un comando privato di test e il primo ciclo ordinario. Non reimportare vecchi prezzi per resettare i riferimenti dopo l'attivazione.

Esempio amministrativo PowerShell con un secret già caricato privatamente nell'ambiente:

```powershell
$notifierHeaders = @{ "X-Telegram-Bot-Api-Secret-Token" = $env:TELEGRAM_WEBHOOK_SECRET }
Invoke-RestMethod -Method Post -Uri "https://itad-games-notifier.luppinomanuel.workers.dev/admin/scan" -Headers $notifierHeaders
Invoke-RestMethod -Method Get -Uri "https://itad-games-notifier.luppinomanuel.workers.dev/admin/status" -Headers $notifierHeaders
```

Una scansione manuale mentre il flag è true è ordinaria e può notificare. Per ripetere deliberatamente un seed silenzioso, sospendere prima le scansioni e verificare che non vi siano consegne automatiche in volo.

## Budget Free e sorveglianza

Le quote sono condivise con gli altri servizi dell'account e possono cambiare: verificare dashboard e fonti ufficiali prima di ampliare il carico.

| Risorsa | Quota Free | Scelta operativa e fonte |
| --- | --- | --- |
| Workers | 100.000 richieste/giorno; 10 ms CPU per HTTP e Cron; 50 subrequest/invocazione | Budget prudenziale di 10 ms per lavoro; attese di rete separate dalla CPU. [Limiti Workers](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 | 5 milioni righe lette e 100.000 scritte/giorno; 5 GB totali | Misurare righe effettive, incluse scritture degli indici. [Prezzi D1](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 database/invocazione | 500 MB per database; 50 query/invocazione | Query aggregate, indici e lavoro limitato. [Limiti D1](https://developers.cloudflare.com/d1/platform/limits/) |
| Queues | 10.000 operazioni/giorno; retention 24 ore | Un messaggio piccolo senza retry usa normalmente 3 operazioni; i retry aggiungono letture. [Prezzi Queues](https://developers.cloudflare.com/queues/platform/pricing/) |

Il budget applicativo limita la wishlist a **200 giochi distinti** nell'intera installazione. Con 48 cicli al giorno, il solo polling prezzi genera circa `48 × ceil(giochi_distinti / 10)` lavori: a 200 giochi sono 960 lavori e circa 2.880 operazioni Queue, prima di giveaway, comandi, notifiche, retry e duplicati. È un margine di progetto, non una garanzia rispetto a traffico utente arbitrario. Misurare anche l'invio a più utenti; non aumentare la soglia senza una nuova verifica Free.

Il consumer prende un solo messaggio per invocazione, ogni lavoro prezzo contiene al massimo 10 ID e le pagine giveaway un record per lavoro. D1 conserva job e outbox per recuperare errori; update ID Telegram e lease riducono duplicati e concorrenza. Un invio riuscito con esito incerto prima della registrazione può essere ripetuto: questo rischio è stato accettato. Il riferimento prezzo avanza solo dopo il successo registrato; un destinatario che blocca il bot non blocca gli altri.

La prima verifica remota ha mostrato CPU **3,554–8,956 ms** nelle metriche GraphQL e **3–8 ms** nei trace tail, senza errori nel seed osservato. I valori GraphQL erano microsecondi, convertiti dividendo per 1.000. Le verifiche successive prima dell'ottimizzazione hanno rilevato picchi di 18,741 ms nei consumer e 14,381 ms sul trigger, senza errori di risorse. Lo scheduler è stato quindi suddiviso in tre lavori indipendenti (prezzi, giveaway, recupero), con pubblicazione tracciata e pagine giveaway singole. HTTP e Cron ora accodano soltanto tre piccoli messaggi; i lavori funzionano anche se arrivano in ordine diverso. Il costo fisso aggiuntivo è circa 432 operazioni Queue/giorno. Dopo la suddivisione, il ciclo ordinario è terminato senza job pendenti e senza errori di risorse: trigger HTTP 2,283 ms, picco osservato nei lavori 10,499 ms (prima 18,741 ms). Un picco occasionale non equivale a una garanzia che ogni invocazione resti sotto 10 ms; verificare le metriche e il rollover descritto nei limiti Workers. Questo campione non prova ogni percorso né la coda massima: controllare separatamente webhook, comandi con filtri/review, consegne e carico limite. La ricerca reale con 200 record e 10 chiamate recensioni ha restituito 10 offerte usando 6,410 ms CPU; la prova prezzi ha verificato 10 giochi. Entrambe sono letture senza messaggi artificiali. Sono passati 61 test TypeScript e 6 Python, typecheck esteso a strumenti/test e build. Le prime prove hanno riprodotto un HTTP400 per `Content-Type: application/json` sulle richieste GET: il client ora imposta questa intestazione soltanto sulle richieste con corpo.

Controllare CPU/`exceededCpu`, errori API/429, backlog e retry Queue, quota operazioni, righe D1 e timestamp delle scansioni complete. Una Queue vuota non prova una scansione riuscita: verificare anche D1. Se il backlog si avvicina alle 24 ore o i consumi superano il margine, sospendere `SCANS_ENABLED` e ridurre/ottimizzare il lavoro prima di riattivare; non passare automaticamente a Paid. Le pulizie sono limitate per ciclo: update/job completati dopo 7 giorni e consegne finalizzate dopo 90 giorni. Wishlist e preferenze restano persistenti.

## Ripristino e rollback

Per un problema di codice con dati sani, sospendere le scansioni e preferire il ritorno a una versione Worker verificata mantenendo D1. Il rollback del codice non ripristina automaticamente schema o dati: controllare compatibilità prima di attivare una vecchia versione.

Per tornare a Python:

1. Impostare `SCANS_ENABLED=false`, deployare e attendere le consegne in volo, controllando tail e outbox. Fermare il webhook verso il Worker prima di avviare polling legacy, preservando gli update Telegram pendenti.
2. Esportare D1 in un nuovo backup privato. Conservare PostgreSQL, JSON legacy e SQL d'importazione.
3. Riconciliare privatamente nuovi giochi, rimozioni, preferenze e consegne successive al passaggio: non tornano automaticamente su PostgreSQL. Gli strumenti esistenti sono unidirezionali, quindi il rollback dati richiede riconciliazione. Anche la semantica Python delle notifiche è legacy e va rivista rispetto all'ulteriore ribasso concordato.
4. Riattivare un solo processo di polling e un solo scheduler legacy dopo la riconciliazione. L'attuale workflow GitHub è CI; ripristinare uno scheduler operativo è una scelta esplicita e deve evitare due writer contemporanei.
5. Verificare Cloudflare sospeso e nuovi update ricevuti soltanto dal proprietario scelto. Non eliminare D1, Queue o PostgreSQL.

Provare ogni ripristino prima su una copia locale. Usare Time Travel o backup SQL dopo aver verificato il punto di recupero e le consegne già effettuate: una vecchia outbox senza riconciliazione può reinviare messaggi. Conservare gli identificativi delle consegne confermate durante la procedura.
