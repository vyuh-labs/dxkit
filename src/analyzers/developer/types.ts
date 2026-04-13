/**
 * Developer activity report types.
 */

export interface ContributorStats {
  name: string;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  netChange: number;
  mergeCommits: number;
}

export interface HotFile {
  path: string;
  changes: number;
}

export interface CommitQuality {
  conventional: number; // feat:, fix:, chore:, etc.
  descriptive: number; // multi-word, meaningful
  vague: number; // single word, "update", "fix", etc.
  total: number;
  conventionalPercent: number;
}

export interface WeeklyVelocity {
  week: string; // YYYY-Www
  commits: number;
}

export interface DevReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  period: { since: string; until: string };
  summary: {
    totalCommits: number;
    nonMergeCommits: number;
    mergeCommits: number;
    mergeRatio: number; // 0-1
    contributors: number;
  };
  contributors: ContributorStats[];
  commitQuality: CommitQuality;
  hotFiles: HotFile[];
  velocity: WeeklyVelocity[];
  toolsUsed: string[];
}
