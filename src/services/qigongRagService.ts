/**
 * Qigong RAG Service Client.
 * Connects qigong-line-bot to qigong-kb-rag for:
 * 1. Post check-in intelligent coach feedback based on practice methods + feeling notes.
 * 2. 1-on-1 free-form Qigong Q&A.
 */

interface RagChatResponse {
    answer: string;
    sources: Array<{
        title: string;
        url: string;
        canonicalUrl?: string;
    }>;
}

const RAG_API_URL = (process.env.RAG_API_URL || 'http://127.0.0.1:8000/api/chat').replace(/\/$/, '');
const RAG_TIMEOUT_MS = parseInt(process.env.RAG_TIMEOUT_MS || '20000', 10);
const RAG_FEEDBACK_ENABLED = process.env.RAG_FEEDBACK_ENABLED !== 'false';

// Common Qigong physical feeling and reaction keywords to distill for Vespa search
const FEELING_KEYWORDS = [
    '丹田', '發熱', '溫熱', '微汗', '出汗', '流汗', '酸麻', '痠痛', '微痛',
    '刺痛', '排氣', '放屁', '打嗝', '打哈欠', '排痰', '流淚', '氣感',
    '氣攻病灶', '好轉反應', '排濁', '手麻', '腳麻', '頭脹', '胸悶', '放鬆',
    '心火', '平靜', '上熱下寒', '寒氣', '濕氣', '痛則不通', '通則不痛'
];

/**
 * Lightweight distillation of search keywords from practice methods and student notes.
 * Extracts 2~4 clean terms (e.g. '納氣功 丹田 溫熱') so Vespa search won't be overwhelmed.
 */
function distillSearchTerms(methodNames: string[], practiceNote: string): string {
    const matchedTerms: string[] = [];
    const note = practiceNote || '';

    // 1. Pick methods that are actually mentioned in the note, or fallback to first 1-2 methods
    const mentionedMethods = methodNames.filter(m => note.includes(m));
    if (mentionedMethods.length > 0) {
        matchedTerms.push(...mentionedMethods.slice(0, 2));
    } else if (methodNames.length > 0) {
        matchedTerms.push(...methodNames.slice(0, 2));
    }

    // 2. Extract matched feeling keywords from note (up to 3)
    const matchedFeelings = FEELING_KEYWORDS.filter(k => note.includes(k));
    matchedTerms.push(...matchedFeelings.slice(0, 3));

    // 3. Fallback if note has no specific feeling keywords
    if (matchedTerms.length === 0) {
        matchedTerms.push('氣功', '好轉反應');
    }

    return Array.from(new Set(matchedTerms)).join(' ');
}

/**
 * Generate intelligent coach feedback after check-in based on methods practiced & student notes.
 * Decouples search_query for Vespa from the full instructional prompt and student notes for LLM.
 */
export async function generateCheckinFeedback(
    methodNames: string[],
    practiceNote: string
): Promise<string | null> {
    if (!RAG_FEEDBACK_ENABLED) return null;
    const note = practiceNote?.trim();
    if (!note || note.length < 3) return null;

    const methodsText = methodNames.length > 0 ? methodNames.join('、') : '氣功練習';
    
    // 1. Distill concise search query specifically for Vespa (e.g. "納氣功 丹田 溫熱")
    const searchQuery = distillSearchTerms(methodNames, note);

    // 2. Instruction prompt for LLM
    const instruction = '請以白雁氣功專業教練助教的角度，對學員今日練習的功法與體感心得進行簡短（約100~150字）、溫暖且具科學學理根據的鼓勵與分析回饋。若體感提到發熱、微汗、酸麻、排氣、打哈欠、丹田溫熱等反應，請結合氣功排濁、氣攻病灶或好轉反應原理給予適當解析。';
    
    // 3. Background context containing full notes
    const contextText = `學員今日打卡練習功法：【${methodsText}】\n學員體感與心得紀錄：${note}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
        const res = await fetch(RAG_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: instruction,
                search_query: searchQuery,
                context_text: contextText,
                mode: 'feedback'
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => 'unknown');
            console.warn(`[qigong-rag] feedback call failed HTTP ${res.status}: ${errText}`);
            return null;
        }

        const data = (await res.json()) as RagChatResponse;
        const answer = data.answer?.trim();
        console.log(`[qigong-rag] generated checkin feedback in ${Date.now() - startedAt}ms (${answer?.length || 0} chars, query='${searchQuery}')`);
        return answer || null;
    } catch (error) {
        console.error(`[qigong-rag] feedback generation failed after ${Date.now() - startedAt}ms:`, error);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Ask a general Qigong question to knowledge base.
 */
export async function askQigongRag(question: string): Promise<RagChatResponse | null> {
    const q = question?.trim();
    if (!q) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
        const res = await fetch(RAG_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: q,
                mode: 'qa'
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            return null;
        }

        const data = (await res.json()) as RagChatResponse;
        console.log(`[qigong-rag] answered user query in ${Date.now() - startedAt}ms`);
        return data;
    } catch (error) {
        console.error(`[qigong-rag] Q&A query failed after ${Date.now() - startedAt}ms:`, error);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}
