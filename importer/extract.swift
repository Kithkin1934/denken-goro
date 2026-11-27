// 電験三種 語呂アプリ: 過去問PDFの取り込みプログラム（Mac 用）
//
// 使い方:
//   swiftc -O extract.swift -o extract
//   ./extract <PDFのルートフォルダ> <出力フォルダ> [絞り込み文字列...]
// 例:
//   ./extract ~/Documents/電験三種 ../data 理論R8上期 理論H25
//
// 原本PDF と 語呂PDF を組にして、文字認識（Vision）で問題ごとに分け、
// 画像の切り出し・正解候補の検出・語呂テキストの抽出を行い、
// <出力フォルダ>/<科目>/<回>/exam.json と画像を書き出す。

import AppKit
import Foundation
import PDFKit
import Vision

// MARK: - 設定

let renderScale: CGFloat = 2.5
let jpegQuality: CGFloat = 0.8
let subjects = ["理論", "機械", "法規"]

// MARK: - 出力データ

struct Piece: Codable {
    var question: String?   // 原本の切り出し画像（ファイル名）
    var goro: String?       // 語呂PDFの切り出し画像（ファイル名）
}

struct QuestionOut: Codable {
    var id: String          // 例: 理論-R8上期-02
    var number: Int
    var part: String        // "A" | "B" | "?"
    var subCount: Int       // 選択肢の組の数（B問題の (a)(b) なら 2）
    var answers: [Int?]     // 組ごとの正解候補（nil = 見つからない）
    var answerCandidates: [[Int]]  // 組ごとの候補すべて（複数あればあやしい）
    var pieces: [Piece]
    var text: String        // 問題文（検索・重複判定用）
    var goroText: String    // 語呂PDFにだけある文字
    var flags: [String]     // 確認が必要な理由
    var segment: Int        // 複数年度が1ファイルにある場合の区切り番号
    var struck: Bool        // 語呂PDFで斜線が引かれている
    var excluded: Bool      // 取り込み対象外（機械の斜線 = 勉強しない）
}

struct ExamOut: Codable {
    var subject: String
    var exam: String        // 例: R8上期, H25
    var original: String
    var goro: String?
    var pageCount: Int
    var goroPageCount: Int
    var questions: [QuestionOut]
    var warnings: [String]
    var extractedAt: String
}

// MARK: - ファイルの組み合わせ

struct ExamFiles {
    var subject: String
    var exam: String
    var original: URL
    var goro: URL?
}

func normalizeDigits(_ s: String) -> String {
    var out = ""
    for ch in s {
        if let v = ch.unicodeScalars.first?.value, v >= 0xFF10 && v <= 0xFF19 {
            out.append(Character(UnicodeScalar(v - 0xFF10 + 0x30)!))
        } else if ch == "（" { out.append("(") }
        else if ch == "）" { out.append(")") }
        else { out.append(ch) }
    }
    return out
}

func findExams(root: URL) -> [ExamFiles] {
    let fm = FileManager.default
    let re = try! NSRegularExpression(pattern: "^(理論|機械|法規)([HR]\\d+(?:-\\d+)?(?:上期|下期)?)(語呂)?(?:ver(\\d+))?\\.pdf$")
    var originals: [String: URL] = [:]
    var goros: [String: (URL, Int)] = [:]
    var subjectOf: [String: String] = [:]
    for subject in subjects {
        let dir = root.appendingPathComponent(subject)
        guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: nil) else { continue }
        for case let url as URL in e where url.pathExtension.lowercased() == "pdf" {
            let name = url.lastPathComponent.precomposedStringWithCanonicalMapping
            let ns = name as NSString
            guard let m = re.firstMatch(in: name, range: NSRange(location: 0, length: ns.length)) else { continue }
            let subj = ns.substring(with: m.range(at: 1))
            let exam = ns.substring(with: m.range(at: 2))
            let key = subj + "/" + exam
            subjectOf[key] = subj
            if m.range(at: 3).location != NSNotFound {
                let ver = m.range(at: 4).location != NSNotFound ? Int(ns.substring(with: m.range(at: 4))) ?? 1 : 1
                if let cur = goros[key], cur.1 >= ver { continue }
                goros[key] = (url, ver)
            } else {
                originals[key] = url
            }
        }
    }
    return originals.keys.sorted().map { key in
        let parts = key.split(separator: "/").map(String.init)
        return ExamFiles(subject: parts[0], exam: parts[1], original: originals[key]!, goro: goros[key]?.0)
    }
}

// MARK: - ページの描画と文字認識

struct OCRLine {
    var text: String
    var box: CGRect                 // ページ座標（左下原点, pt）
    var markers: [(n: Int, box: CGRect)]  // 行の中の「(n)」の位置
}

struct PageData {
    var size: CGSize
    var image: CGImage
    var pixels: [UInt8]             // RGBA, 上の行から
    var width: Int
    var height: Int
    var lines: [OCRLine]
    var marks: [CGRect]             // 語呂PDFの印（線・蛍光ペン・手書きなど）。ページ座標
    var strikes: [CGRect]           // 問題全体に引いた斜線
}

let markerRegex = try! NSRegularExpression(pattern: "[(（]\\s*([1-5１-５])\\s*[)）]")

/// ページを画像にする。回転（/Rotate）付きのページも見たままの向きで描く。
/// 以降の「ページ座標」は、この見たままの向き（左下原点, pt）を指す。
func renderPage(_ page: PDFPage) -> (CGImage, [UInt8], Int, Int, CGSize, CGAffineTransform) {
    let t = page.transform(for: .cropBox)
    let size = page.bounds(for: .cropBox).applying(t).standardized.size
    let w = Int((size.width * renderScale).rounded()), h = Int((size.height * renderScale).rounded())
    var pixels = [UInt8](repeating: 255, count: w * h * 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    let img: CGImage = pixels.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(.white)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: renderScale, y: renderScale)
        page.draw(with: .cropBox, to: ctx)   // draw は回転と原点の移動（t）を自分で適用する
        return ctx.makeImage()!
    }
    return (img, pixels, w, h, size, t)
}

func ocr(_ img: CGImage, pageSize: CGSize) -> [OCRLine] {
    let req = VNRecognizeTextRequest()
    req.recognitionLanguages = ["ja-JP", "en-US"]
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: img).perform([req])
    var lines: [OCRLine] = []
    for o in req.results ?? [] {
        guard let cand = o.topCandidates(1).first else { continue }
        let toPage = { (r: CGRect) -> CGRect in
            CGRect(x: r.minX * pageSize.width, y: r.minY * pageSize.height,
                   width: r.width * pageSize.width, height: r.height * pageSize.height)
        }
        let text = cand.string
        var markers: [(Int, CGRect)] = []
        let ns = text as NSString
        for m in markerRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let digit = normalizeDigits(ns.substring(with: m.range(at: 1)))
            guard let n = Int(digit), let r = Range(m.range, in: text),
                  let bb = try? cand.boundingBox(for: r)?.boundingBox else { continue }
            markers.append((n, toPage(bb)))
        }
        lines.append(OCRLine(text: text, box: toPage(o.boundingBox), markers: markers))
    }
    return lines
}

let markTypes: Set<String> = ["Line", "Ink", "Highlight", "Underline", "Square", "Circle", "StrikeOut", "Squiggly", "Polygon", "PolyLine"]


/// 斜線かどうか: 直線、または1筆でほぼまっすぐな手書き線
func isStraightStroke(_ a: PDFAnnotation) -> Bool {
    if a.type == "Line" { return true }
    guard a.type == "Ink", let paths = a.paths, paths.count == 1 else { return false }
    var pts: [CGPoint] = []
    let path = paths[0]
    var buf = [CGPoint](repeating: .zero, count: 3)
    for i in 0..<path.elementCount {
        let kind = path.element(at: i, associatedPoints: &buf)
        if kind == .curveTo || kind == .cubicCurveTo { pts.append(buf[2]) } else if kind != .closePath { pts.append(buf[0]) }
    }
    guard let p0 = pts.first, let p1 = pts.last else { return false }
    let dx = p1.x - p0.x, dy = p1.y - p0.y
    let len = (dx * dx + dy * dy).squareRoot()
    guard len > 150, abs(dx) > 80, abs(dy) > 80 else { return false }
    let maxDev = pts.map { abs(($0.x - p0.x) * dy - ($0.y - p0.y) * dx) / len }.max() ?? 0
    return maxDev / len < 0.12
}

func loadPages(_ url: URL, withMarks: Bool) -> [PageData] {
    guard let doc = PDFDocument(url: url) else { return [] }
    var result = [PageData?](repeating: nil, count: doc.pageCount)
    let lock = NSLock()
    // PDFPage の描画は並列にすると不安定なことがあるため、描画は順番に、文字認識だけ並列にする
    var rendered: [(CGImage, [UInt8], Int, Int, CGSize, CGAffineTransform, [CGRect], [CGRect])] = []
    for i in 0..<doc.pageCount {
        let page = doc.page(at: i)!
        let r = renderPage(page)
        var marks: [CGRect] = [], strikes: [CGRect] = []
        if withMarks {
            for a in page.annotations where markTypes.contains(a.type ?? "") {
                let bb = a.bounds.applying(r.5).standardized
                if bb.maxX < 0 || bb.minX > r.4.width { continue }  // ページ外（ポップアップなど）
                // 問題全体にかかる大きな斜線（1本の直線、または1筆の手書き線）
                let t = a.type ?? ""
                if bb.width >= 120 && bb.height >= 120 && isStraightStroke(a) {
                    strikes.append(bb); continue
                }
                marks.append(bb)
            }
        }
        rendered.append((r.0, r.1, r.2, r.3, r.4, r.5, marks, strikes))
    }
    DispatchQueue.concurrentPerform(iterations: rendered.count) { i in
        let r = rendered[i]
        let lines = ocr(r.0, pageSize: r.4)
        let pd = PageData(size: r.4, image: r.0, pixels: r.1, width: r.2, height: r.3, lines: lines, marks: r.6, strikes: r.7)
        lock.lock(); result[i] = pd; lock.unlock()
    }
    return result.map { $0! }
}

// MARK: - 文字列の比較（ページの対応づけ・語呂テキスト抽出）

func compact(_ s: String) -> String {
    String(normalizeDigits(s).filter { !$0.isWhitespace && !",，、。.・".contains($0) })
}

func bigrams(_ s: String) -> Set<String> {
    let c = Array(compact(s))
    guard c.count >= 2 else { return Set(c.map { String($0) }) }
    var set = Set<String>()
    for i in 0..<(c.count - 1) { set.insert(String(c[i]) + String(c[i + 1])) }
    return set
}

func similarity(_ a: Set<String>, _ b: Set<String>) -> Double {
    if a.isEmpty || b.isEmpty { return 0 }
    return Double(a.intersection(b).count) / Double(min(a.count, b.count))
}

/// 語呂PDFの各ページが原本の何ページ目に当たるか（なければ nil = 語呂だけの追加ページ）
func matchPages(goro: [PageData], orig: [PageData]) -> [Int?] {
    let og = orig.map { bigrams($0.lines.map(\.text).joined()) }
    var result: [Int?] = []
    var last = -1
    for g in goro {
        let gb = bigrams(g.lines.map(\.text).joined())
        var best: (Int, Double)? = nil
        for j in max(0, last + 1)..<min(orig.count, last + 6) {
            let s = similarity(gb, og[j])
            // 文字のないページ同士（白紙・図だけ）は、順番どおりなら対応とみなす
            let score = (gb.count < 5 && og[j].count < 5) ? (j == last + 1 ? 0.9 : 0) : s
            if best == nil || score > best!.1 { best = (j, score) }
        }
        if let b = best, b.1 >= 0.6 { result.append(b.0); last = b.0 } else { result.append(nil) }
    }
    return result
}

// MARK: - 問題の見出しを探す

struct Header {
    var page: Int
    var number: Int
    var box: CGRect
    var confident: Bool
}

let headerRegex = try! NSRegularExpression(pattern: "^\\s*[問間閥門閤]\\s*([0-9０-９]{1,2})(?![0-9０-９])")

func findHeaders(_ pages: [PageData], multiYear: Bool, lastNumber: Int) -> (headers: [Header], bStart: [Int: Int]) {
    var cands: [Header] = []
    var bMarks: [Int: Int] = [:]  // ページ -> 「B問題」見出しの y
    for (pi, p) in pages.enumerated() {
        // 表紙・注意事項のページ（「記入例」「マークシート」）は飛ばす
        let pageText = p.lines.map(\.text).joined()
        if pageText.contains("記入例") || pageText.contains("マークシート") || pageText.contains("試験開始の合図") { continue }
        for l in p.lines {
            let t = normalizeDigits(l.text)
            if t.range(of: "^\\s*[BＢ]\\s*問\\s*題", options: .regularExpression) != nil {
                bMarks[pi] = Int(l.box.midY)
            }
            // 「問17及び問18は選択問題…」の注意書きは見出しではない
            if t.range(of: "^\\s*.\\s*\\d+\\s*(及|と|又)", options: .regularExpression) != nil || t.contains("選択問題") { continue }
            guard l.box.minX < p.size.width * 0.35 else { continue }
            let ns = t as NSString
            if let m = headerRegex.firstMatch(in: t, range: NSRange(location: 0, length: ns.length)),
               let n = Int(ns.substring(with: m.range(at: 1))) {
                cands.append(Header(page: pi, number: n, box: l.box, confident: true))
            } else if t.range(of: "^\\s*[問間閥門閤](?!\\s*[ぁ-んァ-ヶ一-龥])", options: .regularExpression) != nil {
                // 番号が読めなかった見出しの候補（番号の流れから補う）
                // 「問に答えよ」のような文の途中の行（問の後ろがかな・漢字）は見出しではない
                cands.append(Header(page: pi, number: -1, box: l.box, confident: false))
            }
        }
    }
    // 読む順（ページ順・上から）に並べ、番号の流れに合うものだけ残す
    cands.sort { $0.page != $1.page ? $0.page < $1.page : $0.box.maxY > $1.box.maxY }
    // 見出しの左端の位置（多数派）
    let xs = cands.filter(\.confident).map { Int($0.box.minX / 4) }
    var freq: [Int: Int] = [:]
    for x in xs { freq[x, default: 0] += 1 }
    let modeX = CGFloat((freq.max { $0.value < $1.value }?.key ?? 0) * 4)
    if ProcessInfo.processInfo.environment["DEBUG"] == "2" {
        for (pi, p) in pages.enumerated() { for l in p.lines where l.box.minX < p.size.width * 0.35 { print("  p\(pi + 1) x=\(Int(l.box.minX)) y=\(Int(l.box.maxY)) \(l.text.prefix(20))") } }
    }
    if ProcessInfo.processInfo.environment["DEBUG"] != nil {
        for c in cands { print("  cand p\(c.page + 1) 問\(c.number) x=\(Int(c.box.minX)) y=\(Int(c.box.maxY))") }
        print("  modeX=\(modeX)")
    }
    var out: [Header] = []
    var expected = 1
    var firstNumber: Int? = nil   // 最初の見出しの番号（B問題だけのファイルは 11 から始まる）
    for var c in cands {
        guard abs(c.box.minX - modeX) < 30 else { continue }
        if out.isEmpty && multiYear {
            // 複数年度ファイル（B問題だけなど）: 最初の見出しの番号から始める
            guard c.number > 0 && c.number <= 20 else { continue }
            firstNumber = c.number; out.append(c); expected = c.number + 1; continue
        }
        let first = firstNumber ?? 1
        // 番号の読み違い（例: 問7 → 問74、番号なし）: 見出しの位置が揃っていれば次の番号とみなす
        if c.number != expected && c.number != first && abs(c.box.minX - modeX) < 10 {
            let n = c.number
            if n < 0 || (n > expected + 1 && String(n).hasPrefix(String(expected))) {
                c.number = expected; c.confident = false
            }
        }
        if c.number == expected {
            out.append(c); expected += 1
        } else if multiYear && c.number == first && expected > first + 2 {
            out.append(c); expected = first + 1   // 次の年度（複数年度が1ファイルの場合）
        } else if let last = out.last, c.number == last.number + 2 {
            // 1つ読み飛ばした可能性（見出しの読み取り失敗）
            out.append(c); expected = c.number + 1
        }
    }

    // 読み飛ばした見出しを補う: 間のページで、ページ上端の行を見出しとみなす
    // （斜線が見出しに重なると「問14」が読めないことがある）
    let topYs = out.filter(\.confident).map(\.box.maxY).sorted()
    let typicalTop = topYs.isEmpty ? 0 : topYs[topYs.count * 3 / 4]
    var fixed: [Header] = []
    for (i, h) in out.enumerated() {
        if i > 0 {
            let a = out[i - 1]
            if h.number == a.number + 2 {
                for pi in (a.page + 1)...max(a.page + 1, h.page) where pi < pages.count {
                    let p = pages[pi]
                    let lines = p.lines.filter { !isFooter($0, p.size) && $0.box.minX < modeX + 60 && (pi != h.page || $0.box.minY > h.box.maxY) }
                    guard let top = lines.max(by: { $0.box.maxY < $1.box.maxY }), top.box.maxY > typicalTop - 30 else { continue }
                    fixed.append(Header(page: pi, number: a.number + 1, box: top.box, confident: false))
                    break
                }
            }
        }
        fixed.append(h)
    }
    out = fixed

    // 最後の問題の見出しが読めなかった場合（例: 斜線がかかった問18）: 後ろのページの上端の行を見出しとみなす
    if !multiYear, let last = out.last, last.number == lastNumber - 1, last.page + 1 < pages.count {
        for pi in (last.page + 1)..<pages.count {
            let p = pages[pi]
            let pageText = p.lines.map(\.text).joined()
            if pageText.contains("選択問題") && !p.lines.contains(where: { $0.box.minX < modeX + 60 && normalizeDigits($0.text).range(of: "^\\s*.\\s*\\d", options: .regularExpression) != nil }) { continue }
            let lines = p.lines.filter { !isFooter($0, p.size) && $0.box.minX < modeX + 60 && !$0.text.contains("選択問題") }
            guard let top = lines.max(by: { $0.box.maxY < $1.box.maxY }), top.box.maxY > typicalTop - 30 else { continue }
            out.append(Header(page: pi, number: lastNumber, box: top.box, confident: false))
            break
        }
    }
    return (out, bMarks)
}

// MARK: - 切り出し範囲

func isFooter(_ l: OCRLine, _ size: CGSize) -> Bool {
    guard l.box.midY < size.height * 0.15 || l.box.midY > size.height * 0.95 else { return false }
    let t = normalizeDigits(l.text).trimmingCharacters(in: .whitespaces)
    // ページ番号（例: - 2 -）は、ページの左右中央にあるものだけ（表の中の「2」などを誤認しないため）
    if t.range(of: "^[-－ー—\\s]*\\d{1,2}[-－ー—\\s]*$", options: .regularExpression) != nil {
        return abs(l.box.midX - size.width / 2) < size.width * 0.08 && t.range(of: "[-－ー—]", options: .regularExpression) != nil
    }
    return t.contains("T1") || t.contains("indd") || t.contains("■") || t.contains("●") || t.contains("Tl-")
}

/// ページの中で内容がありうる上下の範囲（ページ座標）
func contentBand(_ p: PageData) -> (top: CGFloat, bottom: CGFloat) {
    var bottom = p.size.height * 0.03
    for l in p.lines where isFooter(l, p.size) && l.box.midY < p.size.height * 0.15 {
        bottom = max(bottom, l.box.maxY + 2)
    }
    // フッターより下まで書き込み（語呂の文字）がある場合は、ページの下端まで含める
    if p.lines.contains(where: { !isFooter($0, p.size) && $0.box.minY < bottom - 2 && $0.box.maxY > p.size.height * 0.02 }) {
        bottom = 0
    }
    var top = p.size.height * 0.95
    for l in p.lines where isFooter(l, p.size) && l.box.midY > p.size.height * 0.95 {
        top = min(top, l.box.minY - 2)
    }
    return (top, bottom)
}

/// 範囲の中で白以外の画素がある外接矩形（ページ座標）。なければ nil
func inkBounds(_ p: PageData, x0: CGFloat, x1: CGFloat, yTop: CGFloat, yBottom: CGFloat) -> CGRect? {
    let s = renderScale
    let c0 = max(0, Int(x0 * s)), c1 = min(p.width - 1, Int(x1 * s))
    let r0 = max(0, Int((p.size.height - yTop) * s)), r1 = min(p.height - 1, Int((p.size.height - yBottom) * s))
    guard c0 < c1, r0 < r1 else { return nil }
    var minR = Int.max, maxR = -1, minC = Int.max, maxC = -1
    p.pixels.withUnsafeBufferPointer { px in
        for r in r0...r1 {
            let row = r * p.width * 4
            for c in stride(from: c0, through: c1, by: 1) {
                let i = row + c * 4
                if px[i] < 225 || px[i + 1] < 225 || px[i + 2] < 225 {
                    if r < minR { minR = r }; if r > maxR { maxR = r }
                    if c < minC { minC = c }; if c > maxC { maxC = c }
                }
            }
        }
    }
    guard maxR >= 0 else { return nil }
    return CGRect(x: CGFloat(minC) / s, y: p.size.height - CGFloat(maxR + 1) / s,
                  width: CGFloat(maxC - minC + 1) / s, height: CGFloat(maxR - minR + 1) / s)
}

func saveCrop(_ p: PageData, rect: CGRect, to url: URL) {
    let s = renderScale
    let px = CGRect(x: rect.minX * s, y: (p.size.height - rect.maxY) * s, width: rect.width * s, height: rect.height * s).integral
    guard let cropped = p.image.cropping(to: px) else { return }
    let rep = NSBitmapImageRep(cgImage: cropped)
    if let data = rep.representation(using: .jpeg, properties: [.compressionFactor: jpegQuality]) {
        try? data.write(to: url)
    }
}

// MARK: - 1回分の処理

func process(_ ex: ExamFiles, outRoot: URL) {
    let t0 = Date()
    let orig = loadPages(ex.original, withMarks: false)
    let goro = ex.goro.map { loadPages($0, withMarks: true) } ?? []
    var warnings: [String] = []
    if ex.goro == nil { warnings.append("語呂PDFがありません") }

    // 見出しは語呂PDFがあればそちらで探す（追加ページを含めて順番がわかるため）
    let base = goro.isEmpty ? orig : goro
    let pageMap: [Int?] = goro.isEmpty ? orig.indices.map { $0 } : matchPages(goro: goro, orig: orig)
    let unmatched = pageMap.enumerated().filter { $0.element == nil }.map { $0.offset + 1 }
    if !goro.isEmpty && !unmatched.isEmpty { warnings.append("原本にない語呂PDFのページ: \(unmatched)") }

    let multiYear = ex.exam.contains("-")
    let (headers, bMarks) = findHeaders(base, multiYear: multiYear, lastNumber: ex.subject == "法規" ? 13 : 18)
    if headers.isEmpty { warnings.append("問題の見出しが見つかりません") }

    // 横方向の範囲: 文書全体の文字の左右端
    let allLines = base.flatMap { p in p.lines.filter { !isFooter($0, p.size) } }
    let pw = base.first?.size.width ?? 600
    let lefts = allLines.map(\.box.minX).sorted(), rights = allLines.map(\.box.maxX).sorted()
    let xMin = max(pw * 0.04, (lefts.isEmpty ? 0 : lefts[lefts.count / 20]) - 24)
    let xMax = min(pw * 0.96, (rights.isEmpty ? pw : rights[rights.count * 19 / 20]) + 24)

    let dir = outRoot.appendingPathComponent(ex.subject).appendingPathComponent(ex.exam)
    // 前回の分け方を覚えておく（分け方が変わった問題は、確認画面での修正を退避する）
    var oldShape: [String: Int] = [:]
    if let data = try? Data(contentsOf: dir.appendingPathComponent("exam.json")),
       let old = try? JSONDecoder().decode(ExamOut.self, from: data) {
        for q in old.questions { oldShape[q.id] = q.subCount }
    }
    // 前回の画像と exam.json だけ消す（確認画面で直した review.json は残す）
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for f in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where f.hasSuffix(".jpg") || f == "exam.json" {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(f))
    }

    // B問題の始まり（見出し「B問題」の直後の問題）
    var bFrom: Int? = nil
    for (hi, h) in headers.enumerated() {
        if let y = bMarks[h.page], CGFloat(y) >= h.box.maxY - 2, bFrom == nil { bFrom = hi }
    }

    var segment = 0
    var questions: [QuestionOut] = []
    for (hi, h) in headers.enumerated() {
        if hi > 0 && h.number == headers[0].number { segment += 1 }
        let next: Header? = hi + 1 < headers.count ? headers[hi + 1] : nil
        let endPage = next?.page ?? (base.count - 1)
        var pieces: [Piece] = []
        var qLines: [String] = []
        var gLines: [String] = []
        var markers: [(n: Int, box: CGRect, page: Int)] = []
        var marks: [(CGRect, Int)] = []
        var flags: [String] = []
        var struck = false
        let qid = String(format: "%@-%@-%02d", ex.subject, ex.exam, h.number) + (segment > 0 ? "-s\(segment)" : "")

        for pi in h.page...endPage {
            let p = base[pi]
            let band = contentBand(p)
            var top = pi == h.page ? h.box.maxY + 6 : band.top
            var bottom = (next != nil && pi == next!.page) ? next!.box.maxY + 4 : band.bottom
            if pi == h.page && next != nil && next!.page == pi { bottom = next!.box.maxY + 4 }
            top = min(top, band.top); bottom = max(bottom, band.bottom)
            if top - bottom < 8 { continue }

            let op: PageData? = goro.isEmpty ? p : (pageMap[pi].map { orig[$0] })
            let gInk = goro.isEmpty ? nil : inkBounds(p, x0: xMin, x1: xMax, yTop: top, yBottom: bottom)
            let oInk = op.flatMap { inkBounds($0, x0: xMin, x1: xMax, yTop: top, yBottom: bottom) }
            guard var rect = [gInk, oInk].compactMap({ $0 }).reduce(nil as CGRect?, { $0 == nil ? $1 : $0!.union($1) }) else { continue }
            rect = rect.insetBy(dx: -8, dy: -8)
            rect.origin.y = max(rect.origin.y, bottom - 2)
            if rect.maxY > top + 2 { rect.size.height = top + 2 - rect.origin.y }

            let n = pieces.count + 1
            var piece = Piece()
            if let op = op, oInk != nil {
                let f = "\(qid)-q\(n).jpg"; saveCrop(op, rect: rect, to: dir.appendingPathComponent(f)); piece.question = f
            }
            if !goro.isEmpty {
                let f = "\(qid)-g\(n).jpg"; saveCrop(p, rect: rect, to: dir.appendingPathComponent(f)); piece.goro = f
            }
            pieces.append(piece)

            let inBand = { (b: CGRect) in b.midY <= top && b.midY >= bottom }
            let oLines = (op?.lines ?? []).filter { inBand($0.box) && !isFooter($0, p.size) }
            qLines += oLines.map(\.text)
            for l in oLines {
                let t = normalizeDigits(l.text)
                if t.contains("うちから") || t.contains("～(") || t.contains("〜(") || t.contains("~(") { continue }
                for m in l.markers { markers.append((m.n, m.box, pi)) }
            }
            if !goro.isEmpty {
                let ob = Set((op?.lines ?? []).map { compact($0.text) })
                for l in p.lines where inBand(l.box) && !isFooter(l, p.size) {
                    let c = compact(l.text)
                    if c.count >= 2 && !ob.contains(c) && !ob.contains(where: { $0.count > 4 && ($0.contains(c) || c.contains($0)) }) {
                        gLines.append(l.text)
                    }
                }
                if p.strikes.contains(where: { inBand($0) }) { struck = true }
                for mk in p.marks where inBand(mk) || (mk.maxY <= top && mk.minY >= bottom - 4) { marks.append((mk, pi)) }
            }
        }

        // 選択肢の組: 「(1)」が出るたびに新しい組
        var sets: [[(n: Int, box: CGRect, page: Int)]] = []
        for m in markers {
            if m.n == 1 || sets.isEmpty { sets.append([]) }
            sets[sets.count - 1].append(m)
        }
        sets = sets.filter { $0.count >= 3 }
        if sets.isEmpty { flags.append("選択肢の番号が読み取れません"); sets = [[]] }

        var answers: [Int?] = []
        var cands: [[Int]] = []
        for s in sets {
            var hit = Set<Int>()
            // 印ごとに、いちばん近い選択肢番号を1つだけ選ぶ（下線は番号のすぐ下、蛍光ペンは番号に重なる）
            for (mk, pi) in marks {
                var best: (n: Int, d: CGFloat)? = nil
                for m in s where m.page == pi {
                    let mb = m.box
                    let hOverlap = mk.maxX >= mb.minX - 2 && mk.minX <= mb.maxX + 2
                    let startsHere = mk.minX >= mb.minX - 30
                    guard hOverlap && startsHere else { continue }
                    let markMid = mk.height > 6 ? mk.midY : mk.maxY  // 線は上端、面は中心
                    let d = mb.midY - markMid                         // 正 = 印が番号より下
                    guard d > -mb.height * 0.6 && d < mb.height * 0.5 + 12 else { continue }
                    if best == nil || abs(d) < abs(best!.d) { best = (m.n, d) }
                }
                if let b = best { hit.insert(b.n) }
            }
            // 同じ行に複数の選択肢がある場合、線が1つの番号だけにかかるように絞る
            let c = hit.sorted()
            cands.append(c)
            answers.append(c.count == 1 ? c[0] : nil)
        }
        if goro.isEmpty { flags.append("語呂PDFがないため正解は手入力") }
        else {
            if answers.contains(where: { $0 == nil }) { flags.append("正解の印が見つからない、または複数あります") }
        }
        if sets.count > 2 { flags.append("選択肢の組が\(sets.count)つあります") }
        if pieces.isEmpty { flags.append("画像を切り出せませんでした") }

        let excluded = struck && ex.subject == "機械"
        if struck { flags = [excluded ? "斜線あり（勉強しないので除外）" : "斜線あり"] }

        let part: String
        if let b = bFrom { part = hi >= b ? "B" : "A" } else { part = sets.count >= 2 ? "B" : "?" }

        questions.append(QuestionOut(
            id: qid, number: h.number, part: part, subCount: sets.count,
            answers: answers, answerCandidates: cands, pieces: pieces,
            text: qLines.joined(separator: "\n"), goroText: gLines.joined(separator: "\n"),
            flags: flags, segment: segment, struck: struck, excluded: excluded))
    }

    let flagged = questions.filter { !$0.flags.isEmpty && !$0.excluded }.count
    let excludedCount = questions.filter(\.excluded).count
    if excludedCount > 0 { warnings.append("斜線で除外: \(excludedCount)問") }
    let iso = ISO8601DateFormatter()
    let out = ExamOut(subject: ex.subject, exam: ex.exam, original: ex.original.lastPathComponent,
                      goro: ex.goro?.lastPathComponent, pageCount: orig.count, goroPageCount: goro.count,
                      questions: questions, warnings: warnings, extractedAt: iso.string(from: Date()))
    let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try? enc.encode(out).write(to: dir.appendingPathComponent("exam.json"))

    // 分け方が変わった問題の修正内容は、古い分け方に対するものなので外す（元の内容は review.backup-*.json に残す）
    let reviewURL = dir.appendingPathComponent("review.json")
    if let data = try? Data(contentsOf: reviewURL),
       var review = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       var qs = review["questions"] as? [String: Any] {
        let newShape = Dictionary(uniqueKeysWithValues: questions.map { ($0.id, $0.subCount) })
        var dropped: [String] = []
        for (qid, _) in qs {
            let changed = newShape[qid] == nil || (oldShape[qid] != nil && oldShape[qid] != newShape[qid])
            if changed { qs.removeValue(forKey: qid); dropped.append(qid) }
        }
        if !dropped.isEmpty {
            let stamp = Int(Date().timeIntervalSince1970)
            try? data.write(to: dir.appendingPathComponent("review.backup-\(stamp).json"))
            review["questions"] = qs
            if let d = try? JSONSerialization.data(withJSONObject: review, options: [.prettyPrinted, .sortedKeys]) { try? d.write(to: reviewURL) }
            print("  分け方が変わったため確認内容を外しました: \(dropped.sorted().joined(separator: ", "))")
        }
    }
    print(String(format: "%@ %@: %d問 (要確認 %d) %@ [%.0f秒]", ex.subject, ex.exam, questions.count, flagged,
                 warnings.joined(separator: " / "), Date().timeIntervalSince(t0)))
}

// MARK: - main

let args = CommandLine.arguments
guard args.count >= 3 else {
    print("使い方: extract <PDFのルートフォルダ> <出力フォルダ> [絞り込み...]"); exit(1)
}
let root = URL(fileURLWithPath: (args[1] as NSString).expandingTildeInPath)
let outRoot = URL(fileURLWithPath: (args[2] as NSString).expandingTildeInPath)
let filters = Array(args.dropFirst(3))
var exams = findExams(root: root)
if !filters.isEmpty { exams = exams.filter { e in filters.contains { (e.subject + e.exam).contains($0) } } }
// SKIP_EXISTING=1 のとき、取り込み済み（exam.json がある）回は飛ばす
if ProcessInfo.processInfo.environment["SKIP_EXISTING"] != nil {
    exams = exams.filter { !FileManager.default.fileExists(atPath: outRoot.appendingPathComponent($0.subject).appendingPathComponent($0.exam).appendingPathComponent("exam.json").path) }
}
print("対象: \(exams.count)回分")
for ex in exams { autoreleasepool { process(ex, outRoot: outRoot) } }
