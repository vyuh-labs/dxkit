/**
 * Template engine — JS port of .template/scripts/bootstrap/template_engine.py
 *
 * Supports:
 *   {{VAR_NAME}}                    → variable substitution
 *   {{#IF_CONDITION}}...{{/IF_CONDITION}}  → conditional blocks
 *   {{#IF_CONDITION}}...{{#ELSE}}...{{/IF_CONDITION}} → if/else
 *   Nested conditionals (max 20 iterations)
 *
 * Avoids matching GitHub Actions ${{ }} syntax via negative lookbehind.
 */

export class TemplateEngine {
  private variables: Record<string, string>;
  private conditions: Record<string, boolean>;

  constructor(
    variables: Record<string, string>,
    conditions: Record<string, boolean>,
  ) {
    this.variables = variables;
    this.conditions = conditions;
  }

  process(content: string): string {
    content = this.processConditionals(content);
    content = this.processVariables(content);
    // Normalize trailing whitespace: collapse blank lines at end, ensure single newline
    content = content.replace(/\n{3,}/g, '\n\n');
    return content.trimEnd() + '\n';
  }

  private processConditionals(content: string): string {
    // Process innermost conditionals first, iterate to handle nesting
    const pattern = /\{\{#(IF_[A-Z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/;

    for (let i = 0; i < 20; i++) {
      const match = pattern.exec(content);
      if (!match) break;

      const [fullMatch, condName, block] = match;
      const elseParts = block.split('{{#ELSE}}');
      const ifContent = elseParts[0];
      const elseContent = elseParts.length > 1 ? elseParts[1] : '';

      const isTrue = this.conditions[condName] ?? false;
      const replacement = isTrue ? ifContent : elseContent;

      content = content.replace(fullMatch, replacement);
    }

    return content;
  }

  private processVariables(content: string): string {
    // Match {{VAR}} but not ${{ (GitHub Actions syntax)
    // JS doesn't support lookbehind in all environments, so we use a workaround
    return content.replace(/(\$?)\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, prefix, name) => {
      // If preceded by $, it's GitHub Actions syntax — leave it
      if (prefix === '$') return match;
      return this.variables[name] ?? match;
    });
  }
}

/** Process a template string with the given variables and conditions. */
export function processTemplate(
  content: string,
  variables: Record<string, string>,
  conditions: Record<string, boolean>,
): string {
  return new TemplateEngine(variables, conditions).process(content);
}
