/**
 * Compare two `MAJOR.MINOR.PATCH` version strings.
 *
 * Negative when `a` is older, positive when newer, `0` when equal.
 *
 * Why this exists: the node refuses to register a version that is not strictly
 * higher than the registered one (`version 0.1.1 is not higher than current
 * version 0.1.1`). Deciding *before* calling is what lets `deploy` be safe to
 * re-run — at the same version it reconciles instead of erroring, and on a
 * downgrade it says so in one line instead of surfacing a transport error.
 *
 * Deliberately not a full SemVer 2.0.0 implementation. A pre-release suffix is
 * compared lexically and ranks below the same triple without one, which is all
 * this project needs; the node enforces the real rule, so a wrong answer here
 * only changes which message an operator reads.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; pre: string } => {
    const dash = value.indexOf("-");
    const core = dash === -1 ? value : value.slice(0, dash);
    const pre = dash === -1 ? "" : value.slice(dash + 1);
    const nums = core.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
    return { nums, pre };
  };

  const left = parse(a);
  const right = parse(b);

  const width = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < width; i += 1) {
    const l = left.nums[i] ?? 0;
    const r = right.nums[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  if (left.pre === right.pre) return 0;
  // A pre-release ranks below the release it precedes.
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre < right.pre ? -1 : 1;
}
