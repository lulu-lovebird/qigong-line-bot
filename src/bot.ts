import { messagingApi, webhook } from '@line/bot-sdk';
import { db } from './db';
import moment from 'moment-timezone';
import { evaluateBadges } from './badges';
import { saveLegacyTextCheckin } from './services/lineCheckin';
import { createReminderText, sendDailyReminder, sendAdHocBroadcast, sendManualResendReminder } from './cron';
import { buildPeriodLeaderboardText } from './leaderboard';

const TIMEZONE = 'Asia/Taipei';

const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const client = new messagingApi.MessagingApiClient(lineConfig);
const LIFF_ID = process.env.LIFF_ID || '';
const LIFF_ID_CHECKIN = process.env.LIFF_ID_CHECKIN || LIFF_ID;
const LIFF_ID_LEADERBOARD = process.env.LIFF_ID_LEADERBOARD || '';
const LIFF_ID_HISTORY = process.env.LIFF_ID_HISTORY || '';
const LIFF_ID_METHOD_ANALYSIS = process.env.LIFF_ID_METHOD_ANALYSIS || '';
const LIFF_ID_ACHIEVEMENTS = process.env.LIFF_ID_ACHIEVEMENTS || '';
const LIFF_ID_REMINDER = process.env.LIFF_ID_REMINDER || '';
const LINE_LIFF_CHECKIN_URL = LIFF_ID_CHECKIN ? `https://liff.line.me/${LIFF_ID_CHECKIN}` : (process.env.LINE_LIFF_CHECKIN_URL || '');

const buildSharedLineLiffEntryUrl = (page?: string, extraParams?: Record<string, string>) => {
    if (!LINE_LIFF_CHECKIN_URL) return '';

    const url = new URL(LINE_LIFF_CHECKIN_URL);
    if (page) url.searchParams.set('page', page);

    if (extraParams) {
        Object.entries(extraParams).forEach(([key, value]) => {
            if (value) url.searchParams.set(key, value);
        });
    }

    return url.toString();
};

const buildDedicatedLineLiffUrl = (liffId: string, fallbackPage?: string, extraParams?: Record<string, string>) => {
    if (liffId) {
        const url = new URL(`https://liff.line.me/${liffId}`);
        if (extraParams) {
            Object.entries(extraParams).forEach(([key, value]) => {
                if (value) url.searchParams.set(key, value);
            });
        }
        return url.toString();
    }

    return buildSharedLineLiffEntryUrl(fallbackPage, extraParams);
};

const LINE_LIFF_LEADERBOARD_URL = buildDedicatedLineLiffUrl(LIFF_ID_LEADERBOARD, 'leaderboard', { period: 'all' });
const LINE_LIFF_HISTORY_URL = buildDedicatedLineLiffUrl(LIFF_ID_HISTORY, 'history');
const LINE_LIFF_METHOD_ANALYSIS_URL = buildDedicatedLineLiffUrl(LIFF_ID_METHOD_ANALYSIS, 'method-analysis');
const LINE_LIFF_ACHIEVEMENTS_URL = buildDedicatedLineLiffUrl(LIFF_ID_ACHIEVEMENTS, 'achievements');
const LINE_LIFF_REMINDER_URL = buildDedicatedLineLiffUrl(LIFF_ID_REMINDER, 'reminder');

// Simple in-memory state for user sessions
const userStates = new Map<string, string>();

const ensureGroupRegistered = async (event: webhook.Event) => {
    if (!event.source || event.source.type !== 'group') return;
    const groupId = (event.source as any).groupId;
    if (!groupId) return;
    await db.query("INSERT INTO active_groups (group_id) VALUES ($1) ON CONFLICT DO NOTHING", [groupId]);
};

export const handleEvent = async (event: webhook.Event): Promise<any> => {
    // 1. Capture Group ID if the bot is invited to a group
    if (event.type === 'join' && event.source && event.source.type === 'group') {
        const groupId = (event.source as any).groupId;
        if (event.replyToken) {
            await db.query("INSERT INTO active_groups (group_id) VALUES ($1) ON CONFLICT DO NOTHING", [groupId]);
            return client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: '大家好！我已經準備好為大家記錄每天的氣功練習了。請記得加我為好友，在私訊中進行每日打卡喔！' }]
            });
        }
    }

    if (event.source && event.source.type === 'group') {
        await ensureGroupRegistered(event);
    }

    // Handle bot being removed from a group
    if (event.type === 'leave' && event.source && event.source.type === 'group') {
        const groupId = (event.source as any).groupId;
        await db.query("DELETE FROM active_groups WHERE group_id = $1", [groupId]);
        return null;
    }

    // Admin commands (Hidden)
    if (event.type === 'message' && event.message.type === 'text' && event.message.text.trim().startsWith('!admin ')) {
        const adminUserId = process.env.ADMIN_USER_ID;
        const userId = event.source?.userId;
        const text = event.message.text.trim();
        const replyToken = event.replyToken;
        const now = moment().tz(TIMEZONE).format();
        
        console.log(`[Admin Command] Received at ${now}`);
        console.log(`[Admin Command] Command: "${text}"`);
        console.log(`[Admin Command] Sender User ID: ${userId}`);
        console.log(`[Admin Command] Configured Admin ID: ${adminUserId}`);
        console.log(`[Admin Command] Match: ${userId === adminUserId}`);

        if (userId !== adminUserId) {
            console.log(`[Admin Command] Ignored: Unauthorized user.`);
            return null; // Silently ignore if not admin
        }

        console.log(`[Admin Command] Accepted. Executing...`);

        if (text === '!admin register_group' && event.source && event.source.type === 'group') {
            const groupId = (event.source as any).groupId;
            if (replyToken) {
                await db.query("INSERT INTO active_groups (group_id) VALUES ($1) ON CONFLICT DO NOTHING", [groupId]);
                console.log(`[Admin Command] Group registered: ${groupId}`);
                return client.replyMessage({
                    replyToken,
                    messages: [{ type: 'text', text: '系統訊息：此群組已成功註冊至廣播名單。' }]
                });
            }
        }

        if (text === '!admin resend-reminder' && replyToken) {
            console.log(`[Admin Command] Resending daily reminder by requested user: ${userId}`);
            const result = await sendManualResendReminder();
            return client.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: `系統訊息：已成功手動觸發補發提醒廣播！送出 ${result.successCount}/${result.totalCount} 個群組。` }]
            });
        }

        if (text === '!admin create-reminder' && replyToken) {
            const reminderText = await createReminderText();
            return client.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: reminderText }]
            });
        }

        if (text === '!admin list_groups' && replyToken) {
            const { rows } = await db.query("SELECT group_id, joined_at FROM active_groups ORDER BY joined_at DESC");
            const msg = rows.length === 0
                ? '系統訊息：目前沒有已登記群組。'
                : `系統訊息：目前共有 ${rows.length} 個群組\n` + rows.map((row, index) => `${index + 1}. ${row.group_id} (${row.joined_at})`).join('\n');
            return client.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: msg }]
            });
        }

        if (text === '!admin quota' && replyToken) {
            try {
                const [quota, consumption] = await Promise.all([
                    client.getMessageQuota(),
                    client.getMessageQuotaConsumption()
                ]);

                const quotaType = quota.type === 'limited' ? 'limited' : quota.type;
                const quotaValue = typeof quota.value === 'number' ? quota.value : null;
                const used = consumption.totalUsage || 0;
                const remaining = quotaValue === null ? 'unlimited' : Math.max(quotaValue - used, 0).toString();
                const msg = [
                    '系統訊息：本月 Messaging API 配額',
                    `type: ${quotaType}`,
                    `quota: ${quotaValue === null ? 'unlimited' : quotaValue}`,
                    `used: ${used}`,
                    `remaining: ${remaining}`
                ].join('\n');

                return client.replyMessage({
                    replyToken,
                    messages: [{ type: 'text', text: msg }]
                });
            } catch (error) {
                console.error('[Admin Command] Failed to fetch quota:', error);
                return client.replyMessage({
                    replyToken,
                    messages: [{ type: 'text', text: '系統訊息：查詢 quota 失敗，請稍後再試。' }]
                });
            }
        }

        if (text.startsWith('!admin broadcast ') && replyToken) {
            const broadcastMsg = text.replace('!admin broadcast ', '').trim();
            console.log(`[Admin Command] Sending ad-hoc broadcast length: ${broadcastMsg.length}`);
            const successCount = await sendAdHocBroadcast(broadcastMsg, userId);
            return client.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: `系統訊息：自訂廣播已成功發送至 ${successCount} 個群組！` }]
            });
        }
        
        console.log(`[Admin Command] Unknown command or incorrect context.`);
        return null;
    }

    // 2. We only care about text messages from users
    if (event.type !== 'message' || event.message.type !== 'text' || !event.source || event.source.type !== 'user' || !event.replyToken) {
        return null;
    }

    const userId = event.source.userId as string;
    const text = event.message.text.trim();
    const replyToken = event.replyToken as string;

    // LIFF sends the success summary as a user message back into the chat.
    // Ignore it so the bot does not respond with the fallback unknown-command message.
    if (text.startsWith('✅ 打卡成功') || text.startsWith('✅ 補登成功')) {
        return null;
    }

    // Retrieve user profile if not exist in DB
    const profile = await client.getProfile(userId);
    await db.query(
        `INSERT INTO users (line_user_id, display_name) VALUES ($1, $2) ON CONFLICT (line_user_id) DO UPDATE SET display_name = $2`,
        [userId, profile.displayName]
    );

    // Check state
    const currentState = userStates.get(userId);

    if (text === '✅ Check-In') {
        if (LINE_LIFF_CHECKIN_URL) {
            return client.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: `請點下方連結開啟打卡表單：\n${LINE_LIFF_CHECKIN_URL}`
                }]
            });
        }

        // Fallback to legacy text flow if LIFF URL is not configured
        userStates.set(userId, 'WAITING_FOR_NOTE');
        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '太棒了！你今天練習了什麼氣功呢？' }]
        });
    }

    if (text === '🏆 Weekly Leaderboard') {
        const leaderboardUrl = buildDedicatedLineLiffUrl(LIFF_ID_LEADERBOARD, 'leaderboard', { period: 'week' });
        if (leaderboardUrl) {
            return client.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: `請點下方連結開啟週排行榜：\n${leaderboardUrl}`
                }]
            });
        }

        const msg = await buildPeriodLeaderboardText('week');
        return client.replyMessage({ replyToken, messages: [{ type: 'text', text: msg }] });
    }

    if (text === '🏆 Monthly Leaderboard') {
        const leaderboardUrl = buildDedicatedLineLiffUrl(LIFF_ID_LEADERBOARD, 'leaderboard', { period: 'month' });
        if (leaderboardUrl) {
            return client.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: `請點下方連結開啟月排行榜：\n${leaderboardUrl}`
                }]
            });
        }

        const msg = await buildPeriodLeaderboardText('month');
        return client.replyMessage({ replyToken, messages: [{ type: 'text', text: msg }] });
    }

    if (text === '🏆 Quarterly Leaderboard') {
        const leaderboardUrl = buildDedicatedLineLiffUrl(LIFF_ID_LEADERBOARD, 'leaderboard', { period: 'quarter' });
        if (leaderboardUrl) {
            return client.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: `請點下方連結開啟季排行榜：\n${leaderboardUrl}`
                }]
            });
        }

        const msg = await buildPeriodLeaderboardText('quarter');
        return client.replyMessage({ replyToken, messages: [{ type: 'text', text: msg }] });
    }

    if (text === '🏆 Leaderboard') {
        if (LINE_LIFF_LEADERBOARD_URL) {
            return client.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: `請點下方連結開啟排行榜：\n${LINE_LIFF_LEADERBOARD_URL}`
                }]
            });
        }

        const topStreaks = await db.query('SELECT display_name, longest_streak FROM users WHERE longest_streak > 0 ORDER BY longest_streak DESC LIMIT 10');
        const topTotals = await db.query('SELECT display_name, total_checkins FROM users WHERE total_checkins > 0 ORDER BY total_checkins DESC LIMIT 10');

        let msg = '🏆 排行榜 🏆\n\n';
        msg += '🔥 最高連續打卡：\n';
        topStreaks.rows.forEach((r, i) => msg += `${i + 1}. ${r.display_name} (${r.longest_streak}天)\n`);
        
        msg += '\n⭐ 總打卡天數：\n';
        topTotals.rows.forEach((r, i) => msg += `${i + 1}. ${r.display_name} (${r.total_checkins}天)\n`);

        if (topStreaks.rows.length === 0) msg = '目前還沒有人打卡喔，快來搶頭香！';

        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: msg }]
        });
    }

    if (text === '📊 My Stats') {
        if (LINE_LIFF_HISTORY_URL) {
            return client.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: `請點下方連結開啟打卡紀錄：\n${LINE_LIFF_HISTORY_URL}`
                }]
            });
        }

        const userStats = await db.query('SELECT current_streak, longest_streak, total_checkins FROM users WHERE line_user_id = $1', [userId]);
        if (userStats.rows.length > 0) {
            const row = userStats.rows[0];
            
            // Determine level (Title)
            let levelTitle = '練氣 (Level 1)';
            if (row.total_checkins >= 200) levelTitle = '化境 (Level 4)';
            else if (row.total_checkins >= 90) levelTitle = '結丹 (Level 3)';
            else if (row.total_checkins >= 30) levelTitle = '築基 (Level 2)';

            // Fetch Badges
            const badgesRes = await db.query(`
                SELECT b.emoji, b.name, u.earned_year 
                FROM user_badges u 
                JOIN badges b ON u.badge_id = b.id 
                WHERE u.line_user_id = $1 
                ORDER BY u.unlocked_at ASC
            `, [userId]);
            
            let trophyCase = '🏆 你的榮譽勳章：\n';
            if (badgesRes.rows.length === 0) {
                trophyCase += '目前還沒有勳章，快去打卡解鎖吧！';
            } else {
                // Group duplicates by name
                const badgeCounts: Record<string, { emoji: string, count: number, years: string[] }> = {};
                badgesRes.rows.forEach(b => {
                    if (!badgeCounts[b.name]) {
                        badgeCounts[b.name] = { emoji: b.emoji, count: 0, years: [] };
                    }
                    badgeCounts[b.name].count += 1;
                    if (b.earned_year && b.earned_year !== 0) badgeCounts[b.name].years.push(b.earned_year.toString());
                });

                const badgeStrings = Object.keys(badgeCounts).map(name => {
                    const b = badgeCounts[name];
                    let text = `${b.emoji} ${name}`;
                    if (b.count > 1) text += ` (x${b.count})`;
                    if (b.years.length > 0) text += ` [${b.years.join(', ')}]`;
                    return text;
                });
                
                trophyCase += badgeStrings.join(' | ');
            }

            const msgText = `📊 你的修練數據：\n\n【當前境界】${levelTitle}\n🔥 連續打卡：${row.current_streak} 天\n📈 最高連打：${row.longest_streak} 天\n⭐ 總計打卡：${row.total_checkins} 天\n\n${trophyCase}\n\n繼續保持！💪`;

            return client.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: msgText }]
            });
        }
        return null;
    }

    if (text === '🧘 功法分析' && LINE_LIFF_METHOD_ANALYSIS_URL) {
        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `請點下方連結開啟個人功法分析：\n${LINE_LIFF_METHOD_ANALYSIS_URL}` }]
        });
    }

    if (text === '🏅 我的成就' && LINE_LIFF_ACHIEVEMENTS_URL) {
        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `請點下方連結開啟成就頁：\n${LINE_LIFF_ACHIEVEMENTS_URL}` }]
        });
    }

    if (text === '⏰ 提醒設定' && LINE_LIFF_REMINDER_URL) {
        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `請點下方連結開啟提醒設定說明：\n${LINE_LIFF_REMINDER_URL}` }]
        });
    }

    // Handle Note input
    if (currentState === 'WAITING_FOR_NOTE') {
        userStates.delete(userId); // clear state

        const saved = await saveLegacyTextCheckin(userId, text);
        if (saved.alreadyCheckedIn) {
            return client.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: '你今天已經打過卡囉！我們明天見！(如果有新心得也可以繼續分享)' }]
            });
        }

        // Background evaluation of badges (don't await so it doesn't block reply)
        evaluateBadges(userId, text, [], {
            checkinDate: saved.date,
            entryKind: saved.entryKind,
            practiceTimezone: saved.practiceTimezone
        }).catch(e => console.error("Badge evaluation error:", e));

        return client.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `紀錄成功！你已連續打卡 ${saved.stats.currentStreak} 天！🔥\n\n今日練習：${text}` }]
        });
    }

    // Fallback message
    return client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '抱歉，我不懂這個指令。請使用下方選單打卡喔！' }]
    });
};
