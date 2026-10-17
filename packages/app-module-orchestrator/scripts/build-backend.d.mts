/** Bundles the backend; resolves with the path of the file written. Defaults to api-backend/dist/backend.mjs. */
export function buildBackend(options?: { outfile?: string }): Promise<string>;
