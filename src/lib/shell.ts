/**
 * Quote a string for safe use inside a POSIX shell command line. Conservative:
 * any string that's not purely `[A-Za-z0-9_.-]` gets wrapped in single quotes
 * with embedded single quotes escaped via the standard `'\''` idiom.
 *
 * Used everywhere we build a remote shell command for ssh/mosh to evaluate;
 * factored here so future hardening (e.g. switching to `printf %q`-style
 * dollar-quoting) happens in one place. Issue #3, M6.
 */
export function shellSingleQuote(s: string): string {
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
