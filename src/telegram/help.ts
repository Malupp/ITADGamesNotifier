export const HELP = `👋 <b>Benvenuto! Giochi PC gratis e prezzi sotto controllo</b>

Ti aiuto a trovare giochi completi da riscattare gratis e a seguire i ribassi dei giochi che desideri. Prezzi in euro per l'Italia; orari e scadenze nel fuso italiano.

Ogni comando raccoglie i risultati in un solo messaggio. I pulsanti aggiornano quel messaggio; quando serve, usa Avanti e Indietro. Nelle ricerche puoi tornare ai titoli per scegliere un altro gioco. Per aggiornare prezzi e risultati, ripeti il comando; le selezioni scadono entro 24 ore.

🎁 <b>Giochi gratis da tenere</b>
/deals — mostra le promozioni gratuite attive verificate.
Controllo IsThereAnyDeal e confermo la promozione sul negozio ufficiale: al momento la verifica automatica copre Epic Games Store e Steam. Escludo DLC, demo, weekend gratuiti, free-to-play permanenti e offerte che richiedono abbonamenti a pagamento.
Apri il link e riscatta il gioco prima della scadenza: il bot non lo riscatta per te. Gli avvisi gratuiti arrivano nelle chat configurate.

📋 <b>La tua wishlist · in chat privata</b>
/add &lt;titolo&gt; — cerca un gioco, poi premi il pulsante per aggiungerlo.
/wishlist — mostra i tuoi giochi con i prezzi attuali in un unico messaggio; i pulsanti cambiano pagina nello stesso messaggio.
/remove — scegli con un pulsante il gioco da rimuovere.
Per iniziare, prova <code>/add Hollow Knight</code>.

🔔 <b>Quando ricevi un avviso</b>
Controllo ogni 30 minuti. Per la wishlist invio un avviso solo se c'è un effettivo sconto e almeno il 10% di ulteriore ribasso rispetto all'ultima notifica consegnata, oppure al prezzo iniziale se non hai ancora ricevuto avvisi.
Esempio con soglia 10%: 10€ → 9€: avviso; 9€ → 8,90€: nessun avviso; 9€ → 8,10€: nuovo avviso. Lo sconto sul prezzo di listino è un dato distinto da questa soglia.
L'aggiunta e il recupero della wishlist registrano il riferimento senza una raffica di avvisi; se manca il prezzo, attendo la prima osservazione valida. Gli avvisi wishlist arrivano nella tua chat privata. Ricontrollo l'offerta prima dell'invio e ritento gli invii falliti: in casi rari può arrivare un duplicato.

⚙️ <b>Personalizza gli avvisi · in chat privata</b>
/setsconto — mostra la soglia globale della wishlist.
<code>/setsconto 20</code> — richiedi almeno un ulteriore ribasso del 20% (valori 10–99).
/setscontog — scegli una soglia per un singolo gioco o ripristina quella globale.

🔎 <b>Cerca e confronta</b>
/cerca &lt;titolo&gt; — scegli il gioco e visualizza i prezzi disponibili.
/confronta &lt;titolo&gt; — confronta i negozi monitorati per il primo gioco trovato; usa un titolo preciso.
/offerte [prezzo] [sconto%] [score] — cerca offerte a pagamento con questi filtri.
<code>/offerte 10 50 70</code>: massimo 10€, sconto sul listino almeno 50%, recensioni positive Steam almeno 70%.
/offerte_shop [prezzo o range] [numero] [shop...] — filtra anche per negozio.
<code>/offerte_shop 5-20 10 steam,gog</code>: fino a 10 risultati tra 5€ e 20€ su Steam e GOG. Puoi usare anche epic, fanatical, humble e gli altri negozi monitorati.

🛠 <b>Filtri delle ricerche · in chat privata</b>
/setsoglia — mostra i filtri salvati, usati quando ometti gli argomenti.
Esempi: <code>/setsoglia prezzo 10</code>, <code>/setsoglia sconto 50</code>, <code>/setsoglia review 70</code>.
Questi filtri riguardano le ricerche di offerte; le soglie degli avvisi wishlist si impostano con /setsconto e /setscontog.

ℹ️ /status — ultime scansioni completate.
/start o /help — riapri questa guida.`;
