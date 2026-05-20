export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const { name, description, ingredients } = await req.json();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ steps: [] }), {
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a meal prep assistant for a school lunchbox.
Given this recipe description: "${description}"
Recipe name: "${name}"
Ingredients: "${ingredients}"

Generate a JSON array of prep steps. Each step: { "text": "step description", "when": "night_before" | "morning" }.
Night before = can be done the evening before. Morning = must be done the morning of.
Return ONLY the JSON array, no markdown, no backticks, no explanation.`
        }]
      })
    });

    if (!anthropicRes.ok) return new Response(JSON.stringify({ steps: [] }), {
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await anthropicRes.json();
    const text = data.content?.[0]?.text?.trim() || '[]';
    const steps = JSON.parse(text);
    return new Response(JSON.stringify({ steps }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch {
    return new Response(JSON.stringify({ steps: [] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
