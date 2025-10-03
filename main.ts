import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");
const SYLLABUS_LINK = Deno.env.get("SYLLABUS_LINK") || "";

// Allow different bots to use different files; default to syllabus.md
const CONTENT_FILE = Deno.env.get("CONTENT_FILE") || "syllabus.md";

// Canonical “page” references = Brightspace lesson/unit URLs
const LESSON_RE =
  /https:\/\/westernu\.brightspace\.com\/d2l\/le\/lessons\/\d+\/(?:lessons|units)\/\d+/g;

type Section = {
  heading: string;
  start: number;
  end: number;
  text: string;
  lessonUrls: string[];
};

function parseSyllabus(md: string): Section[] {
  const headingRx = /^(#{1,6})\s+(.+)$/gm;
  const sections: Section[] = [];
  const matches = [...md.matchAll(headingRx)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index! + m[0].length;
    const end = next ? next.index! : md.length;
    const heading = m[2].trim();
    const body = md.slice(start, end);

    const headingLinks = heading.match(LESSON_RE) || [];
    const bodyLinks = body.match(LESSON_RE) || [];
    const all = [...headingLinks, ...bodyLinks];
    const dedup = Array.from(new Set(all));

    sections.push({
      heading,
      start,
      end,
      text: body,
      lessonUrls: dedup,
    });
  }
  return sections;
}

function extractQuotedSnippets(answer: string): string[] {
  const snippets: string[] = [];

  for (const line of answer.split("\n")) {
    const m = line.match(/^\s*>\s*(.+)$/);
    if (m && m[1].trim().length >= 20) snippets.push(m[1].trim());
  }

  const quoteRx = /"([^"]{20,})"/g;
  let qm: RegExpExecArray | null;
  while ((qm = quoteRx.exec(answer)) !== null) {
    snippets.push(qm[1].trim());
  }

  if (snippets.length === 0) {
    for (const sent of answer.split(/\n|(?<=[.!?])\s+/)) {
      const words = sent.trim().split(/\s+/).filter(Boolean);
      if (words.length >= 12) snippets.push(sent.trim());
    }
  }

  return Array.from(new Set(snippets));
}

function findCitedSections(answer: string, sections: Section[]): Section[] {
  const snippets = extractQuotedSnippets(answer);
  if (snippets.length === 0) return [];

  const hits: Section[] = [];
  for (const s of sections) {
    const hay = (s.heading + "\n" + s.text).toLowerCase();
    let matched = false;
    for (const snip of snippets) {
      const needle = snip.toLowerCase();
      if (needle.length >= 20 && hay.includes(needle)) {
        matched = true;
        break;
      }
    }
    if (matched) hits.push(s);
  }
  return hits;
}

function attachLinksFromCitedSections(answer: string, syllabusMd: string): string {
  const sections = parseSyllabus(syllabusMd);
  const cited = findCitedSections(answer, sections);

  const urls = new Set<string>();
  for (const s of cited) {
    for (const u of s.lessonUrls) urls.add(u);
  }

  if (urls.size === 0) return answer;

  const lines = Array.from(urls).map((u) => `- ${u}`);
  return `${answer}\n\nRelevant course page(s):\n${lines.join("\n")}`;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: { query: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!OPENAI_API_KEY) {
    return new Response("Missing OpenAI API key", { status: 500 });
  }

  const syllabus = await Deno.readTextFile(CONTENT_FILE).catch(
    () => "Error loading course materials file.",
  );

  const messages = [
    {
      role: "system",
      content: `
You are an accurate assistant for a university course.
You have the full course materials below (from the file loaded at runtime).

When answering student questions:
- If relevant text exists, return it verbatim (quoted or in a blockquote).
- Do not add prefatory phrases like "According to the syllabus" or "the syllabus says".
- Only include Brightspace lesson/unit URLs (https://westernu.brightspace.com/d2l/le/lessons/...) tied to the exact section you quoted from.
- Do not include supporting resource links unless the user explicitly asks.
- Never include the same Brightspace URL more than once in a single response.
- If multiple relevant Brightspace pages apply, include all of them once each.

Here are the course materials:
${syllabus}
      `.trim(),
    },
    { role: "user", content: body.query },
  ];

  const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
    }),
  });

  const openaiJson = await openaiResponse.json();
  const baseResponse =
    openaiJson?.choices?.[0]?.message?.content || "No response from the assistant.";

  const withLinks = attachLinksFromCitedSections(baseResponse, syllabus);

  const result =
    `${withLinks}\n\nThere may be errors in my responses; always refer to the course page: ${SYLLABUS_LINK}`;

  let qualtricsStatus = "Qualtrics not called";
  if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
    const qualtricsPayload = {
      values: {
        responseText: result,
        queryText: body.query,
      },
    };
    const qt = await fetch(
      `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-TOKEN": QUALTRICS_API_TOKEN,
        },
        body: JSON.stringify(qualtricsPayload),
      },
    );
    qualtricsStatus = `Qualtrics status: ${qt.status}`;
  }

  return new Response(`${result}\n<!-- ${qualtricsStatus} -->`, {
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
