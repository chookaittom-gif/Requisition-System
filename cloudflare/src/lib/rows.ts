export type TableName =
  | 'users'
  | 'categories'
  | 'materials'
  | 'requests'
  | 'request_items'
  | 'purchases'
  | 'stock_movements'
  | 'opening_balances'
  | 'audit_log'
  | 'settings'
  | 'shops';

type ColumnMap = Record<string, string>; // D1 column -> legacy header

// Explicit per-table maps (see docs/data-mapping.md, HEADERS in Code/code.gs:29-53).
// Columns absent here are never emitted: users.password_hash is mapped for fromLegacy only
// (see NEVER_EMIT), settings.telegram_bot_token and settings.id, requests.stock_applied/stock_txn
// have no legacy header.
const MAPS: Record<TableName, ColumnMap> = {
  users: {
    id: 'ID', username: 'Username', password_hash: 'Password', full_name: 'FullName', role: 'Role',
    position: 'Position', department: 'Department', email: 'Email',
    created_at: 'CreatedAt', updated_at: 'UpdatedAt',
  },
  categories: { id: 'ID', name: 'Name', code: 'Code', created_at: 'CreatedAt' },
  materials: {
    id: 'ID', code: 'Code', name: 'Name', unit: 'Unit', unit_price: 'UnitPrice', stock_qty: 'StockQty',
    min_qty: 'MinQty', opening_qty: 'OpeningQty', category: 'Category', material_type: 'MaterialType',
    size_spec: 'SizeSpec', storage_location: 'StorageLocation', image_url: 'ImageUrl', file_url: 'FileUrl',
    shop_name: 'ShopName', shop_address: 'ShopAddress', shop_phone: 'ShopPhone', shop_tax_id: 'ShopTaxId',
    budget_source: 'BudgetSource', acquired_date: 'AcquiredDate', order_qty: 'OrderQty',
    created_at: 'CreatedAt', updated_at: 'UpdatedAt',
  },
  requests: {
    id: 'ID', doc_no: 'DocNo', request_date: 'RequestDate', user_id: 'UserID', full_name: 'FullName',
    position: 'Position', department: 'Department', purpose: 'Purpose', note: 'Note', attach_url: 'AttachUrl',
    status: 'Status', reject_reason: 'RejectReason', approved_date: 'ApprovedDate', approved_by: 'ApprovedBy',
    total_amount: 'TotalAmount', item_count: 'ItemCount', created_at: 'CreatedAt', updated_at: 'UpdatedAt',
  },
  request_items: {
    id: 'ID', request_id: 'RequestID', material_id: 'MaterialID', code: 'Code', name: 'Name', unit: 'Unit',
    qty: 'Qty', unit_price: 'UnitPrice', total_price: 'TotalPrice', remark: 'Remark',
  },
  purchases: {
    id: 'ID', material_id: 'MaterialID', code: 'Code', name: 'Name', qty: 'Qty', unit_price: 'UnitPrice',
    amount: 'Amount', purchase_date: 'PurchaseDate', note: 'Note', actor: 'Actor', created_at: 'CreatedAt',
  },
  stock_movements: {
    id: 'ID', material_id: 'MaterialID', code: 'Code', name: 'Name', type: 'Type', qty: 'Qty',
    before_qty: 'BeforeQty', after_qty: 'AfterQty', ref_doc: 'RefDoc', note: 'Note', actor: 'Actor',
    created_at: 'CreatedAt',
  },
  opening_balances: {
    id: 'ID', material_id: 'MaterialID', fiscal_year: 'FiscalYear', opening_qty: 'OpeningQty',
    set_by: 'SetBy', created_at: 'CreatedAt', updated_at: 'UpdatedAt',
  },
  audit_log: {
    id: 'ID', action: 'Action', entity: 'Entity', entity_id: 'EntityID', detail: 'Detail', actor: 'Actor',
    created_at: 'CreatedAt',
  },
  settings: {
    school_name: 'SchoolName', affiliation: 'Affiliation', logo_url: 'LogoUrl', address: 'Address',
    phone: 'Phone', updated_at: 'UpdatedAt', notify_email: 'NotifyEmail', telegram_chat_id: 'TelegramChatId',
    line_token: 'LineToken', line_to: 'LineTo',
    notify_on_new_request: 'NotifyOnNewRequest', notify_on_status_change: 'NotifyOnStatusChange',
    notify_low_stock: 'NotifyLowStock', banner_url: 'BannerUrl',
  },
  shops: {
    id: 'ID',
    name: 'Name',
    tax_id: 'TaxId',
    address: 'Address',
    phone: 'Phone',
    note: 'Note',
    created_at: 'CreatedAt',
    updated_at: 'UpdatedAt',
  },
};

/** D1 columns that must never be sent to the browser. */
const NEVER_EMIT: Partial<Record<TableName, string>> = { users: 'password_hash' };

/** D1 row -> legacy PascalCase object. Unmapped and secret columns are dropped. */
export function toLegacy(table: TableName, row: Record<string, unknown>): Record<string, unknown> {
  const map = MAPS[table];
  const secret = NEVER_EMIT[table];
  const out: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    if (col === secret) continue;
    const key = map[col];
    if (key !== undefined) out[key] = value;
  }
  return out;
}

/** Legacy PascalCase object -> D1 columns. Unknown keys are dropped. */
export function fromLegacy(table: TableName, obj: Record<string, unknown>): Record<string, unknown> {
  const reverse = new Map(Object.entries(MAPS[table]).map(([col, key]) => [key, col]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const col = reverse.get(key);
    if (col !== undefined) out[col] = value;
  }
  return out;
}

export function computeStockState(stockQty: number, minQty: number): 'OUT' | 'LOW' | 'OK' {
  if (stockQty <= 0) return 'OUT';
  if (stockQty <= minQty) return 'LOW';
  return 'OK';
}
