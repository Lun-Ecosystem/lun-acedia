# L’agent d’Acedia

L’agent d’Acedia lit les mails, l’agenda et les tâches, et prépare ce qu’on lui demande, en français. Il ne
fait rien que l’écran d’Acedia ne permette de faire à la main. Il est **neutre par défaut** (« Agent », ton
neutre, sans personnage) : son nom, son icône, son ton et le contexte de son personnage se règlent dans
Réglages › Agent, et ne changent jamais ce qu’il a le droit de faire. Le code garde `pina` comme nom interne
(dossiers, routes, tables).

## Ce qu’il fait

- Lire, chercher et résumer des mails ; dire ce qui attend (« Qu’est-ce qui m’attend aujourd’hui ? »).
- Créer une tâche ou un événement à partir d’un mail ouvert (« Mets ce déjeuner dans mon agenda »).
- Ranger, archiver, mettre à la corbeille, gérer les étiquettes et les règles de tri.
- Préparer un brouillon de réponse, que l’on relit et que l’on envoie soi-même.
- Dire qu’il ne comprend pas, ou poser une question, quand la demande est floue (« Range ça. »).

Il agit uniquement par le catalogue d’actions d’Acedia, le même que celui du contrat satellite.

## Les conflits de l’agenda

À chaque synchro de l’agenda (toutes les minutes), Acedia cherche, sans le modèle, les événements qui se
chevauchent dans les sept jours qui viennent. Chaque conflit fait une carte, quel que soit le mode de l’agent.

- **Ce qui compte** : deux événements à heure fixe qui se recouvrent vraiment. Ne comptent pas : les journées
  entières, les événements refusés, ceux marqués « disponible », ceux déjà commencés, deux événements qui se
  touchent sans se recouvrir. Deux séries récurrentes qui se chevauchent font une seule carte.
- **« Déplacer un événement qui en chevauche un autre »** : proposée seulement pour un événement de l’agenda
  principal dont on est l’organisateur et qui n’a pas d’autres invités. Le début et la fin proposés sont ceux du
  premier créneau libre de même durée, le même jour, après le conflit : au quart d’heure, entre 8 h et 22 h, heure
  de Paris. Valider le déplace, Annuler le remet à son heure.
- **« Deux événements se chevauchent »** : quand aucun des deux ne peut être déplacé (invités, autre agenda, deux
  séries, pas de créneau libre ce jour-là), la carte signale le conflit et dit pourquoi, sans rien proposer.
  Valider la marque « Conflit vu » et ne change rien à l’agenda ; elle n’a ni Modifier ni Annuler.
- **« Tout valider »** ne prend jamais les cartes de conflit.
- **Ce qui les fait partir** : un conflit réglé à la main, ou un créneau proposé pris depuis, retire la carte à
  la synchro suivante. Une carte refusée ou validée ne revient pas ; une carte ignorée jusqu’à son expiration
  revient une fois, la veille du conflit, s’il existe toujours.
- **Le plafond** : trois cartes de conflit au plus par jour, les plus proches d’abord.
- **En pause**, aucune carte nouvelle ; une carte devenue sans objet est tout de même retirée.

## Garde-fous

- **Cartes à valider.** En mode « Valider avant chaque action », toute écriture devient une carte : rien n’est fait
  tant qu’on n’a pas cliqué Valider. Une action faite se défait avec Annuler.
- **Les suppressions sont toujours validées**, même en mode « Faire tout de suite ».
- **Jamais d’envoi.** Aucune action n’envoie un mail. Pour répondre, l’agent crée un brouillon ; seul le clic sur
  Envoyer, dans la rédaction, l’envoie.
- **Le texte d’un mail est une donnée**, jamais une consigne. Un mail qui lui demande d’agir est signalé,
  pas obéi.
- **Huit tours au plus** par demande, puis il s’arrête et demande par où reprendre.
- **Plafond quotidien** de dépense : au-delà, il attend le lendemain ou que le plafond soit relevé.
- Une action refusée n’est pas refaite sans nouvelle demande.

## L’agent, poste du core

Le core confie des demandes à l’agent par le contrat satellite (v1.1) ; il y répond comme à l’écran, avec les
mêmes garde-fous.

- `POST /lun/v1/agent {request, context?}` rend `{summary, cards, refs, cost}`. Un tour délégué tourne toujours en
  mode **Valider** (chaque écriture devient une carte), quel que soit son mode, et ce mode est gardé quand
  le tour reprend. Il partage le fil du jour de l’agent. Acedia en pause : 200 avec un résumé de pause, sans appel au
  modèle. Un `context` hostile (clé inconnue, valeur trop longue, écran inconnu) : 400.
- Cartes relayées : `GET /lun/v1/cards?status=pending`, `POST /lun/v1/cards/:id/accept {input?}` et
  `POST /lun/v1/cards/:id/refuse`. Une carte qui n’est plus en attente : 409 ; une carte d’un jour passé : 409
  « Carte expirée ». Le titre et les lignes sont écrits par le serveur. Une suppression est toujours une carte, et
  l’agent n’envoie jamais de mail.
- `Health.agent` vaut `true`.
- Action `day.digest {since, until}` (instants ISO, intervalle `[since, until[`) : rend
  `{since, until, received, done, pending}`, 200 éléments au plus par liste, les actions défaites exclues.
- Les événements suivent les niveaux du standard de notifications de lun-docs (urgent, normal, low, info, log) ;
  le modèle ne fixe jamais `urgent`.

## Ce que l’agent ne fait pas encore

- **Transférer un mail.** Le transfert se fait depuis l’écran du mail (Transférer) : ses brouillons n’ont pas
  de mail transféré à joindre.

## Réglages

Dans Réglages › Agent : l’identité (nom, icône, ton, contexte du personnage), le mode (Valider avant chaque action, ou Faire tout de suite), les consignes (ses instructions
supplémentaires), la conservation (nombre de jours de fil gardés), le plafond de dépense par jour et le
modèle. Les actions faites par l’agent portent son nom dans le journal (« par » suivi du nom réglé).

## Fournisseurs

Anthropic, OpenAI, Gemini, Mistral, ou un point d’accès compatible OpenAI (un modèle local, par exemple).
Les clés se saisissent dans Réglages › Fournisseurs d’IA et sont enregistrées chiffrées dans la base avec
`ACEDIA_SECRET_KEY`. Une clé enregistrée l’emporte sur celle du `.env` jusqu’à son remplacement. L’échéance
déclarée d’une clé est un rappel facultatif (alerte à J-14 puis J-3), pas une limite technique. L’agent suit le
modèle du tri s’il sait appeler des outils ; on peut en choisir un autre pour lui.

## Raccourcis

| Raccourci | Effet |
|---|---|
| Ctrl J | ouvre ou ferme l’agent |
| Entrée | envoie la demande |
| Ctrl ↵ | valide la carte qui a le focus |
| Échap | refuse la carte qui a le focus |
| ↑ | rappelle la dernière demande (saisie vide) |

## Évaluer le cadre métier

Un jeu de scénarios en français sur les données de démonstration (`server/src/pina/eval/scenarios.ts`) vérifie
que l’agent appelle la bonne action, crée une carte quand il le faut, reste sans action quand la demande est
floue ou hors sujet, ne propose jamais d’envoi et n’exécute aucune suppression. Il se lance à la main, contre
un vrai modèle, avec une clé de test, jamais en CI :

```bash
PINA_EVAL_PROVIDER=anthropic PINA_EVAL_MODEL=<modèle> PINA_EVAL_KEY=<clé de test> npm run pina:eval
```

Google est simulé, la base est en mémoire : ni le vrai compte ni la vraie base ne sont touchés. Le rapport
(résultat, actions, coût par scénario et total) s’affiche et s’écrit dans `server/scripts/pina-eval-report.md`
(ignoré par git) ; le code de sortie est non nul au moindre échec. `npm run pina:eval -- --dry` essaie le
dispositif avec un modèle factice. Pour la recette à la main, voir [Prouver l’agent](prouver-pina.md).
