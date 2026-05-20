// Bus address matcher.
// Addresses look like: `node/session`, `node/*`, `*/session`, `*/role:foo`.
// A subscriber registers a pattern; an incoming SEND `to` is matched against
// every subscriber's pattern. Roles are matched against a per-session role set.
function matchSide(pattern, value, roles) {
    if (pattern === "*")
        return true;
    if (pattern.startsWith("role:")) {
        return roles.has(pattern.slice("role:".length));
    }
    return pattern === value;
}
export function matches(pattern, target) {
    const idx = pattern.indexOf("/");
    if (idx < 0)
        return false;
    const left = pattern.slice(0, idx);
    const right = pattern.slice(idx + 1);
    if (!matchSide(left, target.node, new Set()))
        return false;
    if (!matchSide(right, target.session, target.roles))
        return false;
    return true;
}
export function formatAddress(node, session) {
    return `${node}/${session}`;
}
//# sourceMappingURL=match.js.map