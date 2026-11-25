# Brancher Google

Acedia agit sur **un seul compte Google**. En développement, c'est toujours le **compte de test**,
jamais le vrai compte.

## 1. Créer le projet en mode Personnel (une fois)

Le mode Personnel sert une application utilisée par son seul créateur : pas de vérification par Google,
pas d'écran « application non validée » au consentement.

1. Se connecter à la console Google Cloud avec **le compte qu'Acedia servira** (en développement, le
   compte de test).
2. Créer le projet depuis la page `https://console.cloud.google.com/auth/overview/personal`.
3. Activer les API **Gmail**, **Google Calendar** et **Google Tasks**.
4. Créer un client OAuth, type **Application Web**, avec comme URI de redirection autorisée
   `http://localhost:<port>/oauth/callback` (8787 par défaut), ou la valeur de `GOOGLE_REDIRECT_URI`.
5. Dans « Accès aux données », déclarer les cinq champs d'application demandés par Acedia (Gmail
   modify, send, settings.basic ; Calendar ; Tasks).

Ce que le mode engage :

- **Le projet est lié au compte qui le crée** : lui seul peut connecter Acedia. Un projet créé par le
  mauvais compte est à refaire.
- **Le choix est définitif** : un projet Personnel ne devient ni Externe ni Interne, et un projet Externe
  ou Interne existant ne passe pas en Personnel.
- **Les jetons durent** : d'après l'[aide de Google](https://support.google.com/cloud/answer/15549945),
  les applications en mode Personnel « are not subject to the OAuth user cap or 7-day test user token
  expiration ».

## 2. Configurer Acedia

Dans `.env` : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ACEDIA_SECRET_KEY` (32 octets en base64,
commande dans `.env.example`). Sans ces trois valeurs, Acedia démarre sans Google et le dit. Une
`ACEDIA_SECRET_KEY` qui ne fait pas 32 octets compte comme absente, et le démarrage le dit aussi.

**Changer de client** : après un nouvel identifiant dans `.env`, relancer Acedia, puis déconnecter et
reconnecter le compte (Réglages → Compte Google). Les jetons rangés appartiennent à l'ancien client.

## 3. Se connecter

Depuis le front (Réglages → Compte Google) : « Connecter » ouvre la page de consentement de Google,
puis revient sur Acedia, dans Réglages → Compte Google. Les jetons sont chiffrés dans la base.

Un retour en échec revient au même endroit, avec un message (connexion annulée, retour périmé, ou
Google n'a pas confirmé) ; le compte déjà branché ne change pas. Si ça échoue encore, vérifier que les
trois API du § 1 sont activées : le journal du serveur garde le code court de Google
(`accessNotConfigured`, par exemple).

Un jeton rangé avec une autre `ACEDIA_SECRET_KEY` ne se lit pas : la carte dit « Compte illisible »,
« Non connecté » et pourquoi. Remettre l'ancienne clé dans `.env` et relancer, ou reconnecter le compte.

## Si Google refuse le renouvellement

Mot de passe changé, accès retiré… Acedia passe en état dégradé (`google-reauth`), émet un événement
urgent et continue de servir ce qu'elle a déjà en cache. Il suffit de se reconnecter depuis les réglages.

## Repli : projet Externe, en production sans vérification

L'ancienne voie, à garder pour le cas où la console refuse le mode Personnel au compte.

1. Créer un projet ordinaire, activer les trois API, puis un écran de consentement de type **Externe**
   avec les cinq champs d'application.
2. **Publier l'application en « Production »**, sans la faire vérifier. Restée en « Test », elle fait
   expirer les jetons au bout de 7 jours : il faudrait se reconnecter chaque semaine.
3. Créer le client **Application Web** avec la même URI de redirection qu'au § 1.

Google affiche alors un avertissement « application non validée » au consentement ; pour un usage
personnel, on le passe.
