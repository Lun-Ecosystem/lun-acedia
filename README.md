# Lun'Acedia

Le satellite « ta journée » de l'écosystème Lun' : il remplace Gmail, Google Agenda et Google Tasks
au quotidien, avec un tri automatique des mails sous ton contrôle.

**Rôle dans l'écosystème** : satellite. Il possède la boîte mail, son tri (boîtes, étiquettes, règles,
IA avec seuil de confiance et validation), l'agenda, les tâches et l'autorisation Google. Lun'Anima
s'y branche par le
[contrat satellite](https://github.com/Lun-Ecosystem/lun-docs/blob/main/standards/contrat-satellite.md)
et intègre ses vues publiées (`@lun-ecosystem/lunacedia-views`) sans les réécrire.

## Démarrer en local

```bash
cp .env.example .env    # renseigner les clés de développement et le compte Google de test
npm install
npm run dev
```

Aucune dépendance au NAS : tout tourne sur le poste. Node `^22.13.0 || >=24`. Le serveur écoute sur
`127.0.0.1` par défaut (`HOST` dans `.env` pour une autre adresse).

## Voir l'app sur des données fictives

`npm run build && npm run demo` lance une démo (développement seulement) sur `localhost:8797` : faux Gmail,
faux agenda, faux tri, aucun compte Google, aucun réseau. La commande affiche le jeton d'appareil à coller dans la console du navigateur.

## Pina, l’assistante

Pina agit par le catalogue d’actions : les écritures deviennent des cartes à valider, les suppressions le
restent toujours, et elle n’envoie jamais de mail (brouillon seulement). Voir [docs/pina.md](docs/pina.md).

Contrat v1.1 : le core lui délègue des demandes (`POST /lun/v1/agent`) et relaie ses cartes
(`GET /lun/v1/cards`, `POST /lun/v1/cards/:id/accept`, `POST /lun/v1/cards/:id/refuse`) ; l'action
`day.digest` résume la journée.

## Relier un appareil

```bash
npm run pair-code    # Code d’appairage : 123 456 · expire à 09:52 · usage unique
```

Le code est à usage unique et vaut 10 minutes, que des appareils soient déjà reliés ou non, serveur
lancé ou non. Le front le demande sur un appareil inconnu. Après 5 codes faux en 10 minutes sur
`/lun/v1/pair`, les codes en cours sont annulés et un avertissement est journalisé : redemander un code.
La liste des appareils et applications reliés, et leur retrait, passent par `GET /api/clients` et
`DELETE /api/clients/:id`.

## Organisation

Monorepo à workspaces npm ; l'outillage (format, lint, typage, tests) est à la racine.

| Dossier | Contenu |
|---|---|
| `server/` | le serveur : synchro Google, tri, agenda, API du front, contrat `/lun/v1` (v1.1) |
| `views/` | le paquet de vues Svelte `@lun-ecosystem/lunacedia-views`, publié pour Lun'Anima |
| `app/` | le front autonome (PWA installable), qui n'utilise que le paquet de vues |

## Documentation

- [`docs/`](docs/) : ce que fait le projet aujourd'hui (utilisateur, technique, exploitation), dont
  [Brancher Google](docs/brancher-google.md), [Installer sur le téléphone](docs/installer-sur-le-telephone.md)
  [Prouver J1](docs/prouver-j1.md), [Pina](docs/pina.md)
  et [Prouver Pina](docs/prouver-pina.md).
- [`docs/decisions/`](docs/decisions/) : les décisions propres au projet.
- Cahier des attendus de J1 :
  [lun-docs](https://github.com/Lun-Ecosystem/lun-docs/blob/main/docs/specs/2026-10-19-j1-acedia-design.md).
- Règles communes : [lun-docs](https://github.com/Lun-Ecosystem/lun-docs).

## Contribuer

Une branche, une PR avec critères de fin et preuves, CI verte. Seul CrOliX merge.
