import { listenChoices } from './listening.js';

// The agent dialog, opened from the bridge status: the prompt to paste into a coding agent, and how long that
// agent keeps listening for work (K1), a setting shared by everyone who opens the repo. Nothing here runs or
// wakes an agent; the window only applies while the agent's session stays open.
export function agentDialog({ $, api, toast, session, map }) {
  let revision = null;
  const select = $('#listen-minutes'), status = $('#agent-copy-status');
  select.innerHTML = listenChoices.map(minutes => `<option value="${minutes}">${minutes} minutes</option>`).join('');
  async function loadSetting() {
    const settings = await api('/settings').catch(() => null);
    select.disabled = !settings || !!settings.newer; // A newer Explore's settings are left alone.
    if (settings) { select.value = String(settings.listenMinutes); revision = settings.revision; }
  }
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
  return function show() {
    const where = session(), open = map();
    const target = open ? `Continue only map ${open.id} (${open.title}). Pick up activated branches for this map only.` : 'Ask me which saved map to continue, then pick up its activated branches.';
    $('#agent-prompt').value = `Use the Explore skill at ${where.skillPath || 'skills/explore/SKILL.md'} to continue the workspace ${where.workspacePath || where.workspace || ''}. The local app is running. ${target} Use the command bridge, keep context focused, and send findings and questions back to the map.`;
    status.textContent = ''; loadSetting(); $('#help-dialog').showModal();
  };
}
