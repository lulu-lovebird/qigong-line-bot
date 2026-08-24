INSERT INTO user_badges (line_user_id, badge_id, earned_year)
SELECT line_user_id, 'seasonal_summer_27', 2026
FROM checkin_logs
WHERE COALESCE(checkin_date, DATE(created_at AT TIME ZONE 'Asia/Taipei'))
      BETWEEN DATE '2026-07-15' AND DATE '2026-08-23'
GROUP BY line_user_id
HAVING COUNT(DISTINCT COALESCE(checkin_date, DATE(created_at AT TIME ZONE 'Asia/Taipei'))) = 40
ON CONFLICT DO NOTHING;
