/**
 * Compose a greeting. Deliberately tiny: the example exists to demonstrate
 * the dxkit loop (score, baseline, gate), not the code.
 */
export function greet(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('name must be a non-empty string');
  }
  return `Hello, ${name.trim()}!`;
}
