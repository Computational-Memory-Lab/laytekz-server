/** Mock Anthropic Messages API, for the AI error-fix tests (ANTHROPIC_BASE_URL). */

export const order = 100;

export function handle(req, res, { url, send }) {
  if (url.pathname !== '/v1/messages' || req.method !== 'POST') return false;
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const jsonText = JSON.stringify({
      explanation: 'The command \\thisisnotacommand is not defined. Removing it fixes the compile.',
      fixes: [{ file: 'main.tex', find: '\\thisisnotacommand', replace: '', note: 'remove undefined command' }],
    });
    send(200, {
      id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'text', text: jsonText }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
  });
  return true;
}
