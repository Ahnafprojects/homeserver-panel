// Asisten server berbasis Groq.
//
// Dua batasan yang sengaja ketat:
//   1. Hanya menjawab hal seputar SERVER INI. Pertanyaan umum ditolak.
//   2. Perintah yang mengubah keadaan selalu butuh persetujuan pengguna
//      lebih dulu — model tidak boleh mengeksekusi diam-diam.
import { docker, cpuPercent, memUsage } from './docker.js';
import * as sys from './system.js';
import * as stacks from './stacks.js';
import * as ev from './events.js';

const API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const SYSTEM = `You are a technical assistant for ONE personal home server.
The machine: an Asus K42F laptop (Intel Core i3-370M, 2 cores / 4 threads, 8 GB RAM,
SSD, 10/100 LAN) running Linux Mint, Docker, and this web panel.

ABSOLUTE RULES:
- You discuss ONLY this server: performance, containers, deployments, logs, disk,
  memory, temperature, server networking, databases, backups, server security,
  and configuration.
- A plain greeting ("hi", "halo", "hello", "thanks") or a question about what you
  can help with is NOT off-topic — reply warmly and briefly invite a question
  about the server (e.g. suggest checking status, containers, or logs).
- If asked about something genuinely unrelated to this server (politics, public
  figures, news, general trivia, recipes, general knowledge), reply EXACTLY:
  "Sorry, I can only help with this server." and stop. Do not answer partially.
  Do not give a long explanation.
- Always call the available tools to fetch real data before drawing conclusions.
  Never invent numbers or file contents. Call tools using the real function-calling
  mechanism only — never write out something like "<function=name>...</function>"
  as plain text in your reply.
- Answer in English, concise and specific. Use short bullets when helpful.
- Remember the hardware limits: a 2010-era CPU, so slow builds are normal, and a
  10/100 LAN caps transfers at roughly 12 MB/s.
- When suggesting a fix, give the concrete command.
- For anything that CHANGES state (restart, delete, deploy), call the propose_fix
  tool. Never claim you performed it yourself.`;

/* ── Alat yang boleh dipakai model ── */
const TOOLS = [
  { type: 'function', function: {
    name: 'get_system_status',
    description: 'Current CPU, memory, disk, temperature, network and uptime of the server.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'list_containers',
    description: 'All Docker containers with state, CPU and memory.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'get_container_logs',
    description: 'Last log lines of one container. Use this to diagnose errors.',
    parameters: { type: 'object', required: ['name'], properties: {
      name: { type: 'string', description: 'Container name or ID' },
      lines: { type: 'number', description: 'How many lines, default 100' } } } } },
  { type: 'function', function: {
    name: 'list_stacks',
    description: 'Deployed application stacks and how many services are running.',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'get_events',
    description: 'Recent server events (errors, warnings, deploys, security).',
    parameters: { type: 'object', properties: {
      category: { type: 'string', description: 'system, container, deploy, uptime, database, security, backup, cron' },
      count: { type: 'number' } } } } },
  { type: 'function', function: {
    name: 'get_metric_history',
    description: 'CPU/memory/disk/temperature history, to see trends rather than one moment.',
    parameters: { type: 'object', properties: {
      points: { type: 'number', description: 'Default 60, each point is 5 seconds' } } } } },
  { type: 'function', function: {
    name: 'propose_fix',
    description: 'Propose a fix for the user to approve. You do NOT execute it yourself.',
    parameters: { type: 'object', required: ['action', 'reason'], properties: {
      action: { type: 'string', enum: ['restart_container', 'stop_container', 'deploy_stack',
        'prune_docker', 'restart_service'] },
      target: { type: 'string', description: 'Container / stack / service name' },
      reason: { type: 'string', description: 'Why this is needed' },
      risk: { type: 'string', description: 'What could be disrupted' } } } } },
];

// llama-3.3 on Groq occasionally leaks a pseudo tool-call as plain text
// (e.g. "<function=list_containers></function>") instead of using the real
// tool_calls field. That never actually runs the tool — it's just garbage
// text — so strip it before it reaches the user.
function stripLeakedToolSyntax(text) {
  return String(text || '').replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '').trim();
}

async function runTool(name, args, ctx) {
  try {
    if (name === 'get_system_status') {
      const s = await sys.snapshot();
      return {
        cpu_percent: s.cpu.percent, cores: s.cpu.cores, load: s.cpu.load,
        memory_percent: s.memory.percent,
        memory_used_mb: Math.round(s.memory.used / 1048576),
        memory_total_mb: Math.round(s.memory.total / 1048576),
        swap_used_mb: Math.round((s.memory.swapUsed || 0) / 1048576),
        disk_percent: s.disk.percent,
        disk_free_gb: +(s.disk.free / 1073741824).toFixed(1),
        temp_celsius: s.temperature,
        net_in_kbps: Math.round(s.network.rxRate / 1024),
        net_out_kbps: Math.round(s.network.txRate / 1024),
        uptime_hours: +(s.uptime / 3600).toFixed(1),
      };
    }
    if (name === 'list_containers') {
      const list = await docker.listContainers();
      return await Promise.all(list.map(async (c) => {
        let cpu = 0, mem = 0;
        if (c.State === 'running') {
          try { const st = await docker.statsOnce(c.Id);
            cpu = cpuPercent(st); mem = Math.round(memUsage(st).used / 1048576); } catch {}
        }
        return { name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image,
          status: c.State, detail: c.Status, cpu_percent: cpu, memory_mb: mem };
      }));
    }
    if (name === 'get_container_logs') {
      const list = await docker.listContainers();
      const c = list.find(x => (x.Names?.[0] || '').replace(/^\//, '') === args.name
        || x.Id.startsWith(args.name));
      if (!c) return { error: 'Container not found: ' + args.name };
      const stream = await docker.logsOnce(c.Id, Math.min(args.lines || 100, 300));
      const chunks = [];
      await new Promise((r) => { stream.on('data', d => chunks.push(d));
        stream.on('end', r); stream.on('error', r); setTimeout(r, 8000); });
      const { demuxDockerStream } = await import('./docker.js');
      const text = demuxDockerStream(Buffer.concat(chunks));
      return { container: args.name, log: text.slice(-6000) };
    }
    if (name === 'list_stacks') return await stacks.listStacks();
    if (name === 'get_events') {
      return ev.list({ cat: args.category, limit: Math.min(args.count || 30, 80) })
        .map(e => ({ time: new Date(e.t).toISOString(), severity: e.sev,
          title: e.title, message: e.message }));
    }
    if (name === 'get_metric_history') {
      const pts = ctx.history.slice(-Math.min(args.points || 60, 300));
      if (!pts.length) return { error: 'History not collected yet' };
      const avg = (k) => +(pts.reduce((a, p) => a + (p[k] || 0), 0) / pts.length).toFixed(1);
      const max = (k) => Math.max(...pts.map(p => p[k] || 0));
      return { points: pts.length, range_minutes: Math.round(pts.length * 5 / 60),
        cpu: { avg: avg('c'), peak: max('c') },
        memory: { avg: avg('m'), peak: max('m') },
        disk: { avg: avg('d') },
        temp: { avg: avg('tp'), peak: max('tp') } };
    }
    if (name === 'propose_fix') {
      // Hanya dicatat sebagai usulan; eksekusi menunggu klik pengguna.
      ctx.proposals.push({ id: Math.random().toString(36).slice(2, 8), kind: 'fix', ...args });
      return { status: 'proposed_awaiting_approval', ...args };
    }
    return { error: 'Unknown tool' };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/* Jalankan tindakan yang sudah disetujui pengguna. */
export async function applyFix(action, target) {
  if (action === 'restart_container' || action === 'stop_container') {
    const list = await docker.listContainers();
    const c = list.find(x => (x.Names?.[0] || '').replace(/^\//, '') === target);
    if (!c) throw new Error('Container not found');
    await docker[action === 'restart_container' ? 'restart' : 'stop'](c.Id);
    return 'Container ' + (action === 'restart_container' ? 'di-restart' : 'dihentikan');
  }
  if (action === 'deploy_stack') {
    const code = await stacks.deploy(target, () => {});
    if (code !== 0) throw new Error('Deploy failed (code ' + code + ')');
    return 'Stack redeployed';
  }
  if (action === 'prune_docker') {
    const { dockerExtra } = await import('./docker.js');
    await dockerExtra.pruneImages(); await dockerExtra.pruneContainers();
    return 'Docker cleaned up';
  }
  if (action === 'restart_service') {
    const admin = await import('./admin.js');
    await admin.serviceAction(target, 'restart');
    return 'Service restarted';
  }
  throw new Error('Unknown action');
}

/* ── Percakapan ── */
export async function chat({ apiKey, messages, history = [] }) {
  if (!apiKey) throw new Error('Groq API key is not set. Store it in the Vault as GROQ_API_KEY.');
  const ctx = { history, proposals: [] };
  const convo = [{ role: 'system', content: SYSTEM }, ...messages];

  // Maksimum 5 putaran alat supaya tidak berputar tanpa henti.
  for (let round = 0; round < 5; round++) {
    let data;
    // llama-3.3 di Groq kadang menghasilkan pemanggilan tool yang cacat
    // formatnya (nama fungsi & argumen digabung jadi satu string), yang
    // ditolak Groq sendiri dengan error tool_use_failed. Ini glitch generasi
    // yang acak — coba ulang sekali sebelum menyerah, daripada langsung
    // menampilkan JSON error mentah ke pengguna.
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages: convo, tools: TOOLS,
          tool_choice: 'auto', temperature: 0.2, max_tokens: 1400 }),
        signal: AbortSignal.timeout(60000),
      });
      if (r.ok) { data = await r.json(); break; }
      const t = await r.text();
      const malformed = /tool_use_failed/i.test(t);
      if (malformed && attempt === 0) continue; // satu kali lagi
      if (malformed) {
        return { reply: 'The model got confused calling a tool just now. Try rephrasing '
          + 'the question, or ask again.', proposals: ctx.proposals, used: [] };
      }
      throw new Error(`Groq rejected the request (${r.status}): ${t.slice(0, 300)}`);
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Empty response from Groq');
    convo.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { reply: stripLeakedToolSyntax(msg.content) || '', proposals: ctx.proposals,
        used: convo.filter(m => m.role === 'tool').map(m => m.name) };
    }
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const result = await runTool(call.function.name, args, ctx);
      convo.push({ role: 'tool', tool_call_id: call.id, name: call.function.name,
        content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  return { reply: 'Too many inspection steps. Try a more specific question.',
    proposals: ctx.proposals, used: [] };
}
