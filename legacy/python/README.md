# Archivio Python

Questa è l'implementazione precedente su Railway/PostgreSQL. La produzione usa il Worker TypeScript che entra da src/index.ts nella root. Nessun file di questa cartella viene eseguito da Wrangler o dalla CI operativa.

I file sono conservati per consultazione e riconciliazione del vecchio stato. requirements.txt e nixpacks.toml descrivono il runtime storico. Credenziali e database non sono inclusi. Avviare questo bot contemporaneamente al Worker creerebbe un secondo writer: seguire il rollback in docs/cloudflare.md prima di riattivarlo.

Gli strumenti attuali di recupero sono in scripts/migration/ e i relativi test in tests/migration/. Le modifiche locali dell'utente possono essere conservate qui senza far parte del codice pubblicato.
