/**
 * Générateur de base de données logistique complexe pour tests Calame
 * Tables: client, livreur, depot, zone, colis, tournee, incident, paiement, notification, historique_statut
 * Volume: ~10 000 lignes au total
 */

const Database = require('../node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'demo-logistique-v2.db');

// Supprimer l'ancienne DB si elle existe
const fs = require('fs');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── SCHEMA ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE zone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    libelle TEXT NOT NULL,
    departement TEXT NOT NULL,
    region TEXT NOT NULL
  );

  CREATE TABLE depot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    adresse TEXT NOT NULL,
    ville TEXT NOT NULL,
    code_postal TEXT NOT NULL,
    id_zone INTEGER NOT NULL REFERENCES zone(id),
    capacite_max INTEGER NOT NULL,
    actif INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE client (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prenom TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telephone TEXT,
    adresse TEXT NOT NULL,
    ville TEXT NOT NULL,
    code_postal TEXT NOT NULL,
    id_zone INTEGER REFERENCES zone(id),
    type_client TEXT NOT NULL DEFAULT 'particulier', -- particulier, professionnel, vip
    date_inscription TEXT NOT NULL,
    actif INTEGER NOT NULL DEFAULT 1,
    solde_credit REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE livreur (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prenom TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telephone TEXT NOT NULL,
    id_depot INTEGER NOT NULL REFERENCES depot(id),
    id_zone INTEGER NOT NULL REFERENCES zone(id),
    vehicule TEXT NOT NULL, -- velo, scooter, camionnette, camion
    permis TEXT,
    note_moyenne REAL NOT NULL DEFAULT 5.0,
    nb_livraisons_total INTEGER NOT NULL DEFAULT 0,
    actif INTEGER NOT NULL DEFAULT 1,
    date_embauche TEXT NOT NULL
  );

  CREATE TABLE colis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    id_client INTEGER NOT NULL REFERENCES client(id),
    id_livreur INTEGER REFERENCES livreur(id),
    id_depot INTEGER REFERENCES depot(id),
    poids_kg REAL NOT NULL,
    longueur_cm INTEGER,
    largeur_cm INTEGER,
    hauteur_cm INTEGER,
    statut TEXT NOT NULL, -- en_attente, en_depot, en_cours, livre, echec, retour, perdu
    priorite TEXT NOT NULL DEFAULT 'normale', -- normale, express, urgente
    fragile INTEGER NOT NULL DEFAULT 0,
    valeur_declaree REAL,
    adresse_livraison TEXT NOT NULL,
    ville_livraison TEXT NOT NULL,
    code_postal_livraison TEXT NOT NULL,
    date_creation TEXT NOT NULL,
    date_expedition TEXT,
    date_livraison_prevue TEXT,
    date_livraison_reelle TEXT,
    tentatives_livraison INTEGER NOT NULL DEFAULT 0,
    commentaire TEXT,
    signature_requise INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE tournee (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_livreur INTEGER NOT NULL REFERENCES livreur(id),
    id_depot INTEGER NOT NULL REFERENCES depot(id),
    date_tournee TEXT NOT NULL,
    heure_debut TEXT,
    heure_fin TEXT,
    statut TEXT NOT NULL DEFAULT 'planifiee', -- planifiee, en_cours, terminee, annulee
    nb_colis_prevu INTEGER NOT NULL DEFAULT 0,
    nb_colis_livre INTEGER NOT NULL DEFAULT 0,
    nb_colis_echec INTEGER NOT NULL DEFAULT 0,
    km_parcourus REAL,
    note_livreur REAL
  );

  CREATE TABLE tournee_colis (
    id_tournee INTEGER NOT NULL REFERENCES tournee(id),
    id_colis INTEGER NOT NULL REFERENCES colis(id),
    ordre INTEGER NOT NULL,
    statut TEXT NOT NULL DEFAULT 'prevu', -- prevu, livre, echec, reporte
    PRIMARY KEY (id_tournee, id_colis)
  );

  CREATE TABLE incident (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_colis INTEGER REFERENCES colis(id),
    id_livreur INTEGER REFERENCES livreur(id),
    id_tournee INTEGER REFERENCES tournee(id),
    type TEXT NOT NULL, -- retard, colis_endommage, adresse_introuvable, absent, vol, accident, autre
    gravite TEXT NOT NULL DEFAULT 'faible', -- faible, moyenne, haute, critique
    description TEXT NOT NULL,
    date_incident TEXT NOT NULL,
    resolu INTEGER NOT NULL DEFAULT 0,
    date_resolution TEXT,
    commentaire_resolution TEXT,
    cout_estime REAL
  );

  CREATE TABLE paiement (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_client INTEGER NOT NULL REFERENCES client(id),
    id_colis INTEGER REFERENCES colis(id),
    montant REAL NOT NULL,
    devise TEXT NOT NULL DEFAULT 'EUR',
    methode TEXT NOT NULL, -- carte, virement, especes, credit
    statut TEXT NOT NULL, -- en_attente, valide, rembourse, echec
    reference_transaction TEXT UNIQUE,
    date_paiement TEXT NOT NULL,
    date_validation TEXT
  );

  CREATE TABLE historique_statut (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_colis INTEGER NOT NULL REFERENCES colis(id),
    statut_precedent TEXT,
    statut_nouveau TEXT NOT NULL,
    date_changement TEXT NOT NULL,
    id_livreur INTEGER REFERENCES livreur(id),
    commentaire TEXT
  );

  CREATE TABLE notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    id_client INTEGER NOT NULL REFERENCES client(id),
    id_colis INTEGER REFERENCES colis(id),
    type TEXT NOT NULL, -- sms, email, push
    sujet TEXT NOT NULL,
    message TEXT NOT NULL,
    date_envoi TEXT NOT NULL,
    lu INTEGER NOT NULL DEFAULT 0,
    date_lecture TEXT
  );

  -- Index pour les performances
  CREATE INDEX idx_colis_client ON colis(id_client);
  CREATE INDEX idx_colis_livreur ON colis(id_livreur);
  CREATE INDEX idx_colis_statut ON colis(statut);
  CREATE INDEX idx_paiement_client ON paiement(id_client);
  CREATE INDEX idx_incident_colis ON incident(id_colis);
  CREATE INDEX idx_historique_colis ON historique_statut(id_colis);
  CREATE INDEX idx_notification_client ON notification(id_client);
`);

// ── HELPERS ──────────────────────────────────────────────────────────────────

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[rand(0, arr.length - 1)]; }
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function dateOffset(base, days) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

const NOMS = ['Martin','Dupont','Leroy','Moreau','Bernard','Petit','Durand','Lambert','Fontaine','Rousseau','Simon','Michel','Lefebvre','Leroux','Girard','Bonnet','Fournier','Morel','Perrin','Dubois','Garnier','Faure','Roux','Blanc','Guerin','Muller','Henry','Colin','Mercier','Lacroix'];
const PRENOMS_H = ['Thomas','Nicolas','Julien','Pierre','Alexandre','Mathieu','Antoine','Baptiste','Clement','Florian','Guillaume','Hugo','Maxime','Romain','Sébastien','Adrien','Arthur','Lucas','Nathan','Quentin'];
const PRENOMS_F = ['Marie','Sophie','Julie','Laura','Sarah','Camille','Emma','Léa','Manon','Pauline','Alice','Céline','Charlotte','Elisa','Inès','Jade','Laura','Lucie','Marion','Océane'];
const PRENOMS = [...PRENOMS_H, ...PRENOMS_F];
const VILLES = ['Paris','Lyon','Marseille','Bordeaux','Toulouse','Nantes','Strasbourg','Lille','Rennes','Nice','Montpellier','Grenoble','Rouen','Tours','Dijon'];
const RUES = ['rue de la Paix','avenue Victor Hugo','boulevard Saint-Germain','rue du Faubourg','allée des Roses','impasse des Lilas','chemin du Moulin','rue des Acacias','passage du Commerce','voie Romaine'];
const VEHICULES = ['velo','velo','scooter','scooter','scooter','camionnette','camionnette','camionnette','camion'];
const STATUTS_COLIS = ['en_attente','en_depot','en_cours','livre','livre','livre','livre','echec','retour','perdu'];
const PRIORITES = ['normale','normale','normale','normale','express','urgente'];
const TYPES_CLIENT = ['particulier','particulier','particulier','professionnel','vip'];
const TYPES_INCIDENT = ['retard','colis_endommage','adresse_introuvable','absent','vol','accident','autre'];
const GRAVITES = ['faible','faible','faible','moyenne','haute','critique'];
const METHODES_PAIEMENT = ['carte','carte','carte','virement','especes','credit'];
const REGIONS = [
  { code: 'IDF', libelle: 'Île-de-France', departement: '75', region: 'Île-de-France' },
  { code: 'ARA', libelle: 'Auvergne-Rhône-Alpes', departement: '69', region: 'ARA' },
  { code: 'PACA', libelle: "Provence-Alpes-Côte d'Azur", departement: '13', region: 'PACA' },
  { code: 'NAQ', libelle: 'Nouvelle-Aquitaine', departement: '33', region: 'NAQ' },
  { code: 'OCC', libelle: 'Occitanie', departement: '31', region: 'Occitanie' },
  { code: 'PDL', libelle: 'Pays de la Loire', departement: '44', region: 'PDL' },
  { code: 'GES', libelle: 'Grand Est', departement: '67', region: 'Grand Est' },
  { code: 'HDF', libelle: 'Hauts-de-France', departement: '59', region: 'HDF' },
  { code: 'BRE', libelle: 'Bretagne', departement: '35', region: 'Bretagne' },
  { code: 'NOR', libelle: 'Normandie', departement: '76', region: 'Normandie' },
];

// ── INSERTION ─────────────────────────────────────────────────────────────────

const insertMany = db.transaction((stmt, rows) => {
  for (const row of rows) stmt.run(row);
});

// Zones
const stmtZone = db.prepare('INSERT INTO zone (code, libelle, departement, region) VALUES (@code, @libelle, @departement, @region)');
insertMany(stmtZone, REGIONS);
const zones = db.prepare('SELECT id FROM zone').all().map(r => r.id);
console.log(`✓ ${zones.length} zones`);

// Depots (20)
const stmtDepot = db.prepare('INSERT INTO depot (nom, adresse, ville, code_postal, id_zone, capacite_max) VALUES (@nom, @adresse, @ville, @code_postal, @id_zone, @capacite_max)');
const depots = [];
for (let i = 0; i < 20; i++) {
  const ville = pick(VILLES);
  const r = stmtDepot.run({ nom: `Dépôt ${ville} ${i+1}`, adresse: `${rand(1,200)} ${pick(RUES)}`, ville, code_postal: `${rand(10,99)}000`, id_zone: pick(zones), capacite_max: rand(500, 5000) });
  depots.push(r.lastInsertRowid);
}
console.log(`✓ ${depots.length} dépôts`);

// Clients (500, avec client_id=3 = Emma Leroy boostée à 500 colis)
const stmtClient = db.prepare('INSERT INTO client (nom, prenom, email, telephone, adresse, ville, code_postal, id_zone, type_client, date_inscription, actif, solde_credit) VALUES (@nom, @prenom, @email, @telephone, @adresse, @ville, @code_postal, @id_zone, @type_client, @date_inscription, @actif, @solde_credit)');
const clients = [];
for (let i = 0; i < 500; i++) {
  const nom = pick(NOMS);
  const prenom = pick(PRENOMS);
  const r = stmtClient.run({
    nom, prenom,
    email: `${prenom.toLowerCase()}.${nom.toLowerCase()}${i}@example.com`,
    telephone: `0${rand(6,7)}${String(rand(10000000,99999999))}`,
    adresse: `${rand(1,200)} ${pick(RUES)}`,
    ville: pick(VILLES),
    code_postal: `${rand(10,99)}000`,
    id_zone: pick(zones),
    type_client: pick(TYPES_CLIENT),
    date_inscription: dateOffset('2023-01-01', rand(0, 730)),
    actif: rand(0,10) > 0 ? 1 : 0,
    solde_credit: rand(0,1) === 1 ? rand(0, 100) : 0,
  });
  clients.push(r.lastInsertRowid);
}
console.log(`✓ ${clients.length} clients`);

// Livreurs (50)
const stmtLivreur = db.prepare('INSERT INTO livreur (nom, prenom, email, telephone, id_depot, id_zone, vehicule, permis, note_moyenne, nb_livraisons_total, actif, date_embauche) VALUES (@nom, @prenom, @email, @telephone, @id_depot, @id_zone, @vehicule, @permis, @note_moyenne, @nb_livraisons_total, @actif, @date_embauche)');
const livreurs = [];
for (let i = 0; i < 50; i++) {
  const nom = pick(NOMS);
  const prenom = pick(PRENOMS);
  const vehicule = pick(VEHICULES);
  const r = stmtLivreur.run({
    nom, prenom,
    email: `livreur.${prenom.toLowerCase()}${i}@calame.com`,
    telephone: `0${rand(6,7)}${String(rand(10000000,99999999))}`,
    id_depot: pick(depots),
    id_zone: pick(zones),
    vehicule,
    permis: vehicule === 'camion' ? 'C' : vehicule === 'camionnette' ? 'B' : null,
    note_moyenne: Math.round((3.5 + Math.random() * 1.5) * 10) / 10,
    nb_livraisons_total: rand(50, 3000),
    actif: rand(0,10) > 1 ? 1 : 0,
    date_embauche: dateOffset('2020-01-01', rand(0, 1500)),
  });
  livreurs.push(r.lastInsertRowid);
}
console.log(`✓ ${livreurs.length} livreurs`);

// Colis (20000 dont ~500 pour Emma client_id=3)
const stmtColis = db.prepare(`INSERT INTO colis (reference, id_client, id_livreur, id_depot, poids_kg, longueur_cm, largeur_cm, hauteur_cm, statut, priorite, fragile, valeur_declaree, adresse_livraison, ville_livraison, code_postal_livraison, date_creation, date_expedition, date_livraison_prevue, date_livraison_reelle, tentatives_livraison, commentaire, signature_requise)
VALUES (@reference, @id_client, @id_livreur, @id_depot, @poids_kg, @longueur_cm, @largeur_cm, @hauteur_cm, @statut, @priorite, @fragile, @valeur_declaree, @adresse_livraison, @ville_livraison, @code_postal_livraison, @date_creation, @date_expedition, @date_livraison_prevue, @date_livraison_reelle, @tentatives_livraison, @commentaire, @signature_requise)`);

// Emma est client_id=3 (3ème client inséré)
const emmaClientId = clients[2];

const colisIds = [];
const TOTAL_COLIS = 20000;
const EMMA_COLIS = 500;

// Date de référence = aujourd'hui pour éviter les colis bloqués dans le passé
const TODAY = new Date().toISOString().split('T')[0];

for (let i = 0; i < TOTAL_COLIS; i++) {
  const statut = pick(STATUTS_COLIS);
  const clientId = i < EMMA_COLIS ? emmaClientId : pick(clients);

  // Dates cohérentes avec le statut :
  // - livre/echec/retour/perdu : créés il y a 10-400 jours (terminés)
  // - en_cours/en_depot : créés il y a 1-20 jours (en transit récent)
  // - en_attente : créés il y a 0-7 jours (très récent)
  let dateCreation;
  if (['livre','echec','retour','perdu'].includes(statut)) {
    dateCreation = dateOffset(TODAY, -rand(10, 400));
  } else if (['en_cours','en_depot'].includes(statut)) {
    dateCreation = dateOffset(TODAY, -rand(1, 20));
  } else {
    dateCreation = dateOffset(TODAY, -rand(0, 7));
  }

  const livre = statut === 'livre';
  const r = stmtColis.run({
    reference: `COL-${2024 + Math.floor(i/8000)}-${String(i+1).padStart(5,'0')}`,
    id_client: clientId,
    id_livreur: ['livre','echec','retour'].includes(statut) ? pick(livreurs) : (rand(0,1) ? pick(livreurs) : null),
    id_depot: pick(depots),
    poids_kg: Math.round((0.1 + Math.random() * 29.9) * 10) / 10,
    longueur_cm: rand(5, 120),
    largeur_cm: rand(5, 80),
    hauteur_cm: rand(5, 60),
    statut,
    priorite: pick(PRIORITES),
    fragile: rand(0, 5) === 0 ? 1 : 0,
    valeur_declaree: rand(0,3) === 0 ? rand(10, 2000) : null,
    adresse_livraison: `${rand(1,200)} ${pick(RUES)}`,
    ville_livraison: pick(VILLES),
    code_postal_livraison: `${rand(10,99)}000`,
    date_creation: dateCreation,
    date_expedition: ['en_attente'].includes(statut) ? null : dateOffset(dateCreation, rand(1,3)),
    date_livraison_prevue: dateOffset(dateCreation, rand(2,7)),
    date_livraison_reelle: livre ? dateOffset(dateCreation, rand(2,10)) : null,
    tentatives_livraison: statut === 'livre' ? 1 : statut === 'echec' ? rand(2,3) : rand(0,1),
    commentaire: rand(0,5) === 0 ? 'Laisser chez le voisin si absent' : null,
    signature_requise: rand(0,4) === 0 ? 1 : 0,
  });
  colisIds.push(r.lastInsertRowid);
}
console.log(`✓ ${colisIds.length} colis`);

// Tournées (300) + tournee_colis (liées aux vrais colis des livreurs)
const stmtTournee = db.prepare('INSERT INTO tournee (id_livreur, id_depot, date_tournee, heure_debut, heure_fin, statut, nb_colis_prevu, nb_colis_livre, nb_colis_echec, km_parcourus, note_livreur) VALUES (@id_livreur, @id_depot, @date_tournee, @heure_debut, @heure_fin, @statut, @nb_colis_prevu, @nb_colis_livre, @nb_colis_echec, @km_parcourus, @note_livreur)');
const stmtTourneeColis = db.prepare('INSERT OR IGNORE INTO tournee_colis (id_tournee, id_colis, ordre, statut) VALUES (@id_tournee, @id_colis, @ordre, @statut)');
const tourneeIds = [];
const STATUTS_TOURNEE = ['planifiee','planifiee','en_cours','terminee','terminee','terminee','annulee'];

// Index colis par livreur pour peupler tournee_colis avec de vrais colis
const colisByLivreur = new Map();
const colisLivreurRows = db.prepare('SELECT id, id_livreur, statut FROM colis WHERE id_livreur IS NOT NULL').all();
for (const c of colisLivreurRows) {
  if (!colisByLivreur.has(c.id_livreur)) colisByLivreur.set(c.id_livreur, []);
  colisByLivreur.get(c.id_livreur).push({ id: c.id, statut: c.statut });
}

for (let i = 0; i < 300; i++) {
  const statut = pick(STATUTS_TOURNEE);
  const livreurId = pick(livreurs);
  const prevus = rand(5, 20);

  const r = stmtTournee.run({
    id_livreur: livreurId,
    id_depot: pick(depots),
    date_tournee: dateOffset(TODAY, -rand(0, 365)),
    heure_debut: statut !== 'planifiee' ? `0${rand(7,9)}:${rand(0,5)}0` : null,
    heure_fin: statut === 'terminee' ? `${rand(15,19)}:${rand(0,5)}0` : null,
    statut,
    nb_colis_prevu: prevus,
    nb_colis_livre: 0,   // recalculé après insertion tournee_colis
    nb_colis_echec: 0,
    km_parcourus: statut === 'terminee' ? Math.round(rand(20, 150) * 10) / 10 : null,
    note_livreur: statut === 'terminee' ? Math.round((3 + Math.random() * 2) * 10) / 10 : null,
  });
  const tourneeId = r.lastInsertRowid;
  tourneeIds.push(tourneeId);

  // Peupler tournee_colis avec de vrais colis de ce livreur
  if (statut !== 'planifiee' && statut !== 'annulee') {
    const disponibles = colisByLivreur.get(livreurId) ?? [];
    const selection = pickN(disponibles, Math.min(prevus, disponibles.length));
    let ordre = 1;
    let nbLivre = 0, nbEchec = 0;
    for (const c of selection) {
      const tcStatut = c.statut === 'livre' ? 'livre' : c.statut === 'echec' ? 'echec' : 'prevu';
      stmtTourneeColis.run({ id_tournee: tourneeId, id_colis: c.id, ordre: ordre++, statut: tcStatut });
      if (tcStatut === 'livre') nbLivre++;
      if (tcStatut === 'echec') nbEchec++;
    }
    // Mettre à jour les compteurs avec les vraies valeurs
    db.prepare('UPDATE tournee SET nb_colis_prevu=?, nb_colis_livre=?, nb_colis_echec=? WHERE id=?')
      .run(selection.length, nbLivre, nbEchec, tourneeId);
  }
}
console.log(`✓ ${tourneeIds.length} tournées`);

// Incidents (400)
const stmtIncident = db.prepare('INSERT INTO incident (id_colis, id_livreur, id_tournee, type, gravite, description, date_incident, resolu, date_resolution, commentaire_resolution, cout_estime) VALUES (@id_colis, @id_livreur, @id_tournee, @type, @gravite, @description, @date_incident, @resolu, @date_resolution, @commentaire_resolution, @cout_estime)');
const DESCRIPTIONS = {
  retard: 'Livraison retardée suite à un encombrement routier.',
  colis_endommage: 'Colis reçu avec des dommages visibles sur l\'emballage.',
  adresse_introuvable: 'Adresse non trouvée malgré plusieurs tentatives.',
  absent: 'Destinataire absent lors des 3 tentatives de livraison.',
  vol: 'Colis signalé manquant lors du chargement en dépôt.',
  accident: 'Accident de véhicule pendant la tournée.',
  autre: 'Incident divers signalé par le livreur.',
};
for (let i = 0; i < 400; i++) {
  const type = pick(TYPES_INCIDENT);
  const resolu = rand(0,2) > 0 ? 1 : 0;
  const dateIncident = dateOffset('2025-01-01', rand(0, 466));
  stmtIncident.run({
    id_colis: rand(0,3) > 0 ? pick(colisIds) : null,
    id_livreur: pick(livreurs),
    id_tournee: rand(0,1) ? pick(tourneeIds) : null,
    type,
    gravite: pick(GRAVITES),
    description: DESCRIPTIONS[type],
    date_incident: dateIncident,
    resolu,
    date_resolution: resolu ? dateOffset(dateIncident, rand(1, 14)) : null,
    commentaire_resolution: resolu ? 'Problème résolu après intervention du responsable.' : null,
    cout_estime: ['colis_endommage','vol','accident'].includes(type) ? rand(20, 2000) : null,
  });
}
console.log(`✓ 400 incidents`);

// Paiements (10000 dont ~500 pour Emma)
const stmtPaiement = db.prepare('INSERT INTO paiement (id_client, id_colis, montant, methode, statut, reference_transaction, date_paiement, date_validation) VALUES (@id_client, @id_colis, @montant, @methode, @statut, @reference_transaction, @date_paiement, @date_validation)');
const STATUTS_PAIEMENT = ['en_attente','valide','valide','valide','valide','rembourse','echec'];
const TOTAL_PAIEMENTS = 10000;
const EMMA_PAIEMENTS = 500;
for (let i = 0; i < TOTAL_PAIEMENTS; i++) {
  const isEmma = i < EMMA_PAIEMENTS;
  const statut = pick(STATUTS_PAIEMENT);
  const datePaiement = dateOffset('2025-01-01', rand(0, 466));
  stmtPaiement.run({
    id_client: isEmma ? emmaClientId : pick(clients),
    id_colis: rand(0,3) > 0 ? pick(colisIds) : null,
    montant: Math.round((3 + Math.random() * 97) * 100) / 100,
    methode: pick(METHODES_PAIEMENT),
    statut,
    reference_transaction: `TXN-${Date.now()}-${i}`,
    date_paiement: datePaiement,
    date_validation: ['valide','rembourse'].includes(statut) ? dateOffset(datePaiement, rand(0, 3)) : null,
  });
}
console.log(`✓ ${TOTAL_PAIEMENTS} paiements (dont ${EMMA_PAIEMENTS} pour Emma)`);

// Historique statuts — tous les colis d'Emma + échantillon des autres
const stmtHistorique = db.prepare('INSERT INTO historique_statut (id_colis, statut_precedent, statut_nouveau, date_changement, id_livreur, commentaire) VALUES (@id_colis, @statut_precedent, @statut_nouveau, @date_changement, @id_livreur, @commentaire)');
const CHAINE_STATUTS = [
  [null, 'en_attente'],
  ['en_attente', 'en_depot'],
  ['en_depot', 'en_cours'],
  ['en_cours', 'livre'],
  ['en_cours', 'echec'],
  ['echec', 'retour'],
];
// Tous les colis d'Emma (500) + 5000 autres
const emmaColisIds = colisIds.slice(0, EMMA_COLIS);
const autresColisIds = colisIds.slice(EMMA_COLIS, EMMA_COLIS + 5000);
const colisIdsSample = [...emmaColisIds, ...autresColisIds];
for (const idColis of colisIdsSample) {
  const nb = rand(1, 5);
  let date = dateOffset('2025-01-01', rand(0, 400));
  for (let j = 0; j < nb; j++) {
    const transition = pick(CHAINE_STATUTS);
    date = dateOffset(date, rand(0, 3));
    stmtHistorique.run({
      id_colis: idColis,
      statut_precedent: transition[0],
      statut_nouveau: transition[1],
      date_changement: date,
      id_livreur: rand(0,1) ? pick(livreurs) : null,
      commentaire: rand(0,4) === 0 ? 'Mise à jour automatique du statut' : null,
    });
  }
}
console.log(`✓ ~${2000 * 3} entrées historique`);

// Notifications (6000 dont ~500 pour Emma)
const stmtNotif = db.prepare('INSERT INTO notification (id_client, id_colis, type, sujet, message, date_envoi, lu, date_lecture) VALUES (@id_client, @id_colis, @type, @sujet, @message, @date_envoi, @lu, @date_lecture)');
const TYPES_NOTIF = ['sms','email','email','push'];
const SUJETS = ['Votre colis est en route', 'Livraison effectuée', 'Tentative de livraison échouée', 'Votre colis est disponible en dépôt', 'Confirmation de commande'];
const TOTAL_NOTIFS = 6000;
const EMMA_NOTIFS = 500;
for (let i = 0; i < TOTAL_NOTIFS; i++) {
  const isEmma = i < EMMA_NOTIFS;
  const lu = rand(0,2) > 0 ? 1 : 0;
  const dateEnvoi = dateOffset('2025-01-01', rand(0, 466));
  stmtNotif.run({
    id_client: isEmma ? emmaClientId : pick(clients),
    id_colis: rand(0,1) ? (isEmma ? pick(emmaColisIds) : pick(colisIds)) : null,
    type: pick(TYPES_NOTIF),
    sujet: pick(SUJETS),
    message: 'Bonjour, nous vous informons que votre colis est en cours de traitement.',
    date_envoi: dateEnvoi,
    lu,
    date_lecture: lu ? dateOffset(dateEnvoi, rand(0, 5)) : null,
  });
}
console.log(`✓ ${TOTAL_NOTIFS} notifications (dont ${EMMA_NOTIFS} pour Emma)`);

// Recalculer nb_livraisons_total depuis les vrais colis livrés
db.prepare(`
  UPDATE livreur SET nb_livraisons_total = (
    SELECT COUNT(*) FROM colis WHERE id_livreur = livreur.id AND statut = 'livre'
  )
`).run();
console.log('✓ nb_livraisons_total recalculé');

// Stats finales
const total = db.prepare("SELECT SUM(cnt) as total FROM (SELECT COUNT(*) as cnt FROM client UNION ALL SELECT COUNT(*) FROM livreur UNION ALL SELECT COUNT(*) FROM colis UNION ALL SELECT COUNT(*) FROM tournee UNION ALL SELECT COUNT(*) FROM incident UNION ALL SELECT COUNT(*) FROM paiement UNION ALL SELECT COUNT(*) FROM historique_statut UNION ALL SELECT COUNT(*) FROM notification)").get();
console.log(`\n✅ DB générée : ${total.total} lignes au total`);
console.log(`📁 ${DB_PATH}`);

db.close();
