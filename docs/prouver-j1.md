# Prouver J1

J1 n'est terminé que quand chacun des 16 critères du
[cahier des attendus](https://github.com/Lun-Ecosystem/lun-docs/blob/main/docs/specs/2026-10-19-j1-acedia-design.md)
(§9) est prouvé, **avec le compte Google de test uniquement**. Chaque preuve (capture, enregistrement
ou sortie de commande) va dans la PR, une ligne par critère. Ne jamais y laisser d'adresse mail réelle,
d'adresse interne, de nom de machine ni de jeton.

## Préparer

1. `.env` rempli (voir [Brancher Google](brancher-google.md)) et `ANTHROPIC_API_KEY` pour l'IA.
2. `npm run build && npm start -w @lun-acedia/server`, puis le front sur `http://localhost:8787`.
3. Appairer le navigateur avec le code des journaux, puis Réglages → Compte Google → Connecter.
4. Avoir Gmail, Agenda et Tasks du compte de test ouverts à côté.

## Parcours, critère par critère

| # | Preuve |
|---|---|
| 1 | Archiver, supprimer, relibeller un mail dans Gmail : il suit dans Acedia à la synchro suivante. L'inverse depuis Acedia : Gmail suit immédiatement. |
| 2 | Créer, déplacer, cocher, supprimer un événement et une tâche, d'un côté puis de l'autre. |
| 3 | S'envoyer une newsletter riche : rendu fidèle, aucun script exécuté (console du navigateur vide). |
| 4 | Ouvrir un mail : la liste ne bouge pas ; faire défiler un long mail : la barre d'actions reste ; ranger : la liste se met à jour seule. |
| 5 | Réglages → créer une boîte et une étiquette : elles apparaissent comme libellés dans Gmail. |
| 6 | Créer une règle, s'envoyer un mail qui y correspond : rangé seul, au journal, « Annuler » marche. |
| 7 | Seuil à 100 : aucun mail ne bouge ; chaque proposition montre « ? » et sa confiance, et figure dans « En attente ». |
| 8 | Seuil abaissé : un mail au-dessus est rangé seul (journal, annulable), un mail en dessous attend. |
| 9 | Corriger une proposition, puis s'envoyer un mail semblable : il reçoit la boîte corrigée. |
| 10 | `POST /lun/v1/pause` : rien n'est trié ; lire et ranger à la main marche ; `resume` relance. |
| 11 | Remplacer `ANTHROPIC_API_KEY` par une clé sans crédit : `health` passe `degraded`, les règles tournent, le reste attend, rien ne plante. |
| 12 | Agenda jour, semaine, mois avec événements et tâches mêlés ; un événement avec rappel émet `agenda.reminder` sur le flux. |
| 13 | Client de test en `curl`, ci-dessous. |
| 14 | [Installer sur le téléphone](installer-sur-le-telephone.md), puis lire et ranger un mail depuis la PWA. |
| 15 | Après publication par CrOliX : dans un projet vide, `npm install @lun-ecosystem/lunacedia-views` puis importer `Mailbox`. |
| 16 | Dépôt dans l'organisation, CI verte sur `main`, ruleset actif, entrée à jour dans `registry.yaml` de lun-docs. |

## Critère 13 en `curl`

```bash
B=http://localhost:8787/lun/v1
CODE=…   # Réglages → Appareils et applications → « Relier un appareil »
TOKEN=$(curl -s -X POST $B/pair -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"client\":\"preuve\"}" | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).token))')
H="authorization: Bearer $TOKEN"
curl -s -H "$H" $B/health
curl -s -H "$H" "$B/costs?since=2026-10-01"
curl -sN -H "$H" $B/events                          # noter l'id du dernier événement, couper
curl -sN -H "$H" -H "last-event-id: <id>" $B/events # reprend après cet événement
curl -s -H "$H" -H 'content-type: application/json' -X POST $B/actions/mail.search \
  -d '{"q":"newer_than:1d"}'
```

## Publier le paquet de vues (CrOliX)

Après le merge sur `main`, Actions → « Publish views » → Run workflow. La version publiée est celle de
`views/package.json` ; la changer avant chaque nouvelle publication.
