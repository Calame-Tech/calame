# Authentification

L'authentification utilise des jetons OAuth.

## Durée des sessions

Les sessions restent valides pendant trente jours.
Le rafraîchissement des jetons est automatique : l'utilisateur n'a pas besoin
de ressaisir ses identifiants tant que la session est active.

## Révocation

Un administrateur peut révoquer un jeton à tout moment depuis le panneau
de gestion des tokens.
