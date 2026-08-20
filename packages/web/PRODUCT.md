# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Confirmé : double audience à servir en équilibre. (1) Le décideur/acheteur (DSI, direction) qui évalue Calame en démo et doit y lire sérieux et conformité. (2) L'admin data qui vit dans l'outil au quotidien : configure les sources, gouverne les accès, approuve les écritures. Troisième audience présente mais non prioritaire : l'utilisateur métier qui interroge ses données dans le chat.

## Product Purpose

Calame connecte des sources de données d'entreprise (PostgreSQL, Notion, S3, connecteurs RAG…) à des LLM via MCP, et permet de les interroger en langage naturel sous gouvernance : masquage PII, approbation des écritures, journal d'audit. Livré en app web + desktop (Tauri, Windows). Succès = des réponses utiles sur données réelles, sans fuite ni écriture non contrôlée.

## Positioning

Confirmé par l'utilisateur : le différenciateur défendable est la gouvernance et le PII. L'IA sous contrôle, prouvable : masquage PII visible dans chaque réponse, écritures en file d'approbation, audit complet.

## Operating Context

Sessions longues côté admin : Workspace (Dashboard, Chat, MCP Servers, Sources), Govern (Pending Writes, Audit Log), Admin (Users, Workspaces, Metrics, Settings). Démos commerciales fréquentes. Multi-tenant avec branding par workspace (logo, couleur d'accent configurables).

## Capabilities and Constraints

- Un « profil » (interface Profile, packages/web/src/types/schema.ts) est un serveur MCP servi : label, sources actives, scopes d'accès par source, authMode (open/token/calame/sso/oauth/external), dataScopeRules (cloisonnement par ligne), sharedTables, aiSettingNames.
- Stack web : React + Tailwind 3, accent `--color-os-*` surchargé par tenant via BrandingProvider. Toute nouvelle surface doit préserver la brandabilité de l'accent.
- Contrainte perf actée dans le code : pas de backdrop-blur sur les cartes (jank de scroll).
- Budget 800 lignes par fichier en CI.

## Brand Commitments

- Nom : Calame (instrument d'écriture ; encre et trait appartiennent au territoire symbolique).
- Confirmé : mode sombre par défaut assumé. Depuis la session du 2026-08-14 : l'utilisateur AIME l'identité actuelle (gray-950, IBM Plex Sans light + Plex Mono, accent indigo brandable, cartes rounded-2xl translucides, eyebrows mono) ; les nouvelles surfaces se conçoivent DANS ce langage, pas contre lui.

## Evidence on Hand

- Code : packages/web/src (index.css = système incumbent ; ServePanel, ProfilePreview, Sidebar…).
- Fonctions démontrables : masquage PII, écritures en attente, audit, multi-sources.
- Pas de témoignages/logos clients publics : ne pas en inventer.

## Product Principles

1. Le contrôle se voit : chaque surface montre ce qui est accessible et ce qui est protégé.
2. Impressionner en démo sans fatiguer à l'usage.
3. La donnée est le contenu : typographie des chiffres et du code au premier ordre.
4. Brandable sans se dissoudre.
