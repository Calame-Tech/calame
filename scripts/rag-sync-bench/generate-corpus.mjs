#!/usr/bin/env node
/**
 * Deterministic synthetic corpus for the RAG sync benchmark (see README.md
 * next to this file). Same `--seed` + `--docs` → byte-identical files, so a
 * "before" and an "after" run index exactly the same corpus. No private data:
 * every word comes from the fixed generic vocabulary below.
 *
 * Layout written under `<out>`:
 *   corpus/          the folder the benchmark source points at
 *   manifest.json    what was generated (sizes, formats, defects)
 *
 * The corpus mixes Markdown, plain text, DOCX, HTML, CSV and PDF documents of
 * log-distributed sizes in nested folders whose names carry spaces and
 * accents (as on a Windows "Documents" share), plus a fixed set of defective
 * files: corrupt / truncated / empty DOCX, a Word owner file `~$*.docx`, a
 * file over the size cap, an empty file, a fake PDF and unsupported formats.
 *
 * Usage:
 *   node scripts/rag-sync-bench/generate-corpus.mjs --out <dir> [--docs 1000] [--seed 42]
 *
 * Also imported by run-bench.mjs (generateCorpus / mutateCorpus).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** Per-file cap the benchmark source is configured with (`maxFileSizeBytes`). */
export const BENCH_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Fixed timestamp stamped on every generated file (reproducible etags). */
const FIXED_MTIME = new Date('2026-01-15T09:00:00Z');

// ---------------------------------------------------------------------------
// Deterministic randomness + generic text
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'projet réunion client équipe budget planning livrable contrat facture devis ' +
  'analyse rapport synthèse objectif résultat indicateur trimestre année mois semaine ' +
  'processus procédure qualité sécurité conformité audit risque contrôle validation ' +
  'document version annexe chapitre section tableau graphique donnée fichier dossier ' +
  'service direction département pôle site agence région siège partenaire fournisseur ' +
  'commande livraison stock produit gamme référence tarif remise marge chiffre vente ' +
  'formation compétence recrutement entretien évaluation mission poste salarié contrat ' +
  'maintenance intervention incident ticket demande support utilisateur accès compte ' +
  'serveur réseau application logiciel module fonction paramètre configuration mise ' +
  'jour déploiement test recette production environnement sauvegarde restauration ' +
  'le la les un une des du de et ou mais donc pour par avec sans dans sur sous entre ' +
  'est sont a ont doit peut sera seront été être avoir fait faire prévoir valider ' +
  'suivre mettre préparer envoyer transmettre recevoir confirmer vérifier corriger ' +
  'nouveau prochain dernier premier principal important urgent prioritaire complet ' +
  'partiel global local national interne externe technique commercial financier ' +
  'juridique administratif opérationnel stratégique mensuel annuel hebdomadaire'
).split(/\s+/);

function makeText(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const word = () => pick(WORDS);
  const sentence = () => {
    const n = 8 + Math.floor(rand() * 13);
    const w = Array.from({ length: n }, word);
    w[0] = w[0].charAt(0).toUpperCase() + w[0].slice(1);
    return `${w.join(' ')}.`;
  };
  const paragraph = () => Array.from({ length: 3 + Math.floor(rand() * 5) }, sentence).join(' ');
  const title = () => {
    const t = Array.from({ length: 2 + Math.floor(rand() * 4) }, word).join(' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  /** Sections (title + paragraphs) until roughly `bytes` of text. */
  const sections = (bytes) => {
    const out = [];
    let size = 0;
    while (size < bytes) {
      const paras = [];
      for (let i = 0; i < 1 + Math.floor(rand() * 4) && size < bytes; i++) {
        const p = paragraph();
        paras.push(p);
        size += p.length + 2;
      }
      const t = title();
      size += t.length + 4;
      out.push({ title: t, paragraphs: paras });
    }
    return out;
  };
  return { word, sentence, paragraph, title, sections };
}

/** Log-distributed target text size: mostly small, a long tail of big files. */
function pickSize(rand) {
  const r = rand();
  const between = (lo, hi) => Math.round(lo * Math.pow(hi / lo, rand()));
  if (r < 0.55) return between(300, 4_000);
  if (r < 0.85) return between(4_000, 16_000);
  if (r < 0.98) return between(16_000, 64_000);
  return between(64_000, 200_000);
}

const FORMATS = [
  ['md', 0.35],
  ['txt', 0.2],
  ['docx', 0.25],
  ['html', 0.1],
  ['csv', 0.05],
  ['pdf', 0.05],
];

function pickFormat(rand) {
  let r = rand();
  for (const [fmt, w] of FORMATS) {
    if (r < w) return fmt;
    r -= w;
  }
  return 'md';
}

const FOLDERS = [
  'Comptes rendus',
  'Comptes rendus/Été 2025',
  'Comptes rendus/Hiver 2025-2026',
  'Projets',
  'Projets/Client A',
  'Projets/Client A/Livrables',
  'Projets/Client B',
  'Projets/Client B/Réunions de suivi',
  'Projets/Interne',
  'Qualité',
  'Qualité/Procédures',
  'Qualité/Audits 2025',
  'Ressources humaines',
  'Ressources humaines/Formations',
  'Commercial',
  'Commercial/Devis et propositions',
  'Commercial/Contrats signés',
  'Technique',
  'Technique/Documentation',
  'Technique/Incidents',
  'Archives',
  'Archives/2024',
  'Archives/2024/Trimestre 4',
  'Divers',
];

// ---------------------------------------------------------------------------
// Format writers
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate, UTF-8 names, fixed DOS timestamp). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x4800, 10); // 09:00
    local.writeUInt16LE(0x5c2f, 12); // 2026-01-15
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x4800, 12);
    central.writeUInt16LE(0x5c2f, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function docx(sections, { withDocument = true } = {}) {
  const para = (text, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  const body = sections
    .map((s) => para(s.title, 'Heading1') + s.paragraphs.map((p) => para(p)).join(''))
    .join('');
  const entries = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
  ];
  if (withDocument) {
    entries.push({
      name: 'word/document.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}</w:body></w:document>`,
    });
  }
  return zip(entries);
}

/** Minimal valid PDF (Helvetica, ~45 lines per page, ASCII-folded text). */
function pdf(sections) {
  const ascii = (s) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7e]/g, ' ')
      .replace(/([\\()])/g, '\\$1');
  const lines = [];
  for (const s of sections) {
    lines.push(s.title);
    for (const p of s.paragraphs) {
      const words = p.split(' ');
      let cur = '';
      for (const w of words) {
        if (cur.length + w.length > 90) {
          lines.push(cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) lines.push(cur);
    }
  }
  const pages = [];
  for (let i = 0; i < lines.length; i += 45) pages.push(lines.slice(i, i + 45));
  if (pages.length === 0) pages.push(['']);

  const objects = [];
  const fontId = 3;
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((pageLines, i) => {
    const content =
      'BT /F1 10 Tf 50 800 Td 14 TL ' +
      pageLines.map((l) => `(${ascii(l)}) Tj T*`).join(' ') +
      ' ET';
    objects[pageIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`;
    objects[pageIds[i] + 1] =
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function render(fmt, sections, rand, text) {
  switch (fmt) {
    case 'md':
      return Buffer.from(
        sections.map((s) => `## ${s.title}\n\n${s.paragraphs.join('\n\n')}\n`).join('\n'),
      );
    case 'txt':
      return Buffer.from(
        sections
          .map((s) => `${s.title.toUpperCase()}\n\n${s.paragraphs.join('\n\n')}\n`)
          .join('\n'),
      );
    case 'html':
      return Buffer.from(
        `<!doctype html><html><head><meta charset="utf-8"><title>${xmlEscape(sections[0].title)}</title></head><body>` +
          sections
            .map(
              (s) =>
                `<h2>${xmlEscape(s.title)}</h2>` +
                s.paragraphs.map((p) => `<p>${xmlEscape(p)}</p>`).join(''),
            )
            .join('') +
          '</body></html>',
      );
    case 'csv': {
      const target = sections.reduce((n, s) => n + s.paragraphs.join('').length, 0);
      const rows = ['reference;libelle;quantite;montant;commentaire'];
      let size = 0;
      for (let i = 1; size < target; i++) {
        const row = `REF-${String(i).padStart(5, '0')};${text.word()} ${text.word()};${1 + Math.floor(rand() * 500)};${(rand() * 10000).toFixed(2)};${text.sentence()}`;
        rows.push(row);
        size += row.length;
      }
      return Buffer.from(`${rows.join('\n')}\n`);
    }
    case 'docx':
      return docx(sections);
    case 'pdf':
      return pdf(sections);
    default:
      throw new Error(`unknown format ${fmt}`);
  }
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function writeFile(root, rel, buf) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  fs.utimesSync(abs, FIXED_MTIME, FIXED_MTIME);
}

/**
 * Generate the corpus. Returns the manifest (also written to
 * `<out>/manifest.json`). The output directory is wiped first.
 */
export function generateCorpus({ out, docs = 1000, seed = 42 }) {
  const root = path.join(out, 'corpus');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const rand = mulberry32(seed);
  const text = makeText(rand);

  const files = [];
  const byFormat = {};
  let totalBytes = 0;
  for (let i = 0; i < docs; i++) {
    const fmt = pickFormat(rand);
    const folder = FOLDERS[Math.floor(rand() * FOLDERS.length)];
    const name = `${text.title()} ${String(i + 1).padStart(5, '0')}.${fmt}`;
    const rel = `${folder}/${name}`;
    const buf = render(fmt, text.sections(pickSize(rand)), rand, text);
    writeFile(root, rel, buf);
    files.push({ path: rel, format: fmt, bytes: buf.length });
    byFormat[fmt] = (byFormat[fmt] ?? 0) + 1;
    totalBytes += buf.length;
  }

  // Large but valid DOCX (well under the cap, many chunks).
  const big = docx(text.sections(400_000));
  writeFile(root, 'Archives/Gros document de synthèse.docx', big);
  files.push({
    path: 'Archives/Gros document de synthèse.docx',
    format: 'docx',
    bytes: big.length,
  });
  totalBytes += big.length;

  // Defective / special cases, each with the outcome the sync should report.
  const valid = docx(text.sections(6_000));
  const defects = [
    [
      'Divers/Rapport corrompu.docx',
      Buffer.from(Array.from({ length: 40_000 }, () => Math.floor(rand() * 256))),
      'rejected: corrupt DOCX',
    ],
    [
      'Divers/Contrat tronqué.docx',
      valid.subarray(0, Math.floor(valid.length * 0.6)),
      'rejected: truncated DOCX',
    ],
    [
      'Divers/Sans contenu Word.docx',
      docx([], { withDocument: false }),
      'rejected: DOCX without word/document.xml',
    ],
    ['Divers/~$Rapport annuel.docx', Buffer.alloc(162, 0x20), 'ignored: Word owner/lock file'],
    [
      'Divers/Export complet.txt',
      Buffer.alloc(BENCH_MAX_FILE_BYTES + 1024 * 1024, 0x61),
      'rejected: over the size cap',
    ],
    ['Divers/Note vide.md', Buffer.alloc(0), 'indexed with no chunk (empty)'],
    [
      'Divers/Scan illisible.pdf',
      Buffer.concat([
        Buffer.from('%PDF-1.4\n'),
        Buffer.from(Array.from({ length: 20_000 }, () => Math.floor(rand() * 256))),
      ]),
      'rejected: corrupt PDF',
    ],
    [
      'Divers/Données brutes.bin',
      Buffer.from(Array.from({ length: 4_096 }, () => Math.floor(rand() * 256))),
      'rejected: unsupported format',
    ],
    [
      'Divers/Présentation client.pptx',
      Buffer.from(Array.from({ length: 8_192 }, () => Math.floor(rand() * 256))),
      'rejected: unsupported format',
    ],
  ];
  for (const [rel, buf, expected] of defects) {
    writeFile(root, rel, buf);
    files.push({
      path: rel,
      format: path.extname(rel).slice(1),
      bytes: buf.length,
      defect: expected,
    });
    totalBytes += buf.length;
  }

  const manifest = {
    seed,
    docs,
    files: files.length,
    totalBytes,
    byFormat,
    defects: defects.map(([rel, , expected]) => ({ path: rel, expected })),
    list: files,
  };
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Deterministic partial update applied between the "unchanged" and the
 * "partial" scenarios: edit 5 % of the regular documents (content + mtime
 * change), touch 2 % (mtime only — the content hash must short-circuit),
 * add 1 % new files and delete 1 %.
 */
export function mutateCorpus({ out, seed = 42 }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const root = path.join(out, 'corpus');
  const rand = mulberry32(seed ^ 0x5eed);
  const text = makeText(rand);
  const regular = manifest.list.filter((f) => !f.defect && f.bytes < 300_000);
  const shuffled = [...regular];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const n = (pct) => Math.max(1, Math.round(regular.length * pct));
  const edited = shuffled.splice(0, n(0.05));
  const touched = shuffled.splice(0, n(0.02));
  const deleted = shuffled.splice(0, n(0.01));
  const later = new Date(FIXED_MTIME.getTime() + 86_400_000);

  for (const f of edited) {
    const sections = text.sections(Math.max(500, Math.min(f.bytes, 16_000)));
    const abs = path.join(root, ...f.path.split('/'));
    fs.writeFileSync(abs, render(f.format, sections, rand, text));
    fs.utimesSync(abs, later, later);
  }
  for (const f of touched) {
    const abs = path.join(root, ...f.path.split('/'));
    fs.utimesSync(abs, later, later);
  }
  for (const f of deleted) fs.rmSync(path.join(root, ...f.path.split('/')));
  const added = [];
  for (let i = 0; i < n(0.01); i++) {
    const rel = `Projets/Nouveaux/${text.title()} nouveau ${i + 1}.md`;
    writeFile(root, rel, render('md', text.sections(3_000), rand, text));
    added.push(rel);
  }
  return {
    edited: edited.length,
    touched: touched.length,
    deleted: deleted.length,
    added: added.length,
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

// The basename check keeps this from firing once bundled into bench-runner.
const self = path.resolve(fileURLToPath(import.meta.url));
if (path.basename(self) === 'generate-corpus.mjs' && self === path.resolve(process.argv[1] ?? '')) {
  const out = arg('out');
  if (!out) {
    console.error('usage: generate-corpus.mjs --out <dir> [--docs 1000] [--seed 42]');
    process.exit(2);
  }
  const m = generateCorpus({
    out: path.resolve(out),
    docs: Number(arg('docs', '1000')),
    seed: Number(arg('seed', '42')),
  });
  console.log(
    `Generated ${m.files} files (${(m.totalBytes / 1024 / 1024).toFixed(1)} MB) under ${path.join(path.resolve(out), 'corpus')}`,
  );
  console.log(JSON.stringify(m.byFormat));
}
