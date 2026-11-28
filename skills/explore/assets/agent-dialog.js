import { listenChoices } from './listening.js';

// The prompt to paste into a coding agent: continue this workspace, and this map when one is open.
export function agentPrompt(session, map) {
  const target = map ? `Continue only map ${map.id} (${map.title}). Pick up activated branches for this map only.` : 'Ask me which saved map to continue, then pick up its activated branches.';
  return `Use the Explore skill at ${session.skillPath || 'skills/explore/SKILL.md'} to continue the workspace ${session.workspacePath || session.workspace || ''}. The local app is running. ${target} Use the command bridge, keep context focused, and send findings and questions back to the map.`;
}

// The agent dialog, opened from the bridge status: the prompt, and how long that agent keeps listening for work
// (K1), a setting shared by everyone who opens the repo. Nothing here runs or wakes an agent; the window only
// applies while the agent's session stays open.
export function agentDialog({ api, toast, alerts, session, map }) {
  const $ = selector => document.querySelector(selector), select = $('#listen-minutes'), status = $('#agent-copy-status');
  const model = $('#research-model'), modelButtons = [$('#save-research-model'), $('#clear-research-model')];
  let revision = null;
  select.innerHTML = listenChoices.map(minutes => `<option value="${minutes}">${minutes} minutes</option>`).join('');
  async function loadSetting() {
    for (const control of [select, model, ...modelButtons]) control.disabled = true; // Until the current values are known, so a change never carries a stale revision.
    const settings = await api('/settings').catch(() => null);
    if (!settings) { status.textContent = 'These settings could not be loaded. Close and reopen this dialog to try again.'; return; }
    select.value = String(settings.listenMinutes); model.value = settings.researchModelHint; revision = settings.revision;
    for (const control of [select, model, ...modelButtons]) control.disabled = !!settings.newer; // A newer Explore's settings are left alone.
    if (settings.newer) status.textContent = 'These settings were saved by a newer version of Explore. Update Explore to change them.';
  }
  // The research model (Z5): a hint the agent follows only when its host can run research on that model.
  async function saveModel(value) {
    try {
      const saved = await api('/settings', { researchModelHint: value, expectedRevision: revision });
      revision = saved.revision; model.value = saved.researchModelHint;
      status.textContent = saved.researchModelHint ? `Research jobs now suggest ${saved.researchModelHint}. Only some agents can follow it.` : 'No research model is suggested. Your agent researches with its own model.';
    } catch (error) { toast(error.message); loadSetting(); }
  }
  modelButtons[0].addEventListener('click', () => saveModel(model.value));
  modelButtons[1].addEventListener('click', () => saveModel(''));
  model.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveModel(model.value); } });
  select.addEventListener('change', async () => {
    try {
      const saved = await api('/settings', { listenMinutes: Number(select.value), expectedRevision: revision });
      revision = saved.revision;
      status.textContent = `Your agent keeps listening for ${saved.listenMinutes} minutes without work, while its session stays open.`;
    } catch (error) { toast(error.message); loadSetting(); }
  });
  $('#copy-prompt').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#agent-prompt').value); status.textContent = 'Prompt copied. Paste it into your coding agent.'; }
    catch { $('#agent-prompt').focus(); $('#agent-prompt').select(); status.textContent = 'Copy the selected prompt above.'; }
  });
  // Notify me in the background (K12). Turning it on is the only thing that asks the browser; never on load.
  const notify = $('#notify-toggle'), notifyNote = $('#notify-note');
  const describeNotify = () => {
    notify.disabled = !alerts.available(); notify.checked = alerts.enabled();
    notifyNote.textContent = alerts.available() ? 'Alerts arrive only while this tab is open and an agent is listening. They name the map and the idea, never findings or answers.'
      : 'This browser will not show notifications here. The count in the tab title still works.';
  };
  notify.addEventListener('change', async () => { await alerts.setEnabled(notify.checked); describeNotify(); });
  return function show() {
    describeNotify();
    $('#agent-prompt').value = agentPrompt(session(), map());
    status.textContent = ''; loadSetting(); $('#help-dialog').showModal();
  };
}
