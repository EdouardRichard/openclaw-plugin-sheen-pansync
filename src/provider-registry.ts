import type { CloudDriveProvider, ProviderId } from "./contracts.js";
import { PanSyncError } from "./errors.js";

export class ProviderRegistry {
  private readonly providersByAlias = new Map<string, CloudDriveProvider>();
  private readonly defaultProvider: CloudDriveProvider;

  constructor(providers: readonly CloudDriveProvider[], defaultProviderId: ProviderId) {
    for (const provider of providers) {
      for (const alias of provider.aliases) {
        const normalizedAlias = normalizeAlias(alias);
        if (this.providersByAlias.has(normalizedAlias)) {
          throw new Error("duplicate provider alias");
        }
        this.providersByAlias.set(normalizedAlias, provider);
      }
    }

    const defaultProvider = providers.find((provider) => provider.id === defaultProviderId);
    if (!defaultProvider) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
    this.defaultProvider = defaultProvider;
  }

  resolve(providerName: string | undefined): CloudDriveProvider {
    if (providerName === undefined) {
      return this.defaultProvider;
    }

    const provider = this.providersByAlias.get(normalizeAlias(providerName));
    if (!provider) {
      throw new PanSyncError("CREDENTIALS_INVALID");
    }
    return provider;
  }
}

function normalizeAlias(alias: string): string {
  return alias.toLocaleLowerCase("en-US");
}
