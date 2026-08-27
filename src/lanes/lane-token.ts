/**
 * The ONE lane token definition (Rule 2 applied to workflow templates).
 *
 * Every workflow dxkit installs that creates PRs or issues, or pushes
 * commits that must trigger workflow runs, authenticates through one
 * three-tier chain: a GitHub App installation token minted per run, then
 * the DXKIT_BOT_TOKEN PAT, then the default workflow token (whose PRs and
 * pushes never trigger checks — the degraded tier, always disclosed).
 *
 * The 4.4.1 class this module closes at the root: the chain and its mint
 * step were hand-copied into each template, and the parity test iterated a
 * hand-picked filename list — so the baseline-refresh -branch/-cache
 * variants, comment-defer's push to the PR branch, and the flow/extensions
 * standing-PR lanes all silently stayed on the default token (dxkit #323).
 * Now the chain text exists HERE once; templates carry placeholders
 * (`__DXKIT_LANE_TOKEN_STEPS__`, `__DXKIT_LANE_TOKEN__`, …) and the ONE
 * workflow writer (`installWorkflow` in ship-installers.ts) substitutes
 * them unconditionally — a template cannot drift off the chain, and a new
 * lane template inherits the whole mechanism by writing the placeholder.
 *
 * Deliberately a LEAF module (no imports): consumed by ship-installers and
 * pinned by test/templates-lane-tokens.test.ts, which derives "needs the
 * chain" from template CONTENT (gh-shelling / PR-creating / pushing) with
 * declared exemptions, never a filename list.
 */

/**
 * The configuration NAMES each tier reads. One definition: the workflow
 * text below, the doctor probe (`lane-token-probe.ts`) and every remedy
 * string derive from these, so a rename cannot leave a consumer probing
 * or advising a stale name.
 */
export const LANE_TOKEN_APP_ID_VARIABLE_NAME = 'DXKIT_APP_ID';
export const LANE_TOKEN_APP_KEY_SECRET_NAME = 'DXKIT_APP_PRIVATE_KEY';
export const LANE_TOKEN_PAT_SECRET_NAME = 'DXKIT_BOT_TOKEN';

/**
 * The remedy for a genuinely absent tier, and the per-half remedies for a
 * half-configured App tier. Co-located with the names so every consumer
 * (doctor, install notes, disclosures) derives its advice from the one
 * definition instead of restating the names.
 */
export const LANE_TOKEN_REMEDY_COMMAND = `gh variable set ${LANE_TOKEN_APP_ID_VARIABLE_NAME} && gh secret set ${LANE_TOKEN_APP_KEY_SECRET_NAME}`;
export const LANE_TOKEN_APP_ID_REMEDY_COMMAND = `gh variable set ${LANE_TOKEN_APP_ID_VARIABLE_NAME}`;
export const LANE_TOKEN_APP_KEY_REMEDY_COMMAND = `gh secret set ${LANE_TOKEN_APP_KEY_SECRET_NAME}`;

/** Tier chain for checkout credentials and gh calls: App → PAT → default. */
export const LANE_TOKEN_CHAIN = `\${{ steps.dxkit-app-token.outputs.token || secrets.${LANE_TOKEN_PAT_SECRET_NAME} || github.token }}`;

/**
 * The remediate task step's chain: prefers the token re-minted immediately
 * before the agent task (App installation tokens are hard-capped at one
 * hour, and the first mint happens before checkout + toolchain install),
 * then falls through the standard tiers.
 */
export const LANE_TOKEN_CHAIN_TASK =
  `\${{ steps.dxkit-app-token-task.outputs.token || steps.dxkit-app-token.outputs.token || ` +
  `secrets.${LANE_TOKEN_PAT_SECRET_NAME} || github.token }}`;

/** The resolved tier, as an env value the CLI can branch on ('app' means a
 *  one-hour installation token; under inline landing the CLI clamps the
 *  agent wall clock to it, under deferred landing it only discloses). */
export const LANE_TOKEN_MODE_EXPR =
  `\${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} != '' && 'app' || ` +
  `(secrets.${LANE_TOKEN_PAT_SECRET_NAME} != '' && 'pat' || 'workflow') }}`;

/**
 * The mint + disclose steps, placed before checkout in every chain-carrying
 * template. 6-space indentation matches the templates' step nesting. A
 * configured-but-broken App FAILS the mint step loudly rather than silently
 * degrading a tier; the default-token tier is disclosed with the remedy.
 */
export const LANE_TOKEN_STEPS = `      # The lane token, tier chain: GitHub App installation token (minted
      # per run — no billed seat, one-hour lifetime), then the optional
      # ${LANE_TOKEN_PAT_SECRET_NAME} PAT, then the default token (whose PRs and pushes
      # never trigger workflow runs — disclosed below, never silent).
      # ONE definition: src/lanes/lane-token.ts substitutes this block and
      # every __DXKIT_LANE_TOKEN__ reference at install time.
      - name: Mint the lane token (GitHub App, when configured)
        id: dxkit-app-token
        if: \${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} != '' }}
        uses: actions/create-github-app-token@v2
        with:
          app-id: \${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} }}
          private-key: \${{ secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME} }}

      - name: Disclose token mode
        env:
          DXKIT_APP_SET: \${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} != '' }}
          ${LANE_TOKEN_PAT_SECRET_NAME}_SET: \${{ secrets.${LANE_TOKEN_PAT_SECRET_NAME} != '' }}
        run: |
          if [ "\${DXKIT_APP_SET}" = "true" ]; then
            echo "token tier: GitHub App (short-lived, minted this run)"
          elif [ "\${${LANE_TOKEN_PAT_SECRET_NAME}_SET}" = "true" ]; then
            echo "token tier: ${LANE_TOKEN_PAT_SECRET_NAME} (PAT)"
          else
            echo "::notice title=lane PRs run no checks::This lane pushes with the default GITHUB_TOKEN, and GitHub never triggers workflows for such pushes - the PR it opens will show no checks. Preferred fix: a GitHub App (set the ${LANE_TOKEN_APP_ID_VARIABLE_NAME} variable + the ${LANE_TOKEN_APP_KEY_SECRET_NAME} secret - no billed seat, short-lived per-run tokens). A ${LANE_TOKEN_PAT_SECRET_NAME} PAT secret with repo scope also works."
          fi`;

/**
 * The task-time RE-MINT step (the remediate lane): an App installation
 * token is hard-capped at one hour by GitHub and the first mint happens
 * before checkout + toolchain install, so a long agent budget could
 * outlive it and 401 the landing push after the full agent spend.
 * Rendered from the same name constants as the first mint; the template
 * carries the __DXKIT_LANE_TOKEN_TASK_STEPS__ placeholder (it hardcoded
 * these names once, which is exactly the drift this module exists to
 * prevent). 6-space indentation matches the templates' step nesting.
 */
export const LANE_TOKEN_TASK_STEPS = `      - name: Re-mint the lane token before the task (App tier)
        id: dxkit-app-token-task
        if: \${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} != '' }}
        uses: actions/create-github-app-token@v2
        with:
          app-id: \${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} }}
          private-key: \${{ secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME} }}`;

/**
 * The landing-time mint (two-phase landing, 4.4.7): the remediate task's
 * verify phases scale with repo size and can outlive ANY token minted
 * before the task, so the landing step mints its own: the token's hour
 * starts at delivery time. Runs even after a failed task step (a salvage
 * draft record must still land), hence the always() guard alongside the
 * App-tier condition. Rendered from the same name constants; the template
 * carries the __DXKIT_LANE_TOKEN_LAND_STEPS__ placeholder.
 */
export const LANE_TOKEN_LAND_STEPS = `      - name: Mint the landing token (App tier, fresh for delivery)
        id: dxkit-app-token-land
        if: \${{ always() && vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} != '' }}
        uses: actions/create-github-app-token@v2
        with:
          app-id: \${{ vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME} }}
          private-key: \${{ secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME} }}`;

/**
 * The landing step's chain: the fresh delivery-time mint first, then the
 * earlier mints, then the long-lived tiers.
 */
export const LANE_TOKEN_CHAIN_LAND =
  `\${{ steps.dxkit-app-token-land.outputs.token || steps.dxkit-app-token-task.outputs.token || ` +
  `steps.dxkit-app-token.outputs.token || secrets.${LANE_TOKEN_PAT_SECRET_NAME} || github.token }}`;

/**
 * The substitution map the ONE workflow writer applies to EVERY template,
 * unconditionally — a callsite cannot forget it, and a template without
 * the placeholders is untouched (split/join no-op). Order matters only in
 * that keys never overlap; the longer _TASK_STEPS / _TASK / _MODE keys
 * sort before the bare token key here so the bare key can never eat
 * their prefixes.
 */
export const LANE_TOKEN_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  __DXKIT_LANE_TOKEN_TASK_STEPS__: LANE_TOKEN_TASK_STEPS,
  __DXKIT_LANE_TOKEN_LAND_STEPS__: LANE_TOKEN_LAND_STEPS,
  __DXKIT_LANE_TOKEN_STEPS__: LANE_TOKEN_STEPS,
  __DXKIT_LANE_TOKEN_TASK__: LANE_TOKEN_CHAIN_TASK,
  __DXKIT_LANE_TOKEN_LAND__: LANE_TOKEN_CHAIN_LAND,
  __DXKIT_LANE_TOKEN_MODE__: LANE_TOKEN_MODE_EXPR,
  __DXKIT_LANE_TOKEN__: LANE_TOKEN_CHAIN,
};
