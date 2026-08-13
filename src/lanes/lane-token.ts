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

/** Tier chain for checkout credentials and gh calls: App → PAT → default. */
export const LANE_TOKEN_CHAIN =
  '${{ steps.dxkit-app-token.outputs.token || secrets.DXKIT_BOT_TOKEN || github.token }}';

/**
 * The remediate task step's chain: prefers the token re-minted immediately
 * before the agent task (App installation tokens are hard-capped at one
 * hour, and the first mint happens before checkout + toolchain install),
 * then falls through the standard tiers.
 */
export const LANE_TOKEN_CHAIN_TASK =
  '${{ steps.dxkit-app-token-task.outputs.token || steps.dxkit-app-token.outputs.token || ' +
  'secrets.DXKIT_BOT_TOKEN || github.token }}';

/** The resolved tier, as an env value the CLI can branch on ('app' clamps
 *  the agent wall clock to the installation token's lifetime). */
export const LANE_TOKEN_MODE_EXPR =
  "${{ vars.DXKIT_APP_ID != '' && 'app' || (secrets.DXKIT_BOT_TOKEN != '' && 'pat' || 'workflow') }}";

/**
 * The mint + disclose steps, placed before checkout in every chain-carrying
 * template. 6-space indentation matches the templates' step nesting. A
 * configured-but-broken App FAILS the mint step loudly rather than silently
 * degrading a tier; the default-token tier is disclosed with the remedy.
 */
export const LANE_TOKEN_STEPS = `      # The lane token, tier chain: GitHub App installation token (minted
      # per run — no billed seat, one-hour lifetime), then the optional
      # DXKIT_BOT_TOKEN PAT, then the default token (whose PRs and pushes
      # never trigger workflow runs — disclosed below, never silent).
      # ONE definition: src/lanes/lane-token.ts substitutes this block and
      # every __DXKIT_LANE_TOKEN__ reference at install time.
      - name: Mint the lane token (GitHub App, when configured)
        id: dxkit-app-token
        if: \${{ vars.DXKIT_APP_ID != '' }}
        uses: actions/create-github-app-token@v2
        with:
          app-id: \${{ vars.DXKIT_APP_ID }}
          private-key: \${{ secrets.DXKIT_APP_PRIVATE_KEY }}

      - name: Disclose token mode
        env:
          DXKIT_APP_SET: \${{ vars.DXKIT_APP_ID != '' }}
          DXKIT_BOT_TOKEN_SET: \${{ secrets.DXKIT_BOT_TOKEN != '' }}
        run: |
          if [ "\${DXKIT_APP_SET}" = "true" ]; then
            echo "token tier: GitHub App (short-lived, minted this run)"
          elif [ "\${DXKIT_BOT_TOKEN_SET}" = "true" ]; then
            echo "token tier: DXKIT_BOT_TOKEN (PAT)"
          else
            echo "::notice title=lane PRs run no checks::This lane pushes with the default GITHUB_TOKEN, and GitHub never triggers workflows for such pushes - the PR it opens will show no checks. Preferred fix: a GitHub App (set the DXKIT_APP_ID variable + the DXKIT_APP_PRIVATE_KEY secret - no billed seat, short-lived per-run tokens). A DXKIT_BOT_TOKEN PAT secret with repo scope also works."
          fi`;

/**
 * The substitution map the ONE workflow writer applies to EVERY template,
 * unconditionally — a callsite cannot forget it, and a template without
 * the placeholders is untouched (split/join no-op). Order matters only in
 * that keys never overlap; _TASK and _MODE sort before the bare token key
 * here so the bare key can never eat their prefixes.
 */
export const LANE_TOKEN_SUBSTITUTIONS: Readonly<Record<string, string>> = {
  __DXKIT_LANE_TOKEN_STEPS__: LANE_TOKEN_STEPS,
  __DXKIT_LANE_TOKEN_TASK__: LANE_TOKEN_CHAIN_TASK,
  __DXKIT_LANE_TOKEN_MODE__: LANE_TOKEN_MODE_EXPR,
  __DXKIT_LANE_TOKEN__: LANE_TOKEN_CHAIN,
};
