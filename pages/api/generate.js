import OpenAI from "openai";

// Model can be changed without touching code: set OPENAI_MODEL in the environment.
const MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

const SYSTEM_PROMPT =
  "You are a data visualization assistant inside a web app. The user uploaded a dataset. " +
  "You are given its column profile and some sample rows. Be concise, concrete, and refer to real column names.";

function generatePrompt(mode, profile, question) {
  const data = `DATASET PROFILE (JSON):\n${JSON.stringify(profile)}`;
  if (mode === "suggest") {
    return (
      `${data}\n\nSuggest the single most insightful chart for this dataset. ` +
      `Reply with ONLY a JSON object with these keys: ` +
      `"type" (one of "bar","line","scatter","pie"), "x" (a column name), "y" (a numeric column name), ` +
      `"agg" (one of "sum","avg","count","none"), "title" (short chart title), "reason" (one sentence).`
    );
  }
  return `${data}\n\nQUESTION: ${question || "Summarize the most interesting patterns in this data in 3-5 bullet points."}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not set on the server. Add it to .env (local) or the host's environment variables.",
    });
  }

  const { mode = "ask", profile, question } = req.body || {};
  if (!profile || !Array.isArray(profile.columns)) {
    return res.status(400).json({ error: "Upload a dataset first." });
  }

  try {
    // Keys copied from a PDF often carry stray spaces/line breaks; strip them.
    // Copying from a PDF can also drop the hyphen where "sk-proj-" wraps to a new line; restore it.
    const apiKey = process.env.OPENAI_API_KEY.replace(/[\s"']+/g, "").replace(/^sk-proj(?!-)/, "sk-proj-");
    const openai = new OpenAI({ apiKey });
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: generatePrompt(mode, profile, question) },
      ],
      ...(mode === "suggest" ? { response_format: { type: "json_object" } } : {}),
    });
    const text = completion.choices[0]?.message?.content || "";

    if (mode === "suggest") {
      try {
        return res.status(200).json({ suggestion: JSON.parse(text) });
      } catch {
        return res.status(502).json({ error: "The model did not return valid JSON. Try again." });
      }
    }
    return res.status(200).json({ result: text });
  } catch (error) {
    console.error(error);
    const status = error?.status || 500;
    return res.status(status).json({ error: error?.message || "OpenAI request failed." });
  }
}

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };
