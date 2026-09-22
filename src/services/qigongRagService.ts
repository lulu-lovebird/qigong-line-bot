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
const RAG_TIMEOUT_MS = parseInt(process.env.RAG_TIMEOUT_MS || '15000', 10);
const RAG_FEEDBACK_ENABLED = process.env.RAG_FEEDBACK_ENABLED !== 'false';

/**
 * Generate intelligent coach feedback after check-in based on methods practiced & student notes.
 */
export async function generateCheckinFeedback(
    methodNames: string[],
    practiceNote: string
): Promise<string | null> {
    if (!RAG_FEEDBACK_ENABLED) return null;
    const note = practiceNote?.trim();
    if (!note || note.length < 3) return null;

    const methodsText = methodNames.length > 0 ? methodNames.join('、') : '氣功練習';
    const prompt = `學員今日打卡練習功法：【${methodsText}】\n學員體感與心得紀錄：${note}\n\n請以白雁氣功專業教練的角度，根據參考資料，對學員今日練習的功法與體感心得進行簡短（約100~150字）、溫暖且具科學學理根據的鼓勵與分析回饋。若體感提到發熱、微汗、酸麻、排氣、打哈欠、微痛等反應，請結合氣功排濁、氣攻病灶或好轉反應原理給予適當解析。`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
        const res = await fetch(RAG_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: prompt }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => 'unknown');
            console.warn(`[qigong-rag] feedback call failed HTTP ${res.status}: ${errText}`);
            return null;
        }

        const data = (await res.json()) as RagChatResponse;
        const answer = data.answer?.trim();
        console.log(`[qigong-rag] generated checkin feedback in ${Date.now() - startedAt}ms (${answer?.length || 0} chars)`);
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
            body: JSON.stringify({ message: q }),
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
