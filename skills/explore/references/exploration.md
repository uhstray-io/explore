# Conducting an exploration

The goal is to help the user make a distinction, test a belief, or choose a next step. A large tree is not a success criterion. Match depth and tone to their aim: understanding, a practical decision, planning, or open discovery. Technical architectures, community projects, creative work, personal plans, and business questions can all use the same loop without forcing a software lens.

## Establish just enough direction

Start from the user's stated idea and saved answers. Form a short working frame: the outcome they want, what is already constrained, and the uncertainty this branch can reduce. If the request is broad, propose a provisional frame in the result and make it easy to correct. Do not silently convert a possibility into a commitment.

Ask only when a missing answer would change the next investigation. Budget, time, audience, success criteria, and boundaries are useful dimensions when they matter, not an intake checklist. If the goal is already clear, proceed. If it is not, one concrete question such as “What would you like to be able to decide after exploring this?” can be enough. Do independent work that does not depend on that answer before pausing.

On resumption, identify the saved goal, actual user answers, accepted findings, stale material, and the selected unfinished branch. State a concise orientation only if useful: “We settled X; Y remains open; this branch checks Z.” Do not restart discovery, ask an answered question, or present the original premise as a proven finding. Retrieve an older answer by its question ID or a targeted section search when the packet omits it.

## Follow the map's goal

A packet may carry `goal`: the map's `mode` with its `modeFocus`, an `objective` and `successCriteria` (what done looks like). Each is optional; without them, work as described here. Let the mode set what you look for first:

- **Understand:** concepts, stakeholders and unknowns.
- **Decide:** choices, criteria and trade-offs.
- **Design:** intended outcomes, constraints, interfaces and feasibility.
- **Diagnose:** symptoms, reproduction, evidence and alternative causes.
- **Challenge:** assumptions, counterexamples and failure conditions.

The objective and success criteria shape your working frame and your judgement of when a branch has done enough. The user can change them at any time. A change applies to new work only: never reopen or rewrite completed findings because the guidance changed. When an earlier finding no longer fits the new guidance, say so and propose a new direction instead.

## Choose a topic profile

Before researching a job, pick one profile and read only that file. It adds checks for that kind of topic to the rules here; it never replaces them, grants no extra tools and is not evidence.

| Profile | Choose it when |
| --- | --- |
| [General](topics/general.md) | The default: the topic is mixed, unfamiliar or not technical, or you are unsure. |
| [Software and versions](topics/software-versions.md) | The branch is about adopting, upgrading, migrating or combining software. |
| [Products and services](topics/products-services.md) | The branch is about buying, renting, subscribing to or hiring something. |
| [Concepts and design trade-offs](topics/concepts-tradeoffs.md) | The branch defines an idea or weighs competing approaches. |

Do not force a software lens on an idea that is not technical. In a branch investigation's result, name the profile you used in `topicProfile`; other job types' results do not take it.

## Propose directions that discriminate

A useful child investigates a consequential uncertainty or compares plausible alternatives. Its title names the issue; its body explains what would be checked and what different outcomes would change. Offer only directions with distinct value, often two or three. There is no requirement to fill every category or use the maximum number of suggestions.

For a field-notebook idea, “Technology,” “Users,” and “Security” are weak labels. Stronger directions might be:

- “One editor or simultaneous editing?” Check the actual field workflow; single-editor use may need a much simpler recovery model.
- “What must survive a lost device?” Identify which records are replaceable and which cannot leave the team; that changes local storage and recovery requirements.

For a neighborhood workshop, “Marketing,” “Budget,” and “Operations” are equally weak. Useful alternatives might be:

- “One trial evening or a recurring program?” Compare the evidence each option would give about demand against the organizer's available time.
- “Tools supplied or brought by participants?” Check accessibility and shared-equipment needs; the answer changes who can attend and the practical cost.

These are examples of useful distinctions, not branches to insert into unrelated maps. Avoid duplicating existing directions or researching an unselected child. A suggestion is an invitation for the user to activate it. Its proposed outcomes are hypotheses, not conclusions.

Suggest a `hypothesis` instead of a research direction when the work runs on a testable guess, as in diagnosing a problem or testing a design: its body is the claim, "I think X is true", and its `test` the smallest check that could refute it. When you explore one, design that test, gather evidence for and against, and propose an outcome in `hypothesis`. Never record an outcome: the user does.

## Ask questions worth interrupting for

A question should resolve a decision-relevant ambiguity that research or the existing map cannot answer. Ask about the user's priorities, constraints, lived context, or a choice reserved for them. Investigate externally answerable factual uncertainty with available tools. If evidence is unavailable, state that limit instead of disguising a factual question as a preference.

Prefer one blocking question; group a few only when their answers are independently necessary, and ask at most three in one result. The user answers them one at a time, and the branch continues after the last one. Ask one thing per question. Explain the consequence briefly and offer concrete choices when they help, while allowing an answer outside those choices. Avoid leading questions, vague requests to “tell me more,” false binaries, and bundled questionnaires. Do not ask the user to endorse the agent's preferred conclusion.

Rate each question by how much its answer would change this branch's direction or outcome for the user's goal: `high` only when the answer would change the recommendation or the branch cannot continue without it, `medium` when it shapes a significant part, `low` when it refines details. Importance is impact, not your confidence or how urgent it feels. Give every rated question a `why` that names the consequence, for example "If one editor is enough, recovery stays simple; if not, we need conflict handling". Do not restate the question. The user sees the rating as a label and the `why` behind a "Why?" link, so they can answer the questions that matter first.

Example: “For the first workshop, which matters more: reaching many neighbors or keeping preparation under one evening? A third priority is welcome.” This distinguishes a real tradeoff only if the user has not already settled it. A grounded open question is better when the relevant choices are unknown.

Put required questions in the result's `questions` array so the browser can save and resume them. Optional curiosities belong in inactive suggestions or the uncertainty notes. Do not add a question merely to avoid completing a branch. Record an answer only when the user supplied it; an inferred preference must remain an inference.

When an answer has `changedAt` and a `previousAnswer`, build only on the new answer: check findings flagged for review and earlier follow-ups first, and never reason from the earlier answer. A branch with `revisesAnswer` explores what changes if the user had answered differently; compare with the original only to explain the difference.

When a `question-research` job asks you to help the user answer a question, research only as deep as choosing needs. Prefer primary sources, cite only what you read, and compare the realistic options with their fit, pros and cons. Recommend one only when the evidence and the user's saved answers support it; otherwise give an honest "No recommendation yet" and say what is missing. A suggested answer is a first-person draft the user may copy; never answer for them.

The packet's `questionFeedback` is the user's view of earlier questions on this map. Ask more like those rated good. Treat those rated bad, dismissed or replaced, and their reasons, as what not to ask; never repeat a dismissed question or a close variant. If one was essential, proceed on a stated assumption instead.

Each saved answer says how sure the user is (`answerState`). Build on **Decided** answers; if evidence contradicts one, report the conflict instead of overriding it. Treat **Tentative** answers, the default and the reading of older answers marked `certaintyRecorded: false`, as usable but provisional, and say what depends on them. Treat an **Assumption** as an unverified premise: check it when it matters and say what would disprove it. A question marked `deferred` was saved for later: do not rely or wait on it and do not ask it again; proceed on a stated assumption, or propose an inactive direction if it is essential.

## Offer options only for real choices

When the user asks you to reconsider a comparison against their criteria, do no new retrieval: judge each option against each criterion from the saved evidence. Priorities are the user's preferences, not facts, and a high priority cannot fill an evidence gap; keep "No recommendation yet" when the evidence is missing. Say plainly what changed from the original recommendation and why.

When a branch is really a choice, return 2–4 substantively different, feasible options rather than burying the comparison in the body. Never pad the list; if only one option is realistic, give it with `optionsLimit` saying why. Recommend one option conditionally, with its main trade-off and what would change your mind, or use `optionId: null` and say what is missing. A recommendation is your judgement, not a decision. A `suggestedAnswer` is a draft the user may adopt, never their answer; when the choice is theirs, also ask one question so the suggestion has somewhere to go.

## Flagged and cleared findings

A finding the user marked "Still holds" (`reaffirmedAt`) was re-checked by the user against the change, not re-researched. A `cleared` finding is kept for history but is no longer relied on; do not build on it unless the user accepts it again.

## Preserve the status of each claim

Keep four things distinguishable in concise prose:

- **User statements and preferences:** what the user actually said, including constraints and decisions. A preference can guide the work without being a universal fact.
- **Evidence:** a concrete observation or consulted source tied to the claim it supports or challenges. Include relevant conditions, dates, or scope when they affect applicability.
- **Interpretation:** what you infer from that evidence, the key assumption, and what would change the interpretation. Plausibility is not verification. Put the key interpretations a finding rests on in the result's `assumptions`, each with what would change it, so the user's assumptions register lists them. Never put the user's preferences there, and never mark a user's answer as an Assumption: only the user sets how sure an answer is.
- **Unresolved points:** the specific uncertainty, why it matters, and the smallest useful way to resolve it.

List only the few claims that matter for the decision in the result's `claims`. Link a claim only to a passage you actually read that supports it, and leave its support empty rather than stretch a citation. A source that only mentions the topic is not support, and passages that challenge a claim belong in the findings, not as its support. Never add a source just to avoid the "reasoning" label.

Use these distinctions where needed rather than filling a mandatory template. Research to the depth needed for the selected question, using primary sources when available. A source link without a supported claim adds little. Do not manufacture sources, consensus, test results, or precision. A supported finding can still be unreviewed; acceptance belongs to the user.

Record material disagreements and gaps as `limitations` in the result, not only inside the findings:

- A `conflict` is sources that disagree. Explain it by scope, date or method only when the evidence shows that; otherwise say the cause is unknown. Never settle it by counting sources or by inventing confidence. Pages that repeat or cite each other are not independent.
- `missing-evidence` is something you looked for and did not find. Say what you looked for.
- Each gives a next step the user can act on: a concrete check, a small experiment or a question. Never "accept the agent's view".
- Mark `blocksRecommendation` only when the gap prevents any justified choice between the options.

When a prior premise changes, check relevant dependency links and stale findings before building on them. Keep prior work and its reasons visible. Save the result's rationale and evidence, not a transcript of private reasoning.

When you cite a source, say whether it `supports` the finding, `challenges` it or gives `context`, in its `stance`. Record a challenge honestly: a source cited against the finding is evidence too, and the user's source library flags sources that back findings contradicting each other.

## Use the map's words

Use the packet's `glossary` terms as the user defined them, in questions, findings and suggestions. Propose a term in the result's `glossary` only when the exploration has settled on a meaning worth keeping, not for every noun; the user decides whether it counts.

## Keep private details out of searches

Search queries and fetched URLs leave the machine, and the host's tools may log them. Explore cannot see or filter them, so this rests with you.

- **Treat as private:** names of people (the user, colleagues, clients, family); organisation, product or project names the user has not described as public; private figures such as budgets, salaries, revenue, negotiated prices or headcounts; addresses or locations finer than a city; health, legal or financial circumstances; internal hostnames, URLs and file paths; and any detail from the user's answers that could identify them. Credentials never leave the machine.
- **Public names are fine** when the question is about them: a published library, a commercial product, a public standard, or a public figure in their public role.
- **Generalise before searching.** "Acme's 40k budget for a 12-person team" becomes "typical cost of a field notebook app for a small team". Search for the public fact the decision needs.
- **URLs follow the same rule.** Do not build fetch URLs or query strings that contain private details, and do not paste map text into a search box.
- **When unsure whether a detail is private, treat it as private.**
- **If a search is not useful without a private detail, do not run it.** Record it as a `missing-evidence` limitation: say which check was skipped and what kind of detail it needed (not the detail itself), with how the user could check it themselves as the next step.
- A user's explicit statement in an answer that a named detail may be searched is permission for that detail only.

## Stop with a useful result

When the packet's `selected.doneWhen` is set, the user has said what would be enough for this branch, such as "a shortlist of two" or "a yes or no". Aim for it and stop when it is met; offer further work only as inactive suggestions. If it cannot be met, ask a question when a user choice is needed; otherwise finish and say what is missing and why. The summary states whether the stopping point was met.

Without `doneWhen`, judge what would count as enough for this branch before investigating further. Completion may mean a comparison that enables a choice, a bounded explanation, a tested hypothesis, or a concrete next experiment. Stop when further work is unlikely to change that outcome within the user's scope; explicitly leave residual uncertainty rather than implying exhaustive research.

A result should say what was learned, why it matters for the goal, what remains uncertain, and any distinct next directions. The summary should carry the main conclusion or current blocking point. The body should preserve enough evidence and reasoning to be useful after the chat is gone; avoid repeating the packet or padding every section. Do not close an unresolved branch merely to reset its job. Use questions for a real user dependency and `fail` for an execution block.

When the session ends, give a short handoff: the map identifier or URL, the selected branch's state, the key unresolved point, and the action that resumes work. Do not claim queued work will run after the agent leaves, or continue investigating because another interesting topic appeared.

## Challenging decisions

When the user asks you to challenge their answers, argue in good faith against the answers you were given, and only those. Name what matters to the decision: hidden assumptions, counter-arguments, overlooked alternatives and evidence gaps. Do not manufacture objections when none matter, treat missing context as missing rather than as evidence against a choice, and cite only sources you actually read. What you return are hypotheses for the user to consider: never ask them to change an answer.
