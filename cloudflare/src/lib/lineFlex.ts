import type { LineMessage } from './line';

type Obj = Record<string, unknown>;

const ALT_MAX = 400;

const money = (v: unknown): string =>
  Number(v || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 });

const textOf = (v: unknown): string => String(v ?? '').trim();

function row(label: string, value: string): Obj {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 4, wrap: true },
      { type: 'text', text: value || '-', size: 'sm', color: '#222222', flex: 6, wrap: true },
    ],
  };
}

function card(title: string, headerColor: string, altText: string, req: Obj, extra?: Obj): LineMessage {
  const contents = [
    row('เลขที่', textOf(req.DocNo)),
    row('ผู้ขอเบิก', textOf(req.FullName)),
    row('หลักสูตร / ฝ่ายงาน / โครงการ', textOf(req.Department)),
    row('วัตถุประสงค์', textOf(req.Purpose)),
  ];
  if (extra) contents.push(extra);
  contents.push(
    row('จำนวน', `${textOf(req.ItemCount)} รายการ`),
    row('มูลค่ารวม', `${money(req.TotalAmount)} บาท`),
  );
  return {
    type: 'flex',
    altText: altText.slice(0, ALT_MAX),
    contents: {
      type: 'bubble',
      styles: { header: { backgroundColor: headerColor } },
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: title, weight: 'bold', size: 'md', color: '#ffffff', wrap: true }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents,
      },
    },
  };
}

/** New-request LINE Flex card (orange). Telegram keeps its own text in telegram.ts. */
export function newRequestFlex(req: Obj): LineMessage {
  let extraRow: Obj | undefined;
  const items = Array.isArray(req.Items) ? (req.Items as Obj[]) : [];
  if (items.length > 0) {
    const lines = items.slice(0, 10).map((it) => {
      const unit = it.Unit ? ` ${it.Unit}` : '';
      return `• ${it.Name}: ${it.Qty}${unit}`;
    });
    if (items.length > 10) lines.push(`...และอีก ${items.length - 10} รายการ`);
    extraRow = {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      contents: [
        { type: 'text', text: 'รายการพัสดุที่ขอเบิก:', size: 'xs', color: '#888888', weight: 'bold' },
        { type: 'text', text: lines.join('\n'), size: 'xs', color: '#333333', wrap: true },
      ],
    };
  }
  return card('🔔 มีใบขอเบิกพัสดุใหม่', '#F97316', `🔔 ใบขอเบิกใหม่ ${textOf(req.DocNo)} – ${textOf(req.FullName)}`, req, extraRow);
}

/** Approved-request LINE Flex card (green). */
export function approvedRequestFlex(req: Obj): LineMessage {
  const items = Array.isArray(req.Items) ? (req.Items as Obj[]) : [];
  let approvedCount = 0;
  let rejectedCount = 0;
  const lines: string[] = [];

  for (const it of items) {
    const aQty = Number(it.ApprovedQty ?? it.Qty ?? 0);
    const reqQty = Number(it.Qty ?? 0);
    const unit = it.Unit ? ` ${it.Unit}` : '';
    if (aQty > 0) {
      approvedCount++;
      lines.push(`• ${it.Name}: ${aQty}${unit}${aQty < reqQty ? ` (ขอ ${reqQty})` : ''}`);
    } else {
      rejectedCount++;
      lines.push(`• ${it.Name}: ❌ ไม่อนุมัติ`);
    }
  }

  const isPartial = Boolean(req.IsPartial || rejectedCount > 0 || (items.length > 0 && items.some((it: any) => it.ApprovedQty !== undefined && it.ApprovedQty < it.Qty)));
  const title = isPartial ? '✅ อนุมัติแล้ว (อนุมัติบางส่วน)' : '✅ อนุมัติใบขอเบิกพัสดุแล้ว';
  const color = isPartial ? '#0D9488' : '#16A34A';
  const alt = isPartial ? `✅ อนุมัติแล้ว (อนุมัติบางส่วน) ${textOf(req.DocNo)} – ${textOf(req.FullName)}` : `✅ อนุมัติแล้ว ${textOf(req.DocNo)} – ${textOf(req.FullName)}`;

  let extraRow: Obj | undefined;
  if (lines.length > 0) {
    const disp = lines.slice(0, 10);
    if (lines.length > 10) disp.push(`...และอีก ${lines.length - 10} รายการ`);
    extraRow = {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      contents: [
        { type: 'text', text: `สรุป: อนุมัติ ${approvedCount} | ไม่อนุมัติ ${rejectedCount} รายการ`, size: 'xs', color: '#0F766E', weight: 'bold' },
        { type: 'text', text: disp.join('\n'), size: 'xs', color: '#333333', wrap: true },
      ],
    };
  }

  return card(title, color, alt, req, extraRow);
}

export function rejectedRequestFlex(req: Obj, reason?: string): LineMessage {
  const r = reason || textOf(req.RejectReason) || '-';
  return card(
    '❌ ไม่อนุมัติใบขอเบิกพัสดุ',
    '#E11D48',
    `❌ ไม่อนุมัติ ${textOf(req.DocNo)} – ${textOf(req.FullName)}`,
    req,
    row('เหตุผลที่ไม่อนุมัติ', r),
  );
}
