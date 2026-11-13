// What Temper knows about each model provider: TrueForge type, default endpoint, and how to LIST models
// (discovery only; Temper never calls a provider for inference). No vscode imports.

export interface DiscoveredModel {
  id: string;
  context?: number;
  maxOutput?: number;
  /** false = known not to support tool calls; undefined = unknown (never disqualifies). */
  tools?: boolean;
}

/** How a provider's list-models endpoint is shaped. */
export type ListStyle = 'openai' | 'anthropic' | 'gemini' | 'openrouter';

export interface ProviderDef {
  /** Key used by the UI and the add flow. */
  id: string;
  label: string;
  /** TrueForge manifest type. */
  type: string;
  kind: 'catalog' | 'custom';
  /** TrueForge provider name: equals `type` for catalog providers; the manifest `name` for custom ones. */
  name: string;
  /** Default API base URL (custom providers send it as `base_url`). */
  baseUrl?: string;
  /** The user must be asked for a base URL (generic OpenAI-compatible). */
  askBaseUrl?: boolean;
  /** The server may run without a key (Ollama, LM Studio). */
  keyOptional?: boolean;
  /** Base URL used only for model discovery when the manifest sends none (catalog providers). */
  listBase?: string;
  list: ListStyle;
  /** Where to get a key; shown in the key prompt. */
  keyHint?: string;
}

/** Providers with built-in TrueForge catalog support. */
export const CATALOG_PROVIDERS: ProviderDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai',
    kind: 'catalog',
    name: 'openai',
    listBase: 'https://api.openai.com/v1',
    list: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    kind: 'catalog',
    name: 'anthropic',
    listBase: 'https://api.anthropic.com/v1',
    list: 'anthropic',
  },
  {
    id: 'google-gemini',
    label: 'Google Gemini',
    type: 'google-gemini',
    kind: 'catalog',
    name: 'google-gemini',
    listBase: 'https://generativelanguage.googleapis.com/v1beta',
    list: 'gemini',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    type: 'fireworks',
    kind: 'catalog',
    name: 'fireworks',
    listBase: 'https://api.fireworks.ai/inference/v1',
    list: 'openai',
  },
  {
    id: 'together',
    label: 'Together AI',
    type: 'together',
    kind: 'catalog',
    name: 'together',
    listBase: 'https://api.together.xyz/v1',
    list: 'openai',
  },
  {
    id: 'moonshot',
    label: 'Moonshot AI',
    type: 'moonshot',
    kind: 'catalog',
    name: 'moonshot',
    listBase: 'https://api.moonshot.ai/v1',
    list: 'openai',
  },
  {
    id: 'zai',
    label: 'Z.ai',
    type: 'zai',
    kind: 'catalog',
    name: 'zai',
    listBase: 'https://api.z.ai/api/paas/v4',
    list: 'openai',
  },
  {
    id: 'alibaba',
    label: 'Alibaba Cloud (Qwen)',
    type: 'alibaba',
    kind: 'catalog',
    name: 'alibaba',
    listBase: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    list: 'openai',
  },
];

/** OpenAI-compatible presets (TrueForge type `custom`). */
export const COMPATIBLE_PRESETS: ProviderDef[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'custom',
    kind: 'custom',
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    list: 'openrouter',
  },
  {
    id: 'groq',
    label: 'Groq',
    type: 'custom',
    kind: 'custom',
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    list: 'openai',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    type: 'custom',
    kind: 'custom',
    name: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyOptional: true,
    list: 'openai',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    type: 'custom',
    kind: 'custom',
    name: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyOptional: true,
    list: 'openai',
  },
  {
    id: 'compatible',
    label: 'Other OpenAI-compatible endpoint (gateway, vLLM, ...)',
    type: 'custom',
    kind: 'custom',
    name: '',
    askBaseUrl: true,
    keyOptional: true,
    list: 'openai',
  },
];

export const ALL_PROVIDER_DEFS: ProviderDef[] = [...CATALOG_PROVIDERS, ...COMPATIBLE_PRESETS];

export function findDef(id: string): ProviderDef | undefined {
  return ALL_PROVIDER_DEFS.find((d) => d.id === id);
}

/** The def that describes an existing TrueForge provider (by name); custom ones fall back to the generic def. */
export function defForConfigured(name: string, type: string): ProviderDef {
  const known = ALL_PROVIDER_DEFS.find((d) => d.name === name && d.type === type);
  if (known) return known;
  const generic = COMPATIBLE_PRESETS.find((d) => d.id === 'compatible')!;
  return { ...generic, name, label: name };
}
