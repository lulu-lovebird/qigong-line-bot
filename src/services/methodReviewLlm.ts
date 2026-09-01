import { db } from '../db';

type MethodMixInput = {
    totalCheckinDays: number;
    totalMatchedMethodDays: number;
    methods: Array<{
        methodName: string;
        matchedDays: number;
        attendanceRatio: number;
        compositionRatio: number;
    }>;
};

const buildPrompt = (analysis30d: MethodMixInput) => {
    const methodLines = (analysis30d.methods || [])
        .slice(0, 8)
        .map((method) => [
            `- ${method.methodName}：出現於 ${method.matchedDays} 個打卡日`,
            `占總打卡日 ${(method.attendanceRatio * 100).toFixed(1)}%`,
            `占功法配置 ${(method.compositionRatio * 100).toFixed(1)}%`
        ].join('；'))
        .join('\n');

    return {
        system: [
            '你是一位熟悉道家養生與氣功修練節奏的助教。',
            '請根據學員近30天的主功法分布資料，給出接下來的練功指引。',
            '要求：',
            '1. 使用繁體中文',
            '2. 200字以內',
            '3. 語氣溫和、鼓勵、具體',
            '4. 只根據提供的資料做判斷，不要虛構',
            '5. 重點放在功法配置、持續性、平衡性與下一步方向',
            '6. 「總打卡天數」是唯一代表學員整體打卡幾天的數字',
            '7. 單一功法的打卡日數不等於總打卡天數，不得用它代替總打卡天數',
            '8. 同一天可以修練多個功法，因此功法日次總和可能大於總打卡天數',
            '9. 若提到整體打卡天數，必須原樣使用資料中的總打卡天數，不得自行推算',
            '10. 不提供醫療診斷或療效承諾',
            '11. 直接輸出建議，不要加標題'
        ].join('\n'),
        user: [
            '以下是學員近30天主功法分布資料：',
            '',
            `學員實際總打卡天數（權威值）：${analysis30d.totalCheckinDays || 0} 天`,
            `所有功法累計出現日次（不是總打卡天數）：${analysis30d.totalMatchedMethodDays || 0} 日次`,
            '',
            '主功法明細：',
            methodLines || '- 無資料',
            '',
            '請根據以上資料，用200字內給出接下來的練功指引。'
        ].join('\n')
    };
};

const trimTo200Chars = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length <= 200) return trimmed;
    return `${trimmed.slice(0, 197).trimEnd()}...`;
};

export const generateMethodReviewWithLlm = async (analysis30d: MethodMixInput, fallbackText: string, userId: string) => {
    const enabled = process.env.LOCAL_LLM_ENABLED === 'true';
    const baseUrl = (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/$/, '');
    const model = process.env.LOCAL_LLM_MODEL || '';
    const apiKey = process.env.LOCAL_LLM_API_KEY || 'dummy';
    const timeoutMs = parseInt(process.env.LOCAL_LLM_TIMEOUT_MS || '5000', 10);
    const criteria = parseInt(process.env.LOCAL_LLM_CRITERIA || '0', 10);

    const { rows } = await db.query(
        'SELECT total_checkins FROM users WHERE line_user_id = $1',
        [userId]
    );
    const totalLifetimeCheckins = Number(rows[0]?.total_checkins || 0);

    if (Number.isFinite(criteria) && criteria > 0 && totalLifetimeCheckins < criteria) {
        return fallbackText;
    }

    if (!enabled || !baseUrl || !model) {
        return fallbackText;
    }

    const prompts = buildPrompt(analysis30d);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: prompts.system },
                    { role: 'user', content: prompts.user }
                ],
                temperature: 0.7,
                max_tokens: 220
            }),
            signal: controller.signal
        });

        if (!res.ok) {
            const text = await res.text().catch(() => 'unknown response');
            throw new Error(`LLM API ${res.status}: ${text}`);
        }

        const payload = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content?.trim() || '';
        if (!content) {
            throw new Error('LLM returned empty content');
        }

        const review = trimTo200Chars(content);
        console.log(`[method-review-llm] user=${userId} model=${model} duration=${Date.now() - startedAt}ms status=success methods=${analysis30d.methods?.length || 0}`);
        return review;
    } catch (error) {
        console.error(`[method-review-llm] user=${userId} model=${model} duration=${Date.now() - startedAt}ms status=fallback methods=${analysis30d.methods?.length || 0}`, error);
        return fallbackText;
    } finally {
        clearTimeout(timeout);
    }
};
