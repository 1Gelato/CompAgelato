/**
 * Point d'entrée des tests du client mobile. Le cœur de l'app (`mobile/src/
 * core/`) ne connaît ni React Native ni Expo — uniquement `fetch` et un
 * stockage injecté — précisément pour être exercé ici, en Node, contre un
 * vrai serveur.
 */
export * from '../mobile/src/core/api';
export * from '../mobile/src/core/offline';
