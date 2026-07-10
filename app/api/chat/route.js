import { buildSystemPrompt, parseAIResponse } from "../../../lib/pm1-engine";

export async function POST(req) {
  try {
    const { messages, profile, thread } = await req.json();

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: buildSystemPrompt(profile, thread),
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("ERROR ANTHROPIC:", JSON.stringify(data));
      return Response.json({ error: data.error?.message || "Error de la API de Anthropic" }, { status: 500 });
    }

    const rawText = data.content?.map((c) => c.text || "").join("") || "";
    const parsed = parseAIResponse(rawText);

    return Response.json({ parsed });
  } catch (err) {
    console.error("ERROR SERVIDOR:", err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
