# Brancher Google

Acedia agit sur **un seul compte Google**. En développement, c'est toujours le **compte de test**,
jamais le vrai compte.

## 1. Créer le client OAuth (une fois)

1. Dans la console Google Cloud, créer un projet (ex. « lun-acedia »).
2. Activer les API **Gmail**, **Google Calendar** et **Google Tasks**.
3. Écran de consentement OAuth : type **Externe**, ajouter les cinq champs d'application demandés par
   Acedia (Gmail modify, send, settings.basic ; Calendar ; Tasks).
4. **Publier l'application en « Production »** (sans la faire vérifier). En statut « Test », Google fait
   expirer les jetons au bout de 7 jours : il faudrait se reconnecter chaque semaine. Une app non
   vérifiée affiche un avertissement au moment du consentement ; pour un usage personnel, on le passe.
5. Identifiants → créer un **ID client OAuth**, type **Application Web**, avec comme URI de
   redirection autorisée `http://localhost:8787/oauth/callback` (ou la valeur de
   `GOOGLE_REDIRECT_URI`).

## 2. Configurer Acedia

Dans `.env` : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ACEDIA_SECRET_KEY` (32 octets en base64,
commande dans `.env.example`). Sans ces trois valeurs, Acedia démarre sans Google et le dit.

## 3. Se connecter

Depuis le front (Réglages → Compte Google) : « Connecter » ouvre la page de consentement de Google,
puis revient sur Acedia. Les jetons sont chiffrés dans la base.

## Si Google refuse le renouvellement

Mot de passe changé, accès retiré, app restée en « Test »… Acedia passe en état dégradé
(`google-reauth`), émet un événement urgent et continue de servir ce qu'elle a déjà en cache. Il suffit
de se reconnecter depuis les réglages.
