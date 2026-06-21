// ============================================================
//  Gymnastデータベース  —  APIバックエンド (Google Apps Script)
//  役割: 認証 (login) + データ取得 (getData)
//  フロントは GitHub Pages の静的サイトから呼び出す
//
//  ▼ デプロイ手順（重要）
//   1. このコードを Apps Script エディタに貼り付け
//   2. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
//   3. 「次のユーザーとして実行」= 自分
//      「アクセスできるユーザー」= 全員（匿名含む）  ★必須
//   4. 発行された /exec の URL をフロントの API_URL に設定
//
//  ▼ 認証シート「スタッフ」の仕様
//   1行目: ヘッダー（A=メールアドレス, B=スタッフ名）
//   2行目以降: 実データ
// ============================================================

const SPREADSHEET_ID = '1s8-5WfU-CzvjH3k71_dbrYe9uN8VAHYB826C7lyxmKE';

const SHEET_SCORES  = '得点入力';
const SHEET_RANKING = '世界ランキング入力';
const SHEET_STAFF   = 'スタッフ';

// セッショントークンの有効期限（時間） 7日 = 168時間
const TOKEN_TTL_HOURS = 168;
// トークン署名用の秘密鍵。
// 初回アクセス時に自動でランダム生成し、スクリプトプロパティに保存して使い回す。
// （コードに秘密鍵を直書きする必要はありません）

// ----- エントリーポイント -----
// GitHub Pages からは fetch(POST) で呼ばれる。
// CORS プリフライトを避けるため Content-Type: text/plain で受け取る。
function doPost(e) {
  return handleRequest(e);
}

// GET でも一応動くように（デバッグ・JSONP用）
function doGet(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    var params = parseParams(e);
    var action = params.action || '';
    var result;

    switch (action) {
      case 'login':
        result = doLogin(params);
        break;
      case 'getData':
        result = doGetData(params);
        break;
      default:
        result = { success: false, error: '不明なアクションです: ' + action };
    }
    return jsonOutput(result, params.callback);
  } catch (err) {
    return jsonOutput({ success: false, error: err.message }, null);
  }
}

// POST本文（text/plain JSON）と GETクエリの両方からパラメータを取り出す
function parseParams(e) {
  var params = {};
  if (e && e.parameter) {
    for (var k in e.parameter) params[k] = e.parameter[k];
  }
  if (e && e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      for (var k2 in body) params[k2] = body[k2];
    } catch (ignore) {}
  }
  return params;
}

// JSON / JSONP 出力
function jsonOutput(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  認証
// ============================================================
function doLogin(params) {
  var email = String(params.email || '').trim().toLowerCase();

  if (!email) {
    return { success: false, error: 'メールアドレスを入力してください' };
  }

  var staff = readStaff();
  var matched = null;
  for (var i = 0; i < staff.length; i++) {
    if (staff[i].email === email) {
      matched = staff[i];
      break;
    }
  }

  if (!matched) {
    return { success: false, error: 'このメールアドレスは登録されていません' };
  }

  var token = makeToken(matched.email);
  return {
    success: true,
    token: token,
    staffName: matched.name,
    email: matched.email
  };
}

// スタッフシートを読む（A=email, B=name、1行目ヘッダー）
function readStaff() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_STAFF);
  if (!sheet) throw new Error('シート "' + SHEET_STAFF + '" が見つかりません');

  var data = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var email = String(data[i][0] || '').trim().toLowerCase();
    var name  = String(data[i][1] || '').trim();
    if (!email || !name) continue;
    out.push({ email: email, name: name });
  }
  return out;
}

// ----- 簡易トークン（署名付き、有効期限あり） -----
// 形式:  base64(email)|expiryMillis|signature
function makeToken(email) {
  var expiry = Date.now() + TOKEN_TTL_HOURS * 3600 * 1000;
  var payload = Utilities.base64EncodeWebSafe(email) + '|' + expiry;
  var sig = signPayload(payload);
  return payload + '|' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  var parts = String(token).split('|');
  if (parts.length !== 3) return null;
  var payload = parts[0] + '|' + parts[1];
  var sig = parts[2];
  if (signPayload(payload) !== sig) return null;          // 署名不一致
  var expiry = Number(parts[1]);
  if (!expiry || Date.now() > expiry) return null;        // 期限切れ
  var email = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  // 念のため、現在もスタッフに存在するか確認
  var staff = readStaff();
  for (var i = 0; i < staff.length; i++) {
    if (staff[i].email === email) return staff[i];
  }
  return null;
}

function signPayload(payload) {
  var raw = Utilities.computeHmacSha256Signature(payload, getTokenSecret());
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

// 秘密鍵を取得（無ければ自動生成して保存）
var _tokenSecretCache = null;
function getTokenSecret() {
  if (_tokenSecretCache) return _tokenSecretCache;
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    // 256bit のランダム鍵を生成
    var bytes = [];
    for (var i = 0; i < 32; i++) {
      bytes.push(Math.floor(Math.random() * 256));
    }
    secret = bytes.map(function (b) {
      var v = b.toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('') + '_' + Date.now() + '_' + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  _tokenSecretCache = secret;
  return secret;
}

// ============================================================
//  データ取得（要トークン）
// ============================================================
function doGetData(params) {
  var staff = verifyToken(params.token);
  if (!staff) {
    return { success: false, error: 'AUTH', message: '認証が無効または期限切れです。再度ログインしてください。' };
  }

  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var scoreSheet = ss.getSheetByName(SHEET_SCORES);
  var rankSheet  = ss.getSheetByName(SHEET_RANKING);
  if (!scoreSheet) throw new Error('シート "' + SHEET_SCORES + '" が見つかりません');
  if (!rankSheet)  throw new Error('シート "' + SHEET_RANKING + '" が見つかりません');

  var allScores = readScoreData(scoreSheet);
  var worldRankings = readWorldRankings(rankSheet);
  var players = uniqueList(allScores.map(function (r) { return r.player; }));
  var competitions = uniqueList(allScores.map(function (r) { return r.competition; }));

  return {
    success: true,
    allScores: allScores,
    worldRankings: worldRankings,
    players: players,
    competitions: competitions
  };
}

// ----- 得点入力シートを読み込む -----
function readScoreData(sheet) {
  var data = sheet.getDataRange().getValues();
  var records = [];
  for (var i = 2; i < data.length; i++) {
    var row = data[i];
    var playerName = row[2];
    if (!playerName || String(playerName).trim() === '') continue;
    records.push({
      date: formatDateValue(row[0]),
      competition: String(row[1] || '').trim(),
      player: String(playerName).trim(),
      fx: makeEvent(row, 3),
      ph: makeEvent(row, 8),
      sr: makeEvent(row, 13),
      vt: makeEvent(row, 18),
      pb: makeEvent(row, 23),
      hb: makeEvent(row, 28),
      aa: makeEvent(row, 33)
    });
  }
  return records;
}

function makeEvent(row, startCol) {
  return {
    D:     numOrNull(row[startCol]),
    E:     numOrNull(row[startCol + 1]),
    ND:    numOrNull(row[startCol + 2]),
    SB:    numOrNull(row[startCol + 3]),
    score: numOrNull(row[startCol + 4])
  };
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function formatDateValue(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'JST', 'yyyy/MM/dd');
  return String(v);
}

function uniqueList(arr) {
  var seen = {}, result = [];
  arr.forEach(function (v) {
    if (v && !seen[v]) { seen[v] = true; result.push(v); }
  });
  return result;
}

// ----- 世界ランキング入力シートを読み込む -----
function readWorldRankings(sheet) {
  var lastRow = Math.max(18, sheet.getLastRow());
  var data = sheet.getRange(1, 1, lastRow, 22).getValues();

  var fx = readEventRanking(data, [3,4,5], 1, 3, 4, 5, 6, 7);
  var ph = readEventRanking(data, [3,4,5], 8, 10, 11, 12, null, 14);
  var sr = readEventRanking(data, [3,4,5], 15, 17, 18, 19, 20, 21);

  var vt = [];
  [[9,10],[11,12],[13,14]].forEach(function (pair) {
    var r1 = pair[0], r2 = pair[1];
    if (!data[r1]) return;
    vt.push({
      name: String(data[r1][1] || '').trim(),
      vault1: { D: numOrNull(data[r1][3]), E: numOrNull(data[r1][4]), SB: numOrNull(data[r1][5]), score: numOrNull(data[r1][6]) },
      vault2: { D: numOrNull(data[r2][3]), E: numOrNull(data[r2][4]), SB: numOrNull(data[r2][5]), score: numOrNull(data[r2][6]) },
      avg: numOrNull(data[r1][7])
    });
  });

  var pb = readEventRanking(data, [9,10,11], 8, 10, 11, 12, 13, 14);
  var hb = readEventRanking(data, [9,10,11], 15, 17, 18, 19, 20, 21);
  var aa = readEventRanking(data, [15,16,17], 15, 17, 18, 19, 20, 21);

  return { fx: fx, ph: ph, sr: sr, vt: vt, pb: pb, hb: hb, aa: aa };
}

function readEventRanking(data, rows, nameCol, dCol, eCol, ndCol, sbCol, scoreCol) {
  var out = [];
  rows.forEach(function (r) {
    if (!data[r]) return;
    out.push({
      name:  String(data[r][nameCol] || '').trim(),
      D:     numOrNull(data[r][dCol]),
      E:     numOrNull(data[r][eCol]),
      ND:    numOrNull(data[r][ndCol]),
      SB:    sbCol === null ? null : numOrNull(data[r][sbCol]),
      score: numOrNull(data[r][scoreCol])
    });
  });
  return out;
}
