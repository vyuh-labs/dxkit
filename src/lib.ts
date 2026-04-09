/**
 * Library entry point for @vyuhlabs/dxkit.
 *
 * Re-exports public API for programmatic consumption by other packages
 * (e.g. @vyuhlabs/create-devstack). The CLI entry point is src/index.ts.
 */

export { detect } from './detect';
export { processTemplate, TemplateEngine } from './template-engine';
export type { DetectedStack } from './types';
