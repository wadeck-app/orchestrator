/** The packages the app-core shell shares with module bundles, keyed by package name. Set before a bundle is imported. */
declare global {
  // eslint-disable-next-line no-var
  var __APP_CORE_SHARED__: Record<string, unknown> | undefined;
}

export {};
