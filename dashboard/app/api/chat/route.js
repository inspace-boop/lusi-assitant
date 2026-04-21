import { NextResponse } from 'next/server';
import { Anthropic } from '@anthropic-ai/sdk';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Using standard fetch for Atlassian REST APIs as requested

async function classifyQueryIntent(userMessage) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    system: `You are a search query optimizer for a university rover engineering team's Atlassian workspace. 
Classify the user's query and return ONLY a JSON object with these fields:
- "searchTerms": 1-2 PRIMARY NOUN KEYWORDS. STRIP ALL CONVERSATIONAL FILLER. 
  Example: "can you tell me the status of the waveshare board jim ordered?" -> "waveshare board"
- "prioritize": array of "confluence", "jira", "rules" in priority order.
- "jiraProjects": array of relevant Jira project keys from ["LP", "AD", "OSP", "URC"].
- "confluenceSpaces": array of relevant space keys from ["AD", "Osprey", "URC"].

CRITICAL: Return NO text before or after the JSON. Return NO more than 2 searchTerms.

Classification Examples:
"what did we go over on 4/19?" -> { "searchTerms": "april 19", "prioritize": ["confluence"], "jiraProjects": ["AD"], "confluenceSpaces": ["AD", "URC"] }
"what are our EOY 2026 goals for electronics?" -> { "searchTerms": "EOY goals", "prioritize": ["confluence"], "jiraProjects": ["URC"], "confluenceSpaces": ["URC"] }`,
    messages: [{ role: 'user', content: userMessage }]
  });
  const rawText = res.content[0].text.trim();
  try {
    // Attempt to extract JSON if the model wrapped it in code blocks
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const cleanJson = jsonMatch ? jsonMatch[0] : rawText;
    return JSON.parse(cleanJson);
  } catch {
    console.warn("Intent classification failed to parse JSON. Falling back to basic keyword extraction.");
    // Emergency fallback: just take the most likely first 2 nouns/words
    const fallbackTerms = userMessage
      .replace(/[?.,!]/g, '')
      .split(' ')
      .filter(w => w.length > 3 && !['tell', 'what', 'have', 'does', 'find', 'search', 'please', 'know', 'question'].includes(w.toLowerCase()))
      .slice(0, 2)
      .join(' ');

    return {
      searchTerms: fallbackTerms || userMessage.split(' ').slice(0, 2).join(' '),
      prioritize: ['confluence', 'jira', 'rules'],
      jiraProjects: ['LP', 'AD', 'OSP', 'URC'],
      confluenceSpaces: ['AD', 'Osprey', 'URC']
    };
  }
}

async function fetchConfluenceExcerpts(query, spaces) {
  try {
    if (!process.env.ATLASSIAN_DOMAIN || !process.env.ATLASSIAN_API_TOKEN || !process.env.ATLASSIAN_EMAIL) {
      console.warn("Confluence fetch skipped: Missing Atlassian env vars.");
      return '';
    }
    const auth = Buffer.from(`${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`).toString('base64');
    
    const domain = process.env.ATLASSIAN_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = new URL(`https://${domain}/wiki/rest/api/content/search`);
    url.searchParams.append('cql', `(title ~ "${query}" OR text ~ "${query}") AND space IN (${spaces}) ORDER BY lastmodified DESC`);
    url.searchParams.append('limit', '8');
    url.searchParams.append('expand', 'space,body.view');

    const pinnedCQL = `title IN ("4/19 - Leadership Transition", "EOY Goals", "End of Year Goals", "Leadership Transition") AND space = "URC"`;
    const pinnedUrl = new URL(`https://${domain}/wiki/rest/api/content/search`);
    pinnedUrl.searchParams.append('cql', pinnedCQL);
    pinnedUrl.searchParams.append('limit', '5');
    pinnedUrl.searchParams.append('expand', 'space,body.view');

    const [res, pinnedRes] = await Promise.all([
      fetch(url.toString(), { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } }),
      fetch(pinnedUrl.toString(), { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } })
    ]);
    
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Confluence error ${res.status}:`, errText);
      return '';
    }
    
    let data = await res.json();
    if (pinnedRes.ok) {
      const pinnedData = await pinnedRes.json();
      const combined = [...(data.results || []), ...(pinnedData.results || [])];
      const seenIds = new Set();
      data.results = combined.filter(r => {
        if (!r.id || seenIds.has(r.id)) return false;
        seenIds.add(r.id);
        return true;
      });
    }
    
    // Fallback: if no results with spaces, try without space filter
    if (data.results && data.results.length === 0) {
      const fallbackUrl = new URL(`https://${domain}/wiki/rest/api/content/search`);
      fallbackUrl.searchParams.append('cql', `(title ~ "${query}" OR text ~ "${query}") ORDER BY lastmodified DESC`);
      fallbackUrl.searchParams.append('limit', '8');
      fallbackUrl.searchParams.append('expand', 'space,body.view');
      
      res = await fetch(fallbackUrl.toString(), {
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
      });
      
      if (res.ok) {
        data = await res.json();
      }
    }

    if (data.results && data.results.length > 0) {
      const pageId = data.results[0].id;
      try {
        const fullPage = await fetch(
          `https://${domain}/wiki/rest/api/content/${pageId}?expand=body.storage`,
          { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } }
        );
        if (fullPage.ok) {
          const fullData = await fullPage.json();
          data.results[0].body = { view: { value: fullData.body?.storage?.value || '' } };
        }
      } catch (err) {
        console.error("Failed full page fetch:", err);
      }
    }

    return data.results.map(r => `<page space="${r.space?.key || 'Unknown'}" title="${r.title}" url="${r._links.base}${r._links.webui}">${r.body?.view?.value?.substring(0, 8000) || ''}...</page>`).join('\n');
  } catch (e) {
    console.error("Confluence Error", e);
    return '';
  }
}

async function fetchJiraIssues(query, projects) {
  try {
    if (!process.env.ATLASSIAN_DOMAIN || !process.env.ATLASSIAN_API_TOKEN || !process.env.ATLASSIAN_EMAIL) {
      console.warn("Jira fetch skipped: Missing Atlassian env vars.");
      return '';
    }
    const auth = Buffer.from(`${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`).toString('base64');
    
    console.log('Jira auth test:', `${process.env.ATLASSIAN_EMAIL}`.length > 0, `${process.env.ATLASSIAN_API_TOKEN}`.length > 0);

    const domain = process.env.ATLASSIAN_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = new URL(`https://${domain}/rest/api/3/search/jql`);
    url.searchParams.append('jql', `project IN (${projects}) AND text ~ "${query}" ORDER BY updated DESC`);
    url.searchParams.append('maxResults', '8');
    url.searchParams.append('fields', 'summary,description,status,assignee,updated');

    console.log(`JIRA URL CONSTRUCTED: ${url.toString()}`);

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) {
      console.error(`Jira target returned ${res.status}:`, await res.text());
      return '';
    }
    const data = await res.json();
    return data.issues.map(issue => {
      // Very basic extraction of description text if format is Atlassian Document Format
      let descSnippet = 'No description';
      if (issue.fields?.description?.content && issue.fields.description.content[0]?.content) {
        descSnippet = issue.fields.description.content[0].content.map(c => c.text).join(' ');
      }
      const assigneeStr = issue.fields?.assignee?.displayName ? ` assigned to ${issue.fields.assignee.displayName}` : '';
      return `<issue id="${issue.key}" title="${issue.fields?.summary || 'Untitiled'}" status="${issue.fields?.status?.name || 'Unknown'}"${assigneeStr}>${descSnippet.substring(0,250)}...</issue>`;
    }).join('\n');
  } catch(e) {
    console.error("Jira Error", e);
    return '';
  }
}

async function queryVectorDb(query) {
  let rulesText = '';
  let memoryText = '';
  try {
    if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX) {
      console.warn("Vector DB query skipped: Missing Pinecone env vars.");
      return { rulesText: '[Rules skipped: Missing Config]', memoryText: '[Memory skipped: Missing Config]' };
    }
    const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
    const index = pinecone.index(process.env.PINECONE_INDEX);
    
    // Get embedding
    const embedRes = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
      encoding_format: "float",
    });
    const queryVector = embedRes.data[0].embedding;

    const currentYear = process.env.URC_YEAR ? parseInt(process.env.URC_YEAR) : 2026;
    const prevYear = currentYear - 1;

    // Search rules namespace (Current Year)
    const rulesResCurrent = await index.namespace('urc_rules').query({ 
      topK: 3, 
      vector: queryVector, 
      includeMetadata: true,
      filter: { year: { "$eq": currentYear } }
    });

    // Search rules namespace (Previous Year)
    const rulesResPrev = await index.namespace('urc_rules').query({ 
      topK: 2, 
      vector: queryVector, 
      includeMetadata: true,
      filter: { year: { "$eq": prevYear } }
    });

    const allRules = [...(rulesResCurrent?.matches || []), ...(rulesResPrev?.matches || [])];
    
    if (allRules.length > 0) {
      console.log('Pinecone rules sample:', JSON.stringify(rulesResCurrent.matches[0], null, 2));
    }

    rulesText = allRules.map(m => {
      const text = m.metadata.text || m.metadata.content || JSON.stringify(m.metadata);
      return `<rule year="${m.metadata.year}" section="${m.metadata.section}" task="${m.metadata.task}">${text}</rule>`;
    }).join('\n');
    if (!rulesText) {
      rulesText = "[No URC rules found — check Pinecone ingestion or queries.]";
    }

    // Search memory namespace
    const memRes = await index.namespace('memory').query({ topK: 3, vector: queryVector, includeMetadata: true });
    memoryText = memRes.matches.map(m => `<memory date="${m.metadata.date}" subsystem="${m.metadata.subsystem}" outcome="${m.metadata.outcome}">\nProblem: ${m.metadata.problem}\nSolution: ${m.metadata.solution}\n</memory>`).join('\n');

  } catch(e) {
    console.error("Vector DB Error", e);
  }
  return { rulesText, memoryText };
}


export async function POST(request) {
  try {
    console.log('Env check:', {
      hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
      hasOpenAI: !!process.env.OPENAI_API_KEY,
      hasPinecone: !!process.env.PINECONE_API_KEY,
      hasAtlassian: !!process.env.ATLASSIAN_API_TOKEN,
      domain: process.env.ATLASSIAN_DOMAIN,
      index: process.env.PINECONE_INDEX,
    });

    const { messages } = await request.json();
    const lastUserMessage = messages[messages.length - 1].content;

    const intent = await classifyQueryIntent(lastUserMessage);
    console.log('Intent classification result:', JSON.stringify(intent, null, 2));
    console.log('Extracted search terms:', intent.searchTerms);
    console.log('Jira projects:', intent.jiraProjects);
    console.log('Confluence spaces:', intent.confluenceSpaces);

    const jiraProjectFilter = intent.jiraProjects && intent.jiraProjects.length > 0 ? intent.jiraProjects.map(p => `"${p}"`).join(', ') : '"LP", "AD", "OSP", "URC"';
    const confluenceSpaceFilter = intent.confluenceSpaces && intent.confluenceSpaces.length > 0 ? intent.confluenceSpaces.map(s => `"${s}"`).join(', ') : '"AD", "Osprey", "URC"';

    const [confluenceData, jiraData, { rulesText, memoryText }] = await Promise.all([
      fetchConfluenceExcerpts(intent.searchTerms, confluenceSpaceFilter),
      fetchJiraIssues(intent.searchTerms, jiraProjectFilter),
      queryVectorDb(intent.searchTerms)
    ]);

    const systemPromptText = `You are the LUSI Rover Assistant — an AI built for the Lehigh University Space Initiative engineering team. LUSI builds a Mars rover to compete in the University Rover Challenge (URC) each year.

LUSI WORKSPACE STRUCTURE:

Confluence Spaces (documentation, notes, design specs):
- AD (Admin): Administrative docs, leadership, budgets, onboarding, meeting notes
- Osprey: Osprey cubesat subteam documentation and design specs  
- URC (University Rover Challenge): Rover engineering docs, subsystem specs, meeting notes, EOY goals, design reviews, Liam's notes, arm/drive/comms/science/power subteam pages

Jira Projects (task tracking, parts ordering, issues):
- LP (LUSI Parts): Hardware procurement, parts orders, inventory tracking, ordered/received status of components
- AD (Admin): Administrative tasks, leadership action items
- OSP (Cubesat): Cubesat/Osprey subteam tasks and issues
- URC (URC Rover): Engineering tasks, subsystem tickets, bugs, design action items

Search routing rules:
- Parts, orders, inventory, "did X arrive", "was X bought/ordered/received" → prioritize Jira LP project
- Meeting notes, design specs, documentation, goals, "what did we discuss" → prioritize Confluence URC or AD space
- Bug reports, action items, assigned tasks → prioritize Jira URC or AD project
- Cubesat/Osprey questions → prioritize Confluence Osprey space and Jira OSP project
- When unsure, search both Confluence and Jira simultaneously

Your job is to help team members:
- Find answers in LUSI's Confluence documentation and Jira tickets
- Understand URC rules, scoring criteria, and task requirements
- Recall how past rover problems were diagnosed and solved
- Make decisions grounded in the team's actual documentation

Rules you must follow:
1. Always cite your sources. For every factual claim, note whether it came from Confluence, Jira, the URC rulebook (with section number), or a past solved problem.
2. If you are not sure, say so. Do not fabricate specifications, rules, or solutions.
3. Be direct and technical. LUSI members are engineering students — skip the preamble, get to the answer.
4. If a question involves a URC rule, quote the relevant section number and summarize the rule in plain language.
5. If a similar problem was solved before (provided in <past_solutions>), surface it proactively even if the user didn't ask.
6. Subsystems you know about: arm, drive train, comms, science payload, power system, autonomy/software stack.
7. You have access to rules from both the current (${process.env.URC_YEAR || '2026'}) and previous competition years. If a user asks about a rule that has changed between years, explicitly describe the difference.
8. Important: The <context> block provided in the latest message contains search results ONLY for that specific message. It does not contain context from previous turns. If your previous responses cited valid data that is missing from the current <context> block, DO NOT assume you hallucinated it. Trust that your past citations were based on real search results at that time.`;

    const contextBlock = `
<context>
${confluenceData ? `<confluence>\n${confluenceData}\n</confluence>` : ''}
${jiraData ? `<jira>\n${jiraData}\n</jira>` : ''}
${rulesText ? `<urc_rules>\n${rulesText}\n</urc_rules>` : ''}
${memoryText ? `<past_solutions>\n${memoryText}\n</past_solutions>` : ''}
</context>
`;

    // Map conversation history to anthropic format
    let activeMessages = messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Inject context into the latest user message
    activeMessages[activeMessages.length - 1].content = contextBlock + "\n\nUser question: " + activeMessages[activeMessages.length - 1].content;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', // locked to this specific model as per spec
      max_tokens: 2048,
      system: systemPromptText,
      messages: activeMessages
    });

    return NextResponse.json({ message: response.content[0].text });
  } catch(error) {
    console.error("Chat API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
