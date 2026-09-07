-- scripts/mssql-test-seed.sql
--
-- TEST-ONLY fixture for the MSSQL connector integration suite
-- (packages/connectors/src/__tests__/mssql.integration.test.ts).
--
-- Creates a small but representative database:
--   * dbo.clients      — IDENTITY pk, PII columns (email/phone), BIT, DATETIME2, NVARCHAR(MAX)
--   * dbo.products      — IDENTITY pk
--   * dbo.orders        — IDENTITY pk, FK to clients/products
--   * dbo.order_items   — COMPOSITE pk (order_id, line_no), FK to orders/products
--   * ventes.commandes  — non-dbo schema, FK to dbo.clients (required test case)
--   * rh.employes       — non-dbo schema, PII salary column (required test case)
--
-- All names/emails/phones are fabricated for testing — no real people.
-- Run via scripts/mssql-test-up.sh, or manually:
--   sqlcmd -S localhost,14330 -U sa -P 'CalameTest!2026x' -C -i scripts/mssql-test-seed.sql

SET NOCOUNT ON;
GO

IF DB_ID('calame_test') IS NOT NULL
BEGIN
    ALTER DATABASE calame_test SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE calame_test;
END
GO

CREATE DATABASE calame_test;
GO

USE calame_test;
GO

EXEC('CREATE SCHEMA ventes');
GO
EXEC('CREATE SCHEMA rh');
GO

-- ---------------------------------------------------------------------------
-- dbo.clients — IDENTITY pk, PII (email/phone), BIT, DATETIME2, NVARCHAR(MAX)
-- ---------------------------------------------------------------------------
CREATE TABLE dbo.clients (
    client_id       INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    nom             NVARCHAR(100)     NOT NULL,
    prenom          NVARCHAR(100)     NOT NULL,
    email           NVARCHAR(255)     NOT NULL,
    telephone       NVARCHAR(20)      NULL,
    date_naissance  DATE              NULL,
    actif           BIT               NOT NULL DEFAULT 1,
    date_creation   DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    notes           NVARCHAR(MAX)     NULL
);
GO

-- ---------------------------------------------------------------------------
-- dbo.products — IDENTITY pk
-- ---------------------------------------------------------------------------
CREATE TABLE dbo.products (
    product_id  INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    sku         NVARCHAR(50)      NOT NULL,
    nom         NVARCHAR(200)     NOT NULL,
    prix        DECIMAL(10,2)     NOT NULL,
    en_stock    BIT               NOT NULL DEFAULT 1,
    cree_le     DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- ---------------------------------------------------------------------------
-- dbo.orders — IDENTITY pk, FK -> clients
-- ---------------------------------------------------------------------------
CREATE TABLE dbo.orders (
    order_id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    client_id       INT               NOT NULL,
    date_commande   DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    statut          NVARCHAR(20)      NOT NULL DEFAULT 'en_attente',
    CONSTRAINT fk_orders_client FOREIGN KEY (client_id) REFERENCES dbo.clients(client_id)
);
GO

-- ---------------------------------------------------------------------------
-- dbo.order_items — COMPOSITE pk (order_id, line_no), FK -> orders/products
-- ---------------------------------------------------------------------------
CREATE TABLE dbo.order_items (
    order_id        INT           NOT NULL,
    line_no         INT           NOT NULL,
    product_id      INT           NOT NULL,
    quantite        INT           NOT NULL,
    prix_unitaire   DECIMAL(10,2) NOT NULL,
    CONSTRAINT pk_order_items PRIMARY KEY (order_id, line_no),
    CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES dbo.orders(order_id),
    CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES dbo.products(product_id)
);
GO

-- ---------------------------------------------------------------------------
-- ventes.commandes — non-dbo schema (required test case), FK -> dbo.clients
-- ---------------------------------------------------------------------------
CREATE TABLE ventes.commandes (
    commande_id     INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    client_id       INT               NOT NULL,
    date_commande   DATETIME2(3)      NOT NULL DEFAULT SYSUTCDATETIME(),
    montant_total   DECIMAL(10,2)     NOT NULL,
    statut          NVARCHAR(30)      NOT NULL DEFAULT 'validee',
    region          NVARCHAR(50)      NULL,
    CONSTRAINT fk_commandes_client FOREIGN KEY (client_id) REFERENCES dbo.clients(client_id)
);
GO

-- ---------------------------------------------------------------------------
-- rh.employes — non-dbo schema (required test case), PII salary column
-- ---------------------------------------------------------------------------
CREATE TABLE rh.employes (
    employe_id      INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    nom             NVARCHAR(100)     NOT NULL,
    prenom          NVARCHAR(100)     NOT NULL,
    poste           NVARCHAR(100)     NOT NULL,
    salaire         DECIMAL(10,2)     NOT NULL,
    date_embauche   DATE              NOT NULL,
    actif           BIT               NOT NULL DEFAULT 1
);
GO

-- ============================================================================
-- Seed data
-- ============================================================================

-- dbo.clients (25 rows) ------------------------------------------------------
INSERT INTO dbo.clients (nom, prenom, email, telephone, date_naissance, actif, date_creation, notes) VALUES
('Moreau', 'Camille', 'camille.moreau@example.fr', '06 12 34 56 78', '1988-03-14', 1, '2024-01-05T09:12:00', N'Cliente fidèle, préfère la livraison en point relais.'),
('Lefebvre', 'Antoine', 'antoine.lefebvre@example.fr', '06 23 45 67 89', '1975-11-02', 1, '2024-01-08T14:30:00', NULL),
('Girard', 'Manon', 'manon.girard@example.fr', '07 34 56 78 90', '1993-07-21', 1, '2024-01-10T11:05:00', N'A demandé une facture séparée pour la commande de janvier.'),
('Bonnet', 'Louis', 'louis.bonnet@example.fr', '06 45 67 89 01', '1966-05-30', 0, '2024-01-12T16:45:00', NULL),
('Roux', 'Chloé', 'chloe.roux@example.fr', '07 56 78 90 12', '1998-09-09', 1, '2024-01-15T08:20:00', NULL),
('Fontaine', 'Hugo', 'hugo.fontaine@example.fr', '06 67 89 01 23', '1982-12-25', 1, '2024-01-18T10:10:00', N'Compte professionnel — TVA intracommunautaire FR40123456789.'),
('Chevalier', 'Léa', 'lea.chevalier@example.fr', '07 78 90 12 34', '1991-02-17', 1, '2024-01-20T13:55:00', NULL),
('Robin', 'Nathan', 'nathan.robin@example.fr', '06 89 01 23 45', '1979-06-11', 1, '2024-01-22T15:40:00', NULL),
('Masson', 'Inès', 'ines.masson@example.fr', '07 90 12 34 56', '1996-04-03', 1, '2024-01-25T09:00:00', N'Allergique aux emballages en polystyrène, demande carton uniquement.'),
('Simon', 'Théo', 'theo.simon@example.fr', '06 01 23 45 67', '1985-10-19', 1, '2024-01-28T12:15:00', NULL),
('Dupuis', 'Clara', 'clara.dupuis@example.fr', '07 12 23 34 45', '1990-01-08', 0, '2024-02-01T09:30:00', NULL),
('Perrot', 'Maxime', 'maxime.perrot@example.fr', '06 13 24 35 46', '1972-08-27', 1, '2024-02-03T11:00:00', NULL),
('Barbier', 'Julie', 'julie.barbier@example.fr', '07 24 35 46 57', '1994-03-30', 1, '2024-02-05T14:00:00', N'Newsletter: opt-in.'),
('Renard', 'Adam', 'adam.renard@example.fr', '06 35 46 57 68', '1969-12-01', 1, '2024-02-07T16:20:00', NULL),
('Blanchard', 'Sarah', 'sarah.blanchard@example.fr', '07 46 57 68 79', '1987-05-05', 1, '2024-02-10T08:45:00', NULL),
('Guerin', 'Lucas', 'lucas.guerin@example.fr', '06 57 68 79 80', '1992-11-14', 1, '2024-02-12T10:30:00', NULL),
('Muller', 'Emma', 'emma.muller@example.fr', '07 68 79 80 91', '1980-07-07', 0, '2024-02-14T13:10:00', N'Litige résolu le 2024-03-01 — avoir de 15€ émis.'),
('Faure', 'Gabriel', 'gabriel.faure@example.fr', '06 79 80 91 02', '1997-09-23', 1, '2024-02-16T15:00:00', NULL),
('Aubert', 'Zoé', 'zoe.aubert@example.fr', '07 80 91 02 13', '1976-02-28', 1, '2024-02-18T09:50:00', NULL),
('Meunier', 'Raphaël', 'raphael.meunier@example.fr', '06 91 02 13 24', '1989-06-16', 1, '2024-02-20T11:40:00', NULL),
('Lemoine', 'Alice', 'alice.lemoine@example.fr', '07 02 13 24 35', '1995-10-04', 1, '2024-02-22T14:25:00', NULL),
('Boyer', 'Tom', 'tom.boyer@example.fr', '06 03 14 25 36', '1983-04-12', 1, '2024-02-25T16:05:00', N'Préfère être contacté par email uniquement.'),
('Garcia', 'Lina', 'lina.garcia@example.fr', '07 14 25 36 47', '1999-01-29', 1, '2024-02-27T08:15:00', NULL),
('Rousseau', 'Ethan', 'ethan.rousseau@example.fr', '06 25 36 47 58', '1971-03-08', 1, '2024-03-01T10:50:00', NULL),
('Colin', 'Jade', 'jade.colin@example.fr', '07 36 47 58 69', '1986-08-22', 1, '2024-03-03T12:35:00', NULL);
GO

-- dbo.products (8 rows) -------------------------------------------------------
INSERT INTO dbo.products (sku, nom, prix, en_stock, cree_le) VALUES
('SKU-1001', N'Cahier de note A5 — couverture toilée', 8.90, 1, '2023-11-01T09:00:00'),
('SKU-1002', N'Stylo plume acier inoxydable', 24.50, 1, '2023-11-01T09:00:00'),
('SKU-1003', N'Encre bleue nuit 50ml', 6.20, 1, '2023-11-02T09:00:00'),
('SKU-1004', N'Porte-documents cuir végétal', 39.00, 0, '2023-11-05T09:00:00'),
('SKU-1005', N'Agenda annuel relié', 14.90, 1, '2023-11-10T09:00:00'),
('SKU-1006', N'Set de 3 crayons graphite', 5.50, 1, '2023-11-12T09:00:00'),
('SKU-1007', N'Enveloppes kraft A4 (x50)', 9.90, 1, '2023-11-15T09:00:00'),
('SKU-1008', N'Tampon encreur personnalisable', 18.00, 0, '2023-11-20T09:00:00');
GO

-- dbo.orders (15 rows, referencing clients 1..15) -----------------------------
INSERT INTO dbo.orders (client_id, date_commande, statut) VALUES
(1, '2024-03-05T10:00:00', 'expediee'),
(2, '2024-03-05T11:15:00', 'expediee'),
(3, '2024-03-06T09:30:00', 'livree'),
(4, '2024-03-06T14:00:00', 'annulee'),
(5, '2024-03-07T08:45:00', 'livree'),
(6, '2024-03-07T16:20:00', 'expediee'),
(7, '2024-03-08T10:10:00', 'en_attente'),
(8, '2024-03-09T12:00:00', 'livree'),
(9, '2024-03-10T09:00:00', 'expediee'),
(10, '2024-03-10T15:30:00', 'livree'),
(1, '2024-03-11T11:00:00', 'en_attente'),
(11, '2024-03-12T13:45:00', 'livree'),
(12, '2024-03-13T09:20:00', 'expediee'),
(13, '2024-03-14T10:50:00', 'livree'),
(3, '2024-03-15T14:15:00', 'en_attente');
GO

-- dbo.order_items (composite pk order_id/line_no; 2 lines per order) ---------
INSERT INTO dbo.order_items (order_id, line_no, product_id, quantite, prix_unitaire) VALUES
(1, 1, 1, 2, 8.90), (1, 2, 3, 1, 6.20),
(2, 1, 2, 1, 24.50),
(3, 1, 5, 1, 14.90), (3, 2, 6, 2, 5.50),
(4, 1, 4, 1, 39.00),
(5, 1, 1, 3, 8.90),
(6, 1, 7, 4, 9.90), (6, 2, 3, 2, 6.20),
(7, 1, 8, 1, 18.00),
(8, 1, 2, 2, 24.50), (8, 2, 1, 1, 8.90),
(9, 1, 5, 1, 14.90),
(10, 1, 6, 3, 5.50),
(11, 1, 7, 1, 9.90),
(12, 1, 1, 1, 8.90), (12, 2, 8, 1, 18.00),
(13, 1, 3, 5, 6.20),
(14, 1, 2, 1, 24.50),
(15, 1, 5, 2, 14.90), (15, 2, 6, 1, 5.50);
GO

-- ventes.commandes (12 rows, non-dbo schema) ----------------------------------
INSERT INTO ventes.commandes (client_id, date_commande, montant_total, statut, region) VALUES
(1, '2024-04-01T09:00:00', 156.30, 'validee', N'Île-de-France'),
(2, '2024-04-02T10:15:00', 89.00, 'validee', N'Auvergne-Rhône-Alpes'),
(3, '2024-04-03T11:30:00', 240.75, 'expediee', N'Occitanie'),
(4, '2024-04-04T13:00:00', 45.20, 'annulee', N'Bretagne'),
(5, '2024-04-05T14:20:00', 312.00, 'validee', N'Île-de-France'),
(6, '2024-04-06T15:40:00', 78.50, 'expediee', N'Nouvelle-Aquitaine'),
(7, '2024-04-07T08:10:00', 199.99, 'validee', N'Hauts-de-France'),
(8, '2024-04-08T09:45:00', 63.40, 'validee', N'Grand Est'),
(9, '2024-04-09T11:05:00', 421.10, 'expediee', N'Île-de-France'),
(10, '2024-04-10T12:30:00', 27.90, 'annulee', N'Normandie'),
(11, '2024-04-11T14:00:00', 134.60, 'validee', N'Pays de la Loire'),
(12, '2024-04-12T16:15:00', 502.25, 'validee', N'Provence-Alpes-Côte d''Azur');
GO

-- rh.employes (8 rows, non-dbo schema, salary PII) ----------------------------
INSERT INTO rh.employes (nom, prenom, poste, salaire, date_embauche, actif) VALUES
('Girard', 'Sophie', N'Responsable logistique', 42500.00, '2019-06-01', 1),
('Lambert', 'Julien', N'Développeur back-end', 46800.00, '2021-02-15', 1),
('Petit', 'Charlotte', N'Assistante RH', 32000.00, '2022-09-01', 1),
('Bertrand', 'Nicolas', N'Comptable', 38500.00, '2018-03-12', 1),
('Fournier', 'Marie', N'Chargée de clientèle', 29800.00, '2023-01-10', 1),
('Mercier', 'David', N'Directeur commercial', 61200.00, '2015-11-03', 1),
('Dubois', 'Pauline', N'Chef de projet', 44300.00, '2020-05-20', 0),
('Vincent', 'Alexandre', N'Technicien support', 31500.00, '2022-11-07', 1);
GO

PRINT 'calame_test seeded: dbo.clients, dbo.products, dbo.orders, dbo.order_items, ventes.commandes, rh.employes';
GO
