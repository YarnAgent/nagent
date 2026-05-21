/**
 * Deterministic JSON serialization. Keys at every level are sorted
 * alphabetically so the same logical object always produces the same byte
 * string, regardless of which order the source code happened to populate
 * fields. Used as the canonical form for signing (invites, gossip).
 *
 * Arrays preserve order — only object keys are sorted.
 */
export function canonicalJson(obj) {
    return JSON.stringify(sortKeys(obj));
}
function sortKeys(x) {
    if (Array.isArray(x))
        return x.map(sortKeys);
    if (x && typeof x === "object") {
        const out = {};
        for (const k of Object.keys(x).sort()) {
            out[k] = sortKeys(x[k]);
        }
        return out;
    }
    return x;
}
//# sourceMappingURL=canonical.js.map