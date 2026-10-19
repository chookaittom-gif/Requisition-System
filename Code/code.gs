/*************************************************************************************
 *  ระบบเบิกจ่ายพัสดุ — Backend (ฉบับปรับปรุง: เร็วขึ้น + ปลอดภัยขึ้น)
 *  - cache Spreadsheet/Sheet ต่อ execution, cache ข้อมูลชีตด้วย CacheService
 *  - อ่านชีตด้วย API call เดียว, เขียนแถวด้วย setValues ครั้งเดียว
 *  - ลบฟังก์ชันซ้ำ เหลือชุดเดียว (รหัสผ่านแบบ hash ไม่ส่งกลับ browser)
 *  - บังคับ actor จาก session (กันปลอมชื่อใน Audit Log)
 *  - ดูคลิปการใช้งาน ช่อง Youtube : https://www.youtube.com/@Pormodtanoy/videos
 *************************************************************************************/

/* ============================== CONFIG ============================== */
const SHEET_ID        = '1S4frAL32lw4MNpdZvzwVq36h_bYJjxBtFxPKDc532Nc';
const DRIVE_FOLDER_ID = '1kVDobdN0V1U7bqTHHFMEDrlUEhQAMG4U';
const TZ = 'Asia/Bangkok';

const SHEETS = {
  SETTINGS:       'Settings',
  USERS:          'Users',
  MATERIALS:      'Materials',
  REQUESTS:       'Requests',
  REQUEST_ITEMS:  'RequestItems',
  PURCHASES:      'Purchases',
  STOCK_MOVEMENTS:'StockMovements',
  AUDIT_LOG:      'AuditLog',
  CATEGORIES:     'Categories',
  OPENING_BALANCES:'OpeningBalances',
  SHOPS:          'Shops'
};

const HEADERS = {
  Settings: [
    'SchoolName','Affiliation','LogoUrl','Address','Phone','UpdatedAt',
    'NotifyEmail','TelegramBotToken','TelegramChatId','LineToken',
    'NotifyOnNewRequest','NotifyOnStatusChange','NotifyLowStock','BannerUrl','LineTo'
  ],
  Users: ['ID','Username','Password','FullName','Role','Position','Department','Email','CreatedAt','UpdatedAt'],
  Materials: [
    'ID','Code','Name','Unit','UnitPrice','StockQty','MinQty','OpeningQty',
    'Category','MaterialType','SizeSpec','StorageLocation',
    'ImageUrl','FileUrl',
    'ShopName','ShopAddress','ShopPhone','ShopTaxId','BudgetSource','AcquiredDate','OrderQty',
    'CreatedAt','UpdatedAt'
  ],
  Requests: [
    'ID','DocNo','RequestDate','UserID','FullName','Position','Department','Purpose',
    'Note','AttachUrl','Status','RejectReason','ApprovedDate','ApprovedBy',
    'TotalAmount','ItemCount','CreatedAt','UpdatedAt'
  ],
  RequestItems: ['ID','RequestID','MaterialID','Code','Name','Unit','Qty','UnitPrice','TotalPrice','Remark'],
  Purchases: ['ID','MaterialID','Code','Name','Qty','UnitPrice','Amount','PurchaseDate','Note','Actor','CreatedAt'],
  StockMovements: [
    'ID','MaterialID','Code','Name','Type','Qty','BeforeQty','AfterQty',
    'RefDoc','Note','Actor','CreatedAt'
  ],
  AuditLog: ['ID','Action','Entity','EntityID','Detail','Actor','CreatedAt'],
  Categories: ['ID','Name','Code','CreatedAt'],
  OpeningBalances: ['ID','MaterialID','FiscalYear','OpeningQty','SetBy','CreatedAt','UpdatedAt'],
  Shops: ['ID','Name','TaxId','Address','Phone','Note','CreatedAt','UpdatedAt']
};

/* ============================== WEB APP ENTRY ============================== */
function doGet(e){
  ensureSetup();
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('ระบบเบิกจ่ายพัสดุ')
    .setFaviconUrl('https://lh3.googleusercontent.com/d/1of8t2iKc8OkbPVXstgNsRL_YPlAIbBd3')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ===== API ROUTER (เรียกจาก Cloudflare Pages) ===== */
const FN_ACCESS = {
  apiGetBootstrap:'public', apiLogin:'public',
  apiGetMaterials:'public', apiGetLowStock:'public', apiGetCategories:'public',
  apiCreateRequest:'public', apiTrackRequest:'public',

  // Officer level (เจ้าหน้าที่พัสดุ + Admin):
  apiLogout:'officer', apiGetMyRequests:'officer', apiGetRequestForPrint:'officer',
  apiGetTeacherDashboard:'officer', apiUpdateProfile:'officer', apiGetStockCard:'officer',
  apiSaveMaterials:'officer', apiDeleteMaterials:'officer',
  apiPurchaseMaterials:'officer', apiSaveCategory:'officer', apiGetRequests:'officer',
  apiGetShops:'officer', apiSaveShop:'officer', apiDeleteShop:'officer',
  apiUpdateRequestStatus:'officer', apiDeleteRequests:'officer', apiGetStockMovements:'officer',
  apiGetAdminDashboard:'officer', apiGetInventoryAccount:'officer',
  apiGetInventoryReport:'officer', apiSaveOpeningBalance:'officer', apiExportInventoryReportSheet:'officer',

  // Admin only (ผู้ดูแลระบบ):
  apiGetUsers:'admin', apiGetSettings:'admin', apiSaveSettings:'admin', apiSaveUsers:'admin',
  apiDeleteUsers:'admin', apiGetAuditLog:'admin', apiTestTelegram:'admin', apiTestLine:'admin',
  apiRunSchemaMigration:'admin',
  apiExportCSV:'admin',
  apiClearStockMovements:'admin'
};

function doPost(e){
  let out;
  try{
    const req = JSON.parse(e.postData.contents);
    out = dispatch_(String(req.fn||''), req.args || [], req.token || '');
  }catch(err){
    out = { ok:false, message:String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function dispatch_(fn, args, token){
  const level = FN_ACCESS[fn];
  if(!level) return { ok:false, message:'ไม่พบฟังก์ชัน' };

  let sess = null;
  const ROLE_RANK = { admin:2, officer:1, staff:1 };

  if(level !== 'public'){
    const raw = CacheService.getScriptCache().get('tk_' + token);
    if(!raw) return { ok:false, code:'AUTH', message:'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' };
    sess = JSON.parse(raw);
    const userRank = ROLE_RANK[sess.role] || 0;
    const reqRank  = ROLE_RANK[level] || 0;
    if(userRank < reqRank)
      return { ok:false, code:'FORBIDDEN', message:'ไม่มีสิทธิ์ใช้งานส่วนนี้' };

    // บังคับ actor จาก session เสมอ (ไม่เชื่อค่าที่ browser ส่งมา)
    args.forEach(a=>{
      if(Array.isArray(a)) a.forEach(it=>{ if(it && typeof it === 'object') it.actor = sess.username; });
      else if(a && typeof a === 'object') a.actor = sess.username;
    });

    if(fn === 'apiDeleteUsers') args[1] = sess.username;
    if(fn === 'apiDeleteShop') args[1] = sess.username;
    if(fn === 'apiLogout') args[0] = sess.username;

    if(fn === 'apiGetMyRequests' && !args[0]) args[0] = sess.id;
    if(fn === 'apiUpdateProfile'){ args[0] = args[0] || {}; args[0].ID = sess.id; }
  } else {
    // กรณี public ฟังก์ชัน (เช่น apiCreateRequest ที่ส่งจากหน้าเว็บโดยไม่ได้ล็อกอิน)
    if(fn === 'apiCreateRequest'){
      args[0] = args[0] || {};
      if(!args[0].UserID) args[0].UserID = 'GUEST';
      if(!args[0].actor) args[0].actor = args[0].FullName || 'ผู้ขอเบิก (บุคคลทั่วไป)';
    }
  }

  const res = globalThis[fn].apply(null, args);

  if(fn === 'apiLogin' && res && res.ok){
    const tk = Utilities.getUuid();
    CacheService.getScriptCache().put('tk_' + tk,
      JSON.stringify({ id:res.user.ID, role:res.user.Role, username:res.user.Username }), 21600);
    res.token = tk;
  }
  if(fn === 'apiLogout' && token) CacheService.getScriptCache().remove('tk_' + token);
  return res;
}

/* ============================== SHEET HELPERS ============================== */
let _book = null;
const _shCache = {};
function ss_(){ return _book || (_book = SpreadsheetApp.openById(SHEET_ID)); }

function getSheet_(name){
  if(_shCache[name]) return _shCache[name];
  const book = ss_();
  let sh = book.getSheetByName(name);
  if(!sh){
    sh = book.insertSheet(name);
    const headers = HEADERS[name];
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1,1,1,headers.length)
      .setBackground('#075985').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
    sh.setRowHeight(1, 32);
    sh.autoResizeColumns(1, headers.length);
  }
  return (_shCache[name] = sh);
}

function cellVal_(v){
  if(v === null || v === undefined) return '';
  if(Object.prototype.toString.call(v) === '[object Date]'){
    if(isNaN(v.getTime())) return '';
    try{ return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss').replace(' 00:00:00',''); }
    catch(e){ return String(v); }
  }
  if(typeof v === 'number') return isFinite(v) ? v : 0;
  if(typeof v === 'boolean') return v;
  return String(v);
}

/* ---------- Cache ข้อมูลชีต (แบ่ง chunk เพราะ CacheService จำกัด ~100KB/key) ---------- */
const CACHE_SHEETS = ['Materials','Users','Categories','Requests','RequestItems','Purchases','OpeningBalances','Shops'];
const CACHE_TTL = 300;   // วินาที
const CHUNK = 30000;     // ตัวอักษรต่อ chunk

function cacheGet_(key){
  try{
    const c = CacheService.getScriptCache();
    const n = Number(c.get(key + '_n') || 0);
    if(!n) return null;
    const ks = []; for(let i=0;i<n;i++) ks.push(key + '_' + i);
    const parts = c.getAll(ks);
    let s = '';
    for(let i=0;i<n;i++){ const p = parts[key + '_' + i]; if(p == null) return null; s += p; }
    return JSON.parse(s);
  }catch(e){ return null; }
}
function cachePut_(key, obj){
  try{
    const s = JSON.stringify(obj);
    const n = Math.max(1, Math.ceil(s.length / CHUNK));
    if(n > 20) return;                         // ใหญ่เกินไป ข้ามการ cache
    const pack = {}; pack[key + '_n'] = String(n);
    for(let i=0;i<n;i++) pack[key + '_' + i] = s.substr(i*CHUNK, CHUNK);
    CacheService.getScriptCache().putAll(pack, CACHE_TTL);
  }catch(e){}
}
function cacheClear_(name){
  if(CACHE_SHEETS.indexOf(name) < 0) return;
  try{
    const c = CacheService.getScriptCache(), key = 'sh_' + name;
    const n = Number(c.get(key + '_n') || 0);
    const ks = [key + '_n']; for(let i=0;i<n;i++) ks.push(key + '_' + i);
    c.removeAll(ks);
  }catch(e){}
}

/* ---------- อ่านทั้งชีตด้วย API call เดียว ---------- */
function readAll_(name){
  const cacheable = CACHE_SHEETS.indexOf(name) >= 0;
  const key = 'sh_' + name;
  if(cacheable){ const hit = cacheGet_(key); if(hit) return hit; }

  const values = getSheet_(name).getDataRange().getValues();
  if(values.length < 2) return [];
  const headers = values[0].map(h => String(h || '').trim());
  const out = [];
  for(let r=1; r<values.length; r++){
    const row = values[r], obj = {};
    for(let i=0;i<headers.length;i++){ if(headers[i]) obj[headers[i]] = cellVal_(row[i]); }
    if(name === SHEETS.SETTINGS || String(obj.ID || '').trim() !== '') out.push(obj);
  }
  if(cacheable) cachePut_(key, out);
  return out;
}

function appendRow_(name, obj){
  const sh = getSheet_(name);
  const headers = HEADERS[name];
  sh.appendRow(headers.map(h => obj[h] !== undefined ? obj[h] : ''));
  cacheClear_(name);
  return sh.getLastRow();
}

/* เขียนทั้งแถวด้วย setValues ครั้งเดียว */
function updateRowById_(name, id, patch){
  const sh = getSheet_(name);
  const lastRow = sh.getLastRow();
  const headers = HEADERS[name];
  const idCol = headers.indexOf('ID') + 1;
  if(lastRow < 2 || idCol < 1) return false;
  const ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
  for(let i=0;i<ids.length;i++){
    if(String(ids[i][0]) === String(id)){
      const rng = sh.getRange(i + 2, 1, 1, headers.length);
      const row = rng.getValues()[0];
      headers.forEach((h, ci)=>{ if(patch[h] !== undefined) row[ci] = patch[h]; });
      rng.setValues([row]);
      cacheClear_(name);
      return i + 2;
    }
  }
  return false;
}

function deleteRowById_(name, id){
  const sh = getSheet_(name);
  const lastRow = sh.getLastRow();
  const headers = HEADERS[name];
  const idCol = headers.indexOf('ID') + 1;
  if(lastRow < 2 || idCol < 1) return false;
  const ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
  for(let i=0;i<ids.length;i++){
    if(String(ids[i][0]) === String(id)){
      sh.deleteRow(i + 2);
      cacheClear_(name);
      return true;
    }
  }
  return false;
}

function withLock_(fn){
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{ return fn(); }
  finally{ lock.releaseLock(); }
}

/* ============================== UTILITIES ============================== */
function genId_(prefix){
  return (prefix||'ID') + '-' + Utilities.getUuid().split('-')[0].toUpperCase();
}
function nowIso_(){ return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function todayStr_(){ return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function genDocNo_(){
  const datePart = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const reqs = readAll_(SHEETS.REQUESTS);
  const countToday = reqs.filter(r=> String(r.DocNo||'').indexOf('REQ-'+datePart) === 0).length;
  return 'REQ-' + datePart + '-' + String(countToday + 1).padStart(4,'0');
}
function computeStockState_(stockQty, minQty){
  if(stockQty <= 0) return 'OUT';
  if(stockQty <= minQty) return 'LOW';
  return 'OK';
}
function daysAgoStr_(n){
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/* ============================== PASSWORD (SHA-256 + salt) ============================== */
// salt เก็บใน Script Properties ชื่อ PW_SALT
// ถ้ายังไม่ได้ตั้ง จะใช้ค่าเดิมเพื่อให้รหัสที่ hash ไว้แล้วยังใช้ได้
const LEGACY_SALT = 'เปลี่ยนเป็นข้อความสุ่มยาวๆ ของคุณ';
let _salt = null;
function getSalt_(){
  if(_salt) return _salt;
  _salt = PropertiesService.getScriptProperties().getProperty('PW_SALT') || LEGACY_SALT;
  return _salt;
}

/* รันครั้งเดียว "ก่อนเริ่มใช้งานจริง" (ตอนที่ยังไม่มีรหัสผ่านที่ hash แล้ว) เพื่อสุ่ม salt ใหม่ */
function initPasswordSalt(){
  const hashed = readAll_(SHEETS.USERS).filter(u => isHashed_(u.Password)).length;
  if(hashed > 0) throw new Error('มีรหัสผ่านที่ hash แล้ว '+hashed+' บัญชี การเปลี่ยน salt จะทำให้เข้าสู่ระบบไม่ได้ — ยกเลิก');
  PropertiesService.getScriptProperties().setProperty('PW_SALT', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('ตั้งค่า PW_SALT เรียบร้อย');
}

function hashPw_(pw){
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, getSalt_() + '|' + pw, Utilities.Charset.UTF_8);
  return 'sha256$' + bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function isHashed_(s){ return String(s||'').indexOf('sha256$') === 0; }
function checkPw_(stored, input){
  stored = String(stored||'').trim();
  return isHashed_(stored) ? stored === hashPw_(input) : stored === String(input);
}

/* ============================== AUDIT + STOCK MOVEMENT ============================== */
function logAudit_(action, entity, entityId, detail, actor){
  try{
    appendRow_(SHEETS.AUDIT_LOG, {
      ID: genId_('AUD'), Action: action, Entity: entity, EntityID: entityId || '',
      Detail: detail || '', Actor: actor || '', CreatedAt: nowIso_()
    });
  }catch(e){ console.error('Audit log error: '+e); }
}

function logStockMovement_(materialId, code, name, type, qty, beforeQty, afterQty, refDoc, note, actor){
  try{
    appendRow_(SHEETS.STOCK_MOVEMENTS, {
      ID: genId_('SM'), MaterialID: materialId, Code: code, Name: name,
      Type: type, // IN / OUT / ADJUST
      Qty: qty, BeforeQty: beforeQty, AfterQty: afterQty,
      RefDoc: refDoc || '', Note: note || '', Actor: actor || '', CreatedAt: nowIso_()
    });
  }catch(e){ console.error('Stock movement error: '+e); }
}

/* ============================== DRIVE FILE STORAGE ============================== */
function getSubFolder_(name){
  const root = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const it = root.getFoldersByName(name);
  if(it.hasNext()) return it.next();
  return root.createFolder(name);
}

function saveFile_(fileObj, subfolderName){
  if(!fileObj || !fileObj.base64) return '';
  const folder = getSubFolder_(subfolderName);
  const raw = String(fileObj.base64);
  const commaIdx = raw.indexOf(',');
  const meta = commaIdx >= 0 ? raw.substring(0, commaIdx) : '';
  const data = commaIdx >= 0 ? raw.substring(commaIdx+1) : raw;
  const mimeMatch = meta.match(/data:([^;]+);/);
  const mime = fileObj.mimeType || (mimeMatch ? mimeMatch[1] : 'application/octet-stream');
  const bytes = Utilities.base64Decode(data);
  const blob = Utilities.newBlob(bytes, mime, fileObj.fileName || ('file_' + Date.now()));
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const isImage = String(mime).indexOf('image/') === 0;
  return isImage ? ('https://lh3.googleusercontent.com/d/' + file.getId()) : file.getUrl();
}

/* ============================== SETUP + SEED ============================== */
function ensureSetup(){
  const cache = CacheService.getScriptCache();
  if(cache.get('setup_ok')) return;
  Object.keys(SHEETS).forEach(k=> getSheet_(SHEETS[k]));
  seedSettingsIfEmpty_();
  seedUsersIfEmpty_();
  seedCategoriesIfEmpty_();
  seedMaterialsIfEmpty_();
  seedRequestsIfEmpty_();
  seedShopsIfEmpty_();
  cache.put('setup_ok', '1', 21600);
}

function seedShopsIfEmpty_(){
  const sh = getSheet_(SHEETS.SHOPS);
  if(sh.getLastRow() >= 2) return;
  const materials = readAll_(SHEETS.MATERIALS);
  const seen = new Set();
  const rows = [];
  materials.forEach(m => {
    const name = String(m.ShopName || '').trim();
    if(!name) return;
    const key = name.toLowerCase();
    if(seen.has(key)) return;
    seen.add(key);
    rows.push({
      ID: genId_('SHP'),
      Name: name,
      TaxId: String(m.ShopTaxId || '').trim(),
      Address: String(m.ShopAddress || '').trim(),
      Phone: String(m.ShopPhone || '').trim(),
      Note: '',
      CreatedAt: nowIso_(),
      UpdatedAt: nowIso_()
    });
  });
  rows.forEach(r => appendRow_(SHEETS.SHOPS, r));
}

function seedSettingsIfEmpty_(){
  const sh = getSheet_(SHEETS.SETTINGS);
  if(sh.getLastRow() < 2){
    appendRow_(SHEETS.SETTINGS, {
      SchoolName: 'มหาวิทยาลัยสวนดุสิต ศูนย์การศึกษาลำปาง',
      Affiliation: 'กระทรวงการอุดมศึกษา วิทยาศาสตร์ วิจัยและนวัตกรรม',
      LogoUrl: '', Address: '140 ถนนสุเรนทร์ ตำบลสบตุ๋ย อำเภอเมืองลำปาง จังหวัดลำปาง 52100', Phone: '054-228019',
      UpdatedAt: nowIso_(),
      NotifyEmail: '', TelegramBotToken: '', TelegramChatId: '',
      NotifyOnNewRequest: 'YES', NotifyOnStatusChange: 'YES', NotifyLowStock: 'YES', BannerUrl: ''
    });
  }
}

function seedUsersIfEmpty_(){
  const sh = getSheet_(SHEETS.USERS);
  if(sh.getLastRow() < 2){
    const mk = (u,f,r,p,d)=> appendRow_(SHEETS.USERS, { ID:genId_('U'), Username:u, Password:'1234', FullName:f, Role:r, Position:p, Department:d||'', Email:'', CreatedAt: nowIso_(), UpdatedAt: nowIso_() });
    mk('admin',   'ผู้ดูแลระบบ',           'admin',   'เจ้าหน้าที่', 'สำนักงานศูนย์การศึกษา');
    mk('officer', 'สมชาย ใจดี',             'officer', 'เจ้าหน้าที่', 'สำนักงานศูนย์การศึกษา');
    mk('staff1',  'อ.ดร.พิมพ์ใจ สุขสม',     'officer', 'อาจารย์',   'สาขาวิชาธุรกิจการบิน');
    mk('staff2',  'นายวิชัย พัฒนาการ',      'officer', 'เจ้าหน้าที่', 'ฝ่ายงานส่งเสริมวิชาการและงานทะเบียน');
  }
}

function seedCategoriesIfEmpty_(){
  const sh = getSheet_(SHEETS.CATEGORIES);
  if(sh.getLastRow() < 2){
    ['หมวดงานเอกสารและกระดาษ','หมวดเครื่องเขียนและอุปกรณ์ตัด','หมวดอุปกรณ์ยึดติดและเทป','หมวดอุปกรณ์ไอทีและวัสดุคอมพิวเตอร์','หมวดงานบ้านงานครัวสำนักงาน'].forEach(name=>{
      appendRow_(SHEETS.CATEGORIES, { ID: genId_('CAT'), Name: name, CreatedAt: nowIso_() });
    });
  }
}

function seedMaterialsIfEmpty_(){
  const sh = getSheet_(SHEETS.MATERIALS);
  if(sh.getLastRow() < 2){
    const samples = [
      ['MED-001', 'หน้ากากอนามัยแบบใช้แล้วทิ้ง (Surgical Mask)',     'กล่อง',  85,  120, 20, 'อุปกรณ์ป้องกัน'],
      ['MED-002', 'ถุงมือยางตรวจโรค (Examination Gloves) ขนาด M',   'กล่อง', 150,   80, 15, 'อุปกรณ์ป้องกัน'],
      ['MED-003', 'แอลกอฮอล์เจลล้างมือ 70% ขนาด 500 มล.',          'ขวด',   65,   45, 10, 'วัสดุสิ้นเปลือง'],
      ['MED-004', 'สำลีแผ่นปลอดเชื้อ (Cotton Pad)',                 'ห่อ',   35,   60, 15, 'วัสดุสิ้นเปลือง'],
      ['MED-005', 'ผ้าพันแผลยืดหยุ่น ขนาด 3 นิ้ว',                  'ม้วน',  28,   40, 10, 'วัสดุสิ้นเปลือง'],
      ['MED-006', 'เข็มฉีดยาใช้แล้วทิ้ง ขนาด 5 มล. (Syringe)',      'กล่อง', 120,   25,  8, 'เครื่องมือแพทย์'],
      ['MED-007', 'กระบอกฉีดยา (Syringe) ขนาด 3 มล. พร้อมเข็ม',     'กล่อง',  95,   30,  8, 'เครื่องมือแพทย์'],
      ['MED-008', 'แอลกอฮอล์เช็ดแผล 70% ขนาด 450 มล.',             'ขวด',   45,   35, 10, 'วัสดุสิ้นเปลือง'],
      ['MED-009', 'เทอร์โมมิเตอร์ดิจิทัลวัดไข้ (Digital Thermometer)','อัน',  180,   12,  5, 'เครื่องมือแพทย์'],
      ['MED-010', 'แผ่นพลาสเตอร์ปิดแผลแบบกลม (Band-Aid)',           'กล่อง',  40,   55, 15, 'วัสดุสิ้นเปลือง'],
      ['MED-011', 'น้ำเกลือล้างแผล 0.9% NaCl ขนาด 1000 มล.',       'ขวด',   25,   40, 12, 'ยาและเวชภัณฑ์'],
      ['MED-012', 'ผ้าก๊อซปลอดเชื้อ (Sterile Gauze) ขนาด 4x4 นิ้ว', 'ห่อ',   55,   50, 15, 'วัสดุสิ้นเปลือง'],
      ['MED-013', 'หมวกคลุมผมทางการแพทย์แบบใช้แล้วทิ้ง',            'กล่อง',  70,   30, 10, 'อุปกรณ์ป้องกัน'],
      ['MED-014', 'ชุด PPE ป้องกันส่วนบุคคล (Coverall) ขนาด L',     'ชุด',  280,    8,  3, 'อุปกรณ์ป้องกัน'],
      ['MED-015', 'เครื่องวัดความดันโลหิตแบบดิจิทัล (แขน)',         'เครื่อง', 890,  5,  2, 'เครื่องมือแพทย์']
    ];
    samples.forEach(s=>{
      appendRow_(SHEETS.MATERIALS, {
        ID: genId_('M'), Code:s[0], Name:s[1], Unit:s[2], UnitPrice:s[3],
        StockQty:s[4], MinQty:s[5], OpeningQty:s[4], Category:s[6],
        ImageUrl:'', FileUrl:'', CreatedAt: nowIso_(), UpdatedAt: nowIso_()
      });
    });
  }
}

function seedRequestsIfEmpty_(){
  const sh = getSheet_(SHEETS.REQUESTS);
  if(sh.getLastRow() >= 2) return;
  const materials = readAll_(SHEETS.MATERIALS);
  const users = readAll_(SHEETS.USERS).filter(u => u.Role === 'officer' || u.Role === 'staff');
  if(!materials.length || !users.length) return;

  const pick = (i) => materials[Math.min(i, materials.length - 1)];

  const samples = [
    { daysAgo:12, userIdx:0, dept:'สาขาวิชาธุรกิจการบิน', purpose:'ใช้จัดการเรียนการสอนและฝึกปฏิบัติการบริการผู้โดยสาร', status:'APPROVED', items:[{m:0,qty:5},{m:1,qty:2},{m:3,qty:3}] },
    { daysAgo:10, userIdx:1, dept:'ฝ่ายงานส่งเสริมวิชาการและงานทะเบียน', purpose:'ใช้ในการจัดทำเอกสารลงทะเบียนและประเมินผลการเรียน', status:'APPROVED', items:[{m:0,qty:10},{m:2,qty:6},{m:9,qty:4}] },
    { daysAgo:9,  userIdx:0, dept:'สาขาวิชาการศึกษาปฐมวัย', purpose:'เบิกวัสดุสำหรับสื่อการสอนและกิจกรรมเสริมทักษะเด็ก', status:'APPROVED', items:[{m:4,qty:8},{m:5,qty:2},{m:7,qty:3},{m:11,qty:5}] },
    { daysAgo:8,  userIdx:2, dept:'สำนักงานศูนย์การศึกษา', purpose:'ใช้ในการจัดประชุมบุคลากรและงานสารบรรณประจำวัน', status:'APPROVED', items:[{m:13,qty:3},{m:0,qty:15},{m:1,qty:5}] },
    { daysAgo:7,  userIdx:1, dept:'สาขาวิชาเทคโนโลยีการประกอบอาหารและการบริการ', purpose:'ใช้ในห้องปฏิบัติการอาหารและเตรียมการฝึกอบรม', status:'PENDING', items:[{m:1,qty:3},{m:3,qty:4},{m:7,qty:2}] },
    { daysAgo:5,  userIdx:0, dept:'ฝ่ายอาคารสถานที่ สิ่งแวดล้อม และแหล่งเรียนรู้', purpose:'ใช้ในงานซ่อมบำรุงและดูแลพื้นที่ศูนย์การศึกษาลำปาง', status:'PENDING', items:[{m:8,qty:2},{m:9,qty:6},{m:10,qty:4},{m:4,qty:5}] },
    { daysAgo:4,  userIdx:2, dept:'สาขาวิชาการประถมศึกษา', purpose:'ใช้จัดกิจกรรมโครงการค่ายวิชาการพัฒนาเยาวชน', status:'PENDING', items:[{m:2,qty:4},{m:3,qty:5},{m:11,qty:3}] },
    { daysAgo:3,  userIdx:1, dept:'โรงเรียนสาธิตละอออุทิศ ลำปาง', purpose:'ใช้ในกิจกรรมการเรียนรู้ของนักเรียนสาธิตละอออุทิศ', status:'REJECTED', rejectReason:'จำนวนที่ขอเบิกเกินเกณฑ์สำรองประจำเดือน — กรุณาปรับลดจำนวน', items:[{m:0,qty:2}] },
    { daysAgo:2,  userIdx:0, dept:'ฝ่ายพัฒนางานวิจัยและนวัตกรรม', purpose:'ใช้ในโครงการวิจัยและบริการวิชาการแก่ชุมชน', status:'APPROVED', items:[{m:14,qty:1},{m:8,qty:1},{m:2,qty:3}] },
    { daysAgo:1,  userIdx:2, dept:'ฝ่ายงานพัฒนานักศึกษา', purpose:'เตรียมเอกสารโครงการปฐมนิเทศและกิจกรรมพัฒนาศักยภาพนักศึกษา', status:'PENDING', items:[{m:4,qty:10},{m:9,qty:8},{m:3,qty:6},{m:7,qty:4}] }
  ];

  samples.forEach((s, idx)=>{
    const user = users[Math.min(s.userIdx, users.length - 1)];
    const reqDate = daysAgoStr_(s.daysAgo);
    const datePart = reqDate.replace(/-/g, '');
    const docNo = 'REQ-' + datePart + '-' + String(idx + 1).padStart(4, '0');

    let total = 0;
    const resolved = [];
    s.items.forEach(it=>{
      const m = pick(it.m);
      const qty = Number(it.qty || 0);
      if(!(qty > 0)) return;
      const unitPrice = Number(m.UnitPrice || 0);
      const totalPrice = qty * unitPrice;
      total += totalPrice;
      resolved.push({
        MaterialID: m.ID, Code: m.Code, Name: m.Name, Unit: m.Unit,
        Qty: qty, UnitPrice: unitPrice, TotalPrice: totalPrice, Remark: ''
      });
    });
    if(!resolved.length) return;

    const reqId = genId_('R');
    const isApproved = s.status === 'APPROVED';
    const isRejected = s.status === 'REJECTED';

    appendRow_(SHEETS.REQUESTS, {
      ID: reqId, DocNo: docNo, RequestDate: reqDate, UserID: user.ID,
      FullName: user.FullName, Position: user.Position || 'เจ้าหน้าที่',
      Department: s.dept, Purpose: s.purpose, Note: '', AttachUrl: '',
      Status: s.status, RejectReason: isRejected ? (s.rejectReason || '') : '',
      ApprovedDate: (isApproved || isRejected) ? nowIso_() : '',
      ApprovedBy: (isApproved || isRejected) ? 'admin' : '',
      TotalAmount: total, ItemCount: resolved.length,
      CreatedAt: nowIso_(), UpdatedAt: nowIso_()
    });

    resolved.forEach(it=>{
      appendRow_(SHEETS.REQUEST_ITEMS, Object.assign({ ID: genId_('RI'), RequestID: reqId }, it));
    });

    if(isApproved){
      resolved.forEach(it=>{
        const m = materials.find(x => String(x.ID) === String(it.MaterialID));
        if(!m) return;
        const before = Number(m.StockQty || 0);
        const newStock = Math.max(0, before - Number(it.Qty || 0));
        updateRowById_(SHEETS.MATERIALS, m.ID, { StockQty: newStock, UpdatedAt: nowIso_() });
        logStockMovement_(m.ID, m.Code, m.Name, 'OUT', it.Qty, before, newStock, docNo, 'เบิกจากใบขอเบิก (seed)', 'admin');
        m.StockQty = newStock;
      });
    }
  });
}

/* ============================== NOTIFICATION ============================== */
function sendEmailNotify_(to, subject, bodyHtml){
  if(!to) return;
  const recipients = String(to).split(',').map(s=>s.trim()).filter(Boolean);
  if(!recipients.length) return;
  try{
    GmailApp.sendEmail(recipients.join(','), subject, '', { htmlBody: bodyHtml, name: 'ระบบเบิกจ่ายพัสดุ' });
  }catch(e){ console.error('Email error: '+e); }
}

function sendTelegramNotify_(botToken, chatId, text){
  if(!botToken || !chatId) return { ok: false, message: 'กรุณาระบุ Telegram Bot Token และ Chat ID' };
  if(String(botToken).indexOf(':') === -1){
    return { ok: false, message: 'รูปแบบ Telegram Bot Token ไม่ถูกต้อง (ต้องมีเครื่องหมาย : เช่น 123456:ABC... ที่ได้รับจาก @BotFather)' };
  }
  try{
    const url = 'https://api.telegram.org/bot' + botToken + '/sendMessage';
    const resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
      muteHttpExceptions: true
    });
    const code = resp.getResponseCode();
    const content = resp.getContentText();
    if(code >= 200 && code < 300){
      return { ok: true, message: 'ส่งข้อความสำเร็จ' };
    }
    let errMsg = 'Telegram API Error (' + code + ')';
    try {
      const parsed = JSON.parse(content);
      if(parsed && parsed.description) errMsg += ': ' + parsed.description;
    } catch(_) { errMsg += ': ' + content.substring(0, 120); }
    console.error(errMsg);
    return { ok: false, message: errMsg };
  }catch(e){
    console.error('Telegram error: '+e);
    return { ok: false, message: String(e) };
  }
}

function getNotifyConfig_(){
  const s = getSettingsObj_();
  return {
    emails: s.NotifyEmail || '',
    botToken: s.TelegramBotToken || '',
    chatId: s.TelegramChatId || '',
    lineToken: s.LineToken || '',
    lineTo: s.LineTo || '',
    onNewRequest: String(s.NotifyOnNewRequest || 'YES').toUpperCase() === 'YES',
    onStatusChange: String(s.NotifyOnStatusChange || 'YES').toUpperCase() === 'YES',
    onLowStock: String(s.NotifyLowStock || 'YES').toUpperCase() === 'YES',
    schoolName: s.SchoolName || 'ระบบเบิกจ่ายพัสดุ'
  };
}

// LINE Notify ปิดบริการแล้ว: ส่งผ่าน LINE Messaging API (push) token และ to เป็นความลับ ห้าม log
function sendLinePush_(token, to, text){
  const t = String(token || '').trim();
  const dest = String(to || '').trim();
  if(!t) return { ok: false, message: 'กรุณาระบุ LINE Channel access token' };
  if(!dest) return { ok: false, message: 'กรุณาระบุ LINE Group ID หรือ User ID' };
  try{
    const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + t },
      payload: JSON.stringify({ to: dest, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    if(code >= 200 && code < 300) return { ok: true, message: 'ส่งข้อความสำเร็จ' };
    let msg = 'LINE API Error (' + code + ')';
    try{ const j = JSON.parse(response.getContentText()); if(j && j.message) msg += ': ' + j.message; }catch(_){}
    return { ok: false, message: msg };
  }catch(e){
    console.error('Line push error');
    return { ok: false, message: 'ส่งข้อความ LINE ไม่สำเร็จ' };
  }
}

function apiTestLine(payload){
  try{
    let token = '';
    let to = '';
    if(payload && typeof payload === 'object'){ token = payload.token || payload.LineToken || ''; to = payload.to || payload.LineTo || ''; }
    else if(typeof payload === 'string') token = payload.trim();
    const s = getSettingsObj_();
    token = token || s.LineToken;
    to = to || s.LineTo;
    if(!token || !to) return { ok: false, message: 'กรุณากรอก LINE Channel access token และ Group ID ก่อนทดสอบ' };
    const testMsg = '🔔 ทดสอบการเชื่อมต่อ LINE\nระบบ: ' + (s.SchoolName || 'ระบบเบิกจ่ายพัสดุ') + '\nเวลาทดสอบ: ' + thaiDateFull_(todayStr_());
    const res = sendLinePush_(token, to, testMsg);
    if(res && res.ok === false) return res;
    return { ok: true, message: 'ส่งข้อความทดสอบไปยัง LINE สำเร็จแล้ว' };
  }catch(err){ return { ok: false, message: String(err) }; }
}

function notifyNewRequest_(req){
  const cfg = getNotifyConfig_();
  if(!cfg.onNewRequest) return;
  if(!cfg.emails && !(cfg.botToken && cfg.chatId) && !cfg.lineToken) return;
  const subject = '[' + cfg.schoolName + '] มีใบขอเบิกใหม่ ' + req.DocNo;
  const html = `<div style="font-family:Sarabun,sans-serif;line-height:1.6">
    <h3>มีใบขอเบิกพัสดุใหม่</h3>
    <p><b>เลขที่:</b> ${req.DocNo}<br><b>ผู้ขอ:</b> ${req.FullName} (${req.Position||'-'})<br>
    <b>หลักสูตร/ฝ่ายงาน:</b> ${req.Department||'-'}<br><b>วันที่:</b> ${req.RequestDate}<br>
    <b>วัตถุประสงค์:</b> ${req.Purpose||'-'}<br><b>จำนวนรายการ:</b> ${req.ItemCount}<br>
    <b>มูลค่ารวม:</b> ${Number(req.TotalAmount||0).toLocaleString('th-TH',{minimumFractionDigits:2})} บาท</p>
    <p style="color:#0284c7">กรุณาเข้าสู่ระบบเพื่อตรวจสอบและอนุมัติ</p></div>`;
  sendEmailNotify_(cfg.emails, subject, html);

  // ข้อความ Telegram แบบสั้น (ไม่มีรายการพัสดุ/หมายเหตุ/ไฟล์แนบ) ให้ตรงกับฝั่ง Cloudflare
  const tg = `🔔 <b>มีใบขอเบิกพัสดุใหม่</b>\n` +
    `📄 <b>เลขที่:</b> <code>${req.DocNo}</code>\n` +
    `👤 <b>ผู้ขอเบิก:</b> ${req.FullName}\n` +
    `🏢 <b>หลักสูตร / ฝ่ายงาน / โครงการ:</b> ${req.Department || '-'}\n` +
    `🎯 <b>วัตถุประสงค์:</b> ${req.Purpose || '-'}\n` +
    `📊 <b>จำนวน:</b> ${req.ItemCount} รายการ | <b>มูลค่ารวม:</b> ${Number(req.TotalAmount||0).toLocaleString('th-TH', {minimumFractionDigits:2})} บาท`;
  if(cfg.botToken && cfg.chatId) sendTelegramNotify_(cfg.botToken, cfg.chatId, tg);

  if(cfg.lineToken && cfg.lineTo){
    sendLinePush_(cfg.lineToken, cfg.lineTo, '📄 มีใบขอเบิกพัสดุใหม่\nเลขที่: ' + req.DocNo + '\nผู้ขอเบิก: ' + req.FullName + '\nแผนก: ' + (req.Department||'-') + '\nวัตถุประสงค์: ' + (req.Purpose||'-') + '\nจำนวน: ' + req.ItemCount + ' รายการ | มูลค่ารวม: ' + Number(req.TotalAmount||0).toLocaleString('th-TH', {minimumFractionDigits:2}) + ' บาท');
  }
}

function notifyStatusChange_(req, newStatus, reason){
  const cfg = getNotifyConfig_();
  // แจ้ง Telegram/LINE เฉพาะเมื่ออนุมัติ (ใช้สวิตช์เดียวกับใบขอเบิกใหม่) ให้ตรงกับฝั่ง Cloudflare
  if(newStatus === 'APPROVED' && cfg.onNewRequest){
    const total = Number(req.TotalAmount||0).toLocaleString('th-TH', {minimumFractionDigits:2});
    if(cfg.botToken && cfg.chatId){
      sendTelegramNotify_(cfg.botToken, cfg.chatId, `✅ <b>อนุมัติใบขอเบิกพัสดุแล้ว</b>\n` +
        `📄 <b>เลขที่:</b> <code>${req.DocNo}</code>\n` +
        `👤 <b>ผู้ขอเบิก:</b> ${req.FullName}\n` +
        `🏢 <b>หลักสูตร / ฝ่ายงาน / โครงการ:</b> ${req.Department || '-'}\n` +
        `📊 <b>จำนวน:</b> ${req.ItemCount} รายการ | <b>มูลค่ารวม:</b> ${total} บาท`);
    }
    if(cfg.lineToken && cfg.lineTo){
      sendLinePush_(cfg.lineToken, cfg.lineTo, '✅ อนุมัติใบขอเบิกพัสดุแล้ว\nเลขที่: ' + req.DocNo + '\nผู้ขอเบิก: ' + req.FullName + '\nแผนก: ' + (req.Department||'-') + '\nจำนวน: ' + req.ItemCount + ' รายการ | มูลค่ารวม: ' + total + ' บาท');
    }
  }
  if(!cfg.onStatusChange) return;
  const users = readAll_(SHEETS.USERS);
  const user = users.find(u => String(u.ID) === String(req.UserID));
  const userEmail = (user && user.Email) ? user.Email : '';
  // อีเมลถึงผู้ขอเบิก (Telegram/LINE แจ้งเฉพาะเมื่ออนุมัติ ด้านบน)
  if(!userEmail) return;

  const statusTh = newStatus === 'APPROVED' ? 'อนุมัติแล้ว ✅' : newStatus === 'REJECTED' ? 'ถูกปฏิเสธ ❌' : (newStatus === 'CANCELLED' ? 'ยกเลิกแล้ว ⚪' : newStatus);
  const subject = '[' + cfg.schoolName + '] สถานะใบขอเบิก ' + req.DocNo + ' → ' + statusTh;
  const html = `<div style="font-family:Sarabun,sans-serif;line-height:1.6">
    <h3>สถานะใบขอเบิกของคุณเปลี่ยนแล้ว</h3>
    <p><b>เลขที่:</b> ${req.DocNo}<br><b>สถานะใหม่:</b> ${statusTh}<br>
    ${reason ? '<b>เหตุผล:</b> '+reason+'<br>' : ''}<b>วันที่:</b> ${todayStr_()}</p></div>`;
  sendEmailNotify_(userEmail, subject, html);
}

/**
 * ฟังก์ชันทดสอบการเชื่อมต่อ Telegram จากหน้าตั้งค่าระบบ
 */
function apiTestTelegram(payload, chatIdArg){
  try {
    let token = '';
    let chatId = '';
    if(payload && typeof payload === 'object'){
      token = payload.token || payload.TelegramBotToken;
      chatId = payload.chatId || payload.TelegramChatId;
    } else if(typeof payload === 'string'){
      token = payload;
      chatId = chatIdArg;
    }
    const s = getSettingsObj_();
    token = token || s.TelegramBotToken;
    chatId = chatId || s.TelegramChatId;

    if(!token || !chatId){
      return { ok: false, message: 'กรุณากรอก Telegram Bot Token และ Chat ID ก่อนทดสอบ' };
    }
    const testMsg = `🔔 <b>ทดสอบการเชื่อมต่อ Telegram</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🏫 <b>ระบบ:</b> ${s.SchoolName || 'ระบบเบิกจ่ายพัสดุ'}\n` +
      `📅 <b>เวลาทดสอบ:</b> ${nowIso_()}\n` +
      `🟢 <b>สถานะ:</b> บอทส่งข้อความสำเร็จเรียบร้อยแล้ว!\n` +
      `━━━━━━━━━━━━━━━━━━━`;
    const res = sendTelegramNotify_(token, chatId, testMsg);
    if(res && res.ok === false) return res;
    return { ok: true, message: 'ส่งข้อความทดสอบไปยัง Telegram สำเร็จแล้ว' };
  } catch(err) {
    return { ok: false, message: String(err) };
  }
}

function notifyLowStock_(){
  const cfg = getNotifyConfig_();
  if(!cfg.onLowStock) return;
  const low = apiGetLowStock();
  if(!low.ok || !low.data.length) return;
  const outList = low.data.filter(m => m.StockState === 'OUT');
  const lowList = low.data.filter(m => m.StockState === 'LOW');
  let lines = `⚠️ <b>แจ้งเตือนสต็อกพัสดุ</b>\nหมดสต็อก: ${outList.length} รายการ\nใกล้หมด: ${lowList.length} รายการ\n\n`;
  low.data.slice(0,15).forEach(m => { lines += `• ${m.Code} ${m.Name} → ${m.StockQty} ${m.Unit}\n`; });
  if(low.data.length > 15) lines += `... และอีก ${low.data.length-15} รายการ`;
  sendTelegramNotify_(cfg.botToken, cfg.chatId, lines);
  const html = `<div style="font-family:Sarabun,sans-serif"><h3>รายงานพัสดุใกล้หมด / หมดสต็อก</h3>
    <p>หมด: <b>${outList.length}</b> | ใกล้หมด: <b>${lowList.length}</b></p>
    <ul>${low.data.map(m=>`<li>${m.Code} - ${m.Name} (${m.StockQty} ${m.Unit})</li>`).join('')}</ul></div>`;
  sendEmailNotify_(cfg.emails, '['+cfg.schoolName+'] แจ้งเตือนสต็อกพัสดุ', html);
}

function createDailyLowStockTrigger(){
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(t.getHandlerFunction() === 'notifyLowStock_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('notifyLowStock_')
    .timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
}

/* ============================== BOOTSTRAP / AUTH ============================== */
function getSettingsObj_(){
  const sh = getSheet_(SHEETS.SETTINGS);
  if(sh.getLastRow() < 2) return {
    SchoolName:'', Affiliation:'', LogoUrl:'', Address:'', Phone:'', UpdatedAt:'',
    NotifyEmail:'', TelegramBotToken:'', TelegramChatId:'', LineToken:'',
    NotifyOnNewRequest:'YES', NotifyOnStatusChange:'YES', NotifyLowStock:'YES', BannerUrl:'', LineTo:''
  };
  const headers = HEADERS.Settings;
  const row = sh.getRange(2, 1, 1, headers.length).getValues()[0];
  const obj = {};
  headers.forEach((h,i)=> obj[h] = cellVal_(row[i]));
  return obj;
}

function apiGetBootstrap(){
  try{
    const cache = CacheService.getScriptCache();
    const hit = cache.get('boot_v1');
    if(hit) return JSON.parse(hit);
    ensureSetup();
    const s = getSettingsObj_();
    const out = { ok:true, settings:{
      SchoolName:s.SchoolName, Affiliation:s.Affiliation, LogoUrl:s.LogoUrl, BannerUrl:s.BannerUrl,
      Address:s.Address, Phone:s.Phone
    }};
    cache.put('boot_v1', JSON.stringify(out), 600);
    return out;
  }catch(err){ return { ok:false, message:String(err) }; }
}

function sanitizeUser_(u){
  return { ID:u.ID, Username:u.Username, FullName:u.FullName, Role:u.Role, Position:u.Position, Department:u.Department||'', Email:u.Email||'' };
}

/* ชื่อผู้ใช้ไม่สนตัวพิมพ์เล็ก/ใหญ่: เก็บตามที่พิมพ์ (แสดงผลเหมือนเดิม) เทียบแบบ lower —
   รหัสผ่านยังสนเคสเสมอ */
function eqUsername_(a, b){
  return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
}

function apiLogin(payload){
  try{
    const username = String((payload||{}).username||'').trim();
    const password = String((payload||{}).password||'').trim();
    if(!username || !password) return { ok:false, message:'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' };
    const u = readAll_(SHEETS.USERS).find(x => eqUsername_(x.Username, username) && checkPw_(x.Password, password));
    if(!u) return { ok:false, message:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    const updates = {};
    if(!isHashed_(u.Password)) updates.Password = hashPw_(password);
    if(String(u.Role).toLowerCase() === 'staff'){
      u.Role = 'officer';
      updates.Role = 'officer';
    }
    if(Object.keys(updates).length > 0) updateRowById_(SHEETS.USERS, u.ID, updates);
    logAudit_('LOGIN', 'User', u.ID, 'เข้าสู่ระบบ (' + u.Role + ')', u.Username);
    return { ok:true, user: sanitizeUser_(u) };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiLogout(username){
  logAudit_('LOGOUT', 'User', '', 'ออกจากระบบ', username||'');
  return { ok:true };
}

/* ============================== SETTINGS ============================== */
function apiGetSettings(){
  try{ return { ok:true, data:getSettingsObj_() }; }
  catch(err){ return { ok:false, message:String(err) }; }
}

function apiSaveSettings(payload){
  return withLock_(()=>{
    try{
      let logoUrl = payload.LogoUrl || '';
      if(payload.logoFile && payload.logoFile.base64) logoUrl = saveFile_(payload.logoFile, 'Logo');
      let bannerUrl = payload.BannerUrl || '';
      if(payload.bannerFile && payload.bannerFile.base64) bannerUrl = saveFile_(payload.bannerFile, 'Banner');

      const data = {
        SchoolName: String(payload.SchoolName||'').trim(),
        Affiliation: String(payload.Affiliation||'').trim(),
        LogoUrl: logoUrl,
        BannerUrl: bannerUrl,
        Address: String(payload.Address||'').trim(),
        Phone: String(payload.Phone||'').trim(),
        UpdatedAt: nowIso_(),
        NotifyEmail: String(payload.NotifyEmail||'').trim(),
        TelegramBotToken: String(payload.TelegramBotToken||'').trim(),
        TelegramChatId: String(payload.TelegramChatId||'').trim(),
        LineToken: String(payload.LineToken||'').trim(),
        LineTo: String(payload.LineTo||'').trim(),
        NotifyOnNewRequest: payload.NotifyOnNewRequest || 'YES',
        NotifyOnStatusChange: payload.NotifyOnStatusChange || 'YES',
        NotifyLowStock: payload.NotifyLowStock || 'YES'
      };
      if(!data.SchoolName || !data.Affiliation) return { ok:false, message:'กรุณากรอกชื่อหน่วยงานและสังกัด' };

      const sh = getSheet_(SHEETS.SETTINGS);
      const headers = HEADERS.Settings;
      const row = headers.map(h=> data[h] !== undefined ? data[h] : '');
      if(sh.getLastRow() < 2) sh.appendRow(row);
      else sh.getRange(2,1,1,headers.length).setValues([row]);

      CacheService.getScriptCache().remove('boot_v1');
      logAudit_('UPDATE', 'Settings', '', 'บันทึกการตั้งค่าระบบ', payload.actor||'');
      return { ok:true, message:'บันทึกการตั้งค่าเรียบร้อยแล้ว', data };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

/* ============================== CATEGORIES ============================== */
const DEFAULT_CAT_CODES_ = {
  'หมวดงานเอกสารและกระดาษ': 'DOC',
  'หมวดเครื่องเขียนและอุปกรณ์ตัด': 'PEN',
  'หมวดอุปกรณ์ยึดติดและเทป': 'TAP',
  'หมวดอุปกรณ์ไอทีและวัสดุคอมพิวเตอร์': 'IT',
  'หมวดงานบ้านงานครัวสำนักงาน': 'HOM'
};

function apiGetCategories(){
  try{
    const data = readAll_(SHEETS.CATEGORIES).map(c => {
      const code = String(c.Code || DEFAULT_CAT_CODES_[c.Name] || '').toUpperCase().trim();
      return Object.assign({}, c, { Code: code });
    }).sort((a,b)=> String(a.Name).localeCompare(String(b.Name),'th'));
    return { ok:true, data };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiSaveCategory(payload){
  return withLock_(()=>{
    try{
      const name = String(payload.Name||'').trim();
      if(!name) return { ok:false, message:'กรุณาระบุชื่อหมวดหมู่' };
      const rawCode = String(payload.Code || payload.code || '').toUpperCase().trim();
      if(rawCode && !/^[A-Z0-9_-]{2,10}$/.test(rawCode)){
        return { ok:false, message:'รหัสย่อหมวดหมู่ต้องเป็นตัวอักษรภาษาอังกฤษหรือตัวเลข 2-10 ตัวอักษร' };
      }
      const cats = readAll_(SHEETS.CATEGORIES);
      if(payload.action === 'delete'){
        deleteRowById_(SHEETS.CATEGORIES, payload.ID);
        logAudit_('DELETE', 'Category', payload.ID, name, payload.actor||'');
        return { ok:true, message:'ลบหมวดหมู่เรียบร้อยแล้ว' };
      }
      const dupName = cats.find(c => String(c.Name).trim() === name && String(c.ID) !== String(payload.ID));
      if(dupName) return { ok:false, message:'ชื่อหมวดหมู่ "'+name+'" มีอยู่แล้วในระบบ' };
      if(rawCode){
        const dupCode = cats.find(c => {
          const cCode = String(c.Code || DEFAULT_CAT_CODES_[c.Name] || '').toUpperCase().trim();
          return cCode === rawCode && String(c.ID) !== String(payload.ID);
        });
        if(dupCode) return { ok:false, message:'รหัสย่อหมวดหมู่ "'+rawCode+'" มีอยู่แล้วในระบบ' };
      }
      if(payload.action === 'update'){
        const updates = { Name:name };
        if(rawCode) updates.Code = rawCode;
        updateRowById_(SHEETS.CATEGORIES, payload.ID, updates);
        logAudit_('UPDATE', 'Category', payload.ID, name + (rawCode ? ' ('+rawCode+')' : ''), payload.actor||'');
      }else{
        appendRow_(SHEETS.CATEGORIES, { ID:genId_('CAT'), Name:name, Code:rawCode, CreatedAt:nowIso_() });
        logAudit_('CREATE', 'Category', '', name + (rawCode ? ' ('+rawCode+')' : ''), payload.actor||'');
      }
      return { ok:true, message:'บันทึกหมวดหมู่เรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

/* ============================== SHOPS ============================== */
function apiGetShops(){
  try{
    seedShopsIfEmpty_();
    const data = readAll_(SHEETS.SHOPS).sort((a,b)=> String(a.Name||'').localeCompare(String(b.Name||''),'th'));
    return { ok:true, data };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiSaveShop(payload){
  return withLock_(()=>{
    try{
      const name = String(payload.Name||'').trim();
      if(!name) return { ok:false, message:'กรุณาระบุชื่อร้านค้า' };
      const taxId = String(payload.TaxId||'').trim();
      const address = String(payload.Address||'').trim();
      const phone = String(payload.Phone||'').trim();
      const note = String(payload.Note||'').trim();

      const shops = readAll_(SHEETS.SHOPS);
      if(payload.action === 'delete'){
        deleteRowById_(SHEETS.SHOPS, payload.ID);
        logAudit_('DELETE', 'Shop', payload.ID, name, payload.actor||'');
        return { ok:true, message:'ลบข้อมูลร้านค้าเรียบร้อยแล้ว' };
      }

      const dupName = shops.find(s => String(s.Name).trim().toLowerCase() === name.toLowerCase() && String(s.ID) !== String(payload.ID));
      if(dupName) return { ok:false, message:'ชื่อร้านค้า "'+name+'" มีอยู่แล้วในระบบ' };

      if(payload.action === 'update' || (payload.ID && payload.action !== 'create')){
        updateRowById_(SHEETS.SHOPS, payload.ID, {
          Name: name,
          TaxId: taxId,
          Address: address,
          Phone: phone,
          Note: note,
          UpdatedAt: nowIso_()
        });
        logAudit_('UPDATE', 'Shop', payload.ID, name, payload.actor||'');
        return { ok:true, message:'บันทึกข้อมูลร้านค้าเรียบร้อยแล้ว' };
      }else{
        const id = genId_('SHP');
        appendRow_(SHEETS.SHOPS, {
          ID: id,
          Name: name,
          TaxId: taxId,
          Address: address,
          Phone: phone,
          Note: note,
          CreatedAt: nowIso_(),
          UpdatedAt: nowIso_()
        });
        logAudit_('CREATE', 'Shop', id, name, payload.actor||'');
        return { ok:true, message:'เพิ่มร้านค้าเรียบร้อยแล้ว', id: id };
      }
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiDeleteShop(id, actor){
  return withLock_(()=>{
    try{
      if(!id) return { ok:false, message:'ไม่พบรหัสร้านค้า' };
      const shops = readAll_(SHEETS.SHOPS);
      const target = shops.find(s => String(s.ID) === String(id));
      const name = target ? target.Name : id;
      deleteRowById_(SHEETS.SHOPS, id);
      logAudit_('DELETE', 'Shop', id, name, actor||'');
      return { ok:true, message:'ลบข้อมูลร้านค้าเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function ensureShopExists_(name, taxId, address, phone, actor){
  try{
    const cleanName = String(name||'').trim();
    if(!cleanName) return;
    const shops = readAll_(SHEETS.SHOPS);
    const existing = shops.find(s => String(s.Name||'').trim().toLowerCase() === cleanName.toLowerCase());
    if(!existing){
      const id = genId_('SHP');
      appendRow_(SHEETS.SHOPS, {
        ID: id,
        Name: cleanName,
        TaxId: String(taxId||'').trim(),
        Address: String(address||'').trim(),
        Phone: String(phone||'').trim(),
        Note: '',
        CreatedAt: nowIso_(),
        UpdatedAt: nowIso_()
      });
      logAudit_('CREATE', 'Shop', id, 'สร้างร้านค้าใหม่อัตโนมัติจากพัสดุ: ' + cleanName, actor||'');
    }
  }catch(e){
    console.error('ensureShopExists_ error:', e);
  }
}

/* ============================== USERS ============================== */
function apiGetUsers(){
  try{
    const data = readAll_(SHEETS.USERS).map(u => Object.assign(sanitizeUser_(u), { CreatedAt:u.CreatedAt }))
      .sort((a,b)=> String(a.FullName).localeCompare(String(b.FullName),'th'));
    return { ok:true, data };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiSaveUsers(list){
  return withLock_(()=>{
    try{
      const users = readAll_(SHEETS.USERS);
      list.forEach(item=>{
        if(item.action === 'delete'){
          deleteRowById_(SHEETS.USERS, item.ID);
          logAudit_('DELETE', 'User', item.ID, '', item.actor||'');
          return;
        }
        const username = String(item.Username||'').trim();
        const dup = users.find(u=> eqUsername_(u.Username, username) && String(u.ID)!==String(item.ID));
        if(dup) throw new Error('ชื่อผู้ใช้ "'+username+'" มีอยู่แล้วในระบบ');
        const pw = String(item.Password||'').trim();

        if(item.action === 'update'){
          const old = users.find(u=> String(u.ID)===String(item.ID));
          updateRowById_(SHEETS.USERS, item.ID, {
            Username: username,
            Password: pw ? hashPw_(pw) : (old ? old.Password : ''),   // ว่าง = คงรหัสเดิม
            FullName: String(item.FullName||'').trim(), Role: item.Role,
            Position: String(item.Position||'').trim(),
            Department: item.Department !== undefined ? String(item.Department||'').trim() : (old ? old.Department : ''),
            Email: String(item.Email||'').trim(),
            UpdatedAt: nowIso_()
          });
          logAudit_('UPDATE', 'User', item.ID, username, item.actor||'');
        }else{
          if(!pw) throw new Error('กรุณากำหนดรหัสผ่าน');
          appendRow_(SHEETS.USERS, {
            ID: genId_('U'), Username: username, Password: hashPw_(pw),
            FullName: String(item.FullName||'').trim(), Role: item.Role,
            Position: String(item.Position||'').trim(),
            Department: String(item.Department||'').trim(),
            Email: String(item.Email||'').trim(),
            CreatedAt: nowIso_(), UpdatedAt: nowIso_()
          });
          logAudit_('CREATE', 'User', '', username, item.actor||'');
        }
      });
      return { ok:true, message:'บันทึกข้อมูลผู้ใช้งานเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiDeleteUsers(ids, actor){
  return withLock_(()=>{
    try{
      (ids||[]).forEach(id=>{
        deleteRowById_(SHEETS.USERS, id);
        logAudit_('DELETE', 'User', id, '', actor||'');
      });
      return { ok:true, message:'ลบข้อมูลผู้ใช้งานเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiUpdateProfile(payload){
  return withLock_(()=>{
    try{
      const users = readAll_(SHEETS.USERS);
      const old = users.find(x=> String(x.ID)===String(payload.ID));
      if(!old) return { ok:false, message:'ไม่พบผู้ใช้งานนี้' };
      const username = String(payload.Username||'').trim();
      const dup = users.find(u=> eqUsername_(u.Username, username) && String(u.ID)!==String(payload.ID));
      if(dup) return { ok:false, message:'ชื่อผู้ใช้ "'+username+'" มีอยู่แล้วในระบบ' };
      const pw = String(payload.Password||'').trim();

      updateRowById_(SHEETS.USERS, payload.ID, {
        Username: username,
        Password: pw ? hashPw_(pw) : old.Password,                    // ว่าง = คงรหัสเดิม
        FullName: String(payload.FullName||'').trim(),
        Position: String(payload.Position||'').trim(),
        Department: payload.Department !== undefined ? String(payload.Department||'').trim() : (old.Department||''),
        UpdatedAt: nowIso_()
      });
      const u = readAll_(SHEETS.USERS).find(x=> String(x.ID)===String(payload.ID));
      logAudit_('UPDATE', 'User', payload.ID, 'อัปเดตโปรไฟล์', u.Username);
      return { ok:true, message:'อัปเดตข้อมูลส่วนตัวเรียบร้อยแล้ว', user: sanitizeUser_(u) };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

/* ============================== MATERIALS ============================== */
function apiGetMaterials(){
  try{
    const rows = readAll_(SHEETS.MATERIALS).map(m=>{
      const stockQty = Number(m.StockQty||0), minQty = Number(m.MinQty||0);
      return {
        ID:m.ID, Code:m.Code, Name:m.Name, Unit:m.Unit,
        UnitPrice: Number(m.UnitPrice||0), StockQty: stockQty, MinQty: minQty,
        OpeningQty: Number(m.OpeningQty||0), Category: m.Category||'',
        MaterialType: m.MaterialType || m.Category || '',
        SizeSpec: m.SizeSpec || '',
        StorageLocation: m.StorageLocation || '',
        ImageUrl: m.ImageUrl||'', FileUrl: m.FileUrl||'',
        StockState: computeStockState_(stockQty, minQty)
      };
    }).sort((a,b)=> String(a.Code).localeCompare(String(b.Code)));
    return { ok:true, data: rows };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiGetLowStock(){
  try{
    const all = apiGetMaterials();
    if(!all.ok) return all;
    return { ok:true, data: all.data.filter(m=> m.StockState !== 'OK') };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiSaveMaterials(list){
  return withLock_(()=>{
    try{
      const materials = readAll_(SHEETS.MATERIALS);
      list.forEach(item=>{
        if(item.action === 'delete'){
          deleteRowById_(SHEETS.MATERIALS, item.ID);
          logAudit_('DELETE', 'Material', item.ID, item.Code||'', item.actor||'');
          return;
        }
        const code = String(item.Code||'').trim();
        const dup = materials.find(m=> String(m.Code).trim()===code && String(m.ID)!==String(item.ID));
        if(dup) throw new Error('รหัสพัสดุ "'+code+'" มีอยู่แล้วในระบบ');

        let imageUrl = item.ImageUrl || '';
        let fileUrl  = item.FileUrl  || '';
        if(item.imageFile && item.imageFile.base64) imageUrl = saveFile_(item.imageFile, 'MaterialImages');
        if(item.docFile   && item.docFile.base64)   fileUrl  = saveFile_(item.docFile,   'MaterialFiles');

        const materialType = String(item.MaterialType || item.Category || '').trim();
        const sizeSpec = String(item.SizeSpec || '').trim();
        const storageLoc = String(item.StorageLocation || '').trim();
        const shopName = String(item.ShopName || '').trim();
        const shopAddress = String(item.ShopAddress || '').trim();
        const shopPhone = String(item.ShopPhone || '').trim();
        const shopTaxId = String(item.ShopTaxId || '').trim();
        const budgetSource = String(item.BudgetSource || 'งบประมาณแผ่นดิน').trim();
        const acquiredDate = String(item.AcquiredDate || '').trim();
        const orderQty = Number(item.OrderQty || 0);

        if(item.action === 'update'){
          const old = materials.find(m=> String(m.ID)===String(item.ID));
          const oldStock = old ? Number(old.StockQty||0) : 0;
          const newStock = Number(item.StockQty||0);
          updateRowById_(SHEETS.MATERIALS, item.ID, {
            Code: code, Name: String(item.Name||'').trim(), Unit: String(item.Unit||'').trim(),
            UnitPrice: Number(item.UnitPrice||0), StockQty: newStock, MinQty: Number(item.MinQty||0),
            Category: String(item.Category||'').trim(),
            MaterialType: materialType,
            SizeSpec: sizeSpec,
            StorageLocation: storageLoc,
            ShopName: shopName,
            ShopAddress: shopAddress,
            ShopPhone: shopPhone,
            ShopTaxId: shopTaxId,
            BudgetSource: budgetSource,
            AcquiredDate: acquiredDate,
            OrderQty: orderQty,
            ImageUrl: imageUrl, FileUrl: fileUrl, UpdatedAt: nowIso_()
          });
          if(oldStock !== newStock){
            logStockMovement_(item.ID, code, item.Name, 'ADJUST', Math.abs(newStock-oldStock),
              oldStock, newStock, '', 'ปรับยอดจากฟอร์มแก้ไข', item.actor||'');
          }
          logAudit_('UPDATE', 'Material', item.ID, code, item.actor||'');
        }else{
          const stock = Number(item.StockQty||0);
          const initialOrderQty = Number(orderQty > 0 ? orderQty : 0);
          const openingQty = Math.max(0, stock - initialOrderQty);
          const id = genId_('M');
          appendRow_(SHEETS.MATERIALS, {
            ID: id, Code: code, Name: String(item.Name||'').trim(), Unit: String(item.Unit||'').trim(),
            UnitPrice: Number(item.UnitPrice||0), StockQty: stock, MinQty: Number(item.MinQty||0),
            OpeningQty: openingQty, Category: String(item.Category||'').trim(),
            MaterialType: materialType,
            SizeSpec: sizeSpec,
            StorageLocation: storageLoc,
            ShopName: shopName,
            ShopAddress: shopAddress,
            ShopPhone: shopPhone,
            ShopTaxId: shopTaxId,
            BudgetSource: budgetSource,
            AcquiredDate: acquiredDate,
            OrderQty: orderQty,
            ImageUrl: imageUrl, FileUrl: fileUrl, CreatedAt: nowIso_(), UpdatedAt: nowIso_()
          });
          materials.push({ ID:id, Code:code });     // กันรหัสซ้ำในรายการเดียวกัน
          if(stock > 0){
            logStockMovement_(id, code, item.Name, 'IN', stock, 0, stock, '', 'จัดซื้อ', item.actor||'');
          }
          if(initialOrderQty > 0){
            appendRow_(SHEETS.PURCHASES, {
              ID: genId_('P'), MaterialID: id, Code: code, Name: String(item.Name||'').trim(),
              Qty: initialOrderQty, UnitPrice: Number(item.UnitPrice||0),
              Amount: initialOrderQty * Number(item.UnitPrice||0),
              PurchaseDate: acquiredDate || todayStr_(), Note: 'จัดซื้อรับเข้า (สร้างพัสดุ)',
              Actor: item.actor||'', CreatedAt: nowIso_()
            });
          }
          logAudit_('CREATE', 'Material', id, code, item.actor||'');
        }

        if(shopName){
          ensureShopExists_(shopName, shopTaxId, shopAddress, shopPhone, item.actor||'');
        }
      });
      return { ok:true, message:'บันทึกข้อมูลพัสดุเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiDeleteMaterials(ids){
  return withLock_(()=>{
    try{
      (ids||[]).forEach(id=>{
        deleteRowById_(SHEETS.MATERIALS, id);
        logAudit_('DELETE', 'Material', id, '', '');
      });
      return { ok:true, message:'ลบข้อมูลพัสดุเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiPurchaseMaterials(list){
  return withLock_(()=>{
    try{
      const materials = readAll_(SHEETS.MATERIALS);       // อ่านครั้งเดียวนอกลูป
      list.forEach(item=>{
        const m = materials.find(x=> String(x.ID)===String(item.MaterialID));
        if(!m) return;
        const qty = Number(item.Qty||0);
        if(!(qty>0)) return;
        const before = Number(m.StockQty||0);
        const newStock = before + qty;
        updateRowById_(SHEETS.MATERIALS, m.ID, { StockQty:newStock, UpdatedAt: nowIso_() });
        m.StockQty = newStock;                              // กันยอดเพี้ยนถ้าพัสดุเดียวกันซ้ำในรายการ
        appendRow_(SHEETS.PURCHASES, {
          ID: genId_('P'), MaterialID:m.ID, Code:m.Code, Name:m.Name, Qty:qty,
          UnitPrice: Number(m.UnitPrice||0), Amount: qty*Number(m.UnitPrice||0),
          PurchaseDate: item.PurchaseDate || todayStr_(), Note: item.Note||'',
          Actor: item.actor||'', CreatedAt: nowIso_()
        });
        logStockMovement_(m.ID, m.Code, m.Name, 'IN', qty, before, newStock,
          '', item.Note||'จัดซื้อเพิ่ม', item.actor||'');
        logAudit_('PURCHASE', 'Material', m.ID, m.Code+' +'+qty, item.actor||'');
      });
      return { ok:true, message:'บันทึกการจัดซื้อพัสดุเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

/* ============================== REQUESTS ============================== */
function mapRequestRow_(r){
  return {
    ID:r.ID, DocNo:r.DocNo, RequestDate:r.RequestDate, UserID:r.UserID, FullName:r.FullName,
    Position:r.Position, Department:r.Department, Purpose:r.Purpose, Note:r.Note, AttachUrl:r.AttachUrl,
    Status:String(r.Status||'PENDING').toUpperCase(), RejectReason:r.RejectReason,
    ApprovedDate:r.ApprovedDate, ApprovedBy:r.ApprovedBy,
    TotalAmount:Number(r.TotalAmount||0), ItemCount:Number(r.ItemCount||0), CreatedAt:r.CreatedAt
  };
}

function apiCreateRequest(payload){
  return withLock_(()=>{
    try{
      const materials = readAll_(SHEETS.MATERIALS);
      let total = 0;
      const itemsResolved = [];
      for(const it of (payload.items||[])){
        const m = materials.find(x=> String(x.ID)===String(it.MaterialID));
        if(!m) continue;
        const qty = Number(it.Qty||0);
        if(!(qty>0)) continue;
        if(qty > Number(m.StockQty||0)){
          return { ok:false, message:'จำนวนที่ขอเบิก "'+m.Name+'" เกินจำนวนคงเหลือในสต็อก ('+m.StockQty+' '+m.Unit+')' };
        }
        const totalPrice = qty * Number(m.UnitPrice||0);
        total += totalPrice;
        itemsResolved.push({
          MaterialID:m.ID, Code:m.Code, Name:m.Name, Unit:m.Unit, Qty:qty,
          UnitPrice:Number(m.UnitPrice||0), TotalPrice: totalPrice, Remark: it.Remark||''
        });
      }
      if(!itemsResolved.length) return { ok:false, message:'ไม่พบรายการพัสดุที่ถูกต้อง' };

      let attachUrl = '';
      if(payload.attachFile && payload.attachFile.base64) attachUrl = saveFile_(payload.attachFile, 'RequestAttachments');

      const reqId = genId_('R');
      const docNo = genDocNo_();
      appendRow_(SHEETS.REQUESTS, {
        ID:reqId, DocNo:docNo, RequestDate: payload.RequestDate || todayStr_(),
        UserID: payload.UserID, FullName: payload.FullName, Position: payload.Position||'',
        Department: payload.Department||'', Purpose: payload.Purpose||'', Note: payload.Note||'',
        AttachUrl: attachUrl, Status:'PENDING', RejectReason:'', ApprovedDate:'', ApprovedBy:'',
        TotalAmount: total, ItemCount: itemsResolved.length, CreatedAt: nowIso_(), UpdatedAt: nowIso_()
      });
      itemsResolved.forEach(it=>{
        appendRow_(SHEETS.REQUEST_ITEMS, Object.assign({ ID: genId_('RI'), RequestID: reqId }, it));
      });

      logAudit_('CREATE', 'Request', reqId, docNo, payload.actor||'');
      notifyNewRequest_({
        ID: reqId, DocNo: docNo, FullName: payload.FullName, Position: payload.Position,
        Department: payload.Department, Purpose: payload.Purpose, Note: payload.Note || '',
        AttachUrl: attachUrl, RequestDate: payload.RequestDate||todayStr_(),
        ItemCount: itemsResolved.length, TotalAmount: total, Items: itemsResolved
      });

      return { ok:true, message:'บันทึกใบขอเบิกพัสดุเรียบร้อยแล้ว เลขที่ '+docNo };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiGetRequests(filter){
  try{
    let rows = readAll_(SHEETS.REQUESTS).map(mapRequestRow_)
      .sort((a,b)=> new Date(b.CreatedAt) - new Date(a.CreatedAt));
    if(filter){
      if(filter.status) rows = rows.filter(r=> r.Status === String(filter.status).toUpperCase());
      if(filter.from) rows = rows.filter(r=> r.RequestDate >= filter.from);
      if(filter.to) rows = rows.filter(r=> r.RequestDate <= filter.to);
      if(filter.q){
        const q = String(filter.q).toLowerCase();
        rows = rows.filter(r=>
          String(r.DocNo).toLowerCase().indexOf(q)>=0 ||
          String(r.FullName).toLowerCase().indexOf(q)>=0 ||
          String(r.Department).toLowerCase().indexOf(q)>=0 ||
          String(r.Purpose).toLowerCase().indexOf(q)>=0
        );
      }
    }
    return { ok:true, data: rows };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiGetMyRequests(userId){
  try{
    const reqs = readAll_(SHEETS.REQUESTS).filter(r=> String(r.UserID)===String(userId))
      .map(mapRequestRow_).sort((a,b)=> new Date(b.CreatedAt) - new Date(a.CreatedAt));
    const items = readAll_(SHEETS.REQUEST_ITEMS);
    reqs.forEach(r=>{
      r.Items = items.filter(it=> String(it.RequestID)===String(r.ID)).map(it=>({
        MaterialID:it.MaterialID, Code:it.Code, Name:it.Name, Unit:it.Unit,
        Qty:Number(it.Qty||0), UnitPrice:Number(it.UnitPrice||0), TotalPrice:Number(it.TotalPrice||0), Remark:it.Remark
      }));
    });
    return { ok:true, data: reqs };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiTrackRequest(q){
  try{
    if(!q || !String(q).trim()) return { ok:false, message:'กรุณาระบุเลขที่ใบขอเบิก หรือชื่อผู้ขอเบิก' };
    const query = String(q).trim().toLowerCase();
    const reqs = readAll_(SHEETS.REQUESTS).map(mapRequestRow_);
    const matched = reqs.filter(r =>
      String(r.DocNo||'').toLowerCase() === query ||
      String(r.ID||'').toLowerCase() === query ||
      String(r.FullName||'').toLowerCase().includes(query)
    ).sort((a,b)=> new Date(b.CreatedAt) - new Date(a.CreatedAt));

    if(!matched.length) return { ok:false, message:'ไม่พบข้อมูลใบขอเบิกที่ตรงกับคำค้นหา: ' + q };

    const items = readAll_(SHEETS.REQUEST_ITEMS);
    const result = matched.slice(0, 10).map(r => {
      const myItems = items.filter(it => String(it.RequestID) === String(r.ID)).map(it => ({
        Name: it.Name,
        Qty: Number(it.Qty||0),
        Unit: it.Unit,
        Remark: it.Remark||''
      }));
      return {
        ID: r.ID,
        DocNo: r.DocNo,
        RequestDate: r.RequestDate,
        FullName: r.FullName,
        Department: r.Department,
        Purpose: r.Purpose,
        Status: r.Status,
        RejectReason: r.RejectReason || '',
        ApprovedDate: r.ApprovedDate || '',
        ApprovedBy: r.ApprovedBy || '',
        ItemCount: r.ItemCount || myItems.length,
        TotalAmount: r.TotalAmount || 0,
        Items: myItems
      };
    });

    return { ok:true, data: result };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiGetRequestForPrint(id){
  try{
    const r = readAll_(SHEETS.REQUESTS).find(x=> String(x.ID)===String(id));
    if(!r) return { ok:false, message:'ไม่พบใบขอเบิกนี้' };
    const items = readAll_(SHEETS.REQUEST_ITEMS).filter(it=> String(it.RequestID)===String(id)).map(it=>({
      Code:it.Code, Name:it.Name, Unit:it.Unit, Qty:Number(it.Qty||0),
      UnitPrice:Number(it.UnitPrice||0), TotalPrice:Number(it.TotalPrice||0)
    }));
    return { ok:true, data:{ request: mapRequestRow_(r), items, printedAt: nowIso_() } };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function adjustStockForRequest_(requestId, sign, actor, docNo){
  const items = readAll_(SHEETS.REQUEST_ITEMS).filter(it=> String(it.RequestID)===String(requestId));
  const materials = readAll_(SHEETS.MATERIALS);
  items.forEach(it=>{
    const m = materials.find(x=> String(x.ID)===String(it.MaterialID));
    if(!m) return;
    const before = Number(m.StockQty||0);
    const qty = Number(it.Qty||0);
    const newStock = Math.max(0, before + sign*qty);
    updateRowById_(SHEETS.MATERIALS, m.ID, { StockQty: newStock, UpdatedAt: nowIso_() });
    m.StockQty = newStock;
    const type = sign < 0 ? 'OUT' : 'IN';
    const note = sign < 0 ? 'ตัดสต็อกจากใบขอเบิก' : 'คืนสต็อกจากใบขอเบิก';
    logStockMovement_(m.ID, m.Code, m.Name, type, qty, before, newStock, docNo||'', note, actor||'');
  });
}

function apiUpdateRequestStatus(list){
  return withLock_(()=>{
    try{
      list.forEach(item=>{
        const r = readAll_(SHEETS.REQUESTS).find(x=> String(x.ID)===String(item.ID));
        if(!r) return;
        const prevStatus = String(r.Status).toUpperCase();
        const newStatus  = String(item.Status).toUpperCase();
        if(prevStatus === newStatus) return;

        if(newStatus === 'APPROVED' && prevStatus !== 'APPROVED'){
          adjustStockForRequest_(r.ID, -1, item.actor, r.DocNo);
        }
        if(prevStatus === 'APPROVED' && newStatus !== 'APPROVED'){
          adjustStockForRequest_(r.ID, 1, item.actor, r.DocNo);
        }

        updateRowById_(SHEETS.REQUESTS, item.ID, {
          Status:newStatus,
          RejectReason: newStatus==='REJECTED' ? (item.RejectReason||'') : '',
          ApprovedDate: nowIso_(), ApprovedBy: item.actor||'', UpdatedAt: nowIso_()
        });

        logAudit_('STATUS', 'Request', item.ID, r.DocNo+' → '+newStatus, item.actor||'');
        notifyStatusChange_(r, newStatus, item.RejectReason||'');
      });
      return { ok:true, message:'อัปเดตสถานะใบขอเบิกเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

function apiDeleteRequests(ids){
  return withLock_(()=>{
    try{
      (ids||[]).forEach(id=>{
        const r = readAll_(SHEETS.REQUESTS).find(x=> String(x.ID)===String(id));
        if(r && String(r.Status).toUpperCase()==='APPROVED'){
          adjustStockForRequest_(id, 1, '', r.DocNo);
        }
        deleteRowById_(SHEETS.REQUESTS, id);
        const items = readAll_(SHEETS.REQUEST_ITEMS).filter(it=> String(it.RequestID)===String(id));
        items.forEach(it=> deleteRowById_(SHEETS.REQUEST_ITEMS, it.ID));
        logAudit_('DELETE', 'Request', id, r ? r.DocNo : '', '');
      });
      return { ok:true, message:'ลบใบขอเบิกเรียบร้อยแล้ว' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

/* ============================== STOCK MOVEMENTS ============================== */
function apiGetStockMovements(filter){
  try{
    let rows = readAll_(SHEETS.STOCK_MOVEMENTS)
      .sort((a,b)=> new Date(b.CreatedAt) - new Date(a.CreatedAt));
    if(filter){
      if(filter.materialId) rows = rows.filter(r=> String(r.MaterialID)===String(filter.materialId));
      if(filter.type) rows = rows.filter(r=> r.Type === filter.type);
      if(filter.from) rows = rows.filter(r=> String(r.CreatedAt).substring(0,10) >= filter.from);
      if(filter.to) rows = rows.filter(r=> String(r.CreatedAt).substring(0,10) <= filter.to);
      if(filter.q){
        const q = String(filter.q).toLowerCase();
        rows = rows.filter(r=>
          String(r.Code).toLowerCase().indexOf(q)>=0 ||
          String(r.Name).toLowerCase().indexOf(q)>=0 ||
          String(r.RefDoc).toLowerCase().indexOf(q)>=0
        );
      }
    }
    return { ok:true, data: rows.slice(0, 1000) };     // จำกัด 1000 รายการล่าสุด
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiClearStockMovements(){
  return withLock_(()=>{
    try{
      const sh = getSheet_(SHEETS.STOCK_MOVEMENTS);
      const lastRow = sh.getLastRow();
      let deletedCount = 0;
      if(lastRow >= 2){
        deletedCount = lastRow - 1;
        sh.deleteRows(2, deletedCount);
        cacheClear_(SHEETS.STOCK_MOVEMENTS);
      }
      logAudit_('DELETE', 'StockMovements', 'ALL', 'ล้างประวัติสต็อกทั้งหมด ' + deletedCount + ' รายการ', '');
      return { ok:true, message:'ล้างประวัติเคลื่อนไหวสต็อกเรียบร้อยแล้ว (' + deletedCount + ' รายการ)' };
    }catch(err){ return { ok:false, message:String(err) }; }
  });
}

/* ============================== AUDIT LOG ============================== */
function apiGetAuditLog(filter){
  try{
    let rows = readAll_(SHEETS.AUDIT_LOG)
      .sort((a,b)=> new Date(b.CreatedAt) - new Date(a.CreatedAt));
    if(filter){
      if(filter.action) rows = rows.filter(r=> r.Action === filter.action);
      if(filter.from) rows = rows.filter(r=> String(r.CreatedAt).substring(0,10) >= filter.from);
      if(filter.to) rows = rows.filter(r=> String(r.CreatedAt).substring(0,10) <= filter.to);
      if(filter.q){
        const q = String(filter.q).toLowerCase();
        rows = rows.filter(r=>
          String(r.Detail).toLowerCase().indexOf(q)>=0 ||
          String(r.Actor).toLowerCase().indexOf(q)>=0 ||
          String(r.Entity).toLowerCase().indexOf(q)>=0
        );
      }
    }
    return { ok:true, data: rows.slice(0, 500) };      // จำกัด 500 รายการล่าสุด
  }catch(err){ return { ok:false, message:String(err) }; }
}

/* ============================== DASHBOARDS ============================== */
function apiGetAdminDashboard(){
  try{
    const matRes = apiGetMaterials();
    const materials = (matRes && matRes.ok && Array.isArray(matRes.data)) ? matRes.data : [];
    const reqs  = readAll_(SHEETS.REQUESTS).map(mapRequestRow_);
    const items = readAll_(SHEETS.REQUEST_ITEMS);

    const approvedReqIds = new Set(reqs.filter(r=> r.Status==='APPROVED').map(r=> r.ID));
    const approvedItems  = items.filter(it=> approvedReqIds.has(it.RequestID));

    const remainValue = materials.reduce((s,m)=> s + m.StockQty*m.UnitPrice, 0);
    const usedValue    = approvedItems.reduce((s,it)=> s + Number(it.TotalPrice||0), 0);
    const usedQty      = approvedItems.reduce((s,it)=> s + Number(it.Qty||0), 0);
    const lowStock     = materials.filter(m=> m.StockState !== 'OK').length;

    const counters = {
      approved: reqs.filter(r=> r.Status==='APPROVED').length,
      pending:  reqs.filter(r=> r.Status==='PENDING').length,
      rejected: reqs.filter(r=> r.Status==='REJECTED').length
    };

    const byItem = {};
    approvedItems.forEach(it=>{ byItem[it.Name] = (byItem[it.Name]||0) + Number(it.Qty||0); });
    const chartByItem = Object.keys(byItem).map(k=>({ label:k, value:byItem[k] }));
    const chartTop10  = chartByItem.slice().sort((a,b)=> b.value-a.value).slice(0,10);

    const chartStatus = [
      { label:'อนุมัติแล้ว', value: counters.approved },
      { label:'รออนุมัติ',  value: counters.pending },
      { label:'ปฏิเสธ',     value: counters.rejected }
    ];

    return {
      ok:true,
      summary: { totalMaterials: materials.length, remainValue, usedValue, usedQty, lowStock },
      counters, materials, chartByItem, chartTop10, chartStatus
    };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiGetTeacherDashboard(userId){
  try{
    const reqs = readAll_(SHEETS.REQUESTS).filter(r=> String(r.UserID)===String(userId))
      .map(mapRequestRow_).sort((a,b)=> new Date(b.CreatedAt) - new Date(a.CreatedAt));
    const items = readAll_(SHEETS.REQUEST_ITEMS);
    const reqIds = new Set(reqs.map(r=> r.ID));
    const myItems = items.filter(it=> reqIds.has(it.RequestID));

    const approvedReqIds = new Set(reqs.filter(r=> r.Status==='APPROVED').map(r=> r.ID));
    const approvedItems  = myItems.filter(it=> approvedReqIds.has(it.RequestID));

    const byItem = {};
    approvedItems.forEach(it=>{ byItem[it.Name] = (byItem[it.Name]||0) + Number(it.Qty||0); });
    const chartByItem = Object.keys(byItem).map(k=>({ label:k, value:byItem[k] }));

    const counters = {
      approved: reqs.filter(r=> r.Status==='APPROVED').length,
      pending:  reqs.filter(r=> r.Status==='PENDING').length,
      rejected: reqs.filter(r=> r.Status==='REJECTED').length
    };
    const chartStatus = [
      { label:'อนุมัติแล้ว', value: counters.approved },
      { label:'รออนุมัติ',  value: counters.pending },
      { label:'ปฏิเสธ',     value: counters.rejected }
    ];

    const recent = reqs.slice(0,5).map(r=>{
      r.Items = myItems.filter(it=> String(it.RequestID)===String(r.ID)).map(it=>({
        MaterialID:it.MaterialID, Code:it.Code, Name:it.Name, Unit:it.Unit,
        Qty:Number(it.Qty||0), UnitPrice:Number(it.UnitPrice||0), TotalPrice:Number(it.TotalPrice||0), Remark:it.Remark
      }));
      return r;
    });

    return { ok:true, summary:{ totalRequests: reqs.length }, counters, chartByItem, chartStatus, recent };
  }catch(err){ return { ok:false, message:String(err) }; }
}

function apiGetInventoryAccount(filter){
  try{
    filter = filter || {};
    const currentFY = new Date().getMonth() >= 9
      ? (new Date().getFullYear() + 543 + 1)
      : (new Date().getFullYear() + 543);
    const fiscalYear = filter.fiscalYear ? parseInt(filter.fiscalYear, 10) : (filter.from || filter.to ? null : currentFY);
    const fyRange = fiscalYear ? getFiscalYearRange_(fiscalYear) : null;

    const from = filter.from || (fyRange ? fyRange.start : null);
    const to   = filter.to   || (fyRange ? fyRange.end : null);

    const materials = readAll_(SHEETS.MATERIALS);
    const purchases = readAll_(SHEETS.PURCHASES);
    const reqs  = readAll_(SHEETS.REQUESTS).map(mapRequestRow_);
    const items = readAll_(SHEETS.REQUEST_ITEMS);
    const openings = fiscalYear ? readAll_(SHEETS.OPENING_BALANCES) : [];
    const approvedReqIds = new Set(reqs.filter(r=> r.Status==='APPROVED').map(r=> r.ID));

    const reqDateMap = {};
    reqs.forEach(r=> reqDateMap[r.ID] = r.RequestDate || r.ApprovedDate || '');

    const data = materials.map(m=>{
      const unitPrice  = Number(m.UnitPrice||0);
      let openingQty = Number(m.OpeningQty||0);
      if(fiscalYear){
        const ob = openings.find(o=> String(o.MaterialID)===String(m.ID) && String(o.FiscalYear)===String(fiscalYear));
        if(ob && ob.OpeningQty !== undefined && ob.OpeningQty !== '') openingQty = Number(ob.OpeningQty||0);
      }

      let purchaseList = purchases.filter(p=> String(p.MaterialID)===String(m.ID));
      if(from) purchaseList = purchaseList.filter(p=> (p.PurchaseDate||'').substring(0,10) >= from);
      if(to)   purchaseList = purchaseList.filter(p=> (p.PurchaseDate||'').substring(0,10) <= to);
      let purchaseQty = purchaseList.reduce((s,p)=> s+Number(p.Qty||0), 0);

      // Self-healing fallback: หากพัสดุได้มาในช่วงนี้ แต่ยังไม่มีใน Purchases
      if (purchaseList.length === 0) {
        const acqDate = String(m.AcquiredDate || '').substring(0, 10);
        const inFrom = !from || acqDate >= from;
        const inTo = !to || acqDate <= to;
        if (inFrom && inTo) {
          const autoPurchase = Number(m.OrderQty || 0);
          if (autoPurchase > 0) {
            purchaseQty = autoPurchase;
            openingQty = Math.max(0, openingQty - autoPurchase);
          }
        }
      }

      let usedList = items.filter(it=> String(it.MaterialID)===String(m.ID) && approvedReqIds.has(it.RequestID));
      if(from || to){
        usedList = usedList.filter(it=>{
          const d = (reqDateMap[it.RequestID] || '').substring(0,10);
          if(from && d < from) return false;
          if(to && d > to) return false;
          return true;
        });
      }
      const usedQty = usedList.reduce((s,it)=> s+Number(it.Qty||0), 0);
      const remainQty = Math.max(0, openingQty + purchaseQty - usedQty);

      return {
        Code:m.Code, Name:m.Name, Unit:m.Unit, UnitPrice: unitPrice, Category: m.Category||'',
        OpeningQty: openingQty, OpeningAmount: openingQty*unitPrice,
        PurchaseQty: purchaseQty, PurchasePrice: unitPrice, PurchaseAmount: purchaseQty*unitPrice,
        UsedQty: usedQty, UsedPrice: unitPrice, UsedAmount: usedQty*unitPrice,
        RemainQty: remainQty, RemainAmount: remainQty*unitPrice,
        StockState: computeStockState_(remainQty, Number(m.MinQty||0))
      };
    }).sort((a,b)=> String(a.Code).localeCompare(String(b.Code)));

    const total = data.reduce((acc,x)=>{
      acc.OpeningQty += x.OpeningQty;   acc.OpeningAmount += x.OpeningAmount;
      acc.PurchaseQty += x.PurchaseQty; acc.PurchaseAmount += x.PurchaseAmount;
      acc.UsedQty += x.UsedQty;         acc.UsedAmount += x.UsedAmount;
      acc.RemainQty += x.RemainQty;     acc.RemainAmount += x.RemainAmount;
      return acc;
    }, { OpeningQty:0, OpeningAmount:0, PurchaseQty:0, PurchaseAmount:0, UsedQty:0, UsedAmount:0, RemainQty:0, RemainAmount:0 });

    const summary = {
      totalMaterials: data.length,
      remainValue: total.RemainAmount,
      usedValue: total.UsedAmount,
      lowStock: data.filter(x=> x.StockState !== 'OK').length
    };

    return { ok:true, summary, total, data, asOf: todayStr_(), fiscalYear: fiscalYear||undefined, filter: { from:from||'', to:to||'' } };
  }catch(err){ return { ok:false, message:String(err) }; }
}

/* ============================== EXPORT CSV ============================== */
function apiExportCSV(type, filter){
  try{
    let headers = [], rows = [], filename = 'export.csv';

    if(type === 'materials'){
      const res = apiGetMaterials();
      if(!res.ok) return res;
      headers = ['รหัส','ชื่อพัสดุ','หมวดหมู่','หน่วย','ราคา/หน่วย','คงเหลือ','จุดสั่งซื้อ','สถานะ'];
      rows = res.data.map(m=>[m.Code, m.Name, m.Category, m.Unit, m.UnitPrice, m.StockQty, m.MinQty, m.StockState]);
      filename = 'materials_'+todayStr_()+'.csv';
    }
    else if(type === 'requests'){
      const res = apiGetRequests(filter||{});
      if(!res.ok) return res;
      headers = ['เลขที่','วันที่','ผู้ขอ','ฝ่าย','วัตถุประสงค์','จำนวนรายการ','มูลค่า','สถานะ'];
      rows = res.data.map(r=>[r.DocNo, r.RequestDate, r.FullName, r.Department, r.Purpose, r.ItemCount, r.TotalAmount, r.Status]);
      filename = 'requests_'+todayStr_()+'.csv';
    }
    else if(type === 'stock_movements'){
      const res = apiGetStockMovements(filter||{});
      if(!res.ok) return res;
      headers = ['วันที่','รหัส','ชื่อ','ประเภท','จำนวน','ก่อน','หลัง','อ้างอิง','หมายเหตุ','ผู้ทำ'];
      rows = res.data.map(r=>[r.CreatedAt, r.Code, r.Name, r.Type, r.Qty, r.BeforeQty, r.AfterQty, r.RefDoc, r.Note, r.Actor]);
      filename = 'stock_movements_'+todayStr_()+'.csv';
    }
    else if(type === 'audit'){
      const res = apiGetAuditLog(filter||{});
      if(!res.ok) return res;
      headers = ['วันที่','การกระทำ','Entity','EntityID','รายละเอียด','ผู้ทำ'];
      rows = res.data.map(r=>[r.CreatedAt, r.Action, r.Entity, r.EntityID, r.Detail, r.Actor]);
      filename = 'audit_log_'+todayStr_()+'.csv';
    }
    else if(type === 'account'){
      const res = apiGetInventoryAccount(filter||{});
      if(!res.ok) return res;
      headers = ['รหัส','รายการ','หมวดหมู่','ยอดยกมา','หน่วย','ราคา','รวมยกมา','ซื้อ','รวมซื้อ','ใช้ไป','รวมใช้','คงเหลือ','มูลค่าคงเหลือ'];
      rows = res.data.map(x=>[x.Code,x.Name,x.Category,x.OpeningQty,x.Unit,x.UnitPrice,x.OpeningAmount,x.PurchaseQty,x.PurchaseAmount,x.UsedQty,x.UsedAmount,x.RemainQty,x.RemainAmount]);
      filename = 'inventory_account_'+todayStr_()+'.csv';
    }
    else if(type === 'stock_card'){
      const res = apiGetStockCard(filter && filter.materialId, filter||{});
      if(!res.ok) return res;
      const mat = res.data.material || {};
      headers = ['วันที่','รายการ','รับ','จ่าย','คงเหลือ','ผู้ลงชื่อ/ผู้ทำ','เอกสารอ้างอิง'];
      rows = (res.data.entries||[]).map(e=>[e.dateTh||e.date, e.description, e.inQty||'', e.outQty||'', e.balance, e.actor||'', e.refDoc||'']);
      filename = 'stock_card_'+(mat.Code||'item')+'_'+todayStr_()+'.csv';
    }
    else return { ok:false, message:'ประเภท export ไม่ถูกต้อง' };

    const bom = '\uFEFF';   // BOM สำหรับ Excel ภาษาไทย
    const csvLines = [headers.join(',')];
    rows.forEach(row=>{
      csvLines.push(row.map(v=>{
        const s = String(v===null||v===undefined?'':v);
        if(s.indexOf(',')>=0 || s.indexOf('"')>=0 || s.indexOf('\n')>=0){
          return '"'+s.replace(/"/g,'""')+'"';
        }
        return s;
      }).join(','));
    });
    const csv = bom + csvLines.join('\n');
    const base64 = Utilities.base64Encode(csv, Utilities.Charset.UTF_8);

    return { ok:true, filename, base64, mimeType:'text/csv;charset=utf-8' };
  }catch(err){ return { ok:false, message:String(err) }; }
}

/* ============================== INVENTORY REPORT & OPENING BALANCES ============================== */

/**
 * คำนวณช่วงวันที่ของปีงบประมาณไทย
 * เช่น ปีงบประมาณ 2568: 1 ต.ค. 2567 (2024-10-01) ถึง 30 ก.ย. 2568 (2025-09-30)
 */
function getFiscalYearRange_(fiscalYear) {
  const fy = parseInt(fiscalYear, 10);
  const startYearAD = (fy - 543) - 1;
  const endYearAD   = (fy - 543);
  return {
    start: startYearAD + '-10-01',
    end:   endYearAD + '-09-30'
  };
}

function thaiDateFull_(isoDate) {
  if(!isoDate) return '';
  const parts = String(isoDate).substring(0,10).split('-');
  if(parts.length < 3) return isoDate;
  const y = parseInt(parts[0],10) + 543;
  const m = parseInt(parts[1],10) - 1;
  const d = parseInt(parts[2],10);
  const months = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                  'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  return d + ' ' + (months[m] || '') + ' ' + y;
}

/**
 * ดึงรายงานทะเบียนวัสดุคงเหลือ
 * filter: { fiscalYear: 2568, reportDate: '2025-02-28', category: 'วัสดุสำนักงาน' }
 */
function apiGetInventoryReport(filter) {
  try {
    filter = filter || {};
    const currentFY = new Date().getMonth() >= 9
      ? (new Date().getFullYear() + 543 + 1)
      : (new Date().getFullYear() + 543);
    const fiscalYear = parseInt(filter.fiscalYear || currentFY, 10);
    const reportDate = filter.reportDate || todayStr_();
    const categoryFilter = String(filter.category || '').trim();

    const fyRange = getFiscalYearRange_(fiscalYear);
    const startDate = fyRange.start;
    const endDate = reportDate < fyRange.end ? reportDate : fyRange.end;

    const materials = readAll_(SHEETS.MATERIALS);
    const purchases = readAll_(SHEETS.PURCHASES);
    const reqs      = readAll_(SHEETS.REQUESTS).map(mapRequestRow_);
    const reqItems  = readAll_(SHEETS.REQUEST_ITEMS);
    const openings  = readAll_(SHEETS.OPENING_BALANCES);

    const approvedReqs = reqs.filter(r => r.Status === 'APPROVED');
    const approvedReqMap = {};
    approvedReqs.forEach(r => { approvedReqMap[r.ID] = r; });

    let targetMats = materials;
    if (categoryFilter) {
      targetMats = targetMats.filter(m =>
        String(m.Category || '').trim() === categoryFilter ||
        String(m.MaterialType || '').trim() === categoryFilter
      );
    }

    const data = targetMats.map((m, idx) => {
      const unitPrice = Number(m.UnitPrice || 0);

      // 1) ยอดยกมาตามปีงบประมาณ: ดูจากชีต OpeningBalances ก่อน ถ้าไม่มีให้ใช้ OpeningQty เดิมของรายการ
      const ob = openings.find(o =>
        String(o.MaterialID) === String(m.ID) &&
        String(o.FiscalYear) === String(fiscalYear)
      );
      let openingQty = ob ? Number(ob.OpeningQty || 0) : Number(m.OpeningQty || 0);

      // 2) จำนวนรับเข้า: การจัดซื้อในช่วงปีงบประมาณถึงวันที่รายงาน
      const matPurchases = purchases.filter(p => {
        if (String(p.MaterialID) !== String(m.ID)) return false;
        const pDate = String(p.PurchaseDate || '').substring(0, 10);
        return pDate >= startDate && pDate <= endDate;
      });
      let purchaseQty = matPurchases.reduce((s, p) => s + Number(p.Qty || 0), 0);

      // Self-healing fallback: หากพัสดุได้มาในปีงบนี้ แต่ยังไม่มีใน Purchases และไม่มี OpeningBalances
      if (!ob && matPurchases.length === 0) {
        const acqDate = String(m.AcquiredDate || '').substring(0, 10);
        if (acqDate >= startDate && acqDate <= endDate) {
          const autoPurchase = Number(m.OrderQty || 0);
          if (autoPurchase > 0) {
            purchaseQty = autoPurchase;
            openingQty = Math.max(0, openingQty - autoPurchase);
          }
        }
      }

      // 3) จำนวนเบิก: จากใบขอเบิกที่อนุมัติแล้ว และอยู่ในช่วงปีงบประมาณถึงวันที่รายงาน
      const matUsedItems = reqItems.filter(it => {
        if (String(it.MaterialID) !== String(m.ID)) return false;
        const parentReq = approvedReqMap[it.RequestID];
        if (!parentReq) return false;
        const rDate = String(parentReq.RequestDate || parentReq.ApprovedDate || '').substring(0, 10);
        return rDate >= startDate && rDate <= endDate;
      });
      const usedQty = matUsedItems.reduce((s, it) => s + Number(it.Qty || 0), 0);

      // 4) ยอดคงเหลือ: ยอดยกมา + จำนวนรับ − จำนวนเบิก (ป้องกันติดลบ)
      const remainQty = Math.max(0, openingQty + purchaseQty - usedQty);
      const amount = remainQty * unitPrice;

      return {
        seq: idx + 1,
        ID: m.ID,
        Category: m.Category || '',
        MaterialType: m.MaterialType || m.Category || '',
        Code: m.Code || '',
        Name: m.Name || '',
        SizeSpec: m.SizeSpec || '',
        Unit: m.Unit || '',
        UnitPrice: unitPrice,
        OpeningQty: openingQty,
        PurchaseQty: purchaseQty,
        UsedQty: usedQty,
        RemainQty: remainQty,
        Amount: amount,
        StorageLocation: m.StorageLocation || ''
      };
    }).sort((a, b) => {
      const catCmp = String(a.Category).localeCompare(String(b.Category), 'th');
      if (catCmp !== 0) return catCmp;
      return String(a.Name).localeCompare(String(b.Name), 'th');
    });

    data.forEach((row, i) => { row.seq = i + 1; });

    // สรุปยอดตามประเภทวัสดุ
    const catMap = {};
    data.forEach(r => {
      const catName = r.Category || 'อื่นๆ';
      if (!catMap[catName]) catMap[catName] = 0;
      catMap[catName] += r.Amount;
    });

    const categorySummary = Object.keys(catMap).map(catName => ({
      category: catName,
      totalAmount: catMap[catName]
    }));

    const total = data.reduce((acc, r) => {
      acc.OpeningQty  += r.OpeningQty;
      acc.PurchaseQty += r.PurchaseQty;
      acc.UsedQty     += r.UsedQty;
      acc.RemainQty   += r.RemainQty;
      acc.Amount      += r.Amount;
      return acc;
    }, { OpeningQty: 0, PurchaseQty: 0, UsedQty: 0, RemainQty: 0, Amount: 0 });

    const settings = getSettingsObj_();

    return {
      ok: true,
      reportInfo: {
        schoolName: settings.SchoolName || 'ศูนย์การศึกษา ลำปาง',
        affiliation: settings.Affiliation || '',
        fiscalYear: fiscalYear,
        reportDate: reportDate,
        reportDateThai: thaiDateFull_(reportDate),
        category: categoryFilter,
        startDate: startDate,
        endDate: endDate
      },
      data: data,
      categorySummary: categorySummary,
      total: total,
      asOf: reportDate
    };
  } catch(err) {
    return { ok: false, message: String(err) };
  }
}

/**
 * บันทึกยอดยกมารายปีงบประมาณ
 */
function apiSaveOpeningBalance(payload) {
  return withLock_(() => {
    try {
      const materialId = String(payload.MaterialID || '').trim();
      const fiscalYear = String(payload.FiscalYear || '').trim();
      const openingQty = Number(payload.OpeningQty || 0);

      if (!materialId || !fiscalYear) {
        return { ok: false, message: 'กรุณาระบุรหัสพัสดุและปีงบประมาณ' };
      }

      const openings = readAll_(SHEETS.OPENING_BALANCES);
      const existing = openings.find(o =>
        String(o.MaterialID) === materialId &&
        String(o.FiscalYear) === fiscalYear
      );

      if (existing) {
        updateRowById_(SHEETS.OPENING_BALANCES, existing.ID, {
          OpeningQty: openingQty,
          SetBy: payload.actor || '',
          UpdatedAt: nowIso_()
        });
      } else {
        appendRow_(SHEETS.OPENING_BALANCES, {
          ID: genId_('OB'),
          MaterialID: materialId,
          FiscalYear: fiscalYear,
          OpeningQty: openingQty,
          SetBy: payload.actor || '',
          CreatedAt: nowIso_(),
          UpdatedAt: nowIso_()
        });
      }

      cacheClear_(SHEETS.OPENING_BALANCES);
      logAudit_('UPDATE', 'OpeningBalance', materialId, `ยกยอดปี ${fiscalYear} = ${openingQty}`, payload.actor || '');
      return { ok: true, message: 'บันทึกยอดยกมาเรียบร้อยแล้ว' };
    } catch(err) {
      return { ok: false, message: String(err) };
    }
  });
}

/**
 * เติมคอลัมน์ว่างใน 2D Array ให้มีความยาวเท่ากับ targetCols ทุกแถว (ป้องกัน Exception: จำนวนคอลัมน์ไม่ตรงกับช่วง)
 */
function pad2D_(rows, targetCols) {
  return (rows || []).map(r => {
    const row = Array.isArray(r) ? r.slice() : [];
    while (row.length < targetCols) row.push('');
    return row.slice(0, targetCols);
  });
}

/**
 * สร้าง Google Spreadsheet ชั่วคราวในโฟลเดอร์ Drive แล้วแปลงเป็น XLSX ดาวน์โหลด (วิธีที่ 3 ตามที่ผู้ใช้เลือก)
 */
function apiExportInventoryReportSheet(filter) {
  try {
    const reportRes = apiGetInventoryReport(filter);
    if (!reportRes.ok) return reportRes;

    const rep = reportRes.reportInfo;
    const data = reportRes.data;
    const catSummary = reportRes.categorySummary;
    const total = reportRes.total;

    const title = `รายงานการสำรวจทะเบียนวัสดุคงเหลือ_${rep.fiscalYear}_${rep.reportDate}`;
    const newSS = SpreadsheetApp.create(title);
    const ssId = newSS.getId();

    // ย้ายไฟล์ไปที่ DRIVE_FOLDER_ID
    if (DRIVE_FOLDER_ID) {
      try {
        const file = DriveApp.getFileById(ssId);
        const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
        folder.addFile(file);
        DriveApp.getRootFolder().removeFile(file);
      } catch(e) {}
    }

    const fyShort = String(rep.fiscalYear || '').slice(-2) || String(rep.fiscalYear || '');

    // Sheet 1: สรุปวัสดุคงเหลือ (สรุปงบ ปี <FY>)
    const sh1 = newSS.getActiveSheet();
    sh1.setName('สรุปงบ ปี ' + fyShort);
    const summaryRows = [
      ['สรุปวัสดุคงเหลือ'],
      [rep.schoolName],
      [`ณ วันที่ ${rep.reportDateThai}`],
      [],
      ['ลำดับที่', 'ประเภทวัสดุ', 'จำนวนเงิน', 'หมายเหตุ']
    ];

    catSummary.forEach((cs, i) => {
      summaryRows.push([i + 1, cs.category, cs.totalAmount, '']);
    });
    summaryRows.push(['', 'วัสดุคงเหลือ', total.Amount, '']);

    sh1.getRange(1, 1, summaryRows.length, 4).setValues(pad2D_(summaryRows, 4));
    sh1.getRange(1, 1, 1, 4).merge().setFontWeight('bold').setFontSize(13).setHorizontalAlignment('center');
    sh1.getRange(2, 1, 1, 4).merge().setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center');
    sh1.getRange(3, 1, 1, 4).merge().setFontSize(10).setHorizontalAlignment('center');
    sh1.getRange(5, 1, 1, 4).setBackground('#075985').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9.5).setHorizontalAlignment('center');
    sh1.getRange(summaryRows.length, 1, 1, 4).setFontWeight('bold').setFontSize(9.5);
    const colWidths1 = [60, 180, 120, 140];
    colWidths1.forEach((w, i) => sh1.setColumnWidth(i + 1, w));
    if (summaryRows.length >= 6) {
      sh1.getRange(6, 1, summaryRows.length - 5, 4).setFontSize(9);
      sh1.getRange(5, 1, summaryRows.length - 4, 4).setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
      sh1.getRange(6, 1, summaryRows.length - 5, 1).setHorizontalAlignment('center');
      sh1.getRange(6, 3, summaryRows.length - 4, 1).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
      for (let r = 6; r <= summaryRows.length; r++) sh1.setRowHeight(r, 24);
    }

    // Sheet 2: ทะเบียนวัสดุคงเหลือ (14 คอลัมน์)
    const catTitle = rep.category ? rep.category : 'ทั้งหมด';
    const sh2 = newSS.insertSheet(rep.category ? rep.category.substring(0, 31) : 'ทะเบียนวัสดุคงเหลือ');
    const rows = [
      [`รายงานการสำรวจทะเบียนวัสดุ${catTitle}คงเหลือ`],
      [`หน่วยงาน ${rep.schoolName}`],
      [`ปีงบประมาณ ${rep.fiscalYear} (ณ วันที่ ${rep.reportDateThai})`],
      [],
      [
        'ลำดับที่','ประเภทวัสดุ','ชนิดวัสดุ','รหัสวัสดุ','รายการวัสดุ',
        'ขนาด/ลักษณะ','หน่วยนับ','ราคาต่อหน่วย','ยอดยกมา',
        'จำนวนรับ','จำนวนเบิก','ยอดคงเหลือ','จำนวนเงิน','สถานที่จัดเก็บ'
      ]
    ];

    data.forEach(r => {
      rows.push([
        r.seq, r.Category, r.MaterialType, r.Code, r.Name,
        r.SizeSpec, r.Unit, r.UnitPrice, r.OpeningQty,
        r.PurchaseQty, r.UsedQty, r.RemainQty, r.Amount,
        r.StorageLocation
      ]);
    });

    // แถวรวม
    rows.push([
      '', 'รวม', '', '', '', '', '', '',
      total.OpeningQty, total.PurchaseQty, total.UsedQty, total.RemainQty, total.Amount, ''
    ]);

    rows.push([]);
    rows.push(['หมายเหตุ :  การจัดทำวัสดุคงเหลือ ณ วันที่ 30 กันยายน ของทุกปี จัดทำตามรูปแบบพัสดุ และจัดส่งข้อมูลให้กับกลุ่มงานบัญชีภายในวันที่ 5 ตุลาคม ของทุกปี']);

    sh2.getRange(1, 1, rows.length, 14).setValues(pad2D_(rows, 14));

    // Style Header & Merge Cells
    sh2.getRange(1, 1, 1, 14).merge().setFontWeight('bold').setFontSize(13).setHorizontalAlignment('center');
    sh2.getRange(2, 1, 1, 14).merge().setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center');
    sh2.getRange(3, 1, 1, 14).merge().setFontSize(10).setHorizontalAlignment('center');
    sh2.getRange(5, 1, 1, 14).setBackground('#075985').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9.5).setHorizontalAlignment('center');
    sh2.getRange(rows.length - 2, 1, 1, 14).setFontWeight('bold').setFontSize(9.5);
    sh2.getRange(rows.length, 1, 1, 14).merge().setFontSize(9);
    sh2.getRange(5, 1, rows.length - 4, 14).setWrap(true);
    const colWidths2 = [30, 55, 55, 65, 240, 55, 40, 60, 45, 45, 45, 50, 70, 55];
    colWidths2.forEach((w, i) => sh2.setColumnWidth(i + 1, w));
    if (rows.length >= 7) {
      sh2.getRange(6, 1, rows.length - 7, 14).setFontSize(9);
      sh2.getRange(5, 1, rows.length - 6, 14).setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
      sh2.getRange(6, 1, rows.length - 7, 1).setHorizontalAlignment('center');
      sh2.getRange(6, 4, rows.length - 7, 1).setHorizontalAlignment('center');
      sh2.getRange(6, 7, rows.length - 7, 1).setHorizontalAlignment('center');
      sh2.getRange(6, 8, rows.length - 7, 1).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
      sh2.getRange(6, 9, rows.length - 7, 4).setHorizontalAlignment('center');
      sh2.getRange(6, 13, rows.length - 7, 1).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
      sh2.getRange(6, 14, rows.length - 7, 1).setHorizontalAlignment('center');
      sh2.getRange(rows.length - 2, 8, 1, 6).setNumberFormat('#,##0.00');
      for (let r = 6; r <= rows.length - 2; r++) sh2.setRowHeight(r, 34);
    }

    // Sheet 3: Stock card (แบบตารางจ่ายออกแยกรายวัน 31 วัน ตามฟอร์ม ม.สวนดุสิต ลำปาง)
    const sh3 = newSS.insertSheet('Stock card');
    const rDateObj = new Date(rep.reportDate || todayStr_());
    const rMonth = rDateObj.getMonth();
    const rYearTh = rDateObj.getFullYear() + 543;
    const thMonths = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                      'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
    const monthTitle = thMonths[rMonth] + ' ' + rYearTh;

    // คำนวณจำนวนวันในเดือนนั้น (เช่น 28, 29, 30, หรือ 31)
    const daysInMonth = new Date(rDateObj.getFullYear(), rMonth + 1, 0).getDate();

    // ดึงรายการขอเบิกที่อนุมัติแล้วในเดือนนั้น เพื่อลงตารางรายวัน
    const currentMonthPrefix = rep.reportDate ? rep.reportDate.substring(0, 7) : todayStr_().substring(0, 7);
    const allApprovedReqs = readAll_(SHEETS.REQUESTS)
      .filter(rq => String(rq.Status).toUpperCase() === 'APPROVED' && String(rq.RequestDate||'').substring(0, 7) === currentMonthPrefix);
    const approvedReqIds = {};
    allApprovedReqs.forEach(rq => { approvedReqIds[rq.ID] = rq; });

    const allReqItems = readAll_(SHEETS.REQUEST_ITEMS);
    const dayOutMap = {}; // { materialId: { day: qty } }
    allReqItems.forEach(it => {
      const rq = approvedReqIds[it.RequestID];
      if (rq) {
        const dNum = parseInt(String(rq.RequestDate).substring(8, 10), 10);
        if (dNum >= 1 && dNum <= daysInMonth) {
          const mId = String(it.MaterialID);
          if (!dayOutMap[mId]) dayOutMap[mId] = {};
          dayOutMap[mId][dNum] = (dayOutMap[mId][dNum] || 0) + (parseFloat(it.Qty) || 0);
        }
      }
    });

    const scHeaderRow1 = [`Stock Card  วัสดุ${catTitle}  ${rep.schoolName} ประจำเดือน ${monthTitle}`];
    const scHeaderRow3 = ['ลำดับ', 'รายการวัสดุ', 'หน่วยนับ', 'ราคาต่อหน่วย', 'รายละเอียดรับเข้า', '', '', 'รายละเอียดจ่ายออก (วันที่)'];
    // เติมช่องว่างสำหรับหัวตารางจ่ายออก
    for(let d = 2; d <= daysInMonth; d++) scHeaderRow3.push('');
    scHeaderRow3.push('รวม');
    scHeaderRow3.push('ยอดคงเหลือ');

    const scHeaderRow4 = ['', '', '', '', 'ยอดยกมา', 'รับ', 'รวมยอด'];
    for(let d = 1; d <= daysInMonth; d++) scHeaderRow4.push(d);
    scHeaderRow4.push('รวม');
    scHeaderRow4.push('');

    const scRows = [
      scHeaderRow1,
      [],
      scHeaderRow3,
      scHeaderRow4
    ];

    data.forEach((r, idx) => {
      const mId = String(r.ID || '');
      const op = parseFloat(r.OpeningQty) || 0;
      const rec = parseFloat(r.PurchaseQty) || 0;
      const totalRec = op + rec;
      const row = [
        idx + 1,
        r.Name,
        r.Unit,
        r.UnitPrice,
        op,
        rec > 0 ? rec : '',
        totalRec
      ];

      let monthTotalOut = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const dayQty = (dayOutMap[mId] && dayOutMap[mId][d]) || 0;
        row.push(dayQty > 0 ? dayQty : '');
        monthTotalOut += dayQty;
      }
      row.push(monthTotalOut > 0 ? monthTotalOut : 0);
      row.push(r.RemainQty);
      scRows.push(row);
    });

    scRows.push([]);
    scRows.push(['หมายเหตุ : ยอดรับเมื่อวันที่ ...........................................................']);
    scRows.push(['* คำแนะนำการพิมพ์ A4 แนวนอน: ไปที่ เมนูพิมพ์ (Print) > การตั้งค่ามาตราส่วน (Scaling) > เลือก "Fit All Columns on One Page" (ปรับทุกคอลัมน์ให้อยู่ใน 1 หน้า)']);

    const totalCols = 7 + daysInMonth + 2;
    sh3.getRange(1, 1, scRows.length, totalCols).setValues(pad2D_(scRows, totalCols));
    sh3.getRange(1, 1, 1, totalCols).merge().setFontWeight('bold').setFontSize(12).setHorizontalAlignment('center');

    // ผสานเซลล์หัวตารางแถว 3-4 ตามโครงสร้างตาราง
    sh3.getRange(3, 1, 2, 1).merge().setVerticalAlignment('middle'); // ลำดับ
    sh3.getRange(3, 2, 2, 1).merge().setVerticalAlignment('middle'); // รายการวัสดุ
    sh3.getRange(3, 3, 2, 1).merge().setVerticalAlignment('middle'); // หน่วยนับ
    sh3.getRange(3, 4, 2, 1).merge().setVerticalAlignment('middle'); // ราคาต่อหน่วย
    sh3.getRange(3, 5, 1, 3).merge().setVerticalAlignment('middle'); // รายละเอียดรับเข้า (ยกมา, รับ, รวมยอด)
    sh3.getRange(3, 8, 1, daysInMonth).merge().setVerticalAlignment('middle'); // รายละเอียดจ่ายออก (วันที่)
    sh3.getRange(3, 7 + daysInMonth + 1, 2, 1).merge().setVerticalAlignment('middle'); // รวม
    sh3.getRange(3, 7 + daysInMonth + 2, 2, 1).merge().setVerticalAlignment('middle'); // ยอดคงเหลือ

    // สไตล์หัวตารางหลัก (แถว 3): น้ำเงินเข้ม ตัวอักษรขาว หนา
    sh3.getRange(3, 1, 1, totalCols).setBackground('#0369a1').setFontColor('#ffffff').setFontWeight('bold').setFontSize(9).setHorizontalAlignment('center');

    // สไตล์หัวข้อย่อยและวันที่ 1-31 (แถว 4): สีฟ้าอ่อน ตัวอักษรสีเข้ม อ่านง่าย สบายตา
    sh3.getRange(4, 5, 1, 3 + daysInMonth).setBackground('#f0f9ff').setFontColor('#0c4a6e').setFontWeight('bold').setFontSize(8.5).setHorizontalAlignment('center').setVerticalAlignment('middle');

    sh3.getRange(scRows.length - 1, 1, 1, totalCols).merge().setFontSize(8.5);
    sh3.getRange(scRows.length, 1, 1, totalCols).merge().setFontSize(8).setFontColor('#475569').setFontStyle('italic');
    sh3.getRange(3, 1, scRows.length - 3, totalCols).setWrap(true);
    sh3.setColumnWidth(1, 35);  // ลำดับ
    sh3.setColumnWidth(2, 250); // รายการ (ขยายให้อ่านสะดวก)
    sh3.setColumnWidth(3, 45);  // หน่วย
    sh3.setColumnWidth(4, 60);  // ราคา/หน่วย
    sh3.setColumnWidth(5, 50);  // ยกมา
    sh3.setColumnWidth(6, 45);  // รับ
    sh3.setColumnWidth(7, 50);  // รวมรับ
    for(let d = 1; d <= daysInMonth; d++) sh3.setColumnWidth(7 + d, 24); // วันที่ 1-31 ปรับ 24px (ตัวเลขอ่านง่าย ไม่เบียดขอบ)
    sh3.setColumnWidth(7 + daysInMonth + 1, 50); // รวมจ่าย
    sh3.setColumnWidth(7 + daysInMonth + 2, 60); // ยอดคงเหลือ
    if (scRows.length >= 7) {
      sh3.getRange(5, 1, scRows.length - 7, totalCols).setFontSize(8.5);
      sh3.getRange(3, 1, scRows.length - 5, totalCols).setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
      sh3.getRange(5, 1, scRows.length - 7, 1).setHorizontalAlignment('center');
      sh3.getRange(5, 3, scRows.length - 7, 1).setHorizontalAlignment('center');
      sh3.getRange(5, 4, scRows.length - 7, 1).setNumberFormat('#,##0.00').setHorizontalAlignment('right');
      sh3.getRange(5, 5, scRows.length - 7, totalCols - 4).setHorizontalAlignment('center');
      // ความสูงแถว 34px ให้ชื่อพัสดุ 2 บรรทัดแสดงครบไม่ถูกตัดขอบล่าง
      for (let r = 5; r <= scRows.length - 3; r++) sh3.setRowHeight(r, 34);
    }

    SpreadsheetApp.flush();

    // Export เป็น XLSX blob
    const exportUrl = 'https://docs.google.com/spreadsheets/d/' + ssId + '/export?format=xlsx';
    const resp = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      return {
        ok: false,
        message: 'ไม่สามารถดาวน์โหลด Excel ได้ (HTTP ' + resp.getResponseCode() + '): ' + resp.getContentText().substring(0, 150)
      };
    }

    const bytes = resp.getBlob().getBytes();
    const base64 = Utilities.base64Encode(bytes);

    return {
      ok: true,
      filename: `${title}.xlsx`,
      spreadsheetUrl: newSS.getUrl(),
      base64: base64,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
  } catch(err) {
    return { ok: false, message: String(err) };
  }
}

/**
 * Migration schema อัตโนมัติ (ปลอดภัย: ไม่ลบข้อมูลเดิม เพิ่มเฉพาะคอลัมน์ที่ขาด)
 */
function apiRunSchemaMigration() {
  return withLock_(() => {
    try {
      const book = ss_();
      const sh = getSheet_(SHEETS.MATERIALS);
      const expectedHeaders = HEADERS.Materials;

      const lastCol = Math.max(1, sh.getLastColumn());
      const currentHeaders = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h || '').trim());

      const missing = expectedHeaders.filter(h => currentHeaders.indexOf(h) < 0);
      if (missing.length > 0) {
        // เพิ่มคอลัมน์ใหม่ต่อท้าย
        const startCol = lastCol + 1;
        sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
        sh.getRange(1, startCol, 1, missing.length)
          .setBackground('#075985').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
      }

      // เติมหัวตาราง Settings ที่หายไปในตำแหน่งเดิม (ไม่เลื่อนคอลัมน์และไม่แตะข้อมูลแถวอื่น)
      const settingsSh = getSheet_(SHEETS.SETTINGS);
      const settingsHeadersAdded = [];
      HEADERS.Settings.forEach((header, i) => {
        const cell = settingsSh.getRange(1, i + 1);
        const current = String(cell.getValue() || '').trim();
        if (!current) {
          cell.setValue(header)
            .setBackground('#075985').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
          settingsHeadersAdded.push(header);
        }
      });

      // ตรวจสอบชีต OpeningBalances
      getSheet_(SHEETS.OPENING_BALANCES);

      // อัปเกรดผู้ใช้เดิมที่เป็น staff ให้เป็น officer (2-Role architecture)
      let staffMigrated = 0;
      try {
        const users = readAll_(SHEETS.USERS);
        users.forEach(u => {
          if(String(u.Role).toLowerCase() === 'staff'){
            updateRowById_(SHEETS.USERS, u.ID, { Role: 'officer' });
            staffMigrated++;
          }
        });
        if(staffMigrated > 0) cacheClear_(SHEETS.USERS);
      } catch(_) {}

      cacheClear_(SHEETS.MATERIALS);
      cacheClear_(SHEETS.OPENING_BALANCES);
      CacheService.getScriptCache().remove('boot_v1');

      return {
        ok: true,
        message: 'Schema migration เรียบร้อยแล้ว (คอลัมน์วัสดุ: ' + (missing.join(', ') || 'ไม่มี') + '; หัวตาราง Settings: ' + (settingsHeadersAdded.join(', ') || 'ครบถ้วน') + (staffMigrated > 0 ? '; ปรับผู้ใช้เป็นเจ้าหน้าที่พัสดุ: ' + staffMigrated + ' ราย' : '') + ')'
      };
    } catch(err) {
      return { ok: false, message: String(err) };
    }
  });
}

/* ============================== STOCK CARD (สต๊อกการ์ดรายชิ้น) ============================== */
/**
 * ดึงข้อมูลสต๊อกการ์ดสำหรับวัสดุรายชิ้น พร้อมคำนวณยอดยกมาและยอดคงเหลือสะสม (Running Balance)
 * filter: { fiscalYear: 2568, from: '2024-10-01', to: '2025-09-30' }
 */
function apiGetStockCard(materialId, filter) {
  try {
    if (!materialId) return { ok: false, message: 'กรุณาระบุรหัสวัสดุ (Material ID)' };
    filter = filter || {};

    const materials = readAll_(SHEETS.MATERIALS);
    const mat = materials.find(m => String(m.ID) === String(materialId));
    if (!mat) return { ok: false, message: 'ไม่พบข้อมูลพัสดุในระบบ' };

    const currentFY = new Date().getMonth() >= 9
      ? (new Date().getFullYear() + 543 + 1)
      : (new Date().getFullYear() + 543);
    const fiscalYear = parseInt(filter.fiscalYear || currentFY, 10);
    const fyRange = getFiscalYearRange_(fiscalYear);

    const fromDate = filter.from || fyRange.start;
    const toDate   = filter.to || fyRange.end;

    // 1. ดึงยอดยกมาต้นปีงบประมาณ
    const openings = readAll_(SHEETS.OPENING_BALANCES);
    const opRec = openings.find(o => String(o.MaterialID) === String(materialId) && String(o.FiscalYear) === String(fiscalYear));
    const fiscalOpeningQty = opRec ? (parseFloat(opRec.OpeningQty) || 0) : (parseFloat(mat.OpeningQty) || 0);

    // 2. ดึงประวัติ StockMovements ทั้งหมดของวัสดุนี้
    const allMovements = readAll_(SHEETS.STOCK_MOVEMENTS)
      .filter(m => String(m.MaterialID) === String(materialId))
      .sort((a, b) => new Date(a.CreatedAt) - new Date(b.CreatedAt));

    // 3. คำนวณยอดสะสมก่อนหน้า fromDate เพื่อใช้เป็นยอดยกมาตั้งต้นของช่วงที่เลือก (Period Opening)
    let runningBalance = fiscalOpeningQty;
    let priorMovements = [];
    let periodMovements = [];

    allMovements.forEach(m => {
      const d = String(m.CreatedAt || '').substring(0, 10);
      if (d < fromDate) {
        priorMovements.push(m);
        const qty = parseFloat(m.Qty) || 0;
        if (m.Type === 'IN') runningBalance += qty;
        else if (m.Type === 'OUT') runningBalance -= qty;
        else if (m.Type === 'ADJUST') runningBalance = parseFloat(m.AfterQty) !== undefined ? parseFloat(m.AfterQty) : runningBalance;
      } else if (d <= toDate) {
        periodMovements.push(m);
      }
    });

    const periodOpeningBalance = runningBalance;
    let totalIn = 0;
    let totalOut = 0;

    const allRequests = readAll_(SHEETS.REQUESTS);
    const reqNameMap = {};
    allRequests.forEach(r => {
      if(r.DocNo && r.FullName) reqNameMap[String(r.DocNo).trim()] = r.FullName;
    });

    const entries = [];
    // บรรทัดแรก: ยอดยกมา
    entries.push({
      date: fromDate,
      dateTh: thaiDateFull_(fromDate),
      description: 'ยอดยกมา',
      inQty: 0,
      outQty: 0,
      balance: periodOpeningBalance,
      actor: '-',
      refDoc: ''
    });

    periodMovements.forEach(m => {
      const d = String(m.CreatedAt || '').substring(0, 10);
      const qty = parseFloat(m.Qty) || 0;
      let inQty = 0;
      let outQty = 0;

      let desc = m.Note || '';
      let displayActor = m.Actor || '';
      const refDoc = String(m.RefDoc || '').trim();

      if (m.Type === 'IN') {
        inQty = qty;
        totalIn += qty;
        runningBalance += qty;
        if (!desc) desc = 'รับเข้าสต๊อก' + (refDoc ? ' (' + refDoc + ')' : '');
      } else if (m.Type === 'OUT') {
        outQty = qty;
        totalOut += qty;
        runningBalance -= qty;
        if (!desc) desc = 'จ่ายตามใบขอเบิก' + (refDoc ? ' (' + refDoc + ')' : '');
        if (refDoc && reqNameMap[refDoc]) {
          displayActor = reqNameMap[refDoc];
        }
      } else if (m.Type === 'ADJUST') {
        const after = parseFloat(m.AfterQty) || 0;
        const diff = after - runningBalance;
        if (diff > 0) { inQty = diff; totalIn += diff; }
        else if (diff < 0) { outQty = Math.abs(diff); totalOut += Math.abs(diff); }
        runningBalance = after;
        if (!desc) desc = 'ปรับปรุงยอดสต็อก';
      }

      entries.push({
        date: d,
        dateTh: thaiDateFull_(d),
        description: desc,
        inQty: inQty,
        outQty: outQty,
        balance: runningBalance,
        actor: displayActor,
        refDoc: refDoc
      });
    });

    const settings = getSettingsObj_();

    return {
      ok: true,
      data: {
        schoolName: settings.SchoolName || 'มหาวิทยาลัยสวนดุสิต ศูนย์การศึกษาลำปาง',
        affiliation: settings.Affiliation || 'มหาวิทยาลัยสวนดุสิต',
        fiscalYear: fiscalYear,
        dateRange: { from: fromDate, to: toDate },
        material: {
          ID: mat.ID,
          Code: mat.Code,
          Name: mat.Name,
          Unit: mat.Unit,
          UnitPrice: parseFloat(mat.UnitPrice) || 0,
          Category: mat.Category,
          MaterialType: mat.MaterialType || '',
          SizeSpec: mat.SizeSpec || '',
          StorageLocation: mat.StorageLocation || '',
          StockQty: parseFloat(mat.StockQty) || 0
        },
        openingBalance: periodOpeningBalance,
        summary: {
          totalIn: totalIn,
          totalOut: totalOut,
          currentBalance: runningBalance
        },
        entries: entries
      }
    };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}