/**
 * Public model catalog for the OpenAI-compatible surface.
 *
 * Suno's `mv` value is intentionally kept separate from the public model id:
 * clients can use the stable `suno-music` alias while the provider receives
 * the concrete `chirp-fenix` value. Unknown ids remain pass-through compatible
 * so newer Suno model versions can be used before this catalog is updated.
 */

export const DEFAULT_OPENAI_MODEL: string = 'suno-music';
export const DEFAULT_SUNO_MODEL: string = 'chirp-fenix';

export type SunoModelStatus = 'current' | 'stable' | 'legacy';

export type SunoModelDefinition = {
  id: string;
  providerModel: string;
  label: string;
  description: string;
  status: SunoModelStatus;
  recommended: boolean;
  capabilities: readonly string[];
  aliasOf?: string;
};

export const SUNO_MODEL_CATALOG = [
  {
    id: 'suno-music',
    providerModel: DEFAULT_SUNO_MODEL,
    label: 'Suno Music (Latest)',
    description: 'Recommended OpenAI-compatible alias for the latest Suno music model.',
    status: 'current',
    recommended: true,
    capabilities: ['music'],
    aliasOf: DEFAULT_SUNO_MODEL,
  },
  {
    id: 'suno-v5.5',
    providerModel: 'chirp-fenix',
    label: 'Suno V5.5',
    description: 'Latest Suno model with improved expression and personalization.',
    status: 'current',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-fenix',
  },
  {
    id: 'suno-v5',
    providerModel: 'chirp-crow',
    label: 'Suno V5',
    description: 'Previous-generation Suno V5 music model.',
    status: 'stable',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-crow',
  },
  {
    id: 'suno-v4.5+',
    providerModel: 'chirp-bluejay',
    label: 'Suno V4.5+',
    description: 'Enhanced V4.5 generation model.',
    status: 'stable',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-bluejay',
  },
  {
    id: 'suno-v4.5',
    providerModel: 'chirp-auk',
    label: 'Suno V4.5',
    description: 'Stable V4.5 generation model.',
    status: 'stable',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-auk',
  },
  {
    id: 'suno-v4',
    providerModel: 'chirp-v4',
    label: 'Suno V4',
    description: 'Legacy V4 generation model.',
    status: 'legacy',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-v4',
  },
  {
    id: 'suno-v3.5',
    providerModel: 'chirp-v3-5',
    label: 'Suno V3.5',
    description: 'Legacy V3.5 generation model.',
    status: 'legacy',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-v3-5',
  },
  {
    id: 'suno-v3',
    providerModel: 'chirp-v3-0',
    label: 'Suno V3',
    description: 'Legacy V3 generation model.',
    status: 'legacy',
    recommended: false,
    capabilities: ['music'],
    aliasOf: 'chirp-v3-0',
  },
] as const satisfies readonly SunoModelDefinition[];

const catalogById = new Map<string, SunoModelDefinition>(
  SUNO_MODEL_CATALOG.map((model) => [model.id, model]),
);

/** Return the public model id, defaulting to the stable compatibility alias. */
export function resolveOpenAIModel(model: unknown): string {
  if (typeof model !== 'string') return DEFAULT_OPENAI_MODEL;
  const value = model.trim();
  return value || DEFAULT_OPENAI_MODEL;
}

/** Resolve a public id to the provider's `mv` value without blocking new ids. */
export function resolveSunoProviderModel(model: unknown): string {
  if (typeof model !== 'string') return DEFAULT_SUNO_MODEL;
  const value = model.trim();
  if (!value) return DEFAULT_SUNO_MODEL;
  return catalogById.get(value)?.providerModel || value;
}

export function getSunoModelDefinition(modelId: string): SunoModelDefinition | undefined {
  return catalogById.get(modelId);
}

export type OpenAIModelRecord = {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'suno-api';
  capabilities: readonly string[];
  metadata: {
    provider: 'suno';
    provider_model: string;
    label: string;
    description: string;
    status: SunoModelStatus;
    recommended: boolean;
    alias_of?: string;
  };
};

export function toOpenAIModelRecord(
  definition: SunoModelDefinition,
  created: number,
): OpenAIModelRecord {
  return {
    id: definition.id,
    object: 'model',
    created,
    owned_by: 'suno-api',
    capabilities: definition.capabilities,
    metadata: {
      provider: 'suno',
      provider_model: definition.providerModel,
      label: definition.label,
      description: definition.description,
      status: definition.status,
      recommended: definition.recommended,
      ...(definition.aliasOf ? { alias_of: definition.aliasOf } : {}),
    },
  };
}

export function listOpenAIModelRecords(created: number): OpenAIModelRecord[] {
  return SUNO_MODEL_CATALOG.map((definition) => toOpenAIModelRecord(definition, created));
}
