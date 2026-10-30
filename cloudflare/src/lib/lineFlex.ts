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
  ];
  if (extra) contents.push(extra);
  else contents.push(row('วัตถุประสงค์', textOf(req.Purpose)));
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
  return card('🔔 มีใบขอเบิกพัสดุใหม่', '#F97316', `🔔 ใบขอเบิกใหม่ ${textOf(req.DocNo)} – ${textOf(req.FullName)}`, req);
}

/** Approved-request LINE Flex card (green). */
export function approvedRequestFlex(req: Obj): LineMessage {
  const isPartial = Boolean(req.IsPartial || (Array.isArray(req.Items) && req.Items.some((it: any) => it.ApprovedQty !== undefined && it.ApprovedQty < it.Qty)));
  const title = isPartial ? '✅ อนุมัติแล้ว (อนุมัติบางส่วน)' : '✅ อนุมัติใบขอเบิกพัสดุแล้ว';
  const color = isPartial ? '#0D9488' : '#16A34A';
  const alt = isPartial ? `✅ อนุมัติแล้ว (อนุมัติบางส่วน) ${textOf(req.DocNo)} – ${textOf(req.FullName)}` : `✅ อนุมัติแล้ว ${textOf(req.DocNo)} – ${textOf(req.FullName)}`;

  let extraRow: Obj | undefined;
  if (isPartial && Array.isArray(req.Items) && req.Items.length > 0) {
    const lines: string[] = [];
    for (const it of req.Items as Obj[]) {
      const aQty = Number(it.ApprovedQty ?? it.Qty ?? 0);
      const reqQty = Number(it.Qty ?? 0);
      const unit = it.Unit ? ` ${it.Unit}` : '';
      if (aQty > 0) {
        lines.push(`• ${it.Name}: ${aQty}${unit}${aQty < reqQty ? ` (ขอ ${reqQty})` : ''}`);
      } else {
        lines.push(`• ${it.Name}: ❌ ไม่อนุมัติ`);
      }
    }
    if (lines.length > 0) {
      extraRow = {
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        contents: [
          { type: 'text', text: 'รายละเอียดการอนุมัติ:', size: 'xs', color: '#888888', weight: 'bold' },
          { type: 'text', text: lines.slice(0, 10).join('\n'), size: 'xs', color: '#333333', wrap: true },
        ],
      };
    }
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
