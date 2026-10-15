/**
 * Knowledge-base source form ("+ Add source" → "Knowledge base") — the
 * secondary explanations are folded behind "?" help tips (same HelpTip as the
 * MCP view) while labels, actions and warnings stay visible.
 */
import { render as rtlRender, screen, fireEvent, within, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceForm } from '@calame-ee/rag-core/web';
import type { AiSettingOption } from '../../../../ee/rag-core/src/web/SourceForm.js';
import { I18nProvider } from '../i18n/I18nProvider.js';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nProvider });
}

const LOCAL: AiSettingOption = {
  name: 'local',
  label: 'Local',
  provider: 'local',
  capabilities: ['embeddings'],
  embeddingDimensions: 384,
  localModelAvailable: true,
};

const REMOTE: AiSettingOption = {
  name: 'openai',
  label: 'OpenAI',
  provider: 'openai',
  capabilities: ['embeddings'],
  embeddingModel: 'text-embedding-3-small',
};

function renderForm(props: Partial<React.ComponentProps<typeof SourceForm>> = {}) {
  render(<SourceForm onSave={vi.fn()} onCancel={vi.fn()} aiSettings={[LOCAL]} {...props} />);
}

const LOCAL_HELPS: Array<[string, RegExp]> = [
  ['Chemin absolu du dossier', /Le serveur doit pouvoir lire ce chemin/],
  ['Globs à inclure', /Vide = tout inclure/],
  ['Globs à exclure', /exclusions par défaut \(node_modules, \.git\)/],
  ['Inclure les fichiers cachés', /exclus par défaut/],
  ["Configuration d'embeddings", /Traitement 100 % local/],
  ['Intervalle de synchronisation auto', /La synchronisation manuelle reste toujours disponible/],
];

// rag-core strings follow the saved app locale; these assertions use French.
beforeEach(() => localStorage.setItem('calame-locale', 'fr'));

describe('SourceForm — collapsible "?" help', () => {
  it('folds the secondary explanations of the local-folder form behind "?" tips', () => {
    renderForm();

    for (const [, text] of LOCAL_HELPS) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    for (const [label] of LOCAL_HELPS) {
      const tip = screen.getByRole('button', { name: `Aide : ${label}` });
      expect(tip).toHaveAttribute('tabindex', '0');
      expect(tip).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('reveals each explanation from the keyboard and folds it back with Escape', () => {
    renderForm();

    for (const [label, text] of LOCAL_HELPS) {
      const tip = screen.getByRole('button', { name: `Aide : ${label}` });
      fireEvent.keyDown(tip, { key: 'Enter' });
      expect(screen.getByRole('tooltip')).toHaveTextContent(text);
      expect(tip).toHaveAttribute('aria-expanded', 'true');
      fireEvent.keyDown(tip, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    }
  });

  it('reveals the folder path explanation on mouse hover too', () => {
    vi.useFakeTimers();
    try {
      renderForm();
      const tip = screen.getByRole('button', { name: 'Aide : Chemin absolu du dossier' });
      fireEvent.mouseEnter(tip);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        /Le serveur doit pouvoir lire ce chemin/,
      );
      fireEvent.mouseLeave(tip);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps labels, field controls and actions visible', () => {
    renderForm();

    expect(screen.getByLabelText(/^Nom de la source/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Type/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Chemin absolu du dossier/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Globs à inclure/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Globs à exclure/)).toBeInTheDocument();
    expect(screen.getByLabelText('Inclure les fichiers cachés')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Configuration d'embeddings/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Intervalle de synchronisation auto/)).toBeInTheDocument();
    for (const action of ['Parcourir…', 'Tester', 'Enregistrer', 'Annuler', 'Fermer']) {
      expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
    }
    // Short model facts stay inline next to the selector.
    expect(screen.getByText(/Dimensions/)).toBeInTheDocument();
  });

  it('clicking the "?" of the hidden-files checkbox does not tick it', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Aide : Inclure les fichiers cachés' }));
    expect(screen.getByLabelText('Inclure les fichiers cachés')).not.toBeChecked();
    expect(screen.getByRole('tooltip')).toHaveTextContent(/50 Mo/);
  });

  it('keeps warnings visible: remote provider data notice and missing embeddings support', () => {
    renderForm({ aiSettings: [REMOTE], initial: { embeddingSettingName: 'openai' } });
    expect(
      screen.getByText(/Les documents et les requêtes de recherche sont envoyés à ce fournisseur/),
    ).toBeVisible();
    // No "?" on the embeddings label: the remote notice is not secondary.
    expect(
      screen.queryByRole('button', { name: "Aide : Configuration d'embeddings" }),
    ).not.toBeInTheDocument();
  });

  it('keeps the no-embeddings warning visible', () => {
    renderForm({ aiSettings: [{ name: 'chat', label: 'Chat', capabilities: ['chat'] }] });
    expect(
      screen.getByText(/Aucune configuration IA disponible ne supporte les embeddings/),
    ).toBeVisible();
  });

  it('keeps the edit-mode constraints visible when editing an S3 source', () => {
    renderForm({
      initial: {
        id: 'src_1',
        name: 'Bucket',
        type: 's3',
        config: { bucket: 'b', region: 'eu-west-1', accessKeyId: 'AKIA' },
        embeddingSettingName: 'local',
      },
    });
    expect(
      screen.getByText("Le type d'une source ne peut pas être modifié après création."),
    ).toBeVisible();
    expect(screen.getByText('Laissez vide pour conserver la clé existante.')).toBeVisible();
    expect(screen.queryByText("Utilisez 'auto' pour Cloudflare R2.")).not.toBeInTheDocument();
    const region = screen.getByRole('button', { name: 'Aide : Région' });
    fireEvent.click(region);
    expect(within(document.body).getByRole('tooltip')).toHaveTextContent(
      "Utilisez 'auto' pour Cloudflare R2.",
    );
  });
});

describe('SourceForm — English locale', () => {
  it('renders the knowledge-base source labels in English', () => {
    localStorage.setItem('calame-locale', 'en');
    renderForm();
    expect(screen.getByText('New source')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Absolute folder path/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByText('Enregistrer')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Source name/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Local (folder)' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Automatic sync interval/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Every hour' })).toBeInTheDocument();
    expect(screen.queryByText('Toutes les heures')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByLabelText('Include hidden files')).toBeInTheDocument();
  });
});
