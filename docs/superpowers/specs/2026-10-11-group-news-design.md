# News automatiche nei gruppi Telegram

Data: 11 ottobre 2026. Stato: approvata dall'utente in chat, inclusi gli otto feed e il requisito italiano.

## Obiettivo e preferenze raccolte

Il bot propone automaticamente notizie di videogiochi, film, anime e manga nei gruppi Telegram che hanno attivato la funzione. L'utente ha scelto un unico toggle per gruppo e messaggi singoli con un massimo di tre notizie all'ora per gruppo. Ha inoltre richiesto esplicitamente che tutte le notizie siano in italiano: fonti, titoli editoriali, eventuali estratti e messaggi del bot devono rispettare questo requisito.

La selezione delle fonti usa feed editoriali italiani; una futura aggiunta deve mantenere il requisito linguistico. Il toggle parte spento ed è modificabile dal proprietario o dagli amministratori del gruppo. Queste ultime sono scelte proposte, insieme alle fonti iniziali sotto elencate. L'invio riguarda soltanto chat di tipo `group` o `supergroup` in cui il bot è presente e può scrivere.

## Approccio scelto

Leggere direttamente feed RSS pubblicati da una piccola selezione di testate. È sufficiente per titolo, data, categoria e link; il controllo dei duplicati e delle consegne resta nel bot.

Un aggregatore/API esterno è un'alternativa, ma aggiunge dipendenze, eventuali credenziali e condizioni di utilizzo senza essere necessario per questa prima versione. La raccolta dalle pagine degli articoli non serve: vengono usati soltanto i dati dei feed.

## Fonti iniziali proposte

Verifica HTTP effettuata l'11 ottobre 2026: gli otto endpoint sotto elencati hanno restituito 200 e documenti RSS. Everyeye, Akiba Gamers e Cinefilos sono stati aggiunti su richiesta dell'utente, che ha indicato espressamente Everyeye come esempio di fonte desiderata.

| Area | Testata e feed | Selezione |
| --- | --- | --- |
| Videogiochi | [Multiplayer.it](https://multiplayer.it/feed/rss/news/) | Feed dedicato alle news |
| Videogiochi | [Everyeye](https://www.everyeye.it/feed/feed_news_rss.asp) | Solo articoli dell'area videogiochi: il feed può includere link di altre aree del network, da filtrare per dominio e categoria |
| Film | [ComingSoon.it](https://www.comingsoon.it/feedrss/) | Categoria Cinema; esclusi TV, VIP e anticipazioni televisive |
| Film | [Everyeye Cinema](https://cinema.everyeye.it/feed/feed_news_rss.asp) | News dell'area cinema |
| Film | [Cinefilos](https://cinefilos.it/feed) | Sezioni cinema e trailer cinematografici, identificate da categoria e percorso; esclusi serie TV e argomenti estranei |
| Anime e manga | [MangaForever](https://www.mangaforever.net/feed/) | Categorie di news anime/manga; esclusi classifiche, merchandising e altri temi |
| Anime e manga | [Everyeye Anime](https://anime.everyeye.it/feed/feed_news_rss.asp) | News anime/manga; esclusi comics occidentali, merchandising e argomenti estranei |
| Videogiochi, anime e manga | [Akiba Gamers](https://www.akibagamers.it/feed/) | Categorie di notizie videogiochi e anime/manga; esclusi guide, recensioni, Giappone, tecnologia e merchandising |

Le categorie effettivamente presenti nei feed saranno coperte da fixture, includendo articoli con più categorie. Un articolo su un manga può essere etichettato dalla fonte come anime: entrambe le aree sono abilitate dallo stesso toggle e non serve classificare forzatamente questi casi.

Questa lista è una selezione editoriale proposta, non una classifica oggettiva di affidabilità. AnimeClick e SpazioGames sono possibili future aggiunte, ma i tentativi di accesso automatico alle loro homepage hanno restituito 403: non vengono inclusi senza feed utilizzabili verificati. È stato verificato anche il [feed BadTaste](https://www.badtaste.it/feed), che risponde 200 ma mescola film e TV senza categorie negli elementi osservati: resta candidato finché non esiste una selezione cinema attendibile basata sul feed, senza lettura delle pagine. L'elenco delle fonti è configurato nel codice e può essere aggiornato senza modificare la logica di invio.

L'ampliamento richiede fixture per ciascun feed, compresi i link di Everyeye verso sottodomini diversi e le categorie multiple di Akiba Gamers. Un elemento senza un abbinamento attendibile alle quattro aree richieste viene escluso. Le categorie usate per rubriche, classifiche, recensioni e offerte vengono filtrate prima della selezione.

## Comandi e messaggi

`/news` nel gruppo mostra stato e pulsante «Attiva news» oppure «Disattiva news». `/news on` e `/news off` sono scorciatoie. I cambiamenti richiedono una verifica corrente dei permessi Telegram; utenti ordinari possono vedere lo stato. In privato il comando spiega come attivare le news in un gruppo.

Per la verifica affidabile degli amministratori, la configurazione prevista rende amministratore anche il bot: [Telegram documenta questa condizione per getChatMember](https://core.telegram.org/bots/api#getchatmember). Se non è possibile verificare i permessi, l'impostazione non cambia.

Ogni notizia produce un messaggio compatto con categoria, titolo, nome della testata e link all'articolo. Non vengono copiati articoli completi né generati riassunti tramite un modello. HTML e link sono validati e il messaggio resta entro i limiti Telegram.

## Raccolta e invio

Il cron esistente ogni trenta minuti avvia la raccolta news sulla coda background, con lavori persistiti e recuperabili. Ogni feed è letto una sola volta per ciclo, condividendo il risultato tra i gruppi. Timeout, dimensione massima della risposta, numero massimo di articoli e cache HTTP tengono il lavoro limitato. Un feed guasto non impedisce la raccolta dagli altri.

Il primo caricamento di una fonte registra gli articoli esistenti senza inviarli. Ogni attivazione del toggle parte dalle nuove notizie pubblicate dopo l'attivazione; non recupera lo storico del periodo in cui era spento. Gli articoli hanno una finestra massima di invio di ventiquattro ore. Il limite orario può far scartare notizie prima di consegnarle: non è una distribuzione esaustiva di tutti gli articoli.

La selezione alterna le tre aree disponibili (videogiochi, film, anime/manga) e ruota tra le testate all'interno di ogni area per evitare che il feed più prolifico occupi tutti gli invii. Il massimo di tre notizie all'ora riguarda il totale del gruppo, indipendentemente dal numero di fonti. L'identità deriva da testata più link canonico: un articolo che compare in più feed della stessa testata resta un solo articolo. Il GUID viene conservato come ulteriore riferimento del feed. Per ciascun gruppo un articolo già consegnato non viene selezionato di nuovo; non viene promessa la deduplicazione semantica di articoli diversi sullo stesso evento.

Prima di ogni invio e retry si ricontrollano toggle, generazione di attivazione, tipo di chat, presenza del bot, permessi di scrittura, freschezza e budget del gruppo. Disattivare il toggle invalida subito il lavoro pendente; una richiesta Telegram già in corso può comunque completarsi. Il limite è di tre tentativi di pubblicazione news in una finestra mobile di sessanta minuti, prenotati atomicamente prima della chiamata: anche errori e retry consumano budget, così il tetto non viene superato dai tentativi ripetuti. I comandi e gli avvisi di giochi non consumano questo budget.

## Integrazione e stato

Aggiungere moduli dedicati per normalizzazione delle notizie, lettura RSS, repository D1, orchestrazione e comandi. Usare un parser XML compatibile con Workers, senza risoluzione di entità esterne. Non usare espressioni regolari come parser XML.

Una migrazione additiva successiva a `0006` introduce impostazioni dei gruppi, stato dei feed, articoli, lavori e consegne news. Le consegne news hanno una coda di lavoro dedicata come tipo di messaggio nella Queue background già esistente, conservando i pattern di lease, recupero e retry del progetto. Le tabelle news sono separate dall'outbox dei prezzi, evitando di cambiare i vincoli e lo storico delle consegne esistenti.

Un flag globale `NEWS_ENABLED`, spento per default, controlla la funzione insieme al toggle per gruppo e al flag generale delle scansioni. Non si raccolgono feed quando nessun gruppo è abilitato. Cap iniziale: dieci gruppi attivi, otto feed, cinquanta elementi per feed/ciclo; il limite è comunicato quando una nuova attivazione lo raggiunge. La raccolta usa lavori distinti per feed e condivide gli articoli tra gruppi. Prima del rilascio si verifica che il carico complessivo resti nel piano Cloudflare dell'installazione, includendo il costo degli otto feed e delle news nel carico già prodotto dagli avvisi giochi.

## Verifica e rilascio

Test su SQLite reale e trasporti esterni simulati: gruppi isolati, toggle spento, permessi amministratore, chat private, rimozione del bot, seed silenzioso, riattivazione senza storico, feed malformati e indisponibili, articoli duplicati e scaduti, selezione tra fonti, limite mobile con invii concorrenti e retry, consegne annullate dopo spegnimento.

Verificare suite completa, TypeScript, build dry run e migrazioni locali. Per il rilascio remoto: backup D1, migrazione additiva, deploy con flag globale spento e prova in un gruppo controllato prima di abilitare l'invio. Non attivare automaticamente il toggle in alcun gruppo. Il rollback operativo spegne il flag globale e ripristina il Worker precedente; le tabelle additive possono restare conservate.

La modifica precedente agli affari key 2026/2027 resta presente nel workspace e non ancora pubblicata: va considerata esplicitamente nel successivo pacchetto di rilascio.
