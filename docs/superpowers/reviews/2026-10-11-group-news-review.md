# Verifica e revisione news — 11 ottobre 2026

Implementazione locale nel ramo feat/group-news-2026-10-11; nessun deploy, migrazione remota o messaggio Telegram di prova eseguito. NEWS_ENABLED=false. Le modifiche preesistenti dell’utente in IDE e legacy sono preservate.

## Prove finali

- npm test: 158/158 test passati, inclusi 25 test news.
- npm run typecheck: passato.
- npm run build: dry run passato, bundle303.29KiB / gzip75.15KiB.
- Tutte le sette migrazioni applicate a un D1 locale nuovo.
- Otto feed pubblici letti con il parser e i filtri effettivi. Conteggi recenti: Multiplayer18, Everyeye21, ComingSoon3, EveryeyeCinema11, Cinefilos1, MangaForever2, EveryeyeAnime10, Akiba0. Zero indica assenza di elementi recenti idonei, non errore della fonte. Sono conteggi di una singola osservazione, non garanzie di disponibilità futura.
- Il caso massimo di dieci gruppi resta sotto50 query D1 per job feed nei test; CPU e quote quotidiane remote restano da misurare prima dell’attivazione.

## Revisione indipendente e correzioni

Un revisore indipendente ha letto codice, piano e specifica senza modificare il checkout. Tre problemi importanti sono stati riprodotti con test RED→GREEN: pulsanti rimasti validi dopo off ripetuto; reset degli ID Telegram dopo una settimana; metadati RSS misti che ammettevano offerte e merchandising. Le correzioni mantengono un’unica impostazione news per gruppo, verificata con API Telegram correnti.

Anche la normalizzazione incoerente di query URL con parametri tracking è stata riprodotta e corretta. Un caso di cicli sovrapposti, rilevato dall’implementatore, ha ricevuto un test RED→GREEN: gli articoli di un ciclo ancora incompleto non partecipano alla selezione di un ciclo precedente. GUID conservato come riferimento supplementare, senza usarlo al posto della URL canonica.

## Decisioni operative e costi

1. Ramo nel checkout corrente invece di worktree: conserva filtro key2026/2027 e modifiche IDE/legacy senza spostarle. Costo: checkout condiviso; i file dell’utente sono esclusi dalle modifiche.
2. Registro e comandi Windows nativi al posto degli helper Bash della skill: adatti alla shell disponibile. Costo: bookkeeping verificato manualmente.
3. Revisione dei pulsanti distinta dalla generazione delle consegne: ogni preferenza accettata invalida vecchi pulsanti, mentre on ripetuto conserva la coda e la data di attivazione. Costo: una colonna aggiuntiva nella migrazione additiva.
4. ID Telegram con orario di ricezione persistito e scadenza24ore: dopo più di7giorni ammette un nuovo ID inferiore; vecchi update ritardati restano inapplicabili. Costo: un comando news rimasto in coda oltre24ore richiede ripetizione. Il messaggio originale di un callback può essere vecchio: conta la ricezione del click.
5. Dedup dei parametri query riclassificato da minore a importante: due varianti tracking della stessa URL possono consumare due dei tre invii. Costo della correzione: riserializzazione standard dei parametri URL, senza eliminare parametri non tracking.
6. GUID e ciclo di origine aggiunti ai metadati: allineano la specifica e proteggono la selezione fra cicli sovrapposti. Costo: due colonne additive; nessuna nuova risorsa Cloudflare.
7. Filtri conservativi prima della classificazione positiva: escludono recensioni, guide, offerte, merchandising e classifiche anche quando la categoria è un franchise. Costo: un titolo ambiguo può essere escluso; tassonomie editoriali richiedono manutenzione.
8. Lavoro lasciato sul ramo locale, senza merge, push o deploy: l’approvazione ricevuta riguarda l’implementazione della proposta. Costo: il servizio non è ancora online; il runbook rende concreta la procedura di rilascio e collaudo con backup.

## Caso minore rinviato

Un job feed rimasto in esecuzione oltre il lease di5minuti può vedere l’ingestione respinta e tuttavia completarsi con il vecchio token, se nessun nuovo consumer ha acquisito il job. Quel ciclo può saltare la fonte; il ciclo successivo la ricontrolla. Il timeout HTTP è10secondi e il fenomeno richiede un’esecuzione eccezionalmente ritardata. Non incide sul controllo dei permessi o sul limite degli invii. È registrato come minore e non corretto in questo passaggio, secondo il processo di revisione scelto.

## Perimetri valutati dal revisore

- Modifiche utente IDE/legacy e filtro key precedente: preservati; solo integrazione news verificata. Costo: nessuna revisione dei cambi dell’utente.
- Deploy, backup, permessi reali e quote remote: riservati al rilascio controllato del runbook. Costo: prove locali non garantiscono margini operativi in produzione.
- Esattamente una consegna dopo successo Telegram ambiguo: non promesso, poiché Telegram e D1 non condividono transazione. Costo: raro duplicato possibile, sempre entro il budget dei tentativi.
- Dedup semantico fra articoli o testate diverse: escluso come da specifica. Costo: notizie dello stesso evento possono arrivare da fonti diverse.
- Migrazione automatica group→supergroup: il vecchio gruppo viene disattivato al controllo; il nuovo parte spento. Costo: un amministratore deve riattivarlo.
- Scraping e classificazione statistica della lingua: esclusi; testate italiane note e lingua RSS guidano la selezione. Costo: metadati errati della fonte possono richiedere aggiornamenti.
- Disponibilità futura e classificazione esaustiva delle fonti: non garantite. Costo: manutenzione delle fixture e dei filtri.
- Rifattorizzazioni estetiche e pulizia legacy: escluse dal compito. Costo: nessuna pulizia generale del repository.
