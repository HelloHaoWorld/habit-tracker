export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const { recipes, pantryItems, dates } = await req.json();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not set' }), { status: 500 });

  const recipeSummary = recipes.length
    ? recipes.map(r => `- ${r.name}: ${r.description || ''}`).join('\n')
    : 'None yet.';

  const pantrySummary = pantryItems.length
    ? pantryItems.map(p => `- ${p.name}`).join('\n')
    : 'None.';

  const prompt = `You are a school lunchbox meal planner. Plan simple, kid-friendly lunches for these weekdays: ${dates.join(', ')}.

Each lunch MUST include all three:
1. A protein (chicken, egg, tuna, cheese, beans, etc.)
2. A carb (rice, pasta, bread, tortilla, etc.)
3. A healthy oil (olive oil drizzle, avocado, nuts, hummus, etc.)

Existing recipes to reuse when suitable:
${recipeSummary}

Pantry items already available (exclude from grocery list):
${pantrySummary}

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "meals": [
    {
      "date": "YYYY-MM-DD",
      "name": "Meal name",
      "description": "One sentence description",
      "ingredients": "ingredient1, ingredient2, ingredient3",
      "nutrition_tags": ["protein", "carb", "fat"]
    }
  ],
  "groceryList": {
    "Proteins": ["Chicken breast (400g)", "Eggs (6)"],
    "Grains & Carbs": ["Brown rice (2 cups)"],
    "Vegetables & Fruit": ["Cucumber (2)", "Cherry tomatoes (1 punnet)"],
    "Dairy": ["Cheddar cheese (100g)"],
    "Pantry & Other": ["Olive oil", "Soy sauce (small bottle)"]
  }
}

Use category names that make sense for the items. Common categories: "Proteins", "Grains & Carbs", "Vegetables & Fruit", "Dairy", "Pantry & Other". Only include a category if it has items. Only include items NOT already in pantry. Be specific with quantities for ${dates.length} lunches. Consolidate duplicates.`;

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
