export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are a warm, insightful habit coach. Analyze the user's habit tracking data and provide 3-4 personalized insights.

For each insight:
- Reference actual numbers or patterns from their data
- Be encouraging about what's working
- Give one concrete, actionable suggestion

Format each insight as:
**[relevant emoji] Insight title**
Your observation and suggestion in 1-2 sentences.

Keep the total response under 300 words. Be direct and warm.`;

function buildUserMessage(goals) {
  const summaries = goals.map(g => {
    const recent = g.recent30Days
      .filter(d => d.result !== 'not logged')
      .slice(0, 14);
    const recentStr = recent.length
      ? recent.map(d => d.result === 'hit' ? '✓' : '✗').join(' ')
      : 'no logs yet';
    return `${g.emoji} ${g.name}${g.description ? ` — ${g.description}` : ''}
  Streak: ${g.streak} days | Best: ${g.bestStreak} days | Rate: ${g.successRate !== null ? g.successRate + '%' : 'n/a'} | Total: ${g.totalLogged} days
  Recent (newest first): ${recentStr}`;
  }).join('\n\n');

  return `My habit data:\n\n${summaries}\n\nPlease give me personalized insights.`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 });
  }

  const { goals } = body;
  if (!goals?.length) {
    return new Response(JSON.stringify({ error: 'No goal data' }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      `data: ${JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in Vercel environment variables.' })}\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      stream: true,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(goals) }],
    }),
  });

  if (!anthropicRes.ok) {
    return new Response(
      `data: ${JSON.stringify({ error: `AI error (${anthropicRes.status})` })}\ndata: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = anthropicRes.body.getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`)
                );
              }
            } catch { /* skip malformed lines */ }
          }
        }
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    },
  });
}
