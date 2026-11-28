import { handoffDialogHtml, handoffFileText, handoffFilename, HANDOFF } from './handoff.js';
import { recordDraftDialog } from './record-drafts.js';
import { cssQuote as quote } from './dialog-focus.js';

// The Implementation handoff dialog (F4), opened from Map tools, on the shared draft dialog (record-drafts.js): pick what
// to write and the records it rests on, preview what the agent reads, queue it, edit and accept the result. Its own
// part: the format, and Copy and Download, which give the accepted text with Explore's footer, on the live map only.
// `download(text, type, name)` saves a file.
export function handoffDialog({ map, act, api, esc, toast, live, listening, download }) {
  return recordDraftDialog({ prefix: 'handoff', type: HANDOFF, map, act, api, esc, toast, live, listening, html: handoffDialogHtml, extra: {
    initial: () => ({ format: 'brief' }),
    request: state => ({ options: { format: state.format } }),
    openFocus: ['#handoff-format'],
    words: { queued: listening => (listening ? 'Your agent will write the handoff next.' : 'Queued. Connect your agent to write the handoff.'), accepted: 'Accepted. Copy or download it when you are ready.' },
    acceptedFocus: itemId => `[data-handoff-copy="${quote(itemId)}"]`,
    change: (event, ctx) => {
      if (event.target.id !== 'handoff-format') return false;
      ctx.state.format = event.target.value;
      if (ctx.state.preview) { ctx.state.preview = null; ctx.render(); } // A new format needs a new preview.
      return true;
    },
    click: async (event, target, ctx) => {
      const itemId = target.dataset.handoffCopy || target.dataset.handoffDownload; if (!itemId) return;
      const shown = ctx.map(), proposal = (shown.proposals ?? []).find(entry => entry.id === target.dataset.proposal && entry.type === HANDOFF), item = proposal?.items.find(entry => entry.id === itemId);
      if (!live() || item?.review !== 'accepted') return; // Only an accepted handoff leaves Explore, from the live map.
      const text = handoffFileText(shown, proposal, item);
      if (target.dataset.handoffDownload) { download(text, 'text/markdown;charset=utf-8', handoffFilename(item.title)); toast('Downloaded as Markdown.'); return; }
      try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copying is not available here.'); }
    },
  } });
}
