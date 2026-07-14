#!/usr/bin/env node
// build_production_server.js — etsi014_kme_server.js'ten, demo/geri-düşüş
// kimlik doğrulama kodunun (Bearer token + X-SAE-ID header modu, TLS'siz/
// istemci-sertifikasız sunucu modları) DERLEME ANINDA FİZİKSEL OLARAK
// SÖKÜLDÜĞÜ bir "üretim" derlemesi üretir.
// ═══════════════════════════════════════════════════════════════════
// NEDEN BU SCRIPT VAR: "Demo Kodlarının İçeride Kalması" bulgusu — güvenli
// mTLS modu ile Bearer Token'lı yerel demo modu aynı kod tabanında yan
// yana duruyordu, yalnızca bir kod yorumu ve CLI bayrağıyla ayrılıyordu.
// Sertifikasyon geri bildirimi netti: "üretim sınıfı kod tabanında zayıf
// kimlik doğrulama yöntemleri ve bypass hatları BARINDIRILAMAZ... bu
// kodların derleme anında FİZİKSEL OLARAK SÖKÜLMÜŞ olması gerekir." Bu
// script tam olarak bunu yapar.
//
// NASIL ÇALIŞIR: Kaynak dosyada (etsi014_kme_server.js) demo/bypass koduna
// ait her blok `// PROD-STRIP-BEGIN: <id>` / `// PROD-STRIP-END: <id>`
// işaretçileriyle sarılmıştır — bu script o blokları TAMAMEN SİLER. Bir
// blok çalışma zamanında BOŞ BIRAKILAMAZ hâle gelirse (ör. bir if/else
// zincirinin bir dalı), STRIP bloğunun HEMEN ardından duran bir
// `// PROD-REPLACE-BEGIN: <id>` / `// PROD-REPLACE-END: <id>` bloğu
// (kaynakta bir /* yorum */ İÇİNDE durur — dev modda hiç ÇALIŞMAZ,
// yalnızca bu script tarafından yorum işaretleri çıkarılıp üretim
// derlemesine yerleştirilir) devreye girer. Her iki blok türü de AYNI
// dosyada, birbirinin hemen yanında durur — "neyin neyle değiştiği" bir
// denetçi için TEK bakışta görülebilir, ayrı bir gizli manifestoda değil.
//
// ÇIKTI ÜZERİNDE ÇALIŞTIRILAN GÜVENCELER (herhangi biri başarısız olursa
// build BAŞARISIZ olur — "güven değil doğrula"):
//   1) Kaynaktaki HER PROD-STRIP bloğu, bu script'in STRIP_IDS
//      manifestosunda TANIMLI mı? (tanımsız/yeni bir blok build'i durdurur
//      — yeni bir demo/bypass kodunun SESSİZCE sızmasını önler)
//   2) STRIP_IDS'teki HER id, kaynakta GERÇEKTEN bulundu mu? (bir id
//      kaynaktan silinmiş/yeniden adlandırılmışsa build durur)
//   3) Üretilen çıktıda "Bearer" / "X-SAE-ID" / "demo-token" / "sae-token"
//      / işaretçilerin kendisi gibi YASAKLI örüntülerden HİÇBİRİ kalmamış
//      mı? (POZİTİF doğrulama — yalnızca silme mantığına güvenme, gerçekten
//      grep'le kontrol et)
//   4) Çıktı hâlâ geçerli JavaScript mi? (hem vm.Script hem `node --check`)
//
// KULLANIM:
//   node bb84/build_production_server.js [--out=<yol>]
//     (varsayılan çıktı: bb84/dist/etsi014_kme_server.production.js)
// ═══════════════════════════════════════════════════════════════════
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(__dirname, "etsi014_kme_server.js");
const DEFAULT_OUT = path.join(__dirname, "dist", "etsi014_kme_server.production.js");

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT };
  for (const a of argv) {
    if (a.startsWith("--out=")) out.out = path.resolve(a.slice("--out=".length));
    else if (a === "--help" || a === "-h") {
      console.log("Kullanım: node build_production_server.js [--out=<yol>]");
      process.exit(0);
    }
  }
  return out;
}

// Üretim derlemesinde neyin SÖKÜLECEĞİNİN tam manifestosu. Her id,
// kaynaktaki BİR PROD-STRIP çiftiyle birebir eşleşmelidir (bkz. doğrulama
// #1/#2, aşağıda).
const STRIP_IDS = [
  "demo-auth-token",
  "demo-auth-fallback",
  "demo-server-modes",
  "demo-auth-token-log",
  "demo-auth-doc-fallback-explainer",
  "demo-auth-doc-curl-example",
  "demo-auth-doc-fallback-comment",
];

// Üretim çıktısında KESİNLİKLE bulunmaması gereken örüntüler.
const FORBIDDEN_PATTERNS = [
  { name: "Bearer", re: /bearer/i },
  { name: "X-SAE-ID", re: /x-sae-id/i },
  { name: "demo-token", re: /demo-token/i },
  { name: "sae-token", re: /sae-token/i },
  { name: "PROD-STRIP işaretçisi", re: /PROD-STRIP-/ },
  { name: "PROD-REPLACE işaretçisi", re: /PROD-REPLACE-/ },
];

function extractBlock(source, id, kind) {
  const beginTag = `// ${kind}-BEGIN: ${id}`;
  const endTag = `// ${kind}-END: ${id}`;
  const beginIdx = source.indexOf(beginTag);
  if (beginIdx === -1) return null;
  const endIdx = source.indexOf(endTag, beginIdx);
  if (endIdx === -1) {
    throw new Error(`${beginTag} bulundu ama karşılık gelen ${endTag} bulunamadı — kaynak bozuk.`);
  }
  return { start: beginIdx, end: endIdx + endTag.length };
}

// PROD-REPLACE bloğu, dev modda ÇALIŞMASIN diye /* ... */ İÇİNDE durur —
// üretim derlemesinde bu yorum işaretlerini çıkarıp gerçek kodu açığa çıkarır.
function unwrapReplacementComment(text, id) {
  const m = /\/\*([\s\S]*?)\*\//.exec(text);
  if (!m) {
    throw new Error(`'${id}' için PROD-REPLACE bloğu içinde bir /* ... */ yorumu bulunamadı — kaynak beklenen kalıba uymuyor.`);
  }
  return m[1].trim();
}

function build() {
  const source = fs.readFileSync(SOURCE, "utf8");
  let output = source;

  const foundIdsInSource = new Set([...source.matchAll(/\/\/ PROD-STRIP-BEGIN: (\S+)/g)].map((m) => m[1]));
  const manifestIds = new Set(STRIP_IDS);

  for (const id of foundIdsInSource) {
    if (!manifestIds.has(id)) {
      throw new Error(
        `Kaynakta '${id}' adlı bir PROD-STRIP bloğu bulundu ama STRIP_IDS manifestosunda TANIMLI DEĞİL — ` +
          `bu, sökülmesi gereken yeni bir demo/bypass kod bloğunun SESSİZCE üretim derlemesine sızmasına yol açar. ` +
          `bb84/build_production_server.js içindeki STRIP_IDS listesine ekleyin.`
      );
    }
  }
  for (const id of manifestIds) {
    if (!foundIdsInSource.has(id)) {
      throw new Error(
        `STRIP_IDS manifestosunda '${id}' var ama kaynakta karşılık gelen bir PROD-STRIP-BEGIN bloğu bulunamadı — ` +
          `kaynak (etsi014_kme_server.js) değişmiş olabilir, manifestoyu güncelleyin.`
      );
    }
  }

  for (const id of STRIP_IDS) {
    const stripBlock = extractBlock(output, id, "PROD-STRIP");
    if (!stripBlock) throw new Error(`'${id}' için PROD-STRIP bloğu bulunamadı (ilk taramadan sonra kayboldu?).`);

    // Bir sonraki değiştirme bloğunun etiketi, STRIP bloğunun hemen
    // ardından bir JSDoc/yorum devam karakteriyle (" * ") süslenmiş olarak
    // gelebilir — bu yüzden katı bir startsWith YERİNE küçük bir arama
    // penceresi içinde tag'in VAR OLUP OLMADIĞINA bakıyoruz.
    const searchWindow = output.slice(stripBlock.end, stripBlock.end + 200);
    let spliceEnd = stripBlock.end;
    let replacementText = "";

    // İki tür değiştirme bloğu desteklenir:
    //  - PROD-REPLACE: ÇALIŞTIRILABİLİR JS kodu, dev modda kaçmasın diye
    //    /* ... */ İÇİNDE durur — bu script yorum işaretlerini çıkarır.
    //  - PROD-REPLACE-TEXT: yalnızca DÜZ METİN/dokümantasyon (zaten bir
    //    JSDoc/yorum bloğunun İÇİNDE durduğu için ayrıca gizlenmesine
    //    gerek yok) — AYNEN kullanılır.
    if (searchWindow.includes(`PROD-REPLACE-BEGIN: ${id}`)) {
      const replaceBlock = extractBlock(output, id, "PROD-REPLACE");
      if (!replaceBlock) throw new Error(`'${id}' için PROD-REPLACE-BEGIN bulundu ama blok tam ayrıştırılamadı.`);
      replacementText = unwrapReplacementComment(output.slice(replaceBlock.start, replaceBlock.end), id);
      spliceEnd = replaceBlock.end;
    } else if (searchWindow.includes(`PROD-REPLACE-TEXT-BEGIN: ${id}`)) {
      const replaceBlock = extractBlock(output, id, "PROD-REPLACE-TEXT");
      if (!replaceBlock) throw new Error(`'${id}' için PROD-REPLACE-TEXT-BEGIN bulundu ama blok tam ayrıştırılamadı.`);
      const raw = output.slice(replaceBlock.start, replaceBlock.end);
      // Yalnızca başlangıç/bitiş işaretçi satırlarını çıkar, ARADAKİ metni
      // (dokümantasyon satırları) AYNEN koru.
      replacementText = raw
        .split("\n")
        .filter((line) => !/PROD-REPLACE-TEXT-(BEGIN|END): /.test(line))
        .join("\n")
        .trim();
      spliceEnd = replaceBlock.end;
    }

    output = output.slice(0, stripBlock.start) + replacementText + output.slice(spliceEnd);
  }

  // ── Doğrulama #3: yasaklı örüntüler ──
  const leftover = FORBIDDEN_PATTERNS.filter((p) => p.re.test(output));
  if (leftover.length) {
    throw new Error(
      `Üretim çıktısında YASAKLI örüntü(ler) bulundu: ${leftover.map((p) => p.name).join(", ")} — sökme İŞLEMİ TAM DEĞİL, build DURDURULDU.`
    );
  }

  // ── Doğrulama #4a: geçerli JavaScript mi? (vm.Script) ──
  try {
    new vm.Script(output, { filename: "etsi014_kme_server.production.js" });
  } catch (e) {
    throw new Error(`Üretim çıktısı GEÇERSİZ JavaScript üretti (vm.Script): ${e.message}`);
  }

  return output;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[build] Kaynak: ${path.relative(REPO_ROOT, SOURCE)}`);
  const output = build();

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const header =
    "// ═══════════════════════════════════════════════════════════════\n" +
    "// OTOMATİK ÜRETİLDİ — bb84/build_production_server.js tarafından.\n" +
    "// ELLE DÜZENLEMEYİN. Kaynak: bb84/etsi014_kme_server.js\n" +
    "// Bu dosyada demo/geri-düşüş kimlik doğrulama kodu (Bearer token,\n" +
    "// X-SAE-ID header modu, TLS'siz/istemci-sertifikasız sunucu modları)\n" +
    "// FİZİKSEL OLARAK YOKTUR — mTLS (--cert/--key/--ca üçü birlikte)\n" +
    "// verilmeden bu sunucu BAŞLAMAZ.\n" +
    "// ═══════════════════════════════════════════════════════════════\n";
  // Shebang (#!/usr/bin/env node) SADECE dosyanın KESİN İLK satırıyken
  // geçerlidir — header'ı onun ÖNÜNE değil ARDINA eklemeliyiz.
  let finalOutput;
  if (output.startsWith("#!")) {
    const newlineIdx = output.indexOf("\n");
    finalOutput = output.slice(0, newlineIdx + 1) + header + output.slice(newlineIdx + 1);
  } else {
    finalOutput = header + output;
  }
  fs.writeFileSync(opts.out, finalOutput);
  console.log(`[build] ✓ Üretim derlemesi yazıldı: ${path.relative(REPO_ROOT, opts.out)} (${output.split("\n").length} satır)`);
  console.log(`[build] ✓ Yasaklı örüntü taraması TEMİZ (Bearer/X-SAE-ID/demo-token/sae-token/işaretçiler — hiçbiri yok).`);

  // ── Doğrulama #4b: node'un KENDİ ayrıştırıcısıyla da doğrula (çift kontrol) ──
  execFileSync(process.execPath, ["--check", opts.out], { stdio: "inherit" });
  console.log(`[build] ✓ Sözdizimi geçerli (node --check).`);
}

main();
