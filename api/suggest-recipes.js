export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const { protein, carb, fiber, keyword, existingRecipes } = await req.json();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not set' }), { status: 500 });

  const constraints = [];
  if (protein) constraints.push(`- Protein: must use ${protein}`);
  if (carb)    constraints.push(`- Carb: must use ${carb}`);
  if (fiber)  constraints.push(`- Fiber: must include ${fiber}`);
  if (keyword) constraints.push(`- Style/theme: ${keyword}`);

  const existingNames = (existingRecipes || []).map(r => r.name).join(', ') || 'None';

  const prompt = `You are a school lunchbox recipe expert. Suggest exactly 5 unique, kid-friendly lunchbox recipes.

Constraints:
${constraints.length ? constraints.join('\n') : '- Open to any ingredients and styles'}

Rules for every recipe:
- Must include a protein, a carb, and a healthy fat/oil
- Must be packable in a lunchbox (no reheating or assembly at school)
- Prep time 20 minutes or under
- Kid-friendly flavors and textures

Do NOT suggest any of these already in their recipe book: ${existingNames}

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "recipes": [
    {
      "name": "Recipe name",
      "description": "One sentence description",
      "ingredients": ["ingredient 1", "ingredient 2", "ingredient 3"],
      "prep_time_minutes": 15,
      "nutrition_tags": ["protein", "carb", "fat"]
    }
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
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: `AI error (${res.status}): ${err}` }), { status: 200 });
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '{}';
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const result = JSON.parse(fenceMatch ? fenceMatch[1].trim() : raw);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
}
