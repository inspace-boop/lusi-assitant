import { NextResponse } from 'next/server';
import { Anthropic } from '@anthropic-ai/sdk';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Using standard fetch for Atlassian REST APIs as requested

const queryCache = new Map();
const CACHE_MAX_SIZE = 20;
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes

let totalRequests = 0;
let cacheHits = 0;

function getCacheKey(searchTerms, jiraProjects, confluenceSpaces) {
  return `${searchTerms?.toLowerCase() || ''}|${(jiraProjects || []).join(',')}|${(confluenceSpaces || []).join(',')}`;
}

function getFromCache(key) {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  if (queryCache.size >= CACHE_MAX_SIZE) {
    // Delete oldest entry (first item in the Map iterator)
    const firstKey = queryCache.keys().next().value;
    queryCache.delete(firstKey);
  }
  queryCache.set(key, { value, timestamp: Date.now() });
}

function selectModel(intent, searchTerms) {
  const isSimple = (
    intent.prioritize[0] === 'jira' ||
    intent.prioritize[0] === 'rules' ||
    (searchTerms && searchTerms.split(' ').length <= 3)
  );
  const model = isSimple ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6';
  console.log(`Model selected: ${model} (simple: ${isSimple})`);
  return model;
}

function extractSnippet(fullText, searchTerms, contextSize = 1500) {
  if (!fullText) return '';
  
  const cleanText = fullText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const terms = searchTerms.toLowerCase().split(' ').filter(t => t.length > 3);
  
  if (terms.length === 0) return cleanText.substring(0, contextSize * 2);

  // Find all match indices for all terms
  const matchIndices = [];
  const lowerText = cleanText.toLowerCase();
  
  for (const term of terms) {
    let pos = lowerText.indexOf(term);
    while (pos !== -1) {
      matchIndices.push(pos);
      pos = lowerText.indexOf(term, pos + term.length);
      if (matchIndices.length > 50) break; // Safety cap
    }
  }

  if (matchIndices.length === 0) {
    return cleanText.substring(0, contextSize * 2);
  }

  // Sort and pick top 2 distinctive matches (at least contextSize apart if possible)
  matchIndices.sort((a, b) => a - b);
  const bestMatches = [matchIndices[0]];
  for (let i = 1; i < matchIndices.length; i++) {
    if (matchIndices[i] > bestMatches[bestMatches.length - 1] + contextSize) {
      bestMatches.push(matchIndices[i]);
      if (bestMatches.length >= 2) break;
    }
  }

  // Generate snippets
  const snippets = bestMatches.map(bestIndex => {
    const start = Math.max(0, bestIndex - contextSize);
    const end = Math.min(cleanText.length, bestIndex + contextSize);
    const prefix = start > 0 ? '...' : '';
    const suffix = end < cleanText.length ? '...' : '';
    return prefix + cleanText.substring(start, end) + suffix;
  });

  return snippets.join('\n---\n').substring(0, 3000);
}

async function classifyQueryIntent(userMessage) {
  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    system: `You are a search query optimizer for a university rover engineering team's Atlassian workspace. 
Classify the user's query and return ONLY a JSON object with these fields:
- "searchTerms": 1-2 PRIMARY NOUN KEYWORDS. STRIP ALL CONVERSATIONAL FILLER. If multiple terms are generated, separate them by a comma.
  Example: "can you tell me the status of the waveshare board jim ordered?" -> "waveshare board"
- "prioritize": array of "confluence", "jira", "rules" in priority order.
- "jiraProjects": array of relevant Jira project keys from ["LP", "AD", "OSP", "URC"].
- "confluenceSpaces": array of relevant space keys from ["AD", "Osprey", "URC"].
 
If the user mentions a specific date (e.g. "4/17", "April 17", "last Tuesday"), extract that date in both numeric (4/17) and written (April 17) formats and include both in searchTerms (comma separated). For Confluence, generate a title-focused CQL query.

LUSI SUBSYSTEMS:
- DCS: Drive, Chassis, Suspension (Mobility)
- ARM: Robotic Arm, Manipulation
- SCIENCE: Life detection, payload
- COMMS: Ubiquiti, communication systems
- AUTONOMY: Software stack, GNSS, SLAM

CRITICAL: Return NO text before or after the JSON. Return NO more than 2 search terms (unless adding dual date formats).

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
    
    const isDateQuery = /\d{1,2}\/\d{1,2}/.test(query) || /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(query);
    let cqlCondition;
    if (isDateQuery) {
      const terms = query.split(',').map(t => t.trim()).filter(Boolean);
      cqlCondition = `(${terms.map(t => `title ~ "${t}"`).join(' OR ')})`;
    } else {
      cqlCondition = `(title ~ "${query}" OR text ~ "${query}")`;
    }

    url.searchParams.append('cql', `${cqlCondition} AND space IN (${spaces}) ORDER BY lastmodified DESC`);
    url.searchParams.append('limit', '3'); // Reduced for cost
    url.searchParams.append('expand', 'space,body.view');

    let res;
    try {
      res = await fetch(url.toString(), { headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' } });
    } catch (err) {
      console.error("Fetch error:", err);
      return '';
    }
    
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Confluence error ${res.status}:`, errText);
      return '';
    }
    
    let data = await res.json();
    
    // Fallback: if no results with spaces, try without space filter
    if (data.results && data.results.length === 0) {
      const fallbackUrl = new URL(`https://${domain}/wiki/rest/api/content/search`);
      fallbackUrl.searchParams.append('cql', `${cqlCondition} ORDER BY lastmodified DESC`);
      fallbackUrl.searchParams.append('limit', '3'); // Reduced for cost
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

    if (!data.results) return '';

    return data.results.map(r => {
      const bodyText = r.body?.view?.value || '';
      const snippet = extractSnippet(bodyText, query, 1500);
      return `<page space="${r.space?.key || 'Unknown'}" title="${r.title}" url="${r._links.base}${r._links.webui}">${snippet}</page>`;
    }).join('\n');
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
    url.searchParams.append('maxResults', '3'); // Reduced for cost
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
      return `<issue id="${issue.key}" title="${issue.fields?.summary || 'Untitiled'}" status="${issue.fields?.status?.name || 'Unknown'}"${assigneeStr}>${descSnippet.substring(0,300)}...</issue>`;
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
      return { rulesText: '[Rules skipped: Missing Config]', memoryText: '[Memory skipped: Missing Config]', sarText: '', driveText: '', youtubeText: '' };
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

    // Search rules namespace (Current Year only for cost optimization)
    const rulesResCurrent = await index.namespace('urc_rules').query({ 
      topK: 2, 
      vector: queryVector, 
      includeMetadata: true,
      filter: { year: { "$eq": currentYear } }
    });

    const allRules = rulesResCurrent?.matches || [];
    
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
    const memRes = await index.namespace('memory').query({ topK: 2, vector: queryVector, includeMetadata: true });
    memoryText = memRes.matches.map(m => `<memory date="${m.metadata.date}" subsystem="${m.metadata.subsystem}" outcome="${m.metadata.outcome}">\nProblem: ${m.metadata.problem}\nSolution: ${m.metadata.solution}\n</memory>`).join('\n');

    // Detect Intent
    const isComparison = /compared to|versus|vs|last year|changes|evolution|since|difference|architecture|what was|how did|2025|2024/i.test(query);
    const isTimelineQuery = /when|deadline|schedule|timeline|date|finish|complete|margin|milestone/i.test(query);
    // Detect team/engineering queries that benefit most from video context
    const isTeamQuery = /lusi|byu|wvu|rose|mit|cu|csm|und|ucf|tamu|ncsu|west virginia|colorado|notre dame|team|presented|presentation|video|spoke|discussed|mentioned|said|explained/i.test(query);
    
    // Search SAR reports namespace with Temporal Tiering & Knowledge Filtering
    let sarText = "";
    const sarTopK = isTimelineQuery ? 6 : 12;
    
    // Search YouTube transcripts namespace — separate from PDFs so they always get a fair shot
    const ytTopK = isTeamQuery ? 6 : 3;
    
    const [sarCurr, sarHist, ytRes] = await Promise.all([
      index.namespace('sar_reports').query({ topK: sarTopK, vector: queryVector, filter: { year: { "$eq": currentYear } }, includeMetadata: true }),
      index.namespace('sar_reports').query({ topK: 5, vector: queryVector, filter: { year: { "$lt": currentYear } }, includeMetadata: true }),
      index.namespace('youtube_transcripts').query({ topK: ytTopK, vector: queryVector, includeMetadata: true })
    ]);

    const filterNoise = (matches) => {
      if (isTimelineQuery) return matches;
      return matches.filter(m => m.metadata.page_type !== "visual_or_gantt");
    };

    const currText = filterNoise(sarCurr.matches).map(m => `<current_setup year="${m.metadata.year}" source="${m.metadata.source}" page="${m.metadata.page || 'N/A'}" type="${m.metadata.page_type || 'technical_text'}">${m.metadata.text}</current_setup>`).join('\n');
    const histText = filterNoise(sarHist.matches).map(m => `<historical_reference year="${m.metadata.year}" source="${m.metadata.source}" type="${m.metadata.page_type || 'technical_text'}">${m.metadata.text}</historical_reference>`).join('\n');
    sarText = currText + "\n" + histText;

    // Format YouTube results with timestamp links
    const youtubeText = (ytRes.matches || []).map(m => {
      const tsParam = m.metadata.start_time ? `&t=${Math.floor(m.metadata.start_time)}s` : '';
      const link = `${m.metadata.video_url}${tsParam}`;
      return `<youtube_clip team="${m.metadata.team}" year="${m.metadata.year}" timestamp="${m.metadata.start_ts || '?'}" subsystems="${m.metadata.subsystems || 'general'}" url="${link}">${m.metadata.text}</youtube_clip>`;
    }).join('\n');

    // Search manually ingested Google Drive namespace
    const [driveCurr, driveHist] = await Promise.all([
      index.namespace('google_drive').query({ topK: 6, vector: queryVector, filter: { year: { "$eq": currentYear } }, includeMetadata: true }),
      index.namespace('google_drive').query({ topK: 4, vector: queryVector, filter: { year: { "$lt": currentYear } }, includeMetadata: true })
    ]);
    const dCurrText = driveCurr.matches.map(m => `<google_drive_current file="${m.metadata.filename}" year="${m.metadata.year}">${m.metadata.text}</google_drive_current>`).join('\n');
    const dHistText = driveHist.matches.map(m => `<google_drive_historical_POTENTIALLY_STALE file="${m.metadata.filename}" year="${m.metadata.year}">${m.metadata.text}</google_drive_historical_POTENTIALLY_STALE>`).join('\n');
    const driveText = dCurrText + "\n" + dHistText;

    return { rulesText, memoryText, sarText, driveText, youtubeText };
  } catch(e) {
    console.error("Vector DB Error", e);
  }
  return { rulesText: '', memoryText: '', sarText: '', driveText: '', youtubeText: '' };
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

    totalRequests++;
    if (totalRequests % 10 === 0) {
      console.log(`Cache hits: ${cacheHits}/${totalRequests} (${((cacheHits / totalRequests) * 100).toFixed(1)}%)`);
    }

    const intent = await classifyQueryIntent(lastUserMessage);
    console.log('Intent classification result:', JSON.stringify(intent, null, 2));
    
    let searchTerms = intent.searchTerms;
    // Strip years from semantic search terms to prevent biasing against older documents
    const sanitizedSearchTerms = searchTerms.replace(/202\d/g, '').replace(/\b(last year|previous|current)\b/gi, '').trim() || searchTerms;
    
    const cacheKey = getCacheKey(searchTerms, intent.jiraProjects, intent.confluenceSpaces);
    
    // Skip cache for Jira (data changes often) or if no intent search terms
    const canCache = intent.prioritize[0] !== 'jira' && searchTerms;
    const cachedResponse = canCache ? getFromCache(cacheKey) : null;

    if (cachedResponse) {
      cacheHits++;
      console.log('Cache hit:', cacheKey);
      return NextResponse.json({ 
        message: cachedResponse, 
        model: 'cached',
        cached: true 
      });
    }

    console.log('Extracted search terms:', searchTerms);
    console.log('Jira projects:', intent.jiraProjects);
    console.log('Confluence spaces:', intent.confluenceSpaces);

    const jiraProjectFilter = intent.jiraProjects && intent.jiraProjects.length > 0 ? intent.jiraProjects.map(p => `"${p}"`).join(', ') : '"LP", "AD", "OSP", "URC"';
    const confluenceSpaceFilter = intent.confluenceSpaces && intent.confluenceSpaces.length > 0 ? intent.confluenceSpaces.map(s => `"${s}"`).join(', ') : '"AD", "Osprey", "URC"';

    const [confluenceData, jiraData, { rulesText, memoryText, sarText, driveText, youtubeText }] = await Promise.all([
      fetchConfluenceExcerpts(searchTerms, confluenceSpaceFilter),
      fetchJiraIssues(searchTerms, jiraProjectFilter),
      queryVectorDb(sanitizedSearchTerms)
    ]);

    const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const currentYear = new Date().getFullYear();
    const seasonThreshold = currentYear - 1;
    const systemPromptText = `You are the LUSI Rover Assistant — an AI built for the Lehigh University Space Initiative engineering team. LUSI builds a Mars rover to compete in the University Rover Challenge (URC) each year.

CURRENT DATE: ${currentDate}
CURRENT SEASON: ${currentYear}

### TEMPORAL INTEGRITY (CRITICAL)
1. **Priority**: Always prioritize data from the current year (${currentYear}). If ${currentYear} data exists for a subsystem, use it as the definitive "Current Setup."
2. **Context Tags**: You will receive data in tags like <current_setup> (Priority) and <historical_reference> (Fallback). 
3. **Stale Data Handling**: If you only find information in <historical_reference> or <google_drive_historical> tags and NO current season data is available, you MUST start that section of your response with a disclaimer:
   * "Note: ${currentYear} documentation for this subsystem is limited. The following is based on ${seasonThreshold} designs and may have been updated for the current season."
4. **Persistence of Facts**: If a current season report or task indicates that a system has been "retained," "no change," or "continued," you may ignore the disclaimer and treat the historical specs as current without the warning.
5. **Spec Dominance**: Technical descriptions in \`<current_setup>\` are the primary authority. If a detailed specification exists in a technical chapter, ignore any conflicting milestone labels or project tasks found in other sources.
6. **Subsystems**: DCS (Drive/Chassis/Suspension), Robotic Arm, Science, Autonomy/Software stack, Comms/Networking.

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

Google Drive (archived and historical files):
- Old design documents, spreadsheets, BOMs, CAD reference files
- Historical rover documentation and reports
- Budget and resource reference materials from previous years

SAR Reports (System Acceptance Reviews):
- LUSI's own past SAR reports by year
- Competitor team SAR reports for benchmarking

YouTube Transcripts (video recordings):
- LUSI and competitor team SAR/PDR presentation videos
- Each clip is tagged with subsystems discussed and a deep-link timestamp
- Use these as primary technical sources for competitor rovers if their written SAR report is unavailable. They contain spoken descriptions of their designs.

Search routing rules:
- Parts, orders, inventory, "did X arrive", "was X bought/ordered/received" → prioritize Jira LP project
- Meeting notes, design specs, documentation, goals, "what did we discuss" → prioritize Confluence URC or AD space
- Bug reports, action items, assigned tasks → prioritize Jira URC or AD project
- Old design documents, spreadsheets, BOMs, CAD reference files, budgets, historical records ("old", "previous", "spreadsheet", "BOM", "budget", "historical", "last year") → search archived Google Drive files
- SAR Reports (System Acceptance Reviews) from LUSI or competitors, competitor benchmarks, "how did we/they do X before" → search SAR reports.
- Authoritative Source: SAR reports are the primary source of truth for the rover's physical architecture and "what the rover is." Use technical overview pages (1-4) in the SAR to understand subsystem integration, design philosophy, and performance metrics.
- Competitor benchmarking & presentations: If asked about a competitor team (WVU, BYU, etc.), rely heavily on <youtube_transcripts>. These are their public SAR videos and serve as official documentation. Always include the timestamped URL when citing a clip.
- When unsure, search multiple sources simultaneously. For "BOM" or "last year's design", check both SAR reports and Google Drive.

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
7. You have access to rules from both the current (${currentYear}) and previous competition years. If a user asks about a rule that has changed between years, explicitly describe the difference.
8. Important: The <context> block provided in the latest message contains search results ONLY for that specific message. It does not contain context from previous turns. If your previous responses cited valid data that is missing from the current <context> block, DO NOT assume you hallucinated it. Trust that your past citations were based on real search results at that time.
9. Quality Preference: When answering technical questions about subsystem design, prioritize [TYPE: technical_text] snippets over [TYPE: visual_or_gantt] snippets. Gantt charts should only be used for timelines and task tracking, not as the primary source for engineering specifications.`;

    const contextBlock = `
<context>
${confluenceData ? `<confluence>\n${confluenceData}\n</confluence>` : ''}
${jiraData ? `<jira>\n${jiraData}\n</jira>` : ''}
${rulesText ? `<urc_rules>\n${rulesText}\n</urc_rules>` : ''}
${memoryText ? `<past_solutions>\n${memoryText}\n</past_solutions>` : ''}
${sarText ? `<sar_reports>\n${sarText}\n</sar_reports>` : ''}
${youtubeText ? `<youtube_transcripts>\n${youtubeText}\n</youtube_transcripts>` : ''}
${driveText ? `<google_drive>\n${driveText}\n</google_drive>` : ''}
</context>
`;

    // Map conversation history to anthropic format
    let activeMessages = messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    // Inject context into the latest user message
    activeMessages[activeMessages.length - 1].content = contextBlock + "\n\nUser question: " + activeMessages[activeMessages.length - 1].content;

    const selectedModel = selectModel(intent, searchTerms);

    const response = await anthropic.messages.create({
      model: selectedModel,
      max_tokens: 2048,
      system: systemPromptText,
      messages: activeMessages
    });

    const allContent = response.content[0].text;

    if (canCache) {
      setCache(cacheKey, allContent);
    }

    return NextResponse.json({ 
      message: allContent,
      model: selectedModel
    });
  } catch(error) {
    console.error("Chat API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
