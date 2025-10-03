import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");
const SYLLABUS_LINK = Deno.env.get("SYLLABUS_LINK") || "";

// Allow different bots/files; default to syllabus.md
const CONTENT_FILE = Deno.env.get("CONTENT_FILE") || "syllabus.md";

// Canonical “page” references = Brightspace lesson/unit URLs
const LESSON_RE =
  /https:\/\/westernu\.brightspace\.com\/d2l\/le\/lessons\/\d+\/(?:lessons|units)\/\d+/g;

type Section = {
  heading: string;
  text: string;        // body text
  lessonUrls: string[]; // lesson/unit links from heading + body
};

type Index = {
  sections: Section[];
};

// -------------------------
// Utilities
// -------------------------

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for",
  "from","has","have","if","in","into","is","it","its",
  "of","on","or","that","the","their","there","these",
  "this","to","was","were","will","with","your","you",
  "about","more","than","minimum","requirements","according"
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function dedup<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// -------------------------
// Parsing / Indexing
// -------------------------

function parseMarkdownIntoSections(md: string): Section[] {
  const headingRx = /^(#{1,6})\s+(.+)$/gm;
  const matches = [...md.matchAll(headingRx)];
  const sections: Section[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index! + m[0].length;
    const end = next ? next.index! : md.length;

    const heading = m[2].trim();
    const body = md.slice(start, end);

    const headingLinks = heading.match(LESSON_RE) || [];
    const bodyLinks = body.match(LESSON_RE) || [];
    const lessonUrls = dedup([...headingLinks, ...bodyLinks]);

    sections.push({
      heading,
      text: body,
      lessonUrls
    });
  }

  return sections;
}

function buildIndex(md: string): Index {
  const sections = parseMarkdownIntoSections(md);
  return { sections };
}

// -------------------------
// Query → Section scoring
// -------------------------

function scoreSectionAgainstQuery(query: string, sec: Section): number {
  // Basic keyword overlap with phrase bonuses, and presence of lesson URLs
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;

  const hay = (sec.heading + "\n" + sec.text).toLowerCase();

  // keyword score
  let score = 0;
  for (const t of qTokens) {
    // weight heading matches higher
    if (sec.heading.toLowerCase().includes(t)) score += 3;
    if (hay.includes(` ${t} `)) score += 1;
  }

  // phrase bonuses for common academic/Q&A words
  if (/\bebo\b/i.test(query) && /\bebo\b/i.test(hay)) score += 6;
  if (/\bessay\b/i.test(query) && /\bessay\b/i.test(hay)) score += 4;
  if (/\bfaq\b/i.test(sec.heading)) score += 2;

  // Specific rubric matrix bonuses (robust to many queries that imply grading)
  const rubricPatterns = [
    /\b10\s*=\s*2\.5\b/i, /\b11\s*=\s*3\b/i, /\b12\s*=\s*4\b/i, /\b13\+\s*=\s*5\b/i
  ];
  for (const re of rubricPatterns) {
    if (re.test(hay)) score += 10;
  }

  // Only consider sections that actually have lesson URLs as canonical references
  if (sec.lessonUrls.length > 0) score += 3;

  return score;
}

function pickTopSectionsForQuery(query: string, index: Index, maxSections = 3): Section[] {
  const scored = index.sections
    .map((s) => ({ s, sc: scoreSectionAgainstQuery(query, s) }))
    .filter(({ sc }) => sc > 0)
    .sort((a, b) => b.sc - a.sc);

  const top = scored.slice(0, maxSections).map(({ s }) => s);

  // If top scores are very low, attach nothing to avoid wrong links
  if (scored.length === 0 || scored[0].sc < 6) return [];
  return top;
}

// -------------------------
// Post-process model output
// -------------------------

// Strip any Brightspace lesson/unit URLs the model tried to include in its body
function stripInlineLessonLinks(s: string): string {
  const mdLessonLink = /\[([^\]]+)\]\((https:\/\/westernu\.brightspace\.com\/d2l\/le\/lessons\/\d+\/(?:lessons|units)\/\d+)\)/g;
  let out = s.replace(mdLessonLink, "$1");
  out = out.replace(LESSON_RE, ""); // raw URLs
  out = out.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  return out;
}

function attachLinksFromQuery(query: string, answer: string, index: Index): string {
  const topSections = pickTopSectionsForQuery(query, index, 3);

  const urls = new Set<string>();
  for (const s of topSections) {
    for (const u of s.lessonUrls) urls.add(u);
  }
  if (urls.size === 0) return answer;

  const lines = Array.from(urls).map((u) => `- ${u}`);
  return `${answer}\n\nRelevant course page(s):\n${lines.join("\n")}`;
}

// -------------------------
// Server
// -------------------------

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

  // Load and index content file once per request (simple + safe; cache if needed)
  const materials = await Deno.readTextFile(CONTENT_FILE).catch(
    () => "Error loading course materials file.",
  );
  const index = buildIndex(materials);

  const messages = [
    {
      role: "system",
      content: `
You are an accurate assistant for a university course.
You have the course materials below (loaded at runtime).

Rules for answering:
- If relevant text exists, quote it verbatim (quoted or in a blockquote).
- Do not add prefatory phrases like "According to the syllabus" or "the syllabus says".
- Do not include any Brightspace lesson/unit URLs in your answer body; links will be appended by the system.
- Do not include supporting resource links unless the user explicitly asks.

Here are the materials:
${materials}
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

  // 1) Remove any inline Brightspace lesson/unit URLs the model tried to include.
  const sanitized = stripInlineLessonLinks(baseResponse);

  // 2) Attach only the lesson/unit links chosen deterministically from the QUERY.
  const withLinks = attachLinksFromQuery(body.query, sanitized, index);

  const result =
    `${withLinks}\n\nThere may be errors in my responses; always refer to the course page: ${SYLLABUS_LINK}`;

  let qualtricsStatus = "Qualtrics not called";
  if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
    const qualtricsPayload = {
      values: { responseText: result, queryText: body.query },
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
