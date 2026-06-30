/**
 * User-facing explanation of the similarity score. Kept here (not inline in the
 * CLI) so the same copy backs the eventual web UI's info panel / tooltip — one
 * source of truth for "what does this number mean?".
 *
 * P2-safe: the score is framed as a triage aid, never a verdict.
 */

export const COSINE_SIMILARITY_TITLE = "What is the similarity score?";

export const COSINE_SIMILARITY_EXPLAINER =
  `Each item and your topic are turned into a vector (a list of numbers) by the
embedding model. "Cosine similarity" is how aligned those two vectors are — it
measures closeness in *meaning*, not matching words. So "recall the councilmember"
and "petition to remove her from office" score high despite sharing no keywords.

  ~1.0   nearly the same meaning
  ~0.5   loosely related
  ~0.0   unrelated

The scores are relative — good for ranking and triage within one run, not an
absolute measure of truth. A high score means "worth a look," not "confirmed."
Parallax Fix lays the evidence out; you make the call.`;
