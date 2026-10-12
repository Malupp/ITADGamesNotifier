# Affari key speciali — 12 ottobre 2026

Richiesta utente: listino sopra30EUR e key almeno50% sotto listino. Mantengono anni2026+2027 già concordati; wishlist personale separata. Tetto10EUR precedente sostituito. Per non proporre un acquisto peggiore, key inferiore al miglior prezzo autorizzato corrente; prezzo autorizzato gratuito esclude key a pagamento.

Listino ITAD EUR: Steam se valido, altrimenti minimo listino ufficiale valido; assente/incoerente esclude affari generali. Mai usare minimi storici GG come listino. Persistenza regular_cents nella migrazione additiva0008. Criteri applicati in scansione, invalidazione della outbox e revalidazione prima di inviare. /keys e guida aggiornati.

Verifiche: 163/163 test, typecheck, dry-run bundle305.05KiB/gzip75.67KiB, migrazione0008 locale passata. Revisione indipendente: due difetti di passaggio dati riprodotti RED→GREEN e corretti (scansione GG senza listino, aggiornamento prezzi ufficiali che perdeva il listino).

La verifica remota read-only ha confermato0006 e0007 ancora non applicate. Nessuna migrazione remota o deploy eseguiti. Le modifiche utente IDE/legacy sono preservate.

Blocco automatico: export completo D1 remoto rifiutato perché il trasferimento del database, che può includere dati privati di gruppi e utenti, nel nuovo backup locale non era autorizzato esplicitamente. Il comando non è stato eseguito e non è stato aggirato. Destinazione proposta: migration-private/release-2026-10-12-keys-news/d1-before.sql nel workspace, esclusa da Git e protetta per utente corrente e SYSTEM.

Passi dopo autorizzazione: backup privato, prova ripristino locale e confronto colonne originarie, verifica variabili/versione online, migrazioni additive 0006-0008, pubblicazione Worker, verifica health e schema/outbox. Il primo rilascio news resta conNEWS_ENABLED=false come già approvato; nessun gruppo abilitato automaticamente e nessun messaggio Telegram artificiale. Attivazione news controllata separata secondo runbook.

## Rilascio autorizzato

L’utente ha autorizzato esplicitamente backup e pubblicazione. Export nella destinazione indicata riuscito; ripristino e confronto di tutte le colonne originarie riusciti (17 tabelle,5660 righe). Migrazioni0006–0008 online e Worker 801367ce-a179-4e23-89c5-3d46607b14d3 pubblicato. L’autorizzazione comprende il servizio news con gruppi inizialmente spenti: flag globaletrue, zero gruppi abilitati. Primo controllo ordinario avviato, zero vecchi affari non idonei in coda. Menu news e webhook verificati senza messaggi Telegram di prova.

Verifica operativa finale: primo controllo completato con 116 metadati ricaricati, 31 listini sopra 30€, zero job key attivi e zero affari generali pendenti. La selezione contiene un gioco 2026/2027. Gli avvisi wishlist mantengono i propri riferimenti; nessun gruppo news abilitato e nessun messaggio news artificiale inviato.
