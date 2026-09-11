// A create-react-app source file. No package imports on purpose: the
// fixture has no installed dependency tree beyond the runner shims, and the
// floor's import-resolution check must stay clean so the affected-tests
// assertions isolate the entry-point question.
export function greeting(name) {
  return `Hello, ${name}`;
}

// Placeholder credential (the language-agnostic benign-convention invariant).
export const demoUser = { password: 'password' };
