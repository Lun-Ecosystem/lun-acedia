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

Aucune dépendance au NAS : tout tourne sur le poste. Node `^22.13.0 || >=24`.

## Organisation

Monorepo à workspaces npm ; l'outillage (format, lint, typage, tests) est à la racine.

| Dossier | Contenu |
|---|---|
| `server/` | le serveur : synchro Google, tri, agenda, API du front, contrat `/lun/v1` |
| `views/` | le paquet de vues Svelte `@lun-ecosystem/lunacedia-views`, publié pour Lun'Anima |
| `app/` | le front autonome (PWA installable), qui n'utilise que le paquet de vues |

## Documentation

- [`docs/`](docs/) : ce que fait le projet aujourd'hui (utilisateur, technique, exploitation).
- [`docs/decisions/`](docs/decisions/) : les décisions propres au projet.
- Cahier des attendus de J1 :
  [lun-docs](https://github.com/Lun-Ecosystem/lun-docs/blob/main/docs/specs/2026-10-19-j1-acedia-design.md).
- Règles communes : [lun-docs](https://github.com/Lun-Ecosystem/lun-docs).

## Contribuer

Une branche, une PR avec critères de fin et preuves, CI verte. Seul CrOliX merge.
