export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const { name, ingredients, instructions } = await req.json();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ instruction_steps: [], prep_steps: [] }), { status: 500 });

  const prompt = `You are a recipe assistant for a family meal planner.

Recipe: "${name}"
Ingredients: ${ingredients}
Full instructions written by the user:
${instructions}

Return a JSON object with two arrays:
1. instruction_steps: Clean, numbered cooking steps (concise, action-oriented)
2. prep_steps: Steps that can be done ahead of time, each tagged "night_before" or "morning"

Return ONLY valid JSON, no markdown:
{
  "instruction_steps": ["Step 1: ...", "Step 2: ..."],
  "prep_steps": [
    {"text": "...", "when": "night_before"},
    {"text": "...", "when": "morning"}
  ]
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) return new Response(JSON.stringify({ instruction_steps: [], prep_steps: [] }), { status: 200 });

    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '{}';
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const result = JSON.parse(fenceMatch ? fenceMatch[1].trim() : raw);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ instruction_steps: [], prep_steps: [], error: err.message }), { status: 200 });
  }
}
