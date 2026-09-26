/**
 * features.ts — viewer feature switches.
 *
 * SHOW_TRY_IT: the "Try it in the app" chapter (verification steps) and the
 * "Tried N of M scenarios" line in the summary. Hidden for now: the planned
 * agent-verifier (ST6e) that would fill this screen with before/after
 * screenshots is cut; the bare scenario checklist isn't worth a screen on
 * its own. Flip to true to bring both back unchanged.
 *
 * SHOW_HERO_STATS: the "N short steps · N things to check · ~N min · N/N hunks"
 * row on the start screen.
 *
 * SHOW_CHECKS: the "Your check" card on steps and the checklist on the summary.
 * Off: a reviewer reading a PR shouldn't be asked to go click around the app.
 */
export const SHOW_TRY_IT = false;
export const SHOW_HERO_STATS = false;
export const SHOW_CHECKS = false;
