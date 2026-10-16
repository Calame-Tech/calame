// Guided step from a data configuration to an MCP server (CALAME-6).

import { useState } from 'react';
import { useTranslations } from 'use-intl/react';
import { Button } from './ui/index.js';
import type { Profile } from '../types/schema.js';

/**
 * Next step once a configuration has sources: create a server with it, or
 * open an existing server to attach it. Both only navigate — the server is
 * created / the configuration attached on an explicit action over there.
 */
export default function McpNextStepCard({
  profiles,
  onCreateMcp,
  onAttachMcp,
}: {
  profiles: Profile[];
  onCreateMcp: () => void;
  onAttachMcp: (profileName: string) => void;
}) {
  const t = useTranslations('configurationDetail.nextStep');
  const [picked, setPicked] = useState('');
  const target = profiles.some((p) => p.name === picked) ? picked : (profiles[0]?.name ?? '');
  return (
    <div className="card-primary p-4 mb-4 space-y-3" data-testid="config-next-step">
      <p className="text-sm text-gray-300">{t('description')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onCreateMcp}>
          {t('createMcp')}
        </Button>
        {profiles.length > 0 && (
          <>
            <select
              aria-label={t('attachLabel')}
              value={target}
              onChange={(e) => setPicked(e.target.value)}
              className="input-editorial text-sm"
            >
              {profiles.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.label || p.name}
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => target && onAttachMcp(target)}>
              {t('attachMcp')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
