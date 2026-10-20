# Installer sur le téléphone

Le front autonome est une PWA : il s'installe depuis le navigateur, sans magasin d'applications. Il est
servi par Lun'Acedia lui-même, à la racine du serveur.

## 1. Construire et lancer

```bash
npm run build          # construit aussi app/dist, que le serveur sert sur /
npm start -w @lun-acedia/server
```

Au démarrage, le serveur dit s'il trouve le front (`app/dist`). En développement, `npm run dev -w
@lun-acedia/app` lance Vite, qui renvoie `/api`, `/lun` et `/oauth` vers le serveur sur le port 8787.

## 2. Ouvrir en HTTPS sur le réseau

Un navigateur n'installe une PWA qu'en HTTPS (ou sur `localhost`). Sur le poste qui fait tourner
Acedia, `tailscale serve` publie le port en HTTPS sur le tailnet, et nulle part ailleurs :

```bash
tailscale serve --bg 8787
tailscale serve status   # donne l'adresse https://<machine>.<tailnet>.ts.net
```

Ne jamais écrire cette adresse dans le dépôt, une PR ou une issue (dépôt public).

## 3. Installer

1. Sur le téléphone Android (dans le même tailnet), ouvrir l'adresse dans Chrome.
2. Écran d'appairage : entrer un code à 6 chiffres, donné à tout moment par `npm run pair-code` sur
   le poste qui fait tourner Acedia. Au tout premier lancement, il est aussi dans les journaux du
   serveur ; ensuite, Réglages → Appairage sur un appareil déjà relié.
3. Menu de Chrome → « Installer l'application ». Lun'Acedia apparaît avec son icône de lune.

Le jeton de l'appareil reste dans le navigateur du téléphone. S'il est révoqué, l'app revient à
l'écran d'appairage.

## Ce que l'app garde hors ligne

Seule l'enveloppe de l'app (code, styles, polices, icônes) est en cache. Les mails, l'agenda et les
tâches viennent toujours en direct du serveur : sans réseau, l'app s'ouvre mais ne montre rien de
périmé.

## Connexion Google

Le consentement Google revient sur `GOOGLE_REDIRECT_URI` (par défaut `http://localhost:8787`) : le
faire depuis le poste, dans Réglages → Compte Google. Une fois connecté, le téléphone en profite.
