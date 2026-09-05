import { createAccountAffinity } from '@/lib/account-affinity';
import type { AccountView } from '@/lib/account-pool';

export function addAccountAffinity<T>(
  value: T,
  account: AccountView | null,
): { value: T; affinity?: string } {
  if (!account) return { value };
  const affinity = createAccountAffinity(account.id);
  if (Array.isArray(value)) {
    return {
      value: value.map((item) => (
        item && typeof item === 'object'
          ? { ...item, account_affinity: affinity }
          : item
      )) as T,
      affinity,
    };
  }
  if (value && typeof value === 'object') {
    return { value: { ...value, account_affinity: affinity } as T, affinity };
  }
  return { value, affinity };
}

export function affinityResponseHeaders(affinity?: string): Record<string, string> {
  return affinity ? { 'X-Suno-Account-Affinity': affinity } : {};
}
