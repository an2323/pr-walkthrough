/**
 * schema.ts — Zod-based schema validation for WalkthroughDraft.
 */

import { WalkthroughSchema } from "@pr-walkthrough/shared";

export interface SchemaResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate an unknown value against the Walkthrough schema (minus hunks/coverage,
 * which the backend fills in). We use the full WalkthroughSchema but allow
 * hunks to be missing by running safeParse on the full schema — the draft must
 * pass all fields except the backend-injected ones.
 *
 * The WalkthroughSchema already marks `coverage` as optional.
 * We accept a draft that may or may not include `hunks`; the schema requires it,
 * so we inject an empty array placeholder if missing to avoid a false negative
 * — the real hunks are always provided by the backend anyway.
 */
export function validateSchema(draft: unknown): SchemaResult {
  // Inject a placeholder hunks array so the schema doesn't reject a valid draft
  // that simply hasn't had its hunks field attached yet.
  const toValidate =
    draft !== null && typeof draft === "object" && !Array.isArray(draft)
      ? { hunks: [], ...(draft as Record<string, unknown>) }
      : draft;

  const result = WalkthroughSchema.safeParse(toValidate);

  if (result.success) {
    return { valid: true, errors: [] };
  }

  // Convert Zod's formatted error tree into a flat list of "path: message" strings.
  const formatted = result.error.format();
  const errors: string[] = [];

  function collect(obj: Record<string, unknown>, path: string): void {
    const messages = (obj as { _errors?: string[] })._errors;
    if (messages && messages.length > 0) {
      for (const msg of messages) {
        errors.push(path ? `${path}: ${msg}` : msg);
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === "_errors") continue;
      collect(
        obj[key] as Record<string, unknown>,
        path ? `${path}.${key}` : key
      );
    }
  }

  collect(formatted as unknown as Record<string, unknown>, "");

  return { valid: false, errors };
}
