-- Database Schema for Qigong LINE Bot

CREATE TABLE IF NOT EXISTS users (
    line_user_id VARCHAR(255) PRIMARY KEY,
    display_name VARCHAR(255),
    total_checkins INTEGER DEFAULT 0,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_checkin_date DATE,
    practice_timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
    practice_timezone_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    practice_timezone_updated_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS checkin_logs (
    id SERIAL PRIMARY KEY,
    line_user_id VARCHAR(255) REFERENCES users(line_user_id),
    note TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    checkin_date DATE,
    reflection_note TEXT,
    body_feeling_note TEXT,
    practice_note TEXT,
    source VARCHAR(32) DEFAULT 'text',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    entry_kind VARCHAR(16) NOT NULL DEFAULT 'regular' CHECK (entry_kind IN ('regular', 'makeup')),
    practice_timezone TEXT NOT NULL DEFAULT 'Asia/Taipei'
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'checkin_logs_line_user_id_checkin_date_key'
    ) THEN
        ALTER TABLE checkin_logs
            ADD CONSTRAINT checkin_logs_line_user_id_checkin_date_key UNIQUE (line_user_id, checkin_date);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS config (
    key VARCHAR(50) PRIMARY KEY,
    value TEXT
);

-- Insert a placeholder for group_id so we can update it later
INSERT INTO config (key, value) VALUES ('group_id', NULL) ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS practice_feeling_tags (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE,
    name_zh VARCHAR(40) NOT NULL,
    name_zh_cn VARCHAR(40),
    name_en VARCHAR(80),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO practice_feeling_tags (code, name_zh, name_zh_cn, name_en, sort_order) VALUES
    ('warm_sweating', '發熱出汗', '发热出汗', 'Warm and sweating', 10),
    ('smooth_release', '排濁順暢', '排浊顺畅', 'Smooth release', 20),
    ('calm_mind', '心神平靜', '心神平静', 'Calm and peaceful', 30),
    ('flexible_body', '筋骨柔韌', '筋骨柔韧', 'Flexible and supple', 40),
    ('full_qi', '滿滿氣感', '满满气感', 'Full of qi sensations', 50)
ON CONFLICT (code) DO NOTHING;

-- V2 Tables
CREATE TABLE IF NOT EXISTS active_groups (
    group_id VARCHAR(255) PRIMARY KEY,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS badges (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    emoji VARCHAR(50),
    description TEXT,
    category VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS user_badges (
    line_user_id VARCHAR(255) REFERENCES users(line_user_id),
    badge_id VARCHAR(50) REFERENCES badges(id),
    earned_year INTEGER,
    unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (line_user_id, badge_id, earned_year)
);

-- Populate initial badge catalog
INSERT INTO badges (id, name, emoji, description, category) VALUES
    ('streak_3', '入門', '🥉', '連續打卡 3 天', 'STREAK'),
    ('streak_7', '小成', '🥈', '連續打卡 7 天', 'STREAK'),
    ('streak_21', '結丹', '🥇', '連續打卡 21 天', 'STREAK'),
    ('streak_100', '百日築基', '💎', '連續打卡 100 天', 'STREAK'),
    ('total_10', '初芽', '🌱', '總計打卡 10 天', 'TOTAL'),
    ('total_100', '大樹', '🌳', '總計打卡 100 天', 'TOTAL'),
    ('time_morning', '晨露', '🌅', '連續 5 天在早上 5:00 - 7:00 打卡', 'TIME_BASED'),
    ('time_night', '夜靜', '🦉', '連續 5 天在晚上 9:00 - 11:00 打卡', 'TIME_BASED'),
    ('seasonal_summer_27', '夏練三伏', '☀️', '於當年三伏期間完成全程打卡', 'SEASONAL'),
    ('seasonal_winter_27', '冬練三九', '❄️', '冬至過後，連續打卡 27 天，且練習龜壽功', 'SEASONAL'),
    ('combo_dayan', '大雁雙修', '🦢', '同日練習大雁初與大雁高，可於每年重新解鎖', 'COMBO'),
    ('combo_wuqinxi', '五禽圓滿', '🐅', '同日完成五禽戲全套五式，可於每年重新解鎖', 'COMBO'),
    ('combo_huichun', '回春雙式', '🌱', '同日練習回春初與回春中，可於每年重新解鎖', 'COMBO'),
    ('combo_guishou', '龜壽全式', '🐢', '同日完成龜壽功全套三式，可於每年重新解鎖', 'COMBO'),
    ('combo_zhengyang', '正陽雙照', '☀️', '同日練習晨功與夜功，可於每年重新解鎖', 'COMBO'),
    ('combo_jinggong', '靜功雙法', '🧘', '同日練習周天靜功與七星心法，可於每年重新解鎖', 'COMBO'),
    ('method_dayan_7', '大雁功｜雁行入雲', '🪶', '累計練習「大雁功」7 天', 'METHOD_DAYS'),
    ('method_dayan_30', '大雁功｜雁翥沖虛', '🪽', '累計練習「大雁功」30 天', 'METHOD_DAYS'),
    ('method_dayan_100', '大雁功｜雁歸太和', '🌤️', '累計練習「大雁功」100 天', 'METHOD_DAYS'),
    ('method_wuqinxi_7', '五禽戲｜五行啟藏', '🕊️', '累計練習「五禽戲」7 天', 'METHOD_DAYS'),
    ('method_wuqinxi_30', '五禽戲｜五靈調炁', '🐾', '累計練習「五禽戲」30 天', 'METHOD_DAYS'),
    ('method_wuqinxi_100', '五禽戲｜五禽歸真', '🦚', '累計練習「五禽戲」100 天', 'METHOD_DAYS'),
    ('method_huichun_7', '回春功｜春芽復炁', '🌱', '累計練習「回春功」7 天', 'METHOD_DAYS'),
    ('method_huichun_30', '回春功｜春和養真', '🍃', '累計練習「回春功」30 天', 'METHOD_DAYS'),
    ('method_huichun_100', '回春功｜回春長青', '🌿', '累計練習「回春功」100 天', 'METHOD_DAYS'),
    ('method_guishou_7', '龜壽功｜龜息守一', '🐢', '累計練習「龜壽功」7 天', 'METHOD_DAYS'),
    ('method_guishou_30', '龜壽功｜龜鶴養元', '🪷', '累計練習「龜壽功」30 天', 'METHOD_DAYS'),
    ('method_guishou_100', '龜壽功｜壽炁綿長', '🏞️', '累計練習「龜壽功」100 天', 'METHOD_DAYS'),
    ('method_zhengyang_7', '正陽功｜朝陽啟炁', '🌅', '累計練習「正陽功」7 天', 'METHOD_DAYS'),
    ('method_zhengyang_30', '正陽功｜正陽養正', '☀️', '累計練習「正陽功」30 天', 'METHOD_DAYS'),
    ('method_zhengyang_100', '正陽功｜陽和充盈', '🌞', '累計練習「正陽功」100 天', 'METHOD_DAYS'),
    ('method_huanghai_7', '晃海功｜晃海聽潮', '🌊', '累計練習「神奇晃海功」7 天', 'METHOD_DAYS'),
    ('method_huanghai_30', '晃海功｜海定神凝', '🌌', '累計練習「神奇晃海功」30 天', 'METHOD_DAYS'),
    ('method_huanghai_100', '晃海功｜海天一炁', '🌐', '累計練習「神奇晃海功」100 天', 'METHOD_DAYS'),
    ('method_lotus_7', '蓮花養心法｜蓮心初照', '🪷', '累計練習「蓮花養心法」7 天', 'METHOD_DAYS'),
    ('method_lotus_30', '蓮花養心法｜蓮臺澄心', '💮', '累計練習「蓮花養心法」30 天', 'METHOD_DAYS'),
    ('method_lotus_100', '蓮花養心法｜蓮華見性', '🌺', '累計練習「蓮花養心法」100 天', 'METHOD_DAYS'),
    ('method_heqi_7', '和氣舒壓法｜和氣舒懷', '🍀', '累計練習「和氣舒壓法」7 天', 'METHOD_DAYS'),
    ('method_heqi_30', '和氣舒壓法｜和光同塵', '🌫️', '累計練習「和氣舒壓法」30 天', 'METHOD_DAYS'),
    ('method_heqi_100', '和氣舒壓法｜氣和神泰', '🌈', '累計練習「和氣舒壓法」100 天', 'METHOD_DAYS'),
    ('method_sanwo_7', '三窩功｜三窩聚炁', '🌀', '累計練習「三窩功」7 天', 'METHOD_DAYS'),
    ('method_sanwo_30', '三窩功｜三田歸元', '🫧', '累計練習「三窩功」30 天', 'METHOD_DAYS'),
    ('method_sanwo_100', '三窩功｜窩藏元和', '🪨', '累計練習「三窩功」100 天', 'METHOD_DAYS'),
    ('method_liuyin_7', '六音理臟法｜六音調藏', '🎵', '累計練習「六音理臟法」7 天', 'METHOD_DAYS'),
    ('method_liuyin_30', '六音理臟法｜六律和臟', '🎶', '累計練習「六音理臟法」30 天', 'METHOD_DAYS'),
    ('method_liuyin_100', '六音理臟法｜六炁周流', '🔔', '累計練習「六音理臟法」100 天', 'METHOD_DAYS'),
    ('method_jinggong_7', '靜功｜守靜入門', '🧘', '累計練習「靜功」7 天', 'METHOD_DAYS'),
    ('method_jinggong_30', '靜功｜澄心守一', '🪷', '累計練習「靜功」30 天', 'METHOD_DAYS'),
    ('method_jinggong_100', '靜功｜虛極靜篤', '🌌', '累計練習「靜功」100 天', 'METHOD_DAYS')
ON CONFLICT (id) DO UPDATE SET 
    name = EXCLUDED.name,
    emoji = EXCLUDED.emoji,
    description = EXCLUDED.description,
    category = EXCLUDED.category;

CREATE TABLE IF NOT EXISTS practice_methods (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE NOT NULL,
    name_zh VARCHAR(255) NOT NULL,
    name_en VARCHAR(255),
    estimated_minutes INTEGER,
    parent_id INTEGER REFERENCES practice_methods(id),
    method_type VARCHAR(16) DEFAULT 'leaf',
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkin_method_selections (
    id SERIAL PRIMARY KEY,
    checkin_log_id INTEGER NOT NULL REFERENCES checkin_logs(id) ON DELETE CASCADE,
    practice_method_id INTEGER NOT NULL REFERENCES practice_methods(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (checkin_log_id, practice_method_id)
);

INSERT INTO practice_methods (code, name_zh, name_en, estimated_minutes, sort_order, parent_id, method_type)
VALUES
    ('dayan', '大雁功', 'Dayan Qigong', 20, 10, NULL, 'group'),
    ('wuqinxi', '五禽戲', 'Wuqinxi', 20, 20, NULL, 'group'),
    ('huichun', '回春功', 'Huichun Gong', 20, 30, NULL, 'group'),
    ('guishou', '龜壽功', 'Guishou Gong', 20, 40, NULL, 'group'),
    ('zhengyang', '正陽功', 'Zhengyang Gong', 20, 50, NULL, 'group'),
    ('huanghai', '神奇晃海功', 'Magic Swaying Sea Gong', 20, 60, NULL, 'leaf'),
    ('lotus', '蓮花養心法', 'Lotus Heart Nourishing Method', 20, 70, NULL, 'leaf'),
    ('heqi', '和氣舒壓法', 'Heqi Relaxation Method', 20, 80, NULL, 'leaf'),
    ('sanwo', '三窩功', 'Sanwo Gong', 20, 90, NULL, 'leaf'),
    ('liuyin', '六音理臟法', 'Liuyin Organ Tuning Method', 20, 100, NULL, 'leaf'),
    ('jinggong', '靜功', 'Quiet Practice', 20, 110, NULL, 'group')
ON CONFLICT (code) DO UPDATE SET
    name_zh = EXCLUDED.name_zh,
    name_en = EXCLUDED.name_en,
    estimated_minutes = EXCLUDED.estimated_minutes,
    parent_id = EXCLUDED.parent_id,
    method_type = EXCLUDED.method_type,
    sort_order = EXCLUDED.sort_order,
    is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO practice_methods (code, name_zh, name_en, estimated_minutes, sort_order, parent_id, method_type)
SELECT child.code, child.name_zh, child.name_en, child.estimated_minutes, child.sort_order, parent.id, 'leaf'
FROM (
    VALUES
        ('dayan_chu', '大雁初', 'Dayan Form 1', 10, 11, 'dayan'),
        ('dayan_gao', '大雁高', 'Dayan Form 2', 10, 12, 'dayan'),
        ('wuqinxi_he', '鶴戲', 'Crane Form', 10, 21, 'wuqinxi'),
        ('wuqinxi_yuan', '猿戲', 'Monkey Form', 10, 22, 'wuqinxi'),
        ('wuqinxi_hu', '虎戲', 'Tiger Form', 10, 23, 'wuqinxi'),
        ('wuqinxi_xiong', '熊戲', 'Bear Form', 10, 24, 'wuqinxi'),
        ('wuqinxi_lu', '鹿戲', 'Deer Form', 10, 25, 'wuqinxi'),
        ('huichun_chu', '回春初', 'Huichun Form 1', 10, 31, 'huichun'),
        ('huichun_zhong', '回春中', 'Huichun Form 2', 10, 32, 'huichun'),
        ('guishou_bagua', '八卦功', 'Bagua Practice', 10, 41, 'guishou'),
        ('guishou_qiankun', '乾坤功', 'Qiankun Practice', 10, 42, 'guishou'),
        ('guishou_fengxiang_guishuo', '鳳翔與龜縮', 'Phoenix and Turtle Form', 10, 43, 'guishou'),
        ('zhengyang_morning', '晨功', 'Morning Practice', 10, 51, 'zhengyang'),
        ('zhengyang_night', '夜功', 'Night Practice', 10, 52, 'zhengyang'),
        ('jinggong_zhoutian', '周天靜功', 'Zhoutian Quiet Practice', 10, 111, 'jinggong'),
        ('jinggong_qixing', '七星心法', 'Seven Star Method', 10, 112, 'jinggong'),
        ('jinggong_songjing', '鬆靜功', 'Songjing Practice', 10, 113, 'jinggong')
) AS child(code, name_zh, name_en, estimated_minutes, sort_order, parent_code)
JOIN practice_methods parent ON parent.code = child.parent_code
ON CONFLICT (code) DO UPDATE SET
    name_zh = EXCLUDED.name_zh,
    name_en = EXCLUDED.name_en,
    estimated_minutes = EXCLUDED.estimated_minutes,
    parent_id = EXCLUDED.parent_id,
    method_type = EXCLUDED.method_type,
    sort_order = EXCLUDED.sort_order,
    is_active = TRUE,
    updated_at = CURRENT_TIMESTAMP;
