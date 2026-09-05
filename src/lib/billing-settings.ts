import { promises as fs } from 'fs';
import path from 'node:path';

export type BillingSettings = {
  purchaseCostCny: number;
  purchasedCredits: number;
  creditsPerGeneration: number;
  outputsPerGeneration: number;
  rateMultiplier: number;
  cnyPerUsd: number;
  updatedAt?: string;
};

export type BillingSummary = {
  costPerCreditCny: number;
  costPerGenerationCny: number;
  costPerOutputCny: number;
  billingPointsPerGeneration: number;
  totalBillablePoints: number;
  generationsPerPackage: number;
  outputsPerPackage: number;
  referencePackageValueCny: number;
  referenceGenerationValueCny: number;
  grossMarginPercent: number;
  sub2apiPerRequestPriceUsd: number;
  sub2apiEffectivePriceUsd: number;
};

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  purchaseCostCny: 120,
  purchasedCredits: 2500,
  creditsPerGeneration: 10,
  outputsPerGeneration: 2,
  rateMultiplier: 1,
  cnyPerUsd: 1,
};

const NUMERIC_FIELDS = [
  'purchaseCostCny',
  'purchasedCredits',
  'creditsPerGeneration',
  'outputsPerGeneration',
  'rateMultiplier',
  'cnyPerUsd',
] as const;

type NumericBillingField = (typeof NUMERIC_FIELDS)[number];

const FIELD_LABELS: Record<NumericBillingField, string> = {
  purchaseCostCny: '套餐成本',
  purchasedCredits: '套餐积分',
  creditsPerGeneration: '每次生成消耗积分',
  outputsPerGeneration: '每次生成产出数量',
  rateMultiplier: '计费倍率',
  cnyPerUsd: '余额换算比例',
};

export class BillingSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingSettingsValidationError';
  }
}

function settingsPath() {
  const dataPath = process.env.ACCOUNT_DATA_PATH || path.join(process.cwd(), 'data', 'accounts.json');
  return path.join(path.dirname(dataPath), 'billing-settings.json');
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validatePositiveNumber(field: NumericBillingField, value: unknown): number {
  if (!isPositiveFiniteNumber(value)) {
    throw new BillingSettingsValidationError(`${FIELD_LABELS[field]}必须是大于 0 的有限数字。`);
  }
  return value;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function validateSummary(summary: BillingSummary) {
  for (const [key, value] of Object.entries(summary)) {
    if (!Number.isFinite(value)) {
      throw new BillingSettingsValidationError(`计费设置导致 ${key} 超出有效数字范围。`);
    }
  }
}

export function calculateBillingSummary(settings: BillingSettings): BillingSummary {
  const costPerCreditCny = settings.purchaseCostCny / settings.purchasedCredits;
  const costPerGenerationCny = costPerCreditCny * settings.creditsPerGeneration;
  const costPerOutputCny = costPerGenerationCny / settings.outputsPerGeneration;
  const generationsPerPackage = Math.floor(
    settings.purchasedCredits / settings.creditsPerGeneration,
  );
  const referencePackageValueCny = settings.purchaseCostCny * settings.rateMultiplier;
  const referenceGenerationValueCny = costPerGenerationCny * settings.rateMultiplier;

  const summary: BillingSummary = {
    costPerCreditCny: round(costPerCreditCny),
    costPerGenerationCny: round(costPerGenerationCny),
    costPerOutputCny: round(costPerOutputCny),
    billingPointsPerGeneration: round(settings.creditsPerGeneration * settings.rateMultiplier),
    totalBillablePoints: round(settings.purchasedCredits * settings.rateMultiplier),
    generationsPerPackage,
    outputsPerPackage: round(generationsPerPackage * settings.outputsPerGeneration),
    referencePackageValueCny: round(referencePackageValueCny),
    referenceGenerationValueCny: round(referenceGenerationValueCny),
    grossMarginPercent: round(
      ((referencePackageValueCny - settings.purchaseCostCny) / referencePackageValueCny) * 100,
    ),
    sub2apiPerRequestPriceUsd: round(costPerGenerationCny / settings.cnyPerUsd),
    sub2apiEffectivePriceUsd: round(referenceGenerationValueCny / settings.cnyPerUsd),
  };

  validateSummary(summary);
  return summary;
}

function settingsFromFile(input: unknown): BillingSettings {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const settings: BillingSettings = { ...DEFAULT_BILLING_SETTINGS };

  for (const field of NUMERIC_FIELDS) {
    if (isPositiveFiniteNumber(source[field])) settings[field] = source[field];
  }
  if (typeof source.updatedAt === 'string') settings.updatedAt = source.updatedAt;
  return settings;
}

let cached: BillingSettings | null = null;
let loaded = false;

export async function loadBillingSettings(force = false): Promise<BillingSettings> {
  if (loaded && cached && !force) return cached;

  let settings = { ...DEFAULT_BILLING_SETTINGS };
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    settings = settingsFromFile(JSON.parse(raw));
  } catch {
    // Defaults are used until the first successful save.
  }

  calculateBillingSummary(settings);
  cached = settings;
  loaded = true;
  return settings;
}

export async function saveBillingSettings(
  input: Partial<BillingSettings>,
): Promise<BillingSettings> {
  const current = await loadBillingSettings(true);
  const next: BillingSettings = { ...current };

  for (const field of NUMERIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      next[field] = validatePositiveNumber(field, input[field]);
    }
  }
  next.updatedAt = new Date().toISOString();

  calculateBillingSummary(next);
  const file = settingsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8');
  cached = next;
  loaded = true;
  return next;
}

export async function getBillingSnapshot(force = false) {
  const settings = await loadBillingSettings(force);
  return {
    settings,
    summary: calculateBillingSummary(settings),
  };
}
