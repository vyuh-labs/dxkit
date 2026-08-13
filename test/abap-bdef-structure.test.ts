import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BDEF_STRUCTURE_LABEL,
  abapBdefStructureCheck,
  bdefStructuralProblem,
} from '../src/languages/abap-bdef';
import { runCorrectnessFloor } from '../src/analyzers/correctness/run';
import { getLanguage } from '../src/languages';

/**
 * #309 — the `.bdef` structural floor, calibrated against the reporter's
 * real-shaped samples (invented names). The contract: the four broken-file
 * classes REFUSE; every legal line (including `//` comments and blanks)
 * is accepted; discovery covers BOTH serialization conventions; and the
 * check reports under its OWN label — "structurally plausible", never
 * "parsed".
 */

const LEGAL = `managed implementation in class zbp_i_order unique;
strict ( 2 );

// draft is out of scope for this entity
define behavior for zi_order alias Order
persistent table zorder
lock master
authorization master ( instance )
{
  create;
  update;
  delete;
}
`;

/** Sample A — truncation mid-block (generation cutoff inside the braces). */
const SAMPLE_A = `managed implementation in class zbp_i_order unique;
strict ( 2 );

define behavior for zi_order alias Order
persistent table zorder
lock master
authorization master ( instance )
{
  create;
  upd`;

/** Sample B — truncation at the statement boundary: looks complete to a
 *  naive "has define behavior + braces" check; the block never closes and
 *  the last statement has no terminator. */
const SAMPLE_B = `managed implementation in class zbp_i_orderitem unique;
strict ( 2 );

define behavior for zi_orderitem alias OrderItem
persistent table zorderitem
lock master
authorization master ( instance )
{
  create;
  update;
  delete`;

describe('bdefStructuralProblem — the four classes', () => {
  it('a legal behavior definition (comments + blanks included) is PLAUSIBLE', () => {
    expect(bdefStructuralProblem(LEGAL)).toBeNull();
  });

  it('class 1a (sample A): mid-block truncation → unbalanced braces', () => {
    expect(bdefStructuralProblem(SAMPLE_A)).toContain('never closes');
  });

  it('class 1b (sample B): statement-boundary truncation — the sharp case', () => {
    // A naive "contains define behavior + braces" check passes this one.
    expect(bdefStructuralProblem(SAMPLE_B)).toContain('never closes');
  });

  it('class 2 (sample C): every leak line refused individually; legit neighbors accepted', () => {
    // The reporter's calibration: the four leak shapes are the prose
    // sentence, the two fences, and the bold note.
    const leaks = [
      'Here is the behavior definition for the order entity:',
      '```abap',
      '**Note:** the entity is draft-disabled for simplicity.',
      'The rest of the implementation follows the same pattern.',
    ];
    for (const leak of leaks) {
      const contaminated = LEGAL.replace('strict ( 2 );', `strict ( 2 );\n${leak}`);
      expect(bdefStructuralProblem(contaminated), `leak line must refuse: ${leak}`).not.toBeNull();
    }
  });

  it('class 3: balanced-but-not-a-behavior-definition → header shape named', () => {
    expect(bdefStructuralProblem('define view { x; }')).toContain('implementation header');
    expect(
      bdefStructuralProblem('managed implementation in class zbp unique;\nstrict ( 2 );'),
    ).toContain('define behavior for');
  });

  it('class 4: empty / whitespace-only', () => {
    expect(bdefStructuralProblem('')).toContain('empty');
    expect(bdefStructuralProblem('  \n\t\n')).toContain('empty');
  });
});

describe('abapBdefStructureCheck — discovery + the runner seam', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-bdef-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    return dir;
  }

  it('discovers BOTH conventions — plain .bdef AND abapGit .bdef.asbdef (the mirrored silent-ignore pin)', () => {
    const plainOnly = abapBdefStructureCheck({
      cwd: tree({ 'code/bdef/zi_order.bdef': SAMPLE_A }),
      changedFiles: [],
      scope: 'full',
    });
    expect(plainOnly.kind).toBe('broken');
    const abapGitOnly = abapBdefStructureCheck({
      cwd: tree({ 'src/zi_order.bdef.asbdef': SAMPLE_B }),
      changedFiles: [],
      scope: 'full',
    });
    expect(abapGitOnly.kind).toBe('broken');
  });

  it('no behavior definitions at all → none (nothing ran, nothing claimed)', () => {
    const res = abapBdefStructureCheck({
      cwd: tree({ 'src/zcl_x.clas.abap': 'CLASS zcl_x DEFINITION. ENDCLASS.' }),
      changedFiles: [],
      scope: 'full',
    });
    expect(res.kind).toBe('none');
  });

  it('a clean tree reports its own label with the checked count', () => {
    const res = abapBdefStructureCheck({
      cwd: tree({ 'code/bdef/zi_order.bdef': LEGAL }),
      changedFiles: [],
      scope: 'full',
    });
    expect(res).toMatchObject({ kind: 'clean', label: BDEF_STRUCTURE_LABEL, checkedFiles: 1 });
  });

  it('the floor runner surfaces it as its own check with FILE-keyed findings', () => {
    const cwd = tree({
      'code/bdef/zi_order.bdef': SAMPLE_A,
      'code/bdef/zi_item.bdef': LEGAL,
    });
    const abap = getLanguage('abap')!;
    const floor = runCorrectnessFloor({ cwd, changedFiles: [], scope: 'full', packs: [abap] });
    const check = floor.checks.find((c) => c.label === BDEF_STRUCTURE_LABEL);
    expect(check).toBeDefined();
    expect(check!.status).toBe('fail');
    expect(check!.findings).toEqual(['code/bdef/zi_order.bdef']);
    expect(floor.blocks).toBe(true);
    // Structural honesty in the output: plausible, never parsed.
    expect(check!.output).toContain('never "parsed"');
  });
});
