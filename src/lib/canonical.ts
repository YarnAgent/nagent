/**
 * Deterministic JSON serialization. Keys at every level are sorted
 * alphabetically so the same logical object always produces the same byte
 * string, regardless of which order the source code happened to populate
 * fields. Used as the canonical form for signing (invites, gossip).
 *
 * Arrays preserve order — only object keys are sorted.
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) {
      out[k] = sortKeys((x as Record<string, unknown>)[k]);
    }
    return out;
  }
  return x;
}
