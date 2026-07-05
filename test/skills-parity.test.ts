/**
 * Skills-parity guard: every skill authored under `src-templates/.claude/skills/`
 * MUST be listed in the generator's `DXKIT_SKILLS` (so init/update installs it),
 * and vice versa. Without this, a skill can be authored but silently never
 * shipped — exactly the "the uninstall skill exists in templates but wasn't
 * installed" class of bug from real dogfood feedback.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { DXKIT_SKILLS } from '../src/generator';

const SKILLS_DIR = join(__dirname, '..', 'src-templates', '.claude', 'skills');

function authoredSkills(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((name) => statSync(join(SKILLS_DIR, name)).isDirectory())
    .filter((name) => name.startsWith('dxkit-'));
}

describe('skills parity', () => {
  it('every authored skill is registered in DXKIT_SKILLS (installed on init)', () => {
    const registered = new Set<string>(DXKIT_SKILLS);
    const missing = authoredSkills().filter((s) => !registered.has(s));
    expect(missing, `authored but not shipped: ${missing.join(', ')}`).toEqual([]);
  });

  it('every registered skill has an authored SKILL.md', () => {
    const missing = DXKIT_SKILLS.filter((s) => !existsSync(join(SKILLS_DIR, s, 'SKILL.md')));
    expect(missing, `registered but no template: ${missing.join(', ')}`).toEqual([]);
  });

  it('the uninstall skill specifically is present + registered', () => {
    expect(DXKIT_SKILLS).toContain('dxkit-uninstall');
    expect(existsSync(join(SKILLS_DIR, 'dxkit-uninstall', 'SKILL.md'))).toBe(true);
  });
});
