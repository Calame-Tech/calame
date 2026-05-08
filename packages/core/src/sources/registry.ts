import type { Capability, SourceAdapter } from './types.js';

export class SourceAdapterRegistry {
  private readonly adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    if (this.adapters.has(adapter.type)) {
      throw new Error(`SourceAdapterRegistry: adapter '${adapter.type}' is already registered`);
    }
    this.adapters.set(adapter.type, adapter);
  }

  unregister(type: string): boolean {
    return this.adapters.delete(type);
  }

  get(type: string): SourceAdapter | undefined {
    return this.adapters.get(type);
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }

  /** Returns adapters in insertion order. */
  list(): ReadonlyArray<SourceAdapter> {
    return Array.from(this.adapters.values());
  }

  listByCapability(cap: Capability): ReadonlyArray<SourceAdapter> {
    return Array.from(this.adapters.values()).filter((a) =>
      (a.capabilities as ReadonlyArray<string>).includes(cap),
    );
  }

  /**
   * Returns the adapter for `type` after verifying it declares `cap`.
   * Throws when the adapter is missing or does not declare the capability.
   * Prefer this over `get()` + manual capability check at call sites.
   */
  requireWithCapability<C extends Capability>(type: string, cap: C): SourceAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`SourceAdapterRegistry: adapter '${type}' is not registered`);
    }
    if (!(adapter.capabilities as ReadonlyArray<string>).includes(cap)) {
      throw new Error(
        `SourceAdapterRegistry: adapter '${type}' does not declare capability '${cap}'`,
      );
    }
    return adapter;
  }

  clear(): void {
    this.adapters.clear();
  }
}

export const sourceAdapterRegistry = new SourceAdapterRegistry();
