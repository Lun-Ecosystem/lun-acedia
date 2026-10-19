# Lun'Acedia

> Projet de l'écosystème Lun'. Les règles communes (méthode, git, qualité, design) viennent du plugin
> `lun` et de [lun-docs](https://github.com/Lun-Ecosystem/lun-docs), qui font foi. Ce fichier ne garde
> que ce qui est propre à ce projet. 100 lignes maximum.

## Ce projet

- **Rôle** : satellite, inscrit dans `registry.yaml` de lun-docs. Dépôt **public**.
- **Possède** : la boîte mail et ses gestes, le tri (boîtes, étiquettes, règles, IA, seuil, validation,
  journal), l'agenda, les tâches, les rappels, l'autorisation Google, ses vues (`views/`).
- **Ne possède pas** : Natsume, les modes, le briefing, la voix (Lun'Anima, qui consomme Acedia par le
  contrat satellite et intègre ses vues).

## Lancer en local

```bash
npm install && npm run dev
```

Prérequis : Node `^22.13.0 || >=24`. Variables : copier `.env.example` en `.env` (compte Google de test,
jamais le vrai compte).

## Spécificités

- Google est la source de vérité : la base SQLite n'est qu'un cache plus les données propres
  d'Acedia. Jamais de suppression définitive (corbeille seulement).
- Tout ce qui est automatique s'arrête en pause ; tout ce que fait l'agente se fait aussi à la main.
- Une vue, un exemplaire : `app/` n'a aucun composant métier, tout vient de `views/`.
- Dépôt public : aucun secret, aucune adresse mail réelle, aucune adresse interne.
- Cahier des attendus : `docs/specs/2026-10-19-j1-acedia-design.md` dans lun-docs.
