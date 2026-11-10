# Design Documents Index (Sitemap)

| Feature | Date | Author | Status | Target Components | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [Requisition Department Selection Hardening](./requisition_department_selection_hardening.md) | 2026-11-09 | chookaittom-gif | Proposed | `cloudflare/public/index.html` | Hardens the requisition form department selector to prevent typos and invalid free-text input while maintaining 4 structured optgroups. |
| [Monthly Stock Alert (Telegram + LINE)](./monthly_stock_alert_notification.md) | 2026-11-10 | chookaittom-gif | Proposed | `cloudflare/wrangler.jsonc`, `cloudflare/src/cron.ts`, `cloudflare/src/lib/lineFlex.ts`, `cloudflare/src/lib/telegram.ts` | ปรับการแจ้งเตือนพัสดุใกล้หมด/หมดสต็อกทาง Telegram และ LINE Flex Message ทุกวันที่ 25 เวลา 05:00 น. |
