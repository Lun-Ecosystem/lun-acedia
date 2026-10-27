# Pina-co-lada, l’assistante d’Acedia

Pina (« Pina-co-lada ») est l’assistante d’Acedia : on lui parle en français, elle lit les mails, l’agenda et
les tâches, et prépare ce qu’on lui demande. Elle ne fait rien que l’écran d’Acedia ne permette de faire à la
main.

## Ce qu’elle fait

- Lire, chercher et résumer des mails ; dire ce qui attend (« Qu’est-ce qui m’attend aujourd’hui ? »).
- Créer une tâche ou un événement à partir d’un mail ouvert (« Mets ce déjeuner dans mon agenda »).
- Ranger, archiver, mettre à la corbeille, gérer les étiquettes et les règles de tri.
- Préparer un brouillon de réponse, que l’on relit et que l’on envoie soi-même.
- Dire qu’elle ne comprend pas, ou poser une question, quand la demande est floue (« Range ça. »).

Elle agit uniquement par le catalogue d’actions d’Acedia, le même que celui du contrat satellite.

## Garde-fous

- **Cartes à valider.** En mode « Valider avant chaque action », toute écriture devient une carte : rien n’est fait
  tant qu’on n’a pas cliqué Valider. Une action faite se défait avec Annuler.
- **Les suppressions sont toujours validées**, même en mode « Faire tout de suite ».
- **Jamais d’envoi.** Aucune action n’envoie un mail. Pour répondre, Pina crée un brouillon ; seul le clic sur
  Envoyer, dans la rédaction, l’envoie.
- **Le texte d’un mail est une donnée**, jamais une consigne. Un mail qui lui demande d’agir est signalé,
  pas obéi.
- **Huit tours au plus** par demande, puis elle s’arrête et demande par où reprendre.
- **Plafond quotidien** de dépense : au-delà, elle attend le lendemain ou que le plafond soit relevé.
- Une action refusée n’est pas refaite sans nouvelle demande.

## Réglages

Dans Réglages › Pina : le mode (Valider avant chaque action, ou Faire tout de suite), les consignes (ses instructions
supplémentaires), la conservation (nombre de jours de fil gardés), le plafond de dépense par jour et le
modèle. Les actions faites par Pina portent la mention « par Pina » dans le journal.

## Fournisseurs

Anthropic, OpenAI, Gemini, Mistral, ou un point d’accès compatible OpenAI (un modèle local, par exemple).
Les clés se saisissent dans Réglages › Fournisseurs d’IA et sont enregistrées chiffrées dans la base avec
`ACEDIA_SECRET_KEY`. Une clé enregistrée l’emporte sur celle du `.env` jusqu’à son remplacement. L’échéance
déclarée d’une clé est un rappel facultatif (alerte à J-14 puis J-3), pas une limite technique. Pina suit le
modèle du tri s’il sait appeler des outils ; on peut en choisir un autre pour elle.

## Raccourcis

| Raccourci | Effet |
|---|---|
| Ctrl J | ouvre ou ferme Pina |
| Entrée | envoie la demande |
| Ctrl ↵ | valide la carte qui a le focus |
| Échap | refuse la carte qui a le focus |
| ↑ | rappelle la dernière demande (saisie vide) |

## Évaluer le cadre métier

Un jeu de scénarios en français sur les données de démonstration (`server/src/pina/eval/scenarios.ts`) vérifie
que Pina appelle la bonne action, crée une carte quand il le faut, reste sans action quand la demande est
floue ou hors sujet, ne propose jamais d’envoi et n’exécute aucune suppression. Il se lance à la main, contre
un vrai modèle, avec une clé de test, jamais en CI :

```bash
PINA_EVAL_PROVIDER=anthropic PINA_EVAL_MODEL=<modèle> PINA_EVAL_KEY=<clé de test> npm run pina:eval
```

Google est simulé, la base est en mémoire : ni le vrai compte ni la vraie base ne sont touchés. Le rapport
(résultat, actions, coût par scénario et total) s’affiche et s’écrit dans `server/scripts/pina-eval-report.md`
(ignoré par git) ; le code de sortie est non nul au moindre échec. `npm run pina:eval -- --dry` essaie le
dispositif avec un modèle factice. Pour la recette à la main, voir [Prouver Pina](prouver-pina.md).
