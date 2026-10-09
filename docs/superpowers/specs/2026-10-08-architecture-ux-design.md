# Architettura leggibile, wishlist compatta e risposte più rapide

Stato: specifica approvata dall'utente l'8 ottobre 2026; implementazione da pianificare, codice di produzione non modificato.

## Obiettivo e vincoli

L'utente richiede risposte meno lente, una wishlist raccolta in un messaggio e un progetto con struttura comprensibile. Restano i vincoli già concordati: servizi gratuiti, scansioni ogni 30 minuti, giochi PC completi riscattabili gratis, fonti ufficiali verificate, ulteriori ribassi wishlist almeno del 10%, retry con raro duplicato accettato e recupero silenzioso dello stato. Migliorare chiarezza e interazione senza cambiare queste regole.

## Evidenze raccolte l'8 ottobre 2026

- Il bot attivo è il Worker TypeScript nel worktree `.worktrees/cloudflare-free`; il checkout principale è ancora sul vecchio commit Python `c0d70fa`. La PR #10 è aperta e non integrata. Questo spiega perché aprire la cartella principale non mostra chiaramente l'implementazione in produzione.
- Il checkout principale contiene modifiche locali a `bot.py`, `itad_api.py` e `.idea/workspace.xml`: conservarle e riconciliarle prima di qualsiasi aggiornamento del checkout, senza reset o checkout forzati.
- `/wishlist` prepara fino a dieci risposte distinte per i giochi e un'altra risposta di riepilogo/navigazione. Ogni risposta richiede una propria consegna persistente e un passaggio in coda.
- Un'unica Queue gestisce update Telegram, scansioni, recupero e consegne. Configurazione: batch di un messaggio, timeout batch zero, concorrenza uno. Un lavoro lento può quindi ritardare comandi e risposte; non è il timeout predefinito di cinque secondi.
- I filtri sulle recensioni delle offerte possono richiedere fino a dieci chiamate ITAD consecutive. La ricerca prezzi wishlist usa invece una chiamata per pagina di dieci giochi.
- Tre richieste `/health` hanno restituito HTTP 200 in 102, 81 e 24 ms. Questo misura disponibilità e percorso HTTP dalla macchina di prova, non il tempo di risposta Telegram completo.
- Lo stato amministrativo mostra entrambe le scansioni completate, nessun invio in coda e nessun errore o update pendente nel webhook Telegram al momento della verifica.
- La query amministrativa D1 per ricostruire i tempi storici è stata rifiutata con Cloudflare 7403, autorizzazione account non valida per il servizio. Non sono disponibili misure storiche attendibili di attesa in coda, API e consegna; ripristinare l'autenticazione prima della verifica remota dettagliata.

Workers esegue isolate V8 avviati rapidamente e non un server che va in sleep come un container inattivo. Non attribuire quindi i ritardi osservati a un risveglio del server. Riferimenti: [runtime Workers](https://developers.cloudflare.com/workers/reference/how-workers-works/) e [batching Queues](https://developers.cloudflare.com/queues/configuration/batching-retries/).

## Approccio consigliato e alternative

Consiglio un solo Worker, organizzato per responsabilità, con due code sul medesimo piano Free: una per interazioni e relative risposte, una per scansioni e notifiche automatiche. D1 resta unico. La separazione evita che il lavoro periodico occupi l'unico consumer disponibile per la chat, preservando la consegna persistente.

Spostare soltanto i file e compattare la wishlist è meno invasivo ma lascia la contesa fra comandi e scansioni. Separare il progetto in più servizi o introdurre un framework aggiunge deploy e concetti senza un beneficio necessario per questo bot. Non è previsto.

## Struttura proposta

```text
ITADGamesNotifier/
├── src/
│   ├── index.ts                 # collega HTTP, cron e consumer
│   ├── runtime/                 # webhook, autenticazione, routing code
│   ├── telegram/                # comandi, callback, guida e formattazione
│   ├── application/             # casi d'uso: scansioni, wishlist, invii
│   ├── domain/                  # modelli e regole pure di prezzi/promozioni
│   └── infrastructure/
│       ├── itad/                # client ITAD e normalizzazione risposte
│       ├── stores/              # conferme ufficiali Epic e Steam
│       ├── telegram/            # client HTTP Telegram
│       └── d1/                  # repository, outbox, update e scan-job
├── migrations/                  # schema D1, sequenza esistente conservata
├── scripts/
│   ├── migration/               # export legacy e import D1
│   └── diagnostics/             # probe e benchmark
├── tests/                       # stessa suddivisione delle responsabilità
├── legacy/python/               # codice Python storico e istruzioni
├── docs/
│   ├── architecture.md          # mappa, flussi e guida «dove modificare cosa»
│   ├── cloudflare.md            # gestione, quote, migrazione e rollback
│   └── superpowers/             # specifiche e piani
├── README.md                    # ingresso chiaro al progetto attivo
├── package.json
├── tsconfig.json
└── wrangler.jsonc
```

`index.ts` contiene soltanto la composizione degli handler. Separare l'attuale `worker.ts` in webhook/scheduler/consumer e casi d'uso. Separare comandi, callback e formattazione dell'attuale `bot.ts`. Dividere `clients.ts` fra ITAD e Telegram e `store.ts` fra repository di wishlist/preferenze, outbox, update e impostazioni. Le funzioni pure del dominio non dipendono da Cloudflare o Telegram; la presentazione HTML appartiene a `telegram/`.

L'applicazione riceve client e repository espliciti, così i test non devono sostituire globalmente `fetch`. Introdurre solo interfacce necessarie a questi confini, senza container di dependency injection o livelli vuoti. Riformattare i moduli estratti con nomi leggibili, evitando funzioni compresse su una riga.

Il codice Python viene archiviato, non cancellato. File privati, dotenv, export, stato personale e credenziali non vengono spostati in cartelle pubblicate. Aggiornare percorsi degli strumenti, fixture e documentazione. La consegna comprende un percorso sicuro per rendere visibile il progetto attivo nella cartella principale, preservando le modifiche locali preesistenti.

## Wishlist: un messaggio, con navigazione nello stesso messaggio

`/wishlist` risponde con un solo messaggio: titolo, numero di giochi, righe compatte con titolo, miglior prezzo, negozio, sconto effettivo, link e scadenza se nota. Un prezzo assente rimane «prezzo non disponibile», senza diventare zero. Mostrare fino a dieci giochi per pagina, riducendo il numero se necessario per rispettare il limite Telegram; conteggio e pulsanti indicano chiaramente altri giochi disponibili.

Esempio indicativo, non prezzi live:

```text
📋 La tua wishlist · 1–10 di 16

🎮 Esoteric Ebb
14,11€ · Zapagames · −44% · Apri offerta

🎮 Acts of Blood
Prezzo non disponibile

I prezzi vengono richiesti al momento dell'apertura.
[◀️ Indietro] [Avanti ▶️]
```

Avanti/Indietro modificano il medesimo messaggio con `editMessageText`; non aggiungono dieci nuovi messaggi. Il callback resta vincolato all'utente e alla sua chat privata. Prezzi aggiornati tramite una singola richiesta per pagina; titolo e negozio limitati, HTML escapato, URL HTTPS validato. Il formatter mantiene il messaggio sotto il limite con unità complete, senza tag o link troncati.

La outbox supporta invio e modifica con il relativo `message_id`. La modifica riceve retry persistenti come gli invii. L'errore Telegram «message is not modified» viene trattato come operazione già riuscita; un messaggio eliminato genera un invito breve a riaprire `/wishlist`, senza ricreare tutta la lista. Riferimento: [editMessageText](https://core.telegram.org/bots/api#editmessagetext).

## Interazioni e latenza

Mantenere commit dell'update prima dell'ack HTTP e commit della risposta prima dell'invio. La nuova coda interattiva riceve update e consegne di tipo reply; la coda esistente conserva cron, scan-job e avvisi prezzo/giveaway. Ogni consumer tratta un lavoro per invocazione con batch timeout zero. I lease D1 continuano a impedire invii simultanei della stessa consegna. Accettare anche i messaggi della vecchia coda durante il passaggio, evitando di perdere lavori già pubblicati.

Non aumentare alla cieca la concorrenza della coda condivisa e non eliminare la outbox per ottenere risposte più rapide. La prima riduzione di lavoro è la wishlist compatta. Per le ricerche con recensioni, misurare la durata e valutare un parallelismo limitato a due richieste indipendenti, con il limite totale di dieci e gli stessi filtri; verificare 429 e CPU prima del rilascio. La scelta viene mantenuta soltanto se le prove mostrano un miglioramento senza errori o sforamenti Free.

Registrare tempi aggregati e durate dei confini update → elaborazione, API ITAD, risposta pronta → consegna. Nei log non includere testo dei messaggi, titoli della wishlist, chat ID, URL con token o contenuti API. Conservare correlazione tramite identificativi tecnici e statistiche aggregate. Non promettere risposte istantanee: la rete e le API esterne restano variabili.

## Compatibilità, Free e rilascio

Nessuna ricreazione o reimportazione di wishlist, preferenze, prezzi di riferimento o campagne. Migrazioni additive per le modifiche dei messaggi e per gli eventuali timestamp diagnostici; le vecchie righe outbox restano invii normali. Non resettare i seed né generare notifiche di recupero.

Le due code condividono la quota Free dell'account; la separazione non raddoppia il numero di lavori ordinari. Ricalcolare le operazioni includendo retry e comandi; la wishlist compatta riduce il numero di consegne. Verificare quote correnti e CPU remota prima di attivare il nuovo routing. Non abilitare servizi Paid. Mantenere cron ogni 30 minuti e limite applicativo di 200 giochi distinti.

Aggiornare la PR autorizzata con codice e documentazione soltanto dopo le verifiche. Il deploy è distinto dall'integrazione Git e dall'aggiornamento del checkout principale. Gestire le modifiche locali esplicitamente, senza sovrascriverle. Per rollback conservare la vecchia coda e gestire i nuovi tipi di outbox con un consumer compatibile: ritornare al vecchio codice privo di supporto per le modifiche richiede prima di completare o sospendere tali lavori.

## Criteri di accettazione

1. `/wishlist` genera una sola consegna per pagina; i pulsanti modificano lo stesso messaggio. Wishlist vuota, prezzi mancanti, titoli lunghi, link, scadenze, più pagine e controlli di proprietà sono coperti da test.
2. Le scansioni in corso non occupano il consumer interattivo; replay, retry, lease e ripartenza non perdono avvisi e non avanzano prematuramente i riferimenti prezzo.
3. Tutti i test esistenti continuano a passare dopo la riorganizzazione; nuovi test verificano le modifiche persistenti, gli errori Telegram e il routing. Typecheck e build funzionano su Windows e CI Linux anche con test in sottocartelle.
4. README e `docs/architecture.md` spiegano entrypoint, responsabilità, dipendenze, flussi e dove modificare ogni funzione. Il codice storico ha un percorso distinto e le modifiche locali sono preservate.
5. Prima/dopo remoti confrontano tempo alla prima risposta e tempo alla risposta completa su comandi reali, includendo un ciclo di scansione. Riportare numero di campioni e limiti delle misure; nessun risultato di latenza viene dichiarato senza misurazione.
6. Piano Free, CPU, operazioni Queue, webhook, stato D1 e scansioni vengono verificati dopo il deploy. Se l'autenticazione amministrativa rimane indisponibile, completare le prove locali e dichiarare la verifica remota ancora da eseguire.
