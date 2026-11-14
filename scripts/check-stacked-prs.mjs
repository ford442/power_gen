#!/usr/bin/env node
/**
 * check-stacked-prs.mjs — catch stacked PRs that would merge (or did merge)
 * into a branch that is already on the default branch.
 *
 * #249 and #251 showed "Merged" on GitHub but never reached `main`: each was
 * stacked on a branch, and merged into that branch after the branch itself
 * had merged. The merge commit was left on a side branch; Pages shipped
 * without it. Both were landed later by hand (#264, #265).
 *
 * Run by .github/workflows/stacked-prs.yml:
 *
 *   --mode open    (pull_request opened / reopened / edited / synchronize)
 *       Fails when the PR's base is not the default branch and that base is
 *       already merged into it. Fix: retarget the PR to the default branch.
 *   --mode closed  (pull_request closed with merged == true)
 *       Fails when the PR merged into a non-default base that was already
 *       merged, i.e. its merge commit is orphaned. Fix: land the merge commit
 *       on the default branch (cherry-pick or a PR from the base branch).
 *
 * "Already merged" = the base branch's tip is an ancestor of the default
 * branch (merge commits / fast-forward), or GitHub has a merged PR from the
 * base branch into the default branch (squash or rebase merges).
 *
 * Env (GitHub Actions): GITHUB_REPOSITORY, GITHUB_TOKEN (optional — without
 * it only the git ancestry check runs), PR_NUMBER, BASE_REF, BASE_SHA,
 * MERGE_SHA (closed mode), DEFAULT_BRANCH, STACKED_PR_REPORT (file the
 * failure message is written to, for the workflow to comment with).
 *
 * `node scripts/check-stacked-prs.mjs --self-test` checks the decision table
 * (no git / network); `npm run test:stacked-prs` runs it.
 */
import { execFileSync } from 'node:child_process';

/**
 * Pure decision for one PR event.
 * @param {{ mode: 'open'|'closed', baseRef: string, defaultBranch: string,
 *   baseMerged: boolean, mergeCommitOnDefault?: boolean }} f
 * @returns {{ ok: boolean, message: string }}
 */
export function classify({ mode, baseRef, defaultBranch, baseMerged, mergeCommitOnDefault = false }) {
  if (baseRef === defaultBranch) return { ok: true, message: `base is ${defaultBranch}` };
  if (!baseMerged) {
    return { ok: true, message: `stacked on ${baseRef} (not merged yet) — retarget to ${defaultBranch} before merging` };
  }
  if (mode === 'open') {
    return {
      ok: false,
      message: `base branch ${baseRef} is already merged into ${defaultBranch}. ` +
        `Merging this PR would leave its commits off ${defaultBranch}. Retarget it to ${defaultBranch}.`
    };
  }
  if (mergeCommitOnDefault) return { ok: true, message: `merged into ${baseRef}, and already on ${defaultBranch}` };
  return {
    ok: false,
    message: `merged into ${baseRef} after ${baseRef} had merged into ${defaultBranch}: ` +
      `this PR's changes are NOT on ${defaultBranch}. Land the merge commit on ${defaultBranch} ` +
      `(cherry-pick it, or open a PR from ${baseRef}).`
  };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isAncestor(a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Merged PR from `head` into `base` on GitHub (catches squash / rebase merges). */
async function hasMergedPr(repo, head, base, token) {
  if (!token || !repo) return false;
  const owner = repo.split('/')[0];
  const url = `https://api.github.com/repos/${repo}/pulls?state=closed&per_page=100` +
    `&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
  });
  if (!res.ok) {
    console.warn(`[stacked-prs] GitHub API ${res.status} — using git ancestry only`);
    return false;
  }
  const prs = await res.json();
  return Array.isArray(prs) && prs.some((pr) => pr.merged_at);
}

function selfTest() {
  const cases = [
    [{ mode: 'open', baseRef: 'main', defaultBranch: 'main', baseMerged: false }, true],
    [{ mode: 'open', baseRef: 'feat/a', defaultBranch: 'main', baseMerged: false }, true],
    [{ mode: 'open', baseRef: 'feat/a', defaultBranch: 'main', baseMerged: true }, false],
    [{ mode: 'closed', baseRef: 'main', defaultBranch: 'main', baseMerged: true }, true],
    [{ mode: 'closed', baseRef: 'feat/a', defaultBranch: 'main', baseMerged: false }, true],
    // #249 / #251: merged into an already-merged base, merge commit not on main
    [{ mode: 'closed', baseRef: 'ci/validate-everything', defaultBranch: 'main', baseMerged: true }, false],
    [{ mode: 'closed', baseRef: 'feat/a', defaultBranch: 'main', baseMerged: true, mergeCommitOnDefault: true }, true]
  ];
  let failed = 0;
  for (const [input, want] of cases) {
    const got = classify(input).ok;
    if (got !== want) {
      failed++;
      console.error(`[stacked-prs] FAIL ${JSON.stringify(input)} → ok=${got}, want ${want}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`[stacked-prs] OK — ${cases.length} decision cases`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const mode = argv[argv.indexOf('--mode') + 1];
  if (mode !== 'open' && mode !== 'closed') {
    console.error('usage: check-stacked-prs.mjs --mode open|closed  |  --self-test');
    process.exit(2);
  }
  const env = process.env;
  const defaultBranch = env.DEFAULT_BRANCH || 'main';
  const baseRef = env.BASE_REF;
  if (!baseRef) throw new Error('BASE_REF not set');
  if (baseRef === defaultBranch) {
    console.log(`[stacked-prs] base is ${defaultBranch} — nothing to check`);
    return;
  }

  const defaultRef = `origin/${defaultBranch}`;
  git('fetch', '--no-tags', 'origin', defaultBranch);
  try {
    git('fetch', '--no-tags', 'origin', baseRef);
  } catch {
    // Base branch already deleted — BASE_SHA (closed mode) still identifies its tip.
  }
  // Tip of the base branch: the PR's base SHA when merged (closed mode), else
  // the branch as it is now.
  const baseTip = (mode === 'closed' && env.BASE_SHA) || git('rev-parse', `origin/${baseRef}`);
  const baseMerged = isAncestor(baseTip, defaultRef)
    || await hasMergedPr(env.GITHUB_REPOSITORY, baseRef, defaultBranch, env.GITHUB_TOKEN);
  const mergeCommitOnDefault = mode === 'closed' && !!env.MERGE_SHA && isAncestor(env.MERGE_SHA, defaultRef);

  const { ok, message } = classify({ mode, baseRef, defaultBranch, baseMerged, mergeCommitOnDefault });
  const pr = env.PR_NUMBER ? `#${env.PR_NUMBER} ` : '';
  if (ok) {
    console.log(`[stacked-prs] ${pr}${message}`);
    return;
  }
  console.log(`::error title=Stacked PR::${pr}${message}`);
  const { appendFileSync, writeFileSync } = await import('node:fs');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Stacked PR\n\n${pr}${message}\n`);
  // The workflow posts this on the PR (a failed check on a merged PR is easy to miss).
  if (env.STACKED_PR_REPORT) writeFileSync(env.STACKED_PR_REPORT, `**Stacked PR check:** ${message}\n`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`[stacked-prs] ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
