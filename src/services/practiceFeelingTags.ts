import { db } from '../db';

export interface PracticeFeelingTag {
    id: number;
    nameZh: string;
    nameZhCn: string;
    nameEn: string;
    sortOrder: number;
    isActive: boolean;
}

interface PracticeFeelingTagInput {
    id?: unknown;
    nameZh?: unknown;
    nameZhCn?: unknown;
    nameEn?: unknown;
    isActive?: unknown;
}

const mapTag = (row: Record<string, unknown>): PracticeFeelingTag => ({
    id: Number(row.id),
    nameZh: String(row.name_zh || ''),
    nameZhCn: String(row.name_zh_cn || ''),
    nameEn: String(row.name_en || ''),
    sortOrder: Number(row.sort_order),
    isActive: Boolean(row.is_active)
});

export const normalizePracticeFeelingTags = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error('標籤資料格式不正確');
    if (value.length > 30) throw new Error('快速感受標籤最多 30 個');

    const seenIds = new Set<number>();
    const seenNames = new Set<string>();
    return value.map((raw, index) => {
        const input = (raw || {}) as PracticeFeelingTagInput;
        const id = Number(input.id);
        const nameZh = typeof input.nameZh === 'string' ? input.nameZh.trim() : '';
        const nameZhCn = typeof input.nameZhCn === 'string' ? input.nameZhCn.trim() : '';
        const nameEn = typeof input.nameEn === 'string' ? input.nameEn.trim() : '';
        if (!nameZh) throw new Error(`第 ${index + 1} 個標籤缺少繁體中文名稱`);
        if (nameZh.length > 40 || nameZhCn.length > 40 || nameEn.length > 80) {
            throw new Error(`第 ${index + 1} 個標籤名稱過長`);
        }
        if (Number.isInteger(id) && id > 0) {
            if (seenIds.has(id)) throw new Error(`標籤 ID ${id} 重複`);
            seenIds.add(id);
        }
        const names = new Set([nameZh, nameZhCn, nameEn].filter(Boolean).map((name) => name.toLocaleLowerCase()));
        for (const name of names) {
            if (seenNames.has(name)) throw new Error(`標籤名稱「${name}」與其他標籤重複`);
            seenNames.add(name);
        }
        return {
            id: Number.isInteger(id) && id > 0 ? id : null,
            nameZh,
            nameZhCn,
            nameEn,
            sortOrder: (index + 1) * 10,
            isActive: input.isActive !== false
        };
    });
};

export const getPracticeFeelingTags = async (includeInactive = false) => {
    const { rows } = await db.query(
        `SELECT id, name_zh, name_zh_cn, name_en, sort_order, is_active
         FROM practice_feeling_tags
         ${includeInactive ? '' : 'WHERE is_active = TRUE'}
         ORDER BY sort_order ASC, id ASC`
    );
    return rows.map(mapTag);
};

export const savePracticeFeelingTags = async (value: unknown) => {
    const tags = normalizePracticeFeelingTags(value);
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        for (const tag of tags) {
            if (tag.id) {
                const result = await client.query(
                    `UPDATE practice_feeling_tags
                     SET name_zh = $1, name_zh_cn = $2, name_en = $3, sort_order = $4,
                         is_active = $5, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $6`,
                    [tag.nameZh, tag.nameZhCn || null, tag.nameEn || null, tag.sortOrder, tag.isActive, tag.id]
                );
                if (result.rowCount !== 1) throw new Error(`找不到標籤 ID ${tag.id}`);
            } else {
                await client.query(
                    `INSERT INTO practice_feeling_tags
                        (name_zh, name_zh_cn, name_en, sort_order, is_active)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [tag.nameZh, tag.nameZhCn || null, tag.nameEn || null, tag.sortOrder, tag.isActive]
                );
            }
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    return getPracticeFeelingTags(true);
};
