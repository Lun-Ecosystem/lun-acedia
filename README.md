<div align="center">

<img src="app/public/icon-192.png" alt="" width="96">

# Lun'Acedia

**Ton courrier, ton agenda et tes tâches au même endroit, triés à la source et sous ton contrôle.**

Il remplace Gmail, Google Agenda et Google Tasks au quotidien, au bureau comme sur le téléphone. Tout tourne chez toi,
et rien ne quitte la boîte sans ton accord.

[![Version](https://img.shields.io/github/v/release/Lun-Ecosystem/lun-acedia?style=flat-square&color=3A6080)](https://github.com/Lun-Ecosystem/lun-acedia/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Lun-Ecosystem/lun-acedia/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/Lun-Ecosystem/lun-acedia/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/github/license/Lun-Ecosystem/lun-acedia?style=flat-square&label=licence)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.13%20%7C%7C%20%3E%3D24-5FA04E?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Svelte 5](https://img.shields.io/badge/svelte-5-FF3E00?style=flat-square&logo=svelte&logoColor=white)](https://svelte.dev)
[![Écosystème Lun'](https://img.shields.io/badge/%C3%A9cosyst%C3%A8me-Lun'-3A6080?style=flat-square)](https://github.com/Lun-Ecosystem)

<img src="docs/images/apercu.jpg" alt="La boîte de réception de Lun'Acedia, sur les données fictives de la démo" width="860">

</div>

## Ce qu'il fait

- **Le courrier** : la boîte Gmail, ses boîtes, étiquettes et règles, avec un tri par IA qui annonce sa confiance. Sous
  ton seuil, il propose ; au-dessus, il range.
- **L'agenda et les tâches** : Google Agenda (jour, semaine, mois, planning) et Google Tasks, dans la même app.
- **Les conflits de l'agenda** : deux événements qui se chevauchent vraiment font une carte, trois par jour au plus,
  rien en pause. Elle propose de déplacer un événement de ton agenda principal, dont tu es l'organisateur et le seul invité, au premier créneau libre
  du même jour (8 h à 22 h), ou signale le conflit sans rien changer ([détail](docs/pina.md)).
- **Un agent borné** : ses écritures deviennent des cartes à valider, ses suppressions le restent toujours, et il
  n'envoie jamais de mail (brouillon seulement). Neutre par défaut, son nom, son icône et son ton se règlent.
- **Une app installable** : une PWA servie par le serveur lui-même, sans magasin d'applications.

## Ce qu'il te faut

- Node `^22.13.0 || >=24`.
- Pour le vrai courrier, un client OAuth Google : [Brancher Google](docs/brancher-google.md). En développement, toujours
  un compte de test.
- Une clé de fournisseur d'IA, facultative : Anthropic, OpenAI ou Gemini, dans `.env` ou les Réglages.

## L'essayer sans compte

```bash
npm install
npm run build && npm run demo   # http://localhost:8797
```

Faux Gmail, faux agenda, faux tri, aucun compte Google, aucun réseau. La commande affiche le jeton d'appareil à coller
dans la console du navigateur. `POST /api/demo/deliver` fait arriver le mail fictif suivant, trié aussitôt ; cette route
n'existe que dans la démo.

## Démarrer en local

```bash
cp .env.example .env    # renseigner les clés de développement et le compte Google de test
npm install
npm run build           # construit le front, servi par le serveur à la racine
npm run dev             # http://localhost:8787
npm run pair-code       # dans un autre terminal, le code à saisir dans le front
```

Aucune dépendance au NAS : tout tourne sur le poste. Le serveur écoute sur `127.0.0.1` par défaut (`HOST` dans `.env`
pour une autre adresse). Une variable laissée vide dans `.env` vaut absente : sa valeur par défaut s'applique.
`SYNC_INTERVAL_MS` règle la synchro de Gmail et de l'agenda, en millisecondes : de 1000 à 2147483647, en chiffres
seulement ; toute autre valeur donne une minute, et le journal le dit. Le code d'appareil est à usage unique et vaut
10 minutes.

Le premier appareil : tant que rien n'est relié, la page ouverte à `http://localhost:8787` sur la machine qui héberge
affiche son code, déjà saisi. Elle le demande par `POST /first-code`, hors de `/api` et du contrat, qui ne répond que
depuis la boucle locale, à cet hôte et à cette origine, sans en-tête de relais ; sinon un 404, sans créer de code.

La base est copiée une fois par jour dans `backups/`, à côté d'elle (`data/backups/acedia-AAAA-MM-JJ.db` par défaut) :
dès que le serveur écoute, puis chaque heure si la copie du jour manque, ce qui rattrape un poste éteint la nuit. Les
sept dernières restent ; une copie ratée laisse une ligne au journal du serveur et se retente l'heure suivante.
Reliée à Lun'Anima, Acedia lui envoie aussi un événement `backup.failed`, une fois par jour au plus, même en pause. Une
copie s'ouvre sans clé, comme la base : seuls les jetons Google et les clés d'IA saisies y restent chiffrés, et seule
la même `ACEDIA_SECRET_KEY` les relit. Restaurer une copie :
[Mettre le desktop en service](https://github.com/Lun-Ecosystem/lun-docs/blob/main/docs/mise-en-service-desktop.md#restaurer-une-copie),
dans lun-docs.

## Si ça coince

| Ce que tu vois | Quoi faire |
|---|---|
| Le serveur dit qu'il démarre sans Google | Renseigner `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et `ACEDIA_SECRET_KEY` dans `.env` : [Brancher Google](docs/brancher-google.md). |
| La carte Compte Google dit que le compte enregistré ne se lit pas | Les jetons ont été rangés avec une autre `ACEDIA_SECRET_KEY` (une base restaurée, une clé changée) : remettre l'ancienne clé dans `.env` et relancer, ou reconnecter le compte (Réglages › Compte Google). |
| Il faut reconnecter Google chaque semaine | Le projet est un projet Externe resté en statut « Test » : créer un projet en mode Personnel ([Brancher Google](docs/brancher-google.md)), ou, en repli, le publier en « Production » sans vérification. |
| Le serveur ne trouve pas le front | Lancer `npm run build`, qui construit `app/dist`. |
| Le code d'appareil est refusé | Il a expiré, ou 5 codes faux en 10 minutes ont annulé ceux en cours. Sur une installation neuve, « Nouveau code », sur la page ouverte sur la machine qui héberge Acedia, en remet un ; sinon, un appareil relié en donne un (Réglages › Appareils et applications › Relier un appareil). En recours : `npm run pair-code`. |
| Le téléphone ne propose pas d'installer l'app | Un navigateur n'installe une PWA qu'en HTTPS : [Installer sur le téléphone](docs/installer-sur-le-telephone.md). |

## Dans l'écosystème

**Rôle dans l'écosystème** : satellite. Il possède la boîte mail, son tri, l'agenda, les tâches et l'autorisation Google,
et il sert ses propres écrans. Il fonctionne seul. Lun'Anima s'y branche par le [contrat satellite](https://github.com/Lun-Ecosystem/lun-docs/blob/main/standards/contrat-satellite.md) (v1.8) : il délègue à son agent
(`POST /lun/v1/agent`) et relaie ses cartes (`GET /lun/v1/cards`, `accept`, `refuse`), sans intégrer ses écrans.

Ce qui sort du poste vers Lun'Anima, d'un mail : son objet et une synthèse de deux lignes au plus, l'un et l'autre
masqués (liens, codes, IBAN, numéros longs, jetons) et filtrés (une ligne qui recopie six mots du mail tombe) ; jamais le
corps du mail. Les synthèses qui manquent au résumé du jour se font à la demande, sous un plafond de dépense par jour
réglé dans les réglages du tri (`digestDailyCapUsd`, 0,02 $ par défaut, de 0 à 5 ; 0 n'en fait aucune).

| Dossier | Contenu |
|---|---|
| `server/` | le serveur : synchro Google, tri, agenda, API du front, contrat `/lun/v1` |
| `views/` | les vues Svelte du front, en paquet interne (`@lun-ecosystem/lunacedia-views`) |
| `app/` | le front autonome (PWA), dont les composants métier viennent de `views/` |

## Documentation

- [`docs/`](docs/) : ce que fait le projet aujourd'hui, dont [l’agent](docs/pina.md) et [Prouver J1](docs/prouver-j1.md).
- [`docs/decisions/`](docs/decisions/) : les décisions propres au projet.
- Règles communes : [lun-docs](https://github.com/Lun-Ecosystem/lun-docs).

## Contribuer

Une branche, une PR avec critères de fin et preuves, CI verte. Seul CrOliX merge. Les règles viennent de
[lun-docs](https://github.com/Lun-Ecosystem/lun-docs).

## Licence

[MIT](LICENSE).
