BEGIN;

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

COMMIT;
