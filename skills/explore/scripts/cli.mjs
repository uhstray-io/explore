import path from 'node:path';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { atomicJson } from './store.mjs';
import { runDoctor, readConnection } from './doctor.mjs';
import { runtimePath } from './server-lock.mjs';
import { catalogRevision } from './search.mjs';
import { goalOf } from '../assets/guidance.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${name} requires a value.`);
  return args[i + 1];
};
const required = name => { const value = option(name); if (!value) throw new Error(`--${name} is required.`); return value; };
// Commands whose reply carries Markdown: --format markdown prints it as it is; json prints the rest of the reply.
const outputFormat = () => { const format = option('format', 'json'); if (!['json', 'markdown'].includes(format)) throw new Error('--format must be json or markdown.'); return format; };
function inFormat(output, format, name) {
  if (format === 'json') { delete output.markdown; return undefined; }
  if (typeof output.markdown !== 'string') throw new Error(`The server did not provide a Markdown ${name}.`);
  return output.markdown;
}
const usage = `Explore agent bridge (Node 20+)\n\nCommands:\n  doctor                                 Read-only setup/reconnection diagnostics; server optional\n  doctor --support [--out FILE]          A redacted report to attach to a bug report; --out writes a new file\n  status                                 Local address, bridge status, first map page\n  maps [--query TEXT] [--offset N --revision ID] [--limit 20]\n  maps --query TEXT --content          Search every map's ideas, answers and sources\n  maps --archived include|only           List archived maps too, or only them\n  create --file idea.json                 {title, idea, mode?, objective?, successCriteria?}\n  export --map ID --out FILE               Complete map as JSON (no claim data); refuses to overwrite\n  export --map ID --out FILE --format mermaid|canvas|svg|print [--node ID]\n                                         A diagram or printable page of the map, or of one idea and all below it\n  import --file FILE [--as-copy]          Import an export or map.json; prints a conflict instead of choosing\n  next --wait 25 --worker codex [--map ID]\n  result --job ID --file findings.json     {summary, body, questions?, suggestions?, sources?, links?, options?, recommendation?, limitations?, claims?, glossary?, hypothesis?}\n  result --job ID --file F --check        Check a result against the exploration rules without saving it\n  fail --job ID --reason "..."\n  read --map ID [--query TEXT] [--offset N --revision N] [--limit 20]\n  read --map ID --node ID [--section summary|premise|findings|questions|sources|options|limitations|claims|relationships]\n       [--query TEXT | --question ID] [--offset N --revision N] [--limit 4000]\n  brief --map ID [--node ID] [--format json|markdown]\n  changes --map ID [--since REF] [--format json|markdown]  What changed since a Git commit (read-only)\n  usage [--map ID]                        Recorded CLI output sizes, not model tokens; server optional\n  act --map ID --file action.json         Requires expectedRevision\n\nAll commands accept --workspace PATH. Commands other than doctor/help/usage require an active server.\nOnly user-activated jobs are returned. Claims are saved locally for result delivery.\nList pages return at most 40 entries. Continue with nextOffset and revision using the same query.\nNode section reads return bounded text excerpts; --limit counts characters there.`;
const secrets = [];
const page = (items, revision, fields = ['title']) => {
  const integer = (name, fallback, min, max) => {
    const raw = option(name, String(fallback));
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
    return Number(raw);
  };
  const offset = integer('offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer('limit', 20, 1, 40);
  if (offset && option('revision') === undefined) throw new Error('Continuation requires --revision from the previous page.');
  if (option('revision') !== undefined && option('revision') !== String(revision)) throw new Error('This list changed. Restart the read at offset 0, then continue with its new revision.');
  const query = option('query', '').toLocaleLowerCase();
  const matches = query ? items.filter(item => fields.some(field => String(item[field] || '').toLocaleLowerCase().includes(query))) : items;
  const selected = matches.slice(offset, offset + limit);
  return { revision, total: items.length, matching: matches.length, offset, nextOffset: offset + selected.length < matches.length ? offset + selected.length : null, items: selected };
};
try {
  const workspace = path.resolve(option('workspace', process.cwd()));
  const runtime = runtimePath(workspace);
  if (command === 'help' || args.includes('--help')) { console.log(usage); }
  else if (command === 'doctor') {
    const { stdout, stderr } = await runDoctor({ workspace, support: args.includes('--support'), out: option('out') });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } else {
    if (!['status', 'maps', 'create', 'next', 'result', 'fail', 'read', 'brief', 'changes', 'usage', 'act', 'export', 'import'].includes(command)) throw new Error(usage);
    const connection = command === 'usage' ? null : await readConnection(workspace);
    if (connection) secrets.push(connection.token);
    async function api(route, data) {
      const response = await fetch(connection.address + route, { method: data ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${connection.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
        ...(data ? { body: JSON.stringify(data) } : {}), redirect: 'error', signal: AbortSignal.timeout(35000) });
      const value = await response.json();
      if (!response.ok) throw new Error([value.error, ...(value.errors || []).map(e => `- ${e.code} ${e.field}: ${e.message}`)].join('\n'));
      return value;
    }
    const input = async () => JSON.parse(await readFile(path.resolve(required('file')), 'utf8'));
    const claimPath = jobId => {
      if (!/^job-[a-f0-9]{8}$/.test(jobId)) throw new Error('Invalid job identifier.');
      return path.join(runtime, 'claims', `${jobId}.json`);
    };
    let output, rendered;
    switch (command) {
      case 'status': case 'maps': {
        // --content searches every map's text instead of titles and IDs (I1).
        if (command === 'maps' && args.includes('--content')) {
          const query = new URLSearchParams({ query: required('query'), offset: option('offset', '0') });
          for (const name of ['limit', 'revision']) if (option(name) !== undefined) query.set(name, option(name));
          output = await api(`/api/search?${query}`); break;
        }
        const value = await api(`/api/maps?archived=${encodeURIComponent(option('archived', 'exclude'))}`);
        const revision = catalogRevision(value.maps);
        const { items, ...paging } = page(value.maps, revision, ['id', 'title']);
        output = { ...(command === 'status' ? { address: connection.address, bridge: value.bridge } : {}), ...paging, maps: items };
        break;
      }
      case 'create': { const m = await api('/api/maps', await input()); output = { mapId: m.id, rootId: m.rootId, revision: m.revision }; break; }
      case 'next': {
        const query = new URLSearchParams({ wait: option('wait', '0'), worker: option('worker', 'agent') });
        if (option('map')) query.set('map', option('map'));
        output = await api(`/api/next?${query}`);
        if (output.jobId) {
          await mkdir(path.join(runtime, 'claims'), { recursive: true });
          await atomicJson(claimPath(output.jobId), { mapId: output.mapId, jobId: output.jobId, claimKey: output.claimKey });
          delete output.claimKey; // The agent does not need to carry this in its context.
        }
        break;
      }
      case 'result': case 'fail': {
        const claim = JSON.parse(await readFile(claimPath(required('job')), 'utf8'));
        if (typeof claim.claimKey === 'string') secrets.push(claim.claimKey);
        const check = command === 'result' && args.includes('--check');
        const payload = command === 'result' ? { ...claim, result: await input(), ...(check ? { check: true } : {}) } : { ...claim, reason: required('reason') };
        const m = await api(`/api/maps/${claim.mapId}/${command}`, payload);
        if (check) { output = { mapId: claim.mapId, ...m }; if (!m.ok) process.exitCode = 1; break; } // So `result --check && result` stops.
        output = { saved: true, mapId: m.id, revision: m.revision, job: m.jobs.find(j => j.id === claim.jobId)?.status,
          stale: m.jobs.find(j => j.id === claim.jobId)?.stale || false, warnings: m.warnings };
        break;
      }
      case 'read': {
        if (option('node')) {
          const query = new URLSearchParams({ node: option('node') });
          for (const name of ['section', 'query', 'question', 'offset', 'limit', 'revision']) if (option(name) !== undefined) query.set(name, option(name));
          output = await api(`/api/maps/${required('map')}/context?${query}`);
          break;
        }
        const m = await api(`/api/maps/${required('map')}`);
        const { items, ...paging } = page(m.nodes, m.revision, ['id', 'title', 'prompt', 'summary', 'body']);
        output = { mapId: m.id, title: m.title, goal: goalOf(m), ...paging, nodes: items.map(n => ({ id: n.id, title: n.title, status: n.status, reviewState: n.reviewState, stale: !!n.stale, summary: n.summary.slice(0, 200) })), omittedNodes: paging.matching - items.length };
        break;
      }
      case 'export': {
        // json is the complete map to import again; the other formats are made here from the map, as the browser makes them.
        const out = path.resolve(required('out')), mapId = required('map'), format = option('format', 'json');
        const { exportAs, exportFormats } = await import('../assets/export-formats.js');
        if (format !== 'json' && !Object.hasOwn(exportFormats, format)) throw new Error(`--format must be json, ${Object.keys(exportFormats).join(', ')}.`);
        if (format === 'json' && option('node')) throw new Error('--node works with the diagram formats: a JSON export is always the complete map.');
        const file = format === 'json' ? null : exportAs(await api(`/api/maps/${mapId}`), format, { nodeId: option('node') ?? null });
        const text = file ? file.text : JSON.stringify(await api(`/api/maps/${mapId}/export`), null, 2) + '\n';
        try { await writeFile(out, text, { flag: 'wx' }); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('That file already exists. Choose a new --out path.'); throw error; }
        output = { exported: mapId, format, ...(file ? { ideas: file.count } : {}), file: out }; break;
      }
      case 'import': output = await api('/api/import', { data: await input(), asCopy: args.includes('--as-copy') }); break;
      case 'brief': {
        const format = outputFormat(), query = new URLSearchParams();
        if (option('node')) query.set('node', option('node'));
        output = await api(`/api/maps/${required('map')}/brief${query.size ? `?${query}` : ''}`);
        rendered = inFormat(output, format, 'brief');
        break;
      }
      case 'changes': {
        const format = outputFormat();
        output = await api(`/api/maps/${required('map')}/changes?${new URLSearchParams({ since: option('since', 'HEAD') })}`);
        rendered = inFormat(output, format, 'change summary');
        break;
      }
      case 'usage': {
        let log = '';
        try { log = await readFile(path.join(runtime, 'context-usage.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const entries = log.trim() ? log.trim().split('\n').map(line => JSON.parse(line)) : [];
        const matching = option('map') ? entries.filter(e => e.mapId === option('map')) : entries;
        output = { scope: 'Recorded CLI stdout only; not vendor tokens or active context. Excludes direct file reads, browser observations, research tools, model replies, failed commands, and host compaction.',
          commands: matching.length, characters: matching.reduce((n,e) => n + e.characters, 0), utf8Bytes: matching.reduce((n,e) => n + e.utf8Bytes, 0),
          byCommand: Object.fromEntries([...new Set(matching.map(e => e.command))].map(command => [command, { calls: matching.filter(e => e.command === command).length, characters: matching.filter(e => e.command === command).reduce((n,e) => n + e.characters, 0) }])) };
        break;
      }
      case 'act': { const m = await api(`/api/maps/${required('map')}/action`, await input()); output = { saved: true, mapId: m.id, revision: m.revision }; break; }
      default: throw new Error(usage);
    }
    rendered ??= JSON.stringify(output, null, 2);
    if (command !== 'usage') await appendFile(path.join(runtime, 'context-usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), command, mapId: output.mapId || option('map') || null,
      characters: rendered.length + 1, utf8Bytes: Buffer.byteLength(rendered + '\n') }) + '\n');
    console.log(rendered);
  }
} catch (error) {
  let message = error.message;
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  console.error(message); process.exitCode = 1;
}
