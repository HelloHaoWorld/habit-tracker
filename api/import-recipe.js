export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const { url } = await req.json();
  if (!url || !/^https?:\/\//i.test(url)) {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), { status: 200 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500 });

  // Fetch the page
  let html = '';
  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    html = await pageRes.text();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Could not fetch page: ' + err.message }), { status: 200 });
  }

  // Try JSON-LD structured data (most recipe sites include this for SEO)
  let structuredSnippet = '';
  const ldMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    try {
      const parsed = JSON.parse(m[1]);
      const candidates = [parsed, ...(parsed['@graph'] || [])];
      const recipe = candidates.find(d => d && (d['@type'] === 'Recipe' || (Array.isArray(d['@type']) && d['@type'].includes('Recipe'))));
      if (recipe) {
        structuredSnippet = JSON.stringify(recipe).slice(0, 6000);
        break;
      }
    } catch (_) {}
  }

  // Strip HTML to plain text as fallback/supplement
  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 10000);

  const context = structuredSnippet
    ? `Structured recipe JSON-LD:\n${structuredSnippet}\n\nPage text:\n${plainText}`
    : `Page text:\n${plainText}`;

  const prompt = `You are a recipe parser. Extract the recipe from the following webpage content.

${context}

Return ONLY a valid JSON object, no markdown, no explanation:
{
  "name": "Recipe name",
  "description": "One sentence description of the dish",
  "ingredients": ["ingredient with quantity", "another ingredient"],
  "prep_time_minutes": 15,
  "nutrition_tags": []
}

For nutrition_tags pick any that apply from: "protein", "carb", "fat", "fiber", "fruit"
- protein: meat, fish, seafood, eggs, cheese, tofu, beans, lentils
- carb: rice, pasta, bread, noodles, tortilla, oats, grains, potato
- fat: oil, nuts, seeds, avocado, butter, cream
- fiber: vegetables (non-fruit), leafy greens, broccoli, cucumber
- fruit: fruit of any kind`;

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
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: `AI error (${res.status}): ${err}` }), { status: 200 });
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '{}';
    // Strip markdown code fences if the model wraps the JSON
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw;
    const result = JSON.parse(jsonStr);
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 200 });
  }
}
