// Challenge decisions (F2) in the Store: an answer review (F1's shared job) that argues against 1–40 answers the user
// chose. The agent reads only those answers and the original idea; its hypotheses become one unreviewed proposal, each
// kept or dismissed by the user, and may cite up to three sources it read. Answers never change.
import { answerReviewJob } from './map-jobs.mjs';
import { CHALLENGE, maxChallenged, challengeCategories } from '../assets/challenge.js';

export const challengeJobTypes = {
  [CHALLENGE]: answerReviewJob({
    label: 'Challenge decisions', categories: challengeCategories, choose: { min: 1, max: maxChallenged }, sources: 3,
    reason: 'The user asked the agent to argue against chosen answers.',
    instruction: 'Argue in good faith against these saved answers: name hidden assumptions, counter-arguments, overlooked alternatives and evidence gaps that matter to the decision. Do not manufacture objections when none matter; an empty list is a fine result. Missing context is not evidence against a choice. Cite only sources you actually read. Each finding is a hypothesis for the user to consider, never a finding about the map: never ask the user to change an answer. Return the result through the CLI.',
  }),
};
