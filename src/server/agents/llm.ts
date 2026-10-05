/**
 * The model behind the agents. One function, `turn`, sends a conversation to
 * Claude and streams the reply. A scripted stand-in (AGENTIFY_FAKE_LLM=1)
 * exists so the pipeline can be exercised end to end without credentials; it
 * is for tests and local UI work only and is never used otherwise.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AgentId } from '../../agency/types';


export interface TurnRequest {
  agent: AgentId;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /** Called with each piece of visible text as it is written. */
  onText: (delta: string) => void;
}

const env = (name: string): string | undefined => process.env[name] ?? (import.meta.env?.[name] as string | undefined);

export const isFake = (): boolean => env('AGENTIFY_FAKE_LLM') === '1';

/** Whether agents can run at all: Claude credentials are present (or the scripted stand-in is on). */
export const llmReady = (): boolean => isFake() || !!(env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN'));

export const modelId = (): string => env('AGENTIFY_MODEL') || 'claude-opus-5-5';

let client: Anthropic | undefined;

async function claudeTurn(req: TurnRequest): Promise<Anthropic.Beta.BetaMessage> {
  client ??= new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), authToken: env('ANTHROPIC_AUTH_TOKEN') });
  const stream = client.beta.messages.stream({
    model: modelId(),
    max_tokens: 64000,
    // If a safety classifier declines a request, re-run it on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: req.effort },
    // The system prompt is identical for every step an agent takes, so cache it.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools: req.tools,
    messages: req.messages,
  });
  stream.on('text', req.onText);
  return stream.finalMessage();
}

export function turn(req: TurnRequest): Promise<Anthropic.Beta.BetaMessage> {
  return isFake() ? fakeTurn(req) : claudeTurn(req);
}

/* ── scripted stand-in ─────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SECTION = `<section class="agfy-demo" aria-labelledby="agfy-demo-title-{{ section.id }}">
  <h2 id="agfy-demo-title-{{ section.id }}">{{ section.settings.heading | escape }}</h2>
  <p>{{ section.settings.text | escape }}</p>
</section>
{{ 'agfy-demo.css' | asset_url | stylesheet_tag }}
{% schema %}
{
  "name": "Demo feature",
  "settings": [
    { "type": "text", "id": "heading", "label": "Heading", "default": "Demo feature" },
    { "type": "text", "id": "text", "label": "Text", "default": "Scripted output." }
  ],
  "presets": [{ "name": "Demo feature" }]
}
{% endschema %}
`;

/** What each agent "says" and which tools it calls, by how far the task has got. */
function script(req: TurnRequest): { text: string; calls: { name: string; input: unknown }[] } {
  const has = (name: string) => req.tools.some((t) => 'name' in t && t.name === name);
  const dossierText = JSON.stringify(req.messages[0]?.content ?? '');
  // After the first exchange the scripted agents have nothing more to add.
  if (req.messages.length > 1) return { text: '', calls: [] };

  switch (req.agent) {
    case 'atlas': {
      const clientTurns = (dossierText.match(/\[Client → /g) ?? []).length;
      const hasBrief = dossierText.includes('## Brief (by Atlas)');
      if (clientTurns < 2 && !hasBrief) {
        return { text: 'Thanks, I can take this on. One thing before I brief the team: **where should this appear** (product page, cart, or somewhere else)?', calls: [] };
      }
      if (hasBrief && !has('submit_brief')) return { text: 'Noted.', calls: [] };
      return {
        text: 'Got it. I have written the brief and handed it to Forge to check for blockers before design starts.',
        calls: [{ name: 'submit_brief', input: {
          title: 'Demo feature', summary: 'A scripted brief standing in for a real one.',
          goals: ['Show the pipeline end to end'], userStories: ['As a shopper I see the demo section'],
          acceptanceCriteria: ['The section renders a heading', 'The heading text is editable in the theme editor'],
          outOfScope: ['Anything real'],
        } }],
      };
    }
    case 'forge':
      return {
        text: 'Muse: this is a plain theme section, nothing blocks it. Mind the empty-heading case.',
        calls: [{ name: 'submit_feasibility', input: {
          verdict: 'clear', approach: 'A new Online Store 2.0 section with two text settings.',
          surfaces: ['Theme section'], blockers: [], edgeCases: ['Heading left empty'], questions: [],
        } }],
      };
    case 'muse':
      return {
        text: 'Volt: one section, heading over a line of text. Spec attached.',
        calls: [{ name: 'submit_spec', input: {
          overview: 'A simple content section.', layout: '1. Heading (h2)\n2. One paragraph',
          states: ['Default', 'Empty heading: hide the h2'], responsive: 'Single column at every width.',
          accessibility: ['Section labelled by its heading'], copy: ['Heading: Demo feature'],
        } }],
      };
    case 'volt':
      return {
        text: 'Sieve: two files, a section and its stylesheet.',
        calls: [
          { name: 'write_file', input: { path: 'sections/agfy-demo.liquid', content: SECTION } },
          { name: 'write_file', input: { path: 'assets/agfy-demo.css', content: '.agfy-demo { padding: 2rem 0; }\n' } },
          { name: 'finish_build', input: { summary: 'A demo section and its stylesheet.', installNotes: 'Theme editor → Add section → Demo feature.' } },
        ],
      };
    case 'sieve':
      return {
        text: 'Both criteria pass. This adds one section you can place from the theme editor; approve it to send it to a preview theme.',
        calls: [{ name: 'submit_review', input: {
          verdict: 'pass', issues: [],
          checks: [
            { criterion: 'The section renders a heading', pass: true, note: 'h2 in sections/agfy-demo.liquid' },
            { criterion: 'The heading text is editable in the theme editor', pass: true, note: 'schema setting "heading"' },
          ],
        } }],
      };
    default:
      return { text: '', calls: [] };
  }
}

async function fakeTurn(req: TurnRequest): Promise<Anthropic.Beta.BetaMessage> {
  const { text, calls } = script(req);
  for (const word of text.split(/(?<= )/)) {
    req.onText(word);
    await sleep(25);
  }
  const content: unknown[] = [];
  if (text) content.push({ type: 'text', text });
  calls.forEach((c, i) => content.push({ type: 'tool_use', id: `fake_${Date.now()}_${i}`, name: c.name, input: c.input }));
  return {
    id: `fake_${Date.now()}`, type: 'message', role: 'assistant', model: 'scripted', content,
    stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}
